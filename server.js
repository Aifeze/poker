// server.js — node server.js (Node >= 18). Dépendances installées au premier lancement.
// Prototype : argent fictif, comptes par pseudo sans mot de passe, stockage en mémoire.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomInt } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const runtime = process.env.POKER_RUNTIME_DIR || path.join(os.tmpdir(), `poker-runtime-${os.userInfo().username}`);
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const load = createRequire(path.join(runtime, 'package.json'));
try { load.resolve('express'); load.resolve('socket.io'); }
catch {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'install', '--prefix', runtime, '--no-save', '--package-lock=false', '--no-audit', '--no-fund',
    '--fetch-retries=1', '--fetch-timeout=20000',
    'express@5.1.0', 'socket.io@4.8.1'
  ], { stdio: 'inherit' });
  if (r.error || r.status !== 0) { console.error('Installation impossible.', r.error || ''); process.exit(1); }
}
const app = load('express')();
const server = http.createServer(app);
const io = new (load('socket.io').Server)(server, { maxHttpBufferSize: 8192 });
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.json({ ok: true }));

const BUY_IN = 500, SMALL = 5, BIG = 10, TURN_MS = 30000;
const users = new Map();
const table = { players: [], phase: 'waiting', board: [], deck: [], dealer: null,
  turn: null, currentBet: 0, minRaise: BIG, pending: new Set(), acted: new Map(),
  hand: 0, result: 'Bienvenue à la table.', deadline: 0, endedAt: 0, reveal: false };
