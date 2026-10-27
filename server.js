// server.js — node server.js (Node >= 18). Dépendances installées au premier lancement.
// Render : définir DATABASE_URL (PostgreSQL). Hors Render : fichier local dans POKER_DATA_DIR.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomInt, randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const runtime = process.env.POKER_RUNTIME_DIR || path.join(os.tmpdir(), `poker-runtime-${os.userInfo().username}`);
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const load = createRequire(path.join(runtime, 'package.json'));
try { load.resolve('express'); load.resolve('socket.io'); load.resolve('pg'); }
catch {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'install', '--prefix', runtime, '--no-save', '--package-lock=false', '--no-audit', '--no-fund',
    '--fetch-retries=1', '--fetch-timeout=20000',
    'express@5.1.0', 'socket.io@4.8.1', 'pg@8.16.3'
  ], { stdio: 'inherit' });
  if (r.error || r.status !== 0) { console.error('Installation impossible.', r.error || ''); process.exit(1); }
}
if (process.argv.includes('--install')) { console.log('Dépendances prêtes.'); process.exit(0); }
const app = load('express')();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(load('express').json({ limit: '4kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
const sameOrigin = req => {
  try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
};
const server = http.createServer(app);
const io = new (load('socket.io').Server)(server, {
  maxHttpBufferSize: 8192,
  allowRequest: (req, done) => done(null, sameOrigin(req))
});
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.status(storageReady && !storageUnavailable ? 200 : 503)
  .json({ ok: storageReady && !storageUnavailable }));

const BUY_IN = 500, SMALL = 5, BIG = 10, TURN_MS = 30000, DAY = 86400000;
const scrypt = promisify(scryptCallback);
const users = new Map();
const sessions = new Map(), authAttempts = new Map();
const postgres = !!process.env.DATABASE_URL;
const STORAGE_MESSAGE = 'Le stockage est temporairement indisponible. La partie est suspendue pour protéger vos jetons.';
let pool, dbRevision, storageReady = false, storageUnavailable = false;
let mutationQueue = Promise.resolve(), inMutation = false, turnChanged = false;
const defaultDataDir = path.join(__dirname, '.poker-data');
const renderDataDir = '/var/data/poker';
const dataDir = path.resolve(process.env.POKER_DATA_DIR ||
  (process.env.RENDER && fs.existsSync('/var/data') ? renderDataDir : defaultDataDir));
const dataFile = path.join(dataDir, 'accounts.json');
let capitalResetVersion = 1; // Marqueur historique conservé ; aucune remise à zéro automatique.
function validateAccounts(saved) {
  if (saved.version !== 1 || !Array.isArray(saved.users)) throw Error('Sauvegarde de comptes invalide.');
  const previousReset = saved.capitalResetVersion ?? 0;
  if (!Number.isSafeInteger(previousReset) || previousReset < 0)
    throw Error('Version de remise à zéro non prise en charge.');
  const ids = new Set();
  for (const u of saved.users) {
    if (typeof u.id !== 'string' || typeof u.nick !== 'string' ||
      !/^[a-f0-9]{32}$/.test(u.salt) || !/^[a-f0-9]{128}$/.test(u.hash) ||
      !Number.isSafeInteger(u.wallet) || u.wallet < 0 ||
      !Number.isSafeInteger(u.granted) || u.granted < 1000 ||
      !Number.isSafeInteger(u.lastAidAt) || u.lastAidAt < 0 || ids.has(u.id))
      throw Error('Sauvegarde de comptes invalide.');
    ids.add(u.id);
  }
  return saved;
}
function readAccounts(file) { return validateAccounts(JSON.parse(fs.readFileSync(file, 'utf8'))); }
function findAccounts(file) {
  // Le fichier principal est prioritaire. Un fichier incomplet ne remplace jamais une sauvegarde valide.
  let empty, invalid;
  for (const candidate of [file, file + '.tmp', file + '.bak']) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const saved = readAccounts(candidate);
      const found = { file: candidate, saved };
      if (saved.users.length) return found;
      empty ||= found;
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') throw error;
      invalid ||= error;
      console.error(`[stockage] Sauvegarde inutilisable : ${candidate}. Son contenu est conservé.`);
    }
  }
  return empty || (invalid ? { invalid } : null);
}
function loadLocalAccounts() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let source = findAccounts(dataFile);
  if (!source?.saved?.users.length) {
    const alternatives = [...new Set([defaultDataDir, renderDataDir, '/var/data'].map(p =>
      path.join(path.resolve(p), 'accounts.json')))].filter(file => file !== dataFile)
      .map(file => findAccounts(file)).filter(found => found?.saved?.users.length);
    if (alternatives.length > 1 && alternatives.some(found =>
      !fs.readFileSync(found.file).equals(fs.readFileSync(alternatives[0].file))))
      throw Error('Plusieurs sauvegardes différentes existent. Indiquez leur dossier correct dans POKER_DATA_DIR ; aucun compte n’a été remplacé.');
    if (alternatives.length) source = alternatives[0];
  }
  if (source?.invalid) throw source.invalid;
  if (source?.saved && source.file !== dataFile) {
    // Préserver le fichier remplacé et l'original avant une récupération, sans fusion ni changement de solde.
    if (fs.existsSync(dataFile)) {
      const preserved = dataFile + `.before-recovery-${Date.now()}-${randomBytes(4).toString('hex')}`;
      fs.copyFileSync(dataFile, preserved, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(preserved, 0o600);
    }
    const recoveryFile = dataFile + '.recover-' + randomBytes(6).toString('hex');
    fs.copyFileSync(source.file, recoveryFile, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(recoveryFile, 0o600);
    fs.renameSync(recoveryFile, dataFile);
    console.log(`[stockage] Sauvegarde récupérée depuis ${source.file} ; identifiants et soldes conservés.`);
  }
  if (source?.saved) {
    capitalResetVersion = Math.max(1, source.saved.capitalResetVersion ?? 0);
    for (const u of source.saved.users) users.set(u.id, { ...u, socket: null });
  }
  console.log(`[stockage] ${users.size} compte(s) chargé(s) depuis ${dataFile}.`);
}
async function initializeStorage() {
  if (!postgres) {
    if (process.env.RENDER) throw Object.assign(Error('DATABASE_URL doit être configurée sur Render.'), { code: 'DATABASE_URL_MISSING' });
    loadLocalAccounts(); storageReady = true; return;
  }
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw Error('URL PostgreSQL invalide.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const sslmode = url.searchParams.get('sslmode');
  if (!local && sslmode === 'disable') throw Error('TLS est obligatoire pour une base distante.');
  let ssl = false;
  if (!local || (sslmode && sslmode !== 'disable')) {
    ssl = { rejectUnauthorized: true };
    for (const [query, option] of [['sslrootcert', 'ca'], ['sslcert', 'cert'], ['sslkey', 'key']]) {
      const file = url.searchParams.get(query); if (file) ssl[option] = fs.readFileSync(file, 'utf8');
    }
  }
  // Conserver explicitement la validation du certificat, même si l'URL contient sslmode=require.
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  pool = new (load('pg').Pool)({ connectionString: url.toString(), ssl, max: 2,
    connectionTimeoutMillis: 15000, query_timeout: 15000, idleTimeoutMillis: 30000,
    allowExitOnIdle: true, application_name: 'river-club', enableChannelBinding: true });
  pool.on('error', error => console.error('[stockage] Connexion inactive fermée :', error.code || error.name));
  // Schéma privé : les hachages et les soldes ne sont pas exposés par l'API publique de Supabase.
  await pool.query('CREATE SCHEMA IF NOT EXISTS river_club_private');
  await pool.query('REVOKE ALL ON SCHEMA river_club_private FROM PUBLIC');
  await pool.query(`CREATE TABLE IF NOT EXISTS river_club_private.state (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision BIGINT NOT NULL DEFAULT 0, payload JSONB NOT NULL)`);
  await pool.query('ALTER TABLE river_club_private.state ENABLE ROW LEVEL SECURITY');
  await pool.query('REVOKE ALL ON TABLE river_club_private.state FROM PUBLIC');
  await pool.query(`INSERT INTO river_club_private.state (id, payload) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify({ version: 1, capitalResetVersion: 1, users: [] })]);
  const { rows } = await pool.query('SELECT revision, payload FROM river_club_private.state WHERE id = 1');
  const saved = validateAccounts(rows[0].payload);
  dbRevision = rows[0].revision; capitalResetVersion = Math.max(1, saved.capitalResetVersion ?? 0);
  for (const u of saved.users) users.set(u.id, { ...u, socket: null });
  storageReady = true;
  console.log(`[stockage] PostgreSQL connecté : ${users.size} compte(s) chargé(s).`);
}
const table = { players: [], phase: 'waiting', board: [], deck: [], dealer: null,
  turn: null, currentBet: 0, minRaise: BIG, pending: new Set(), acted: new Map(),
  hand: 0, result: 'Bienvenue à la table.', deadline: 0, endedAt: 0, reveal: false, logs: [] };
let logSequence = 0;
function addLog(message, player) {
  table.logs.push({ id: ++logSequence, hand: table.hand, time: Date.now(),
    message: player ? `[${player.nick}] ${message}` : message });
  if (table.logs.length > 100) table.logs.splice(0, table.logs.length - 100);
}
let timer;
const active = () => !['waiting', 'showdown'].includes(table.phase);
const live = () => table.players.filter(p => !p.folded);
const canAct = p => !p.folded && p.stack > 0 && !p.leaving;
const seat = id => table.players.find(p => p.id === id);
function bankroll(id) {
  const p = seat(id);
  return users.get(id).wallet + (p ? p.stack + p.total : 0);
}
async function persist() {
  if (storageUnavailable) throw Error('Le stockage des comptes est indisponible.');
  // Les mises non réglées retournent à leur propriétaire si le serveur redémarre en pleine main.
  const rows = [...users].map(([id, u]) => ({ id, nick: u.nick, salt: u.salt, hash: u.hash,
    wallet: bankroll(id), granted: u.granted, lastAidAt: u.lastAidAt }));
  const payload = JSON.stringify({ version: 1, capitalResetVersion, users: rows });
  if (postgres) {
    const result = await pool.query(`UPDATE river_club_private.state SET payload = $1::jsonb, revision = revision + 1
      WHERE id = 1 AND revision = $2 RETURNING revision`, [payload, dbRevision]);
    if (result.rowCount !== 1) throw Object.assign(Error('Une autre instance a modifié les comptes.'), { code: 'STORAGE_CONFLICT' });
    dbRevision = result.rows[0].revision; return;
  }
  const temporary = dataFile + '.tmp';
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (fs.existsSync(dataFile)) {
    fs.copyFileSync(dataFile, dataFile + '.bak.tmp');
    fs.chmodSync(dataFile + '.bak.tmp', 0o600);
    fs.renameSync(dataFile + '.bak.tmp', dataFile + '.bak');
  }
  fs.renameSync(temporary, dataFile);
}
function storageFailed(error) {
  storageUnavailable = true; clearTimeout(timer);
  console.error('[stockage] Sauvegarde indisponible :', error.code || error.name);
  if (error.code === 'DATABASE_URL_MISSING') console.error('[stockage] Définissez DATABASE_URL dans Render → Environment. Aucun compte ne sera enregistré sur le disque éphémère.');
  io.emit('storage-error', { message: STORAGE_MESSAGE });
}
function enqueue(action, save = true) {
  const result = mutationQueue.then(async () => {
    await ready;
    if (storageUnavailable) throw Error(STORAGE_MESSAGE);
    const before = structuredClone({ users, table, logSequence });
    clearTimeout(timer); inMutation = true; turnChanged = false;
    let writing = false;
    try {
      const value = action();
      if (save) { writing = true; await persist(); }
      if (turnChanged && table.turn) table.deadline = Date.now() + TURN_MS;
      inMutation = false; scheduleTurn(); broadcast(); return value;
    } catch (error) {
      users.clear(); for (const [id, u] of before.users) users.set(id, u);
      Object.assign(table, before.table); logSequence = before.logSequence; inMutation = false;
      if (writing) { storageFailed(error); throw Error(STORAGE_MESSAGE); }
      scheduleTurn(); throw error;
    }
  });
  mutationQueue = result.catch(() => {});
  return result;
}
function aidStatus(id) {
  const u = users.get(id), nextAt = u.lastAidAt ? u.lastAidAt + DAY : 0;
  return { eligible: !seat(id) && bankroll(id) < BUY_IN && Date.now() >= nextAt, nextAt };
}
function sessionFor(req) {
  const token = /(?:^|;\s*)river_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const session = sessions.get(token);
  if (!session || session.expires <= Date.now()) { if (token) sessions.delete(token); return null; }
  return { ...session, token };
}
function createSession(req, res, id) {
  for (const [token, s] of sessions) if (s.id === id) sessions.delete(token);
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { id, expires: Date.now() + 7 * DAY });
  res.cookie('river_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure,
    maxAge: 7 * DAY, path: '/' });
  res.json({ ok: true, nick: users.get(id).nick });
}
function consumeAttempt(key, limit) {
  const now = Date.now();
  let value = authAttempts.get(key);
  if (!value || value.until <= now) { value = { count: 0, until: now + 15 * 60000 }; authAttempts.set(key, value); }
  return ++value.count <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, v] of authAttempts) if (v.until <= now) authAttempts.delete(key);
  for (const [key, v] of sessions) if (v.expires <= now) sessions.delete(key);
}, 60000).unref();
app.use('/api', async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Origine non autorisée.' });
  if (req.path === '/logout') return next();
  try { await ready; } catch { return res.status(503).json({ error: STORAGE_MESSAGE }); }
  if (storageUnavailable) return res.status(503).json({ error: STORAGE_MESSAGE });
  next();
});
for (const mode of ['register', 'login']) app.post('/api/' + mode, async (req, res) => {
  try {
    const { nick, password } = req.body || {};
    if (!consumeAttempt('ip:' + req.ip, 40)) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    if (typeof nick !== 'string' || !/^[\p{L}\p{N}_ -]{2,20}$/u.test(nick.trim()) ||
      typeof password !== 'string' || password.length < 8 || password.length > 128)
      return res.status(400).json({ error: 'Pseudo : 2 à 20 caractères. Mot de passe : 8 à 128 caractères.' });
    const id = nick.trim().normalize('NFKC').toLocaleLowerCase('fr');
    if (!consumeAttempt('user:' + id, 15)) return res.status(429).json({ error: 'Trop de tentatives sur ce compte. Réessayez dans 15 minutes.' });
    const u = users.get(id);
    if (mode === 'register') {
      const salt = randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, 64)).toString('hex');
      await enqueue(() => {
        if (users.has(id)) throw Object.assign(Error('Ce pseudo est déjà pris. Connectez-vous.'), { status: 409 });
        users.set(id, { nick: nick.trim(), salt, hash, wallet: 1000, granted: 1000, lastAidAt: 0, socket: null });
      });
    } else {
      const hash = await scrypt(password, u ? u.salt : '00000000000000000000000000000000', 64);
      await enqueue(() => {
        const current = users.get(id);
        if (!current || !u || current.hash !== u.hash || !timingSafeEqual(hash, Buffer.from(current.hash, 'hex')))
          throw Object.assign(Error('Pseudo ou mot de passe incorrect.'), { status: 401 });
        if (current.socket && io.sockets.sockets.has(current.socket))
          throw Object.assign(Error('Ce compte est déjà connecté. Fermez son autre session.'), { status: 409 });
      });
    }
    if (res.destroyed) return;
    createSession(req, res, id);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Échec de l’authentification ou de la sauvegarde :', error.code || error.name);
    res.status(503).json({ error: STORAGE_MESSAGE });
  }
});
app.get('/api/session', (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: 'Connectez-vous.' });
  res.json({ ok: true, nick: users.get(s.id).nick });
});
app.post('/api/logout', async (req, res) => {
  const s = sessionFor(req);
  if (s) {
    sessions.delete(s.token);
    const socket = io.sockets.sockets.get(users.get(s.id).socket);
    if (socket?.data.session === s.token) socket.disconnect(true);
  }
  await mutationQueue;
  res.clearCookie('river_session', { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
  res.json({ ok: true });
});
app.use((err, req, res, next) => res.status(400).json({ error: 'Requête invalide.' }));
io.use((socket, next) => {
  enqueue(() => {
    const session = sessionFor(socket.request);
    if (!session) throw Error('Connexion requise.');
    const u = users.get(session.id);
    if (u.socket && io.sockets.sockets.has(u.socket)) throw Error('Ce compte est déjà connecté dans une autre fenêtre.');
    socket.data.uid = session.id; socket.data.session = session.token; u.socket = socket.id;
  }, false).then(() => next(), () => next(Error(storageUnavailable ? STORAGE_MESSAGE : 'Connexion refusée : session invalide ou déjà utilisée.')));
});
function pay(p, amount) {
  amount = Math.min(p.stack, amount);
  p.stack -= amount; p.bet += amount; p.total += amount;
}
function nextAfter(id, predicate) {
  const ps = table.players, start = ps.findIndex(p => p.id === id);
  for (let n = 1; n <= ps.length; n++) {
    const p = ps[(start + n + ps.length) % ps.length];
    if (predicate(p)) return p;
  }
}
function mayRaise(p) {
  return !table.acted.has(p.id) || table.currentBet - table.acted.get(p.id) >= table.minRaise;
}
function stateFor(id) {
  const u = users.get(id), p = seat(id);
  return { me: id, nick: u.nick, wallet: u.wallet, buyIn: BUY_IN,
    bankroll: bankroll(id), profit: bankroll(id) - u.granted, aid: aidStatus(id),
    phase: table.phase, board: table.board, hand: table.hand, turn: table.turn, logs: table.logs,
    deadline: table.deadline, currentBet: table.currentBet, minRaise: table.minRaise,
    pot: table.players.reduce((n, q) => n + q.total, 0), result: table.result,
    canRaise: !!p && mayRaise(p),
    players: table.players.map(q => ({ id: q.id, nick: q.nick, stack: q.stack,
      bet: q.bet, folded: q.folded, leaving: q.leaving, dealer: q.id === table.dealer,
      cards: q.id === id || (table.reveal && !q.folded) ? q.hole : q.hole.map(() => '??') })) };
}
function broadcast() {
  if (inMutation || storageUnavailable) return;
  for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('state', stateFor(s.data.uid));
}
function cleanup() {
  table.players = table.players.filter(p => {
    if (!p.leaving && p.stack > 0 && users.get(p.id).socket) return true;
    users.get(p.id).wallet += p.stack;
    if (p.stack > 0) addLog(`récupère ses ${p.stack} jetons en quittant la table.`, p);
    else addLog('n’a plus de jetons à table.', p);
    return false;
  });
}

// Évaluation exacte des 21 combinaisons de cinq cartes parmi sept, roue comprise.
const labels = ['carte haute', 'paire', 'double paire', 'brelan', 'quinte',
  'couleur', 'full', 'carré', 'quinte flush'];
function five(cards) {
  const ranks = cards.map(c => '23456789TJQKA'.indexOf(c[0]) + 2).sort((a, b) => b - a);
  const groups = [...new Set(ranks)].map(r => [r, ranks.filter(x => x === r).length])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const unique = [...new Set(ranks)];
  const flush = cards.every(c => c[1] === cards[0][1]);
  const straight = unique.length === 5 && (unique[0] - unique[4] === 4 ? unique[0]
    : unique.join(',') === '14,5,4,3,2' ? 5 : 0);
  let category, kick;
  if (flush && straight) [category, kick] = [8, [straight]];
  else if (groups[0][1] === 4) [category, kick] = [7, groups.map(g => g[0])];
  else if (groups[0][1] === 3 && groups[1][1] === 2) [category, kick] = [6, groups.map(g => g[0])];
  else if (flush) [category, kick] = [5, ranks];
  else if (straight) [category, kick] = [4, [straight]];
  else if (groups[0][1] === 3) [category, kick] = [3, groups.map(g => g[0])];
  else if (groups[0][1] === 2 && groups[1][1] === 2) [category, kick] = [2, groups.map(g => g[0])];
  else if (groups[0][1] === 2) [category, kick] = [1, groups.map(g => g[0])];
  else [category, kick] = [0, ranks];
  return [category, ...Array.from({ length: 5 }, (_, i) => kick[i] || 0)]
    .reduce((n, x) => n * 15 + x, 0);
}
function best(cards) {
  let score = -1;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++)
            score = Math.max(score, five([cards[a], cards[b], cards[c], cards[d], cards[e]]));
  return score;
}
function finish() {
  clearTimeout(timer); table.turn = null; table.deadline = 0;
  const ps = table.players, remaining = live(), gains = new Map(), refunds = new Map();
  table.reveal = remaining.length > 1;
  const scores = new Map(remaining.map(p => [p.id, table.reveal ? best([...p.hole, ...table.board]) : 0]));
  // Chaque niveau de contribution constitue un pot distinct ; les excédents sont rendus.
  let previous = 0;
  for (const level of [...new Set(ps.map(p => p.total).filter(Boolean))].sort((a, b) => a - b)) {
    const contributors = ps.filter(p => p.total >= level);
    const eligible = contributors.filter(p => !p.folded);
    const slice = level - previous, amount = slice * contributors.length;
    previous = level;
    if (!eligible.length || contributors.length === 1) {
      for (const p of contributors) {
        p.stack += slice; refunds.set(p.id, (refunds.get(p.id) || 0) + slice);
      }
      continue;
    }
    const high = Math.max(...eligible.map(p => scores.get(p.id)));
    const winners = eligible.filter(p => scores.get(p.id) === high);
    // En cas de partage, le jeton impair revient au premier gagnant à gauche du bouton.
    const dealerIndex = ps.findIndex(p => p.id === table.dealer);
    winners.sort((a, b) => ((ps.indexOf(a) - dealerIndex - 1 + ps.length) % ps.length)
      - ((ps.indexOf(b) - dealerIndex - 1 + ps.length) % ps.length));
    winners.forEach((p, i) => {
      const gain = Math.floor(amount / winners.length) + (i < amount % winners.length ? 1 : 0);
      p.stack += gain; gains.set(p.id, (gains.get(p.id) || 0) + gain);
    });
  }
  table.result = gains.size ? [...gains].map(([id, gain]) => `${users.get(id).nick} gagne ${gain} jetons${
    table.reveal ? ` (${labels[Math.floor(scores.get(id) / 15 ** 5)]})` : ''}`).join(' · ')
    : 'Main terminée : mises remboursées.';
  for (const [id, amount] of refunds) addLog(`récupère ${amount} jetons remboursés.`, users.get(id));
  for (const [id, amount] of gains) addLog(`remporte ${amount} jetons${
    table.reveal ? ` avec ${labels[Math.floor(scores.get(id) / 15 ** 5)]}` : ''}.`, users.get(id));
  if (!gains.size) addLog('Main terminée : les mises ont été remboursées.');
  ps.forEach(p => { p.bet = 0; p.total = 0; });
  table.phase = 'showdown'; table.endedAt = Date.now(); broadcast();
  // Préserver les cartes du résultat jusqu'au prochain départ, rendre immédiatement les jetons sortants.
  cleanup(); broadcast();
}
function setTurn(p) {
  clearTimeout(timer); table.turn = p.id; table.deadline = Date.now() + TURN_MS; turnChanged = true;
}
function scheduleTurn() {
  clearTimeout(timer);
  if (!table.turn || !active() || storageUnavailable) return;
  const id = table.turn, deadline = table.deadline;
  timer = setTimeout(() => {
    enqueue(() => {
      if (table.turn === id && table.deadline === deadline && active()) {
        const p = seat(id); act(p, { type: p.bet === table.currentBet ? 'call' : 'fold' }, true);
      }
    }).catch(() => {});
  }, Math.max(0, deadline - Date.now()));
}
function advance(after) {
  if (live().length <= 1) return finish();
  const able = table.players.filter(canAct);
  for (const id of table.pending) if (!able.some(p => p.id === id)) table.pending.delete(id);
  if (able.length <= 1 && able.every(p => p.bet >= table.currentBet)) table.pending.clear();
  const next = nextAfter(after, p => table.pending.has(p.id));
  if (next) return setTurn(next);
  if (table.phase === 'river') return finish();
  table.phase = { preflop: 'flop', flop: 'turn', turn: 'river' }[table.phase];
  table.deck.pop(); // Carte brûlée.
  const dealt = Array.from({ length: table.phase === 'flop' ? 3 : 1 }, () => table.deck.pop());
  table.board.push(...dealt);
  addLog(`${{ flop: 'Flop', turn: 'Turn', river: 'River' }[table.phase]} : ${dealt.map(c =>
    (c[0] === 'T' ? '10' : c[0]) + ({ s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]])).join(' ')}.`);
  table.players.forEach(p => { p.bet = 0; });
  table.currentBet = 0; table.minRaise = BIG; table.acted.clear();
  table.pending = new Set(able.map(p => p.id));
  advance(table.dealer);
}
function start() {
  if (active()) throw Error('Une main est déjà en cours.');
  if (Date.now() - table.endedAt < 4000) throw Error('Patientez quatre secondes entre deux mains.');
  cleanup();
  const ps = table.players;
  if (ps.length < 2) throw Error('Deux joueurs minimum sont nécessaires.');
  clearTimeout(timer);
  const dealer = nextAfter(table.dealer, () => true);
  table.dealer = dealer.id; table.hand++; table.phase = 'preflop'; table.board = [];
  table.result = `Main ${table.hand} — petites / grosses blindes : ${SMALL} / ${BIG} jetons.`;
  addLog(`Main ${table.hand} : distribution. ${dealer.nick} est au bouton.`);
  table.reveal = false; table.currentBet = BIG; table.minRaise = BIG; table.acted.clear();
  table.deck = [...'23456789TJQKA'].flatMap(r => [...'shdc'].map(s => r + s));
  for (let i = table.deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [table.deck[i], table.deck[j]] = [table.deck[j], table.deck[i]];
  }
  ps.forEach(p => { p.hole = []; p.folded = false; p.bet = 0; p.total = 0; });
  for (let n = 0; n < 2; n++) ps.forEach(p => p.hole.push(table.deck.pop()));
  const sb = ps.length === 2 ? dealer : nextAfter(dealer.id, () => true);
  const bb = nextAfter(sb.id, () => true);
  pay(sb, SMALL); pay(bb, BIG);
  addLog(`pose la petite blinde : ${sb.bet} jetons${sb.stack === 0 ? ' (tapis)' : ''}.`, sb);
  addLog(`pose la grosse blinde : ${bb.bet} jetons${bb.stack === 0 ? ' (tapis)' : ''}.`, bb);
  table.pending = new Set(ps.filter(canAct).map(p => p.id));
  advance(bb.id);
}
function act(p, { type, amount }, automatic = false) {
  if (!active() || table.turn !== p.id || !canAct(p)) throw Error("Ce n'est pas votre tour.");
  if (!['fold', 'call', 'raise'].includes(type)) throw Error('Action inconnue.');
  const timeout = automatic ? ' (délai écoulé)' : '';
  if (type === 'fold') { p.folded = true; addLog(`se couche${timeout}.`, p); }
  if (type === 'call') {
    const paid = Math.min(p.stack, Math.max(0, table.currentBet - p.bet));
    pay(p, paid);
    addLog(paid === 0 ? `check${timeout}.` : p.stack === 0
      ? `fait tapis : ${p.bet} jetons au total (suit ${paid} jetons).`
      : `suit de ${paid} jetons.`, p);
  }
  if (type === 'raise') {
    const maximum = p.bet + p.stack;
    if (!Number.isSafeInteger(amount) || amount <= table.currentBet || amount > maximum
      || (amount < table.currentBet + table.minRaise && amount !== maximum) || !mayRaise(p))
      throw Error('Relance invalide : minimum indiqué, ou votre tapis si inférieur.');
    const increase = amount - table.currentBet, opening = table.currentBet === 0;
    pay(p, amount - p.bet); table.currentBet = amount;
    if (increase >= table.minRaise) {
      table.minRaise = increase;
      table.pending = new Set(table.players.filter(canAct).map(q => q.id));
    } else table.players.filter(q => canAct(q) && q.bet < amount).forEach(q => table.pending.add(q.id));
    addLog(p.stack === 0 ? `fait tapis : ${amount} jetons au total.`
      : opening ? `mise ${amount} jetons.` : `relance à ${amount} jetons.`, p);
  }
  table.acted.set(p.id, table.currentBet); table.pending.delete(p.id); advance(p.id);
}
function leave(id, disconnected = false) {
  const p = seat(id);
  if (!p || p.leaving) return;
  p.leaving = true;
  addLog(disconnected ? 'se déconnecte.' : 'quitte la table.', p);
  if (active()) {
    // Un tapis reste éligible aux pots, même après une déconnexion.
    if (p.stack > 0 && !p.folded) { p.folded = true; addLog('se couche en quittant la main.', p); }
    else if (!p.folded) addLog('reste en jeu à tapis jusqu’au résultat.', p);
    table.pending.delete(id);
    if (live().length <= 1) finish();
    else if (table.turn === id) advance(id);
  } else cleanup();
}
io.on('connection', socket => {
  let windowStart = Date.now(), events = 0;
  const on = (event, handler) => socket.on(event, async (data, ack) => {
    if (Date.now() - windowStart > 1000) { windowStart = Date.now(); events = 0; }
    try {
      if (++events > 20) throw Error('Trop de requêtes, patientez.');
      await enqueue(() => {
        if (!socket.data.uid || !socket.connected) throw Error('Connectez-vous.');
        const session = sessions.get(socket.data.session);
        if (!session || session.expires <= Date.now()) {
          socket.emit('session-expired'); socket.disconnect(true); throw Error('Session expirée.');
        }
        handler(data && typeof data === 'object' ? data : {});
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) { if (typeof ack === 'function') ack({ error: e.message }); }
  });
  enqueue(() => {}, false).catch(() => socket.emit('storage-error', { message: STORAGE_MESSAGE }));
  on('claim-aid', () => {
    const id = socket.data.uid, u = users.get(id);
    if (!aidStatus(id).eligible) throw Error(`Seconde chance : hors table, sous ${BUY_IN} jetons, une fois toutes les 24 h.`);
    u.wallet += 500; u.granted += 500; u.lastAidAt = Date.now();
  });
  on('join', () => {
    const id = socket.data.uid, u = users.get(id);
    if (active()) throw Error('Attendez la fin de la main pour rejoindre.');
    if (seat(id)) throw Error('Vous êtes déjà à table.');
    if (table.players.length >= 6) throw Error('Table complète (6 joueurs).');
    if (u.wallet < BUY_IN) throw Error(`Il faut ${BUY_IN} jetons pour rejoindre. Consultez votre seconde chance.`);
    u.wallet -= BUY_IN;
    table.players.push({ id, nick: u.nick, stack: BUY_IN, bet: 0, total: 0, hole: [], folded: false, leaving: false });
    addLog(`rejoint la table avec ${BUY_IN} jetons.`, u);
  });
  on('leave', () => leave(socket.data.uid));
  on('start', () => { if (!seat(socket.data.uid) || seat(socket.data.uid).leaving) throw Error('Rejoignez la table.'); start(); });
  on('action', data => { const p = seat(socket.data.uid); if (!p) throw Error('Rejoignez la table.'); act(p, data); });
  socket.on('disconnect', () => {
    const id = socket.data.uid;
    if (!id) return;
    enqueue(() => {
      if (users.get(id).socket === socket.id) users.get(id).socket = null;
      leave(id, true);
    }).catch(() => {});
  });
});
const ready = initializeStorage().catch(error => { storageFailed(error); throw Error(STORAGE_MESSAGE); });
ready.catch(() => {});
if (require.main === module) server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {
  console.log(`Poker fictif sur le port ${server.address().port}. Vérifiez /health avant de jouer.`);
});
module.exports = { server, io, table, users, five, best, ready,
  closeStorage: () => pool ? pool.end() : Promise.resolve() };