let timer;
const active = () => !['waiting', 'showdown'].includes(table.phase);
const live = () => table.players.filter(p => !p.folded);
const canAct = p => !p.folded && p.stack > 0 && !p.leaving;
const seat = id => table.players.find(p => p.id === id);
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
    phase: table.phase, board: table.board, hand: table.hand, turn: table.turn,
    deadline: table.deadline, currentBet: table.currentBet, minRaise: table.minRaise,
    pot: table.players.reduce((n, q) => n + q.total, 0), result: table.result,
    canRaise: !!p && mayRaise(p),
    players: table.players.map(q => ({ id: q.id, nick: q.nick, stack: q.stack,
      bet: q.bet, folded: q.folded, leaving: q.leaving, dealer: q.id === table.dealer,
      cards: q.id === id || (table.reveal && !q.folded) ? q.hole : q.hole.map(() => '??') })) };
}
function broadcast() {
  for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('state', stateFor(s.data.uid));
}
function cleanup() {
  table.players = table.players.filter(p => {
    if (!p.leaving && p.stack > 0 && users.get(p.id).socket) return true;
    users.get(p.id).wallet += p.stack;
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
  const ps = table.players, remaining = live(), gains = new Map();
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
      for (const p of contributors) p.stack += slice;
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
  table.result = gains.size ? [...gains].map(([id, gain]) => `${users.get(id).nick} gagne ${gain} $${
    table.reveal ? ` (${labels[Math.floor(scores.get(id) / 15 ** 5)]})` : ''}`).join(' · ')
    : 'Main terminée : mises remboursées.';
  ps.forEach(p => { p.bet = 0; p.total = 0; });
  table.phase = 'showdown'; table.endedAt = Date.now(); broadcast();
  // Préserver les cartes du résultat jusqu'au prochain départ, rendre immédiatement les jetons sortants.
  cleanup(); broadcast();
}
function setTurn(p) {
  clearTimeout(timer); table.turn = p.id; table.deadline = Date.now() + TURN_MS;
  timer = setTimeout(() => {
    if (table.turn === p.id && active()) {
      act(p, { type: p.bet === table.currentBet ? 'call' : 'fold' }); broadcast();
    }
  }, TURN_MS);
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
  table.board.push(...Array.from({ length: table.phase === 'flop' ? 3 : 1 }, () => table.deck.pop()));
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
  table.result = `Main ${table.hand} — petites / grosses blindes : ${SMALL} / ${BIG} $.`;
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
  table.pending = new Set(ps.filter(canAct).map(p => p.id));
  advance(bb.id);
}
function act(p, { type, amount }) {
  if (!active() || table.turn !== p.id || !canAct(p)) throw Error("Ce n'est pas votre tour.");
  if (!['fold', 'call', 'raise'].includes(type)) throw Error('Action inconnue.');
  if (type === 'fold') p.folded = true;
  if (type === 'call') pay(p, Math.max(0, table.currentBet - p.bet));
  if (type === 'raise') {
    const maximum = p.bet + p.stack;
    if (!Number.isSafeInteger(amount) || amount <= table.currentBet || amount > maximum
      || (amount < table.currentBet + table.minRaise && amount !== maximum) || !mayRaise(p))
      throw Error('Relance invalide : minimum indiqué, ou votre tapis si inférieur.');
    const increase = amount - table.currentBet;
    pay(p, amount - p.bet); table.currentBet = amount;
    if (increase >= table.minRaise) {
      table.minRaise = increase;
      table.pending = new Set(table.players.filter(canAct).map(q => q.id));
    } else table.players.filter(q => canAct(q) && q.bet < amount).forEach(q => table.pending.add(q.id));
  }
  table.acted.set(p.id, table.currentBet); table.pending.delete(p.id); advance(p.id);
}
function leave(id) {
  const p = seat(id);
  if (!p || p.leaving) return;
  p.leaving = true;
  if (active()) {
    // Un tapis reste éligible aux pots, même après une déconnexion.
    if (p.stack > 0) p.folded = true;
    table.pending.delete(id);
    if (live().length <= 1) finish();
    else if (table.turn === id) advance(id);
  } else cleanup();
}
io.on('connection', socket => {
  let windowStart = Date.now(), events = 0;
  const on = (event, handler, authenticated = true) => socket.on(event, (data, ack) => {
    if (Date.now() - windowStart > 1000) { windowStart = Date.now(); events = 0; }
    try {
      if (++events > 20) throw Error('Trop de requêtes, patientez.');
      if (authenticated && !socket.data.uid) throw Error('Connectez-vous.');
      handler(data && typeof data === 'object' ? data : {});
      broadcast(); if (typeof ack === 'function') ack({ ok: true });
    } catch (e) { if (typeof ack === 'function') ack({ error: e.message }); }
  });
  on('login', ({ nick }) => {
    if (socket.data.uid) throw Error('Déjà connecté.');
    if (typeof nick !== 'string' || !/^[\p{L}\p{N}_ -]{2,20}$/u.test(nick.trim()))
      throw Error('Pseudo : 2 à 20 lettres, chiffres, espaces, tirets ou _.');
    nick = nick.trim(); const id = nick.normalize('NFKC').toLocaleLowerCase('fr');
    let u = users.get(id);
    if (u?.socket) throw Error('Ce pseudo est déjà connecté.');
    if (!u) { u = { nick, wallet: 1000, socket: null }; users.set(id, u); }
    u.socket = socket.id; socket.data.uid = id;
  }, false);
  on('recharge', () => { users.get(socket.data.uid).wallet += 500; });
  on('join', () => {
    const id = socket.data.uid, u = users.get(id);
    if (active()) throw Error('Attendez la fin de la main pour rejoindre.');
    if (seat(id)) throw Error('Vous êtes déjà à table.');
    if (table.players.length >= 6) throw Error('Table complète (6 joueurs).');
    if (u.wallet < BUY_IN) throw Error('Solde insuffisant. Utilisez Recharger.');
    u.wallet -= BUY_IN;
    table.players.push({ id, nick: u.nick, stack: BUY_IN, bet: 0, total: 0, hole: [], folded: false, leaving: false });
  });
  on('leave', () => leave(socket.data.uid));
  on('start', () => { if (!seat(socket.data.uid) || seat(socket.data.uid).leaving) throw Error('Rejoignez la table.'); start(); });
  on('action', data => { const p = seat(socket.data.uid); if (!p) throw Error('Rejoignez la table.'); act(p, data); });
  socket.on('disconnect', () => {
    const id = socket.data.uid;
    if (!id) return;
    users.get(id).socket = null; leave(id); broadcast();
  });
});
if (require.main === module) server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {
  console.log(`Poker fictif démarré sur le port ${server.address().port}. Ouvrez deux navigateurs avec deux pseudos.`);
});
module.exports = { server, io, table, users, five, best };
