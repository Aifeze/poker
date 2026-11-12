// server.js — node server.js (Node >= 18). Dépendances installées au premier lancement.
// Render : définir DATABASE_URL (PostgreSQL). Hors Render : fichier local dans POKER_DATA_DIR.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomInt, randomBytes, createHash, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
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
app.use(load('express').json({ limit: '64kb' }));
app.use((error, req, res, next) => error?.type === 'entity.too.large'
  ? res.status(413).json({ error:'Photo trop volumineuse. Importez-la avec le sélecteur de photo.' }) : error instanceof SyntaxError
    ? res.status(400).json({ error:'Requête invalide.' }) : next(error));
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
app.get(['/', '/historique', '/parametres', '/boutique', '/quetes'], (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.status(storageReady && !storageUnavailable ? 200 : 503)
  .json({ ok: storageReady && !storageUnavailable }));

const ENTRY_THRESHOLD = 500, AID_THRESHOLD = 500, SMALL = 5, BIG = 10, TURN_MS = 30000, DAY = 86400000;
const RUNOUT_FIRST_MS = 1600, RUNOUT_STREET_MS = 1800, RUNOUT_RESULT_MS = 2200;
const RECONNECT_MS = 30000, HISTORY_LIMIT = 20;
const AVATARS = ['nova', 'atlas', 'luna', 'rio', 'jade', 'oscar'];
const CURRENCY = "A' Coins", QUEST_SWAP_MS = 10 * 60000;
const SHOP_GROUPS = [
  {id:'back',name:'Dos de cartes',icon:'▱'}, {id:'victory',name:'Victoires',icon:'✦'},
  {id:'bet',name:'Mises',icon:'◉'}, {id:'arrival',name:'Arrivées',icon:'→'},
  {id:'frame',name:'Cadres',icon:'◎'}, {id:'table',name:'Tapis de table',icon:'♠'}, {id:'emote',name:'Émotes',icon:'☺'}
];
// The catalog is authoritative: the browser never supplies a price or a coin reward.
const CATALOG = Object.entries({
  back:[
    ['classic','Signature noir & or',0,'weave','♠','#191917','#d5b76e'],
    ['azure','Satin azur',80,'diamond','◆','#132f48','#8ccfea'],
    ['emerald','Émeraude',100,'rings','♣','#12392e','#88deb5'],
    ['crimson','Rouge impérial',120,'weave','♥','#4b1825','#eda7a1'],
    ['midnight','Minuit',140,'stars','☾','#171b38','#bfc5f2'],
    ['honey','Or alvéolé',220,'hex','⬡','#4a3512','#f2d080'],
    ['circuit','Circuit vivant',260,'circuit','⌁','#092c33','#70edf0'],
    ['cosmos','Constellation',340,'stars','✧','#281844','#dcb3ff'],
    ['sakura','Jardin de nuit',280,'petals','❀','#3c2434','#f3b9d2'],
    ['royal','Couronne rubis',480,'royal','♛','#351422','#f3c66e'],
    ['aurora','Aurore boréale',580,'waves','✺','#133536','#adf9df'],
    ['dragon','Sceau du dragon',900,'scales','龍','#271d15','#f4c46e']
  ],
  victory:[
    ['classic','Éclat signature',0,'gold','✦','#e0bd72','#fff1be'],
    ['fireworks','Feu d’artifice',240,'fireworks','✷','#f4b770','#eab1fa'],
    ['blossom','Pluie de sakura',220,'petals','❀','#e8a5c5','#ffe0ee'],
    ['coins','Fortune dorée',320,'coins','◉','#d8ae51','#fff0b4'],
    ['storm','Maître des orages',420,'lightning','ϟ','#8fcff7','#f5edb0'],
    ['ice','Nova de givre',380,'ice','❄','#a6e7f3','#f1ffff'],
    ['galaxy','Naissance d’une étoile',520,'galaxy','✧','#c397f4','#91deff'],
    ['portal','Portail royal',650,'portal','◎','#b792ef','#f2d089'],
    ['phoenix','Renaissance du phénix',850,'phoenix','♨','#f6a15e','#ffdf82'],
    ['dragon','L’éveil du dragon',1200,'dragon','龍','#edbb63','#ff794b']
  ],
  bet:[
    ['classic','Jetons signature',0,'classic','◉','#d5b76e','#fff0c3'],
    ['comet','Comète dorée',160,'comet','☄','#edc26e','#fff3ce'],
    ['electric','Arc électrique',240,'lightning','ϟ','#89d9f2','#ffffff'],
    ['petals','Bluff en fleurs',180,'petals','❀','#e9abc6','#ffe9f2'],
    ['rocket','Propulsion',380,'rocket','↟','#f7a35f','#ffdf96'],
    ['bubbles','Liquidité',220,'bubbles','◌','#8adfd9','#d1fff8'],
    ['glitch','Erreur de calcul',280,'glitch','⌘','#bcadff','#8cf0e7'],
    ['frost','Mise de glace',300,'ice','❄','#b6e8fa','#f1ffff']
  ],
  arrival:[
    ['classic','Une place au club',0,'halo','♠','#d7ba79','#fff0ca'],
    ['wave','Vague d’or',120,'wave','≋','#dfbc67','#fff0b9'],
    ['portal','Entrée dimensionnelle',340,'portal','◎','#ba9bf0','#fae6aa'],
    ['stardust','Poussière d’étoiles',240,'stars','✧','#d6b1f4','#fff4cf'],
    ['bloom','Floraison',200,'petals','❀','#dca8c6','#c0e6bc'],
    ['thunder','Coup de tonnerre',420,'lightning','ϟ','#9bd5fa','#f8e3a4'],
    ['royal','Tapis rouge',300,'carpet','♛','#8e3445','#efd18b'],
    ['vortex','Œil du vortex',650,'vortex','◉','#89dfce','#cdb2fc']
  ],
  frame:[
    ['classic','Liseré signature',0,'classic','◎','#bca779','#ead8aa'],
    ['gold','Or massif',180,'double','◉','#e0bf69','#fff0bb'],
    ['sapphire','Halo saphir',220,'glow','✧','#7bc8f4','#bddfff'],
    ['ember','Cœur de braise',280,'glow','♨','#ee935b','#ffd394'],
    ['aurora','Couronne d’aurore',360,'aurora','≋','#83d7b8','#c3a5f0'],
    ['stellar','Orbite stellaire',440,'orbit','✦','#c6a3ef','#fff1c7'],
    ['carbon','Carbone tressé',300,'carbon','◆','#9faaa8','#e2d5a7'],
    ['dragon','Garde du dragon',800,'dragon','龍','#d4ac5d','#ffbf72']
  ],
  table:[
    ['classic','Carbone & or',0,'felt','♠','#282925','#151714'],
    ['emerald','Velours émeraude',220,'felt','♣','#25634c','#112d24'],
    ['sapphire','Salon saphir',260,'felt','◆','#254363','#141f34'],
    ['burgundy','Bordeaux privé',280,'felt','♥','#61313c','#301a23'],
    ['violet','Nuit améthyste',340,'felt','✧','#48385e','#241e32'],
    ['arctic','Salon arctique',380,'felt','❄','#35545d','#192e34'],
    ['champagne','Velours champagne',480,'felt','♛','#6b5937','#342c1d']
  ],
  emote:[
    ['hi','Salut la table',0,'hello','👋','#d6bb7b','#fff0bc','Salut la table !'],
    ['gg','Belle main',0,'respect','👏','#c5d8bb','#f0f8de','Belle main !'],
    ['bluff','Bluff détecté',0,'wink','🧐','#b6c9e8','#e8edff','Ça sent le bluff…'],
    ['allin','Sans filet',0,'fire','🔥','#efac6d','#ffe3b1','Tapis. Sans filet.'],
    ['coffee','Le café du bluff',50,'wink','☕','#cdac87','#f3dcc1','Ton bluff sent le café.'],
    ['thanks','Merci pour les jetons',70,'cheeky','🪙','#deb96a','#fff0bd','Merci pour les jetons !'],
    ['pokerface','Poker face',60,'cool','😎','#b7c6d5','#e6edf2','Vous ne lirez rien ici.'],
    ['noted','Je prends note',60,'wink','📝','#d6c8aa','#fff3d4','Je prends note…'],
    ['sleep','Réveillez-moi',80,'cheeky','🥱','#c3b6d9','#f0e6ff','Réveillez-moi à la river.'],
    ['luck','Le petit trèfle',70,'respect','🍀','#9bd6ae','#e5ffe9','Un peu de chance ?'],
    ['shark','Alerte requin',120,'cheeky','🦈','#9bcfdf','#e2f6ff','Un requin dans la salle.'],
    ['ice','Sang-froid',100,'cool','🧊','#b3e6f5','#f2ffff','Même pas froid.'],
    ['popcorn','Place au spectacle',100,'cheeky','🍿','#edcc83','#fff0c5','J’attends le spectacle.'],
    ['crown','Le patron',160,'royal','👑','#e6c36d','#fff3c2','Le trône est occupé.'],
    ['dragon','Le dragon se réveille',240,'fire','🐉','#c4d58a','#ffe0a1','Le dragon se réveille.'],
    ['phoenix','Je reviendrai',180,'fire','🦅','#eda77b','#ffdf9b','Je renais de mes cendres.'],
    ['heart','Avec le cœur',90,'respect','🖤','#d9b9c5','#ffe6ed','Avec le cœur. Toujours.'],
    ['rabbit','La river magique',120,'wink','🐇','#dacde9','#fff4ff','Un lapin dans la river ?'],
    ['zen','Zéro pression',100,'cool','🧘','#b3d9bf','#e8fff0','Zéro pression.'],
    ['salute','Respect',80,'respect','🫡','#d8c39d','#fff1ce','Respect. On remet ça ?']
  ]
}).flatMap(([category,rows]) => rows.map(([key,name,price,style,icon,tone,accent,text]) => ({
  id:`${category}-${key}`,category,name,price,style,icon,tone,accent,text,
  rarity:price===0?'starter':price>=800?'legendary':price>=400?'epic':price>=180?'rare':'standard'
})));
const ITEMS = new Map(CATALOG.map(item => [item.id,item]));
const LOADOUT = {back:'back-classic',victory:'victory-classic',bet:'bet-classic',arrival:'arrival-classic',frame:'frame-classic',table:'table-classic'};
const FREE_ITEMS = CATALOG.filter(item=>item.price===0).map(item=>item.id);
const QUESTS = [
  {id:'play',group:'regular',name:'Le rendez-vous',targets:[3,5,8],pay:8,text:n=>`Jouer ${n} mains jusqu’à leur dénouement.`,test:m=>m.played},
  {id:'win',group:'regular',name:'Prendre l’avantage',targets:[1,2,3],pay:35,text:n=>`Remporter ${n} main${n>1?'s':''} avec un gain net de jetons.`,test:m=>m.won},
  {id:'see',group:'regular',name:'Jusqu’au verdict',targets:[2,3,4],pay:18,text:n=>`Atteindre ${n} abattages sans vous coucher.`,test:m=>m.showdown},
  {id:'marathon',group:'regular',name:'Le fauteuil vous va bien',targets:[10,15,20],pay:10,text:n=>`Participer à ${n} mains.`,test:m=>m.played},
  {id:'flops',group:'regular',name:'Le flop, s’il vous plaît',targets:[3,5,8],pay:12,text:n=>`Voir le flop dans ${n} mains.`,test:m=>m.streets>=1},
  {id:'rivers',group:'regular',name:'Au bout de la rivière',targets:[2,3,5],pay:20,text:n=>`Voir la river dans ${n} mains.`,test:m=>m.streets>=3},
  {id:'invest',group:'regular',name:'Mettre du cœur au jeu',targets:[3,5],pay:20,text:n=>`Engager au moins 50 jetons dans ${n} mains.`,test:m=>m.invested>=50},
  {id:'brave',group:'regular',name:'L’habitude du grand saut',targets:[2,3],pay:35,text:n=>`Faire tapis dans ${n} mains.`,test:m=>m.allin},
  {id:'streak',group:'regular',name:'Trois à la suite',targets:[1],pay:180,text:()=>"Enchaîner trois mains bénéficiaires.",test:m=>m.streak>0&&m.streak%3===0},
  ...[
    ['pair','Une bonne paire',1,50],['two','Deux font la paire',2,80],['trips','Jamais deux sans trois',3,100],
    ['straight','Tout est lié',4,120],['flush','Même famille',5,120],['full','Maison pleine',6,160],['quads','Carré privé',7,300]
  ].map(([id,name,category,pay])=>({id,group:'combo',name,targets:[1],pay,text:()=>`Gagner à l’abattage avec ${['','une paire','deux paires','un brelan','une quinte','une couleur','un full','un carré'][category]}.`,test:m=>m.won&&m.showdown&&m.category===category})),
  {id:'aces',group:'combo',name:'Les As dans la manche',targets:[1],pay:100,text:()=>"Gagner à l’abattage avec une paire d’As.",test:m=>m.won&&m.category===1&&m.rank===14},
  {id:'royal',group:'combo',name:'L’exception royale',targets:[1],pay:450,text:()=>"Gagner à l’abattage avec une quinte flush.",test:m=>m.won&&m.category===8},
  {id:'high',group:'combo',name:'Sans même une paire',targets:[1],pay:85,text:()=>"Gagner à l’abattage avec une carte haute.",test:m=>m.won&&m.category===0},
  {id:'kings',group:'combo',name:'Audience chez le Roi',targets:[1],pay:90,text:()=>"Gagner à l’abattage avec une paire de Rois.",test:m=>m.won&&m.category===1&&m.rank===13},
  {id:'twoaces',group:'combo',name:'Les As bien entourés',targets:[1],pay:135,text:()=>"Gagner avec deux paires dont une paire d’As.",test:m=>m.won&&m.category===2&&m.rank===14},
  {id:'aceflush',group:'combo',name:'La couleur du patron',targets:[1],pay:190,text:()=>"Gagner avec une couleur à l’As.",test:m=>m.won&&m.category===5&&m.rank===14},
  {id:'allin',group:'style',name:'Sans filet',targets:[1],pay:110,text:()=>"Remporter une main après avoir fait tapis.",test:m=>m.won&&m.allin},
  {id:'steal',group:'style',name:'Un regard suffit',targets:[1,2],pay:45,text:n=>`Gagner ${n} main${n>1?'s':''} en faisant coucher tous les autres joueurs.`,test:m=>m.won&&!m.reveal},
  {id:'show',group:'style',name:'Cartes sur table',targets:[1,2],pay:45,text:n=>`Gagner ${n} abattage${n>1?'s':''}.`,test:m=>m.won&&m.showdown},
  {id:'big',group:'style',name:'Gros morceau',targets:[1],pay:95,text:()=>"Remporter au moins 500 jetons dans une main bénéficiaire.",test:m=>m.won&&m.received>=500},
  {id:'short',group:'style',name:'Petit tapis, grand cœur',targets:[1],pay:100,text:()=>"Gagner une main commencée avec 250 jetons ou moins.",test:m=>m.won&&m.start<=250},
  {id:'button',group:'style',name:'Le dernier mot',targets:[1,2],pay:45,text:n=>`Remporter ${n} main${n>1?'s':''} au bouton du donneur.`,test:m=>m.won&&m.dealer},
  {id:'crowd',group:'style',name:'Grande tablée',targets:[1],pay:100,text:()=>"Gagner une main commencée à quatre joueurs ou plus.",test:m=>m.won&&m.players>=4},
  {id:'signature',group:'style',name:'En main propre',targets:[1],pay:100,text:()=>"Gagner à l’abattage en utilisant vos deux cartes privées.",test:m=>m.won&&m.both},
  {id:'early',group:'style',name:'Avant le flop',targets:[1,2],pay:45,text:n=>`Remporter ${n} main${n>1?'s':''} avant le flop.`,test:m=>m.won&&m.board===0},
  {id:'heads',group:'style',name:'Duel au sommet',targets:[1,2],pay:55,text:n=>`Remporter ${n} main${n>1?'s':''} jouée${n>1?'s':''} à deux.`,test:m=>m.won&&m.players===2},
  {id:'patient',group:'style',name:'Victoire en douceur',targets:[1,2],pay:45,text:n=>`Gagner ${n} abattage${n>1?'s':''} sans avoir fait tapis.`,test:m=>m.won&&m.showdown&&!m.allin},
  {id:'deep',group:'style',name:'Les grandes profondeurs',targets:[1],pay:130,text:()=>"Gagner une main commencée avec au moins 1 000 jetons à table.",test:m=>m.won&&m.start>=1000},
  {id:'profit',group:'style',name:'Une belle récolte',targets:[1],pay:150,text:()=>"Terminer une main avec au moins 500 jetons de bénéfice net.",test:m=>m.won&&m.net>=500},
  {id:'acehand',group:'style',name:'L’As personnel',targets:[1],pay:80,text:()=>"Gagner à l’abattage en utilisant un As de votre main.",test:m=>m.won&&m.aceUsed}
];
function makeQuest(group,exclude=[]) {
  const choices=QUESTS.filter(q=>q.group===group&&!exclude.includes(q.id)), task=choices[randomInt(choices.length)];
  return {id:randomBytes(12).toString('hex'),task:task.id,target:task.targets[randomInt(task.targets.length)],progress:0};
}
function newClub() {
  const quests=[];
  for(const group of ['regular','combo','style'])for(let i=0;i<4;i++)quests.push(makeQuest(group,[...quests.map(q=>q.task),...(group==='combo'?['quads','royal']:[])]));
  return {version:1,revision:0,coins:120,owned:[...FREE_ITEMS],equipped:{...LOADOUT,emotes:['emote-hi','emote-gg','emote-bluff','emote-allin']},
    quests,nextSwapAt:0,lastHand:'',stats:{hands:0,wins:0,quests:0,earned:120,streak:0},
    feed:[{id:randomBytes(12).toString('hex'),kind:'welcome',amount:120,title:'Bienvenue dans All-In Room',time:Date.now()}]};
}
function validClub(c) {
  const integer=n=>Number.isSafeInteger(n)&&n>=0;
  if (!c||c.version!==1||!integer(c.revision)||!integer(c.coins)||!Array.isArray(c.owned)||new Set(c.owned).size!==c.owned.length||c.owned.some(id=>!ITEMS.has(id))
    ||!c.equipped||Object.keys(LOADOUT).some(key=>!c.owned.includes(c.equipped[key])||ITEMS.get(c.equipped[key])?.category!==key)
    ||!Array.isArray(c.equipped.emotes)||c.equipped.emotes.length>8||new Set(c.equipped.emotes).size!==c.equipped.emotes.length
    ||c.equipped.emotes.some(id=>!c.owned.includes(id)||ITEMS.get(id)?.category!=='emote')||!integer(c.nextSwapAt)
    ||typeof c.lastHand!=='string'||c.lastHand.length>64||!c.stats||['hands','wins','quests','earned','streak'].some(key=>!integer(c.stats[key]))
    ||!Array.isArray(c.feed)||c.feed.length>12||c.feed.some(e=>!e||typeof e.id!=='string'||typeof e.title!=='string'||e.title.length>200||!Number.isSafeInteger(e.amount)||!integer(e.time))
    ||!Array.isArray(c.quests)||c.quests.length!==12||new Set(c.quests.map(q=>q?.task)).size!==12) return false;
  return c.quests.every((q,i)=>{const task=QUESTS.find(t=>t.id===q?.task);return task?.group===['regular','combo','style'][Math.floor(i/4)]&&/^[a-f0-9]{24}$/.test(q.id)&&task.targets.includes(q.target)&&integer(q.progress)&&q.progress<q.target;});
}
function clubState(id) {
  const c=users.get(id).club;
  return {...c,quests:c.quests.map(q=>{const t=QUESTS.find(t=>t.id===q.task),reward=t.pay*q.target;return {...q,name:t.name,description:t.text(q.target),reward,group:t.group,difficulty:reward>=200?'Prestige':reward>=120?'Expert':reward>=70?'Avancé':'Accessible'};})};
}
function publicCosmetics(id) { const {emotes,...loadout}=users.get(id).club.equipped;return loadout; }
function coinEntry(c,amount,title,kind) {
  if (!Number.isSafeInteger(c.coins+amount)||c.coins+amount<0) throw Error('Solde de coins invalide.');
  c.coins+=amount;c.revision++;if(amount>0)c.stats.earned+=amount;
  c.feed.unshift({id:randomBytes(12).toString('hex'),amount,title,kind,time:Date.now()});c.feed.length=Math.min(c.feed.length,12);
}
function rewardHand(id,m,handId) {
  const c=users.get(id).club;if(c.lastHand===handId)return 0;c.lastHand=handId;c.stats.hands++;
  c.stats.streak=m.won?c.stats.streak+1:0;m.streak=c.stats.streak;
  let reward=0;
  if(m.won){c.stats.wins++;reward=20+(m.showdown?5:0)+(m.allin?10:0);coinEntry(c,reward,`Victoire${m.allin?' au tapis':m.showdown?' à l’abattage':''}`,'win');}
  for(let i=0;i<c.quests.length;i++){const q=c.quests[i],task=QUESTS.find(t=>t.id===q.task);if(!task.test(m))continue;q.progress++;
    if(q.progress<q.target)continue;const amount=task.pay*q.target;c.stats.quests++;coinEntry(c,amount,task.name,'quest');
    c.quests[i]=makeQuest(task.group,c.quests.map(q=>q.task));}
  c.revision++;
  return reward;
}
const MAX_PHOTO_BYTES = 32768;
function photoBuffer(value) {
  if (typeof value !== 'string' || value.length > 44000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const data = Buffer.from(value.slice(23),'base64');
  if (data.length < 12 || data.length > MAX_PHOTO_BYTES || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length-2) !== 0xffd9) return null;
  for (let offset = 2; offset + 4 < data.length;) {
    if (data[offset++] !== 255) return null;
    while (data[offset] === 255) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (length < 8) return null;
      const height = data.readUInt16BE(offset+3), width = data.readUInt16BE(offset+5);
      return width > 0 && height > 0 && width <= 256 && height <= 256 ? data : null;
    }
    offset += length;
  }
  return null;
}
function photoUrl(id,u = users.get(id)) {
  return u.photo ? `/api/avatars/${encodeURIComponent(id)}/${createHash('sha256').update(u.photo).digest('hex').slice(0,20)}` : null;
}
function profileFor(id) { const u = users.get(id); return {nick:u.nick,avatar:u.avatar,photo:photoUrl(id,u)}; }
const nickKey = nick => nick.trim().normalize('NFKC').toLocaleLowerCase('fr');
const validNick = nick => typeof nick === 'string' && /^[\p{L}\p{N}_ -]{2,20}$/u.test(nick.trim());
const accountByNick = key => [...users].find(([, u]) => nickKey(u.nick) === key);
const scrypt = promisify(scryptCallback);
const users = new Map();
const sessions = new Map(), authAttempts = new Map();
const chatMessages = [], chatLimits = new Map(), emoteTimes = new Map();
const reconnectTimers = new Map();
let handHistory = [];
let chatSequence = 0;
const postgres = !!process.env.DATABASE_URL;
const storageOwner = randomBytes(32).toString('hex');
const STORAGE_MESSAGE = 'Le stockage est temporairement indisponible. La partie est suspendue pour protéger vos jetons.';
let pool, dbRevision, storageReady = false, storageUnavailable = false;
let mutationQueue = Promise.resolve(), inMutation = false, turnChanged = false, turnBudget = TURN_MS, runoutDelay = 0;
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
  const ids = new Set(), names = new Set();
  for (const u of saved.users) {
    if (typeof u.id !== 'string' || typeof u.nick !== 'string' ||
      !/^[a-f0-9]{32}$/.test(u.salt) || !/^[a-f0-9]{128}$/.test(u.hash) ||
      !Number.isSafeInteger(u.wallet) || u.wallet < 0 ||
      !Number.isSafeInteger(u.granted) || u.granted < 1000 ||
      !Number.isSafeInteger(u.lastAidAt) || u.lastAidAt < 0 || ids.has(u.id) || names.has(nickKey(u.nick))
      || (u.avatar !== undefined && !AVATARS.includes(u.avatar)) || (u.photo != null && !photoBuffer(u.photo)) || (u.club !== undefined && !validClub(u.club)))
      throw Error('Sauvegarde de comptes invalide.');
    ids.add(u.id); names.add(nickKey(u.nick));
  }
  if (saved.history !== undefined && (!Array.isArray(saved.history) || saved.history.length > HISTORY_LIMIT
    || saved.history.some(h => !h || typeof h.id !== 'string' || !Number.isSafeInteger(h.number)
      || !Array.isArray(h.board) || !Array.isArray(h.players) || !Array.isArray(h.winners) || !Array.isArray(h.logs))))
    throw Error('Historique sauvegardé invalide.');
  return saved;
}
function restoreUsers(saved) {
  let migrated = false;
  for (const u of saved.users) {
    const avatar = u.avatar || AVATARS[randomInt(AVATARS.length)];
    if (!u.avatar || !u.club) migrated = true;
    users.set(u.id, { ...u, avatar, club:u.club || newClub(), socket: null });
  }
  return migrated;
}
function restoreHistory(saved) {
  handHistory = saved.history || [];
  table.hand = handHistory[0]?.number || 0;
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
  let migrated = false;
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
    migrated = restoreUsers(source.saved);
    restoreHistory(source.saved);
  }
  console.log(`[stockage] ${users.size} compte(s) chargé(s) depuis ${dataFile}.`);
  return migrated;
}
async function initializeStorage() {
  if (!postgres) {
    if (process.env.RENDER) throw Object.assign(Error('DATABASE_URL doit être configurée sur Render.'), { code: 'DATABASE_URL_MISSING' });
    const migrated = loadLocalAccounts();
    if (migrated) await persist();
    storageReady = true; return;
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
  await pool.query('ALTER TABLE river_club_private.state ADD COLUMN IF NOT EXISTS owner TEXT');
  await pool.query('ALTER TABLE river_club_private.state ENABLE ROW LEVEL SECURITY');
  await pool.query('REVOKE ALL ON TABLE river_club_private.state FROM PUBLIC');
  await pool.query(`INSERT INTO river_club_private.state (id, payload) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify({ version: 1, capitalResetVersion: 1, users: [] })]);
  // Render fait coexister les deux serveurs pendant un déploiement. Le nouveau prend
  // la main et charge le dernier état dans une seule écriture atomique, sans changer les comptes.
  // La révision avancée bloque aussi les anciennes versions qui ne connaissent pas owner.
  const { rows } = await pool.query(`UPDATE river_club_private.state
    SET owner = $1, revision = revision + 1 WHERE id = 1 RETURNING revision, payload`, [storageOwner]);
  const saved = validateAccounts(rows[0].payload);
  dbRevision = rows[0].revision; capitalResetVersion = Math.max(1, saved.capitalResetVersion ?? 0);
  const migrated = restoreUsers(saved);
  restoreHistory(saved);
  if (migrated) await persist();
  storageReady = true;
  console.log(`[stockage] PostgreSQL connecté : ${users.size} compte(s) chargé(s).`);
}
const table = { players: [], phase: 'waiting', board: [], deck: [], dealer: null,
  turn: null, currentBet: 0, minRaise: BIG, pending: new Set(), acted: new Map(),
  hand: 0, handId: '', startedAt: 0, handLogs: [], result: 'Bienvenue à la table.', deadline: 0, endedAt: 0, reveal: false, logs: [], winners: [], runout: false, runoutAt: 0 };
let logSequence = 0;
function addLog(message, player, effect = null) {
  table.logs.push({ id: ++logSequence, hand: table.hand, time: Date.now(),
    message: player ? `[${player.nick}] ${message}` : message, actorId: player?.id, effect });
  if (table.logs.length > 100) table.logs.splice(0, table.logs.length - 100);
  if (active()) { table.handLogs.push(table.logs.at(-1)); if (table.handLogs.length > 200) table.handLogs.shift(); }
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
  const rows = [...users].map(([id, u]) => ({ id, nick: u.nick, avatar: u.avatar, photo: u.photo || null, salt: u.salt, hash: u.hash,
    wallet: bankroll(id), granted: u.granted, lastAidAt: u.lastAidAt, club:u.club }));
  const payload = JSON.stringify({ version: 1, capitalResetVersion, users: rows, history: handHistory });
  if (postgres) {
    const result = await pool.query(`UPDATE river_club_private.state SET payload = $1::jsonb, revision = revision + 1
      WHERE id = 1 AND revision = $2 AND owner = $3 RETURNING revision`, [payload, dbRevision, storageOwner]);
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
  for (const handle of reconnectTimers.values()) clearTimeout(handle);
  reconnectTimers.clear();
  console.error('[stockage] Sauvegarde indisponible :', error.code || error.name);
  if (error.code === 'STORAGE_CONFLICT') console.error('[stockage] Cette instance a été remplacée ou son état est périmé. Écritures arrêtées ; la nouvelle instance conserve les derniers comptes enregistrés.');
  if (error.code === 'DATABASE_URL_MISSING') console.error('[stockage] Définissez DATABASE_URL dans Render → Environment. Aucun compte ne sera enregistré sur le disque éphémère.');
  io.emit('storage-error', { message: STORAGE_MESSAGE });
}
function enqueue(action, save = true) {
  const result = mutationQueue.then(async () => {
    await ready;
    if (storageUnavailable) throw Error(STORAGE_MESSAGE);
    const before = structuredClone({ users, table, logSequence, handHistory });
    clearTimeout(timer); inMutation = true; turnChanged = false; turnBudget = TURN_MS; runoutDelay = 0;
    let writing = false;
    try {
      const value = action();
      if (save) { writing = true; await persist(); }
      if (turnChanged && table.turn) table.deadline = seat(table.turn)?.disconnectedUntil || Date.now() + turnBudget;
      if (runoutDelay && table.runout) table.runoutAt = Date.now() + runoutDelay;
      inMutation = false; scheduleTurn(); scheduleReconnects(); broadcast(); return value;
    } catch (error) {
      users.clear(); for (const [id, u] of before.users) users.set(id, u);
      Object.assign(table, before.table); logSequence = before.logSequence; inMutation = false;
      handHistory = before.handHistory;
      if (writing) { storageFailed(error); throw Error(STORAGE_MESSAGE); }
      scheduleTurn(); scheduleReconnects(); throw error;
    }
  });
  mutationQueue = result.catch(() => {});
  return result;
}
function aidStatus(id) {
  const u = users.get(id), nextAt = u.lastAidAt ? u.lastAidAt + DAY : 0;
  return { eligible: !seat(id) && bankroll(id) < AID_THRESHOLD && Date.now() >= nextAt, nextAt };
}
function sessionFor(req) {
  const token = /(?:^|;\s*)river_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const session = sessions.get(token);
  if (!session || session.expires <= Date.now()) { if (token) sessions.delete(token); return null; }
  return { ...session, token };
}
function issueSession(req, res, id) {
  for (const [token, s] of sessions) if (s.id === id) sessions.delete(token);
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { id, expires: Date.now() + 7 * DAY });
  res.cookie('river_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure,
    maxAge: 7 * DAY, path: '/' });
  return token;
}
function createSession(req, res, id) {
  issueSession(req, res, id);
  res.json({ ok: true, ...profileFor(id) });
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
  for (const [key, v] of chatLimits) if (v.until <= now) chatLimits.delete(key);
  for (const [key,time] of emoteTimes) if (now-time>60000) emoteTimes.delete(key);
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
    const { nick, password, avatar, photo } = req.body || {};
    if (!consumeAttempt('ip:' + req.ip, 40)) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    if (!validNick(nick) ||
      typeof password !== 'string' || password.length < 8 || password.length > 128)
      return res.status(400).json({ error: 'Pseudo : 2 à 20 caractères. Mot de passe : 8 à 128 caractères.' });
    const key = nickKey(nick);
    if (!consumeAttempt('user:' + key, 15)) return res.status(429).json({ error: 'Trop de tentatives sur ce compte. Réessayez dans 15 minutes.' });
    const found = accountByNick(key), u = found?.[1];
    let id = found?.[0];
    if (mode === 'register') {
      if (avatar !== undefined && !AVATARS.includes(avatar)) return res.status(400).json({ error:'Choisissez un personnage de la collection.' });
      if (photo != null && !photoBuffer(photo)) return res.status(400).json({ error:'Photo invalide. Utilisez le sélecteur pour importer une image.' });
      const salt = randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, 64)).toString('hex');
      await enqueue(() => {
        if (accountByNick(key)) throw Object.assign(Error('Ce pseudo est déjà pris. Connectez-vous.'), { status: 409 });
        // L'identifiant du compte reste immuable, même après un changement de pseudo.
        id = key; while (users.has(id)) id = randomBytes(16).toString('hex');
        users.set(id, { nick: nick.trim(), avatar: avatar || AVATARS[randomInt(AVATARS.length)], photo:photo || null, salt, hash, wallet: 1000, granted: 1000, lastAidAt: 0, club:newClub(), socket: null });
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
  res.json({ ok: true, ...profileFor(s.id) });
});
app.get('/api/profile', async (req, res) => {
  const session = sessionFor(req);
  if (!session) return res.status(401).json({ error:'Connectez-vous pour accéder au compte.' });
  try {
    const profile = await enqueue(() => profileFor(session.id), false);
    res.json(profile);
  } catch { res.status(503).json({ error:STORAGE_MESSAGE }); }
});
app.post('/api/profile', async (req, res) => {
  try {
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error:'Reconnectez-vous pour modifier le compte.' });
    if (!consumeAttempt('profile:' + session.id, 30)) return res.status(429).json({ error:'Trop de modifications. Réessayez un peu plus tard.' });
    const body = req.body || {}, u = users.get(session.id);
    const sensitive = body.nick !== undefined || body.newPassword !== undefined;
    if (body.nick !== undefined && !validNick(body.nick)) return res.status(400).json({ error:'Le pseudo doit contenir de 2 à 20 caractères : lettres, chiffres, espaces, tirets ou _.' });
    if (body.avatar !== undefined && !AVATARS.includes(body.avatar)) return res.status(400).json({ error:'Personnage inconnu.' });
    if (body.photo !== undefined && body.photo !== null && !photoBuffer(body.photo)) return res.status(400).json({ error:'Photo invalide. Importez une image avec le sélecteur de photo.' });
    if (body.newPassword !== undefined && (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 128))
      return res.status(400).json({ error:'Le nouveau mot de passe doit contenir de 8 à 128 caractères.' });
    if (!sensitive && body.avatar === undefined && body.photo === undefined) return res.status(400).json({ error:'Aucune modification demandée.' });
    const oldHash = u.hash, oldSalt = u.salt;
    let salt, hash;
    if (sensitive) {
      if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 128) return res.status(400).json({ error:'Saisissez votre mot de passe actuel.' });
      const verifier = await scrypt(body.currentPassword, oldSalt, 64);
      if (!timingSafeEqual(verifier, Buffer.from(oldHash,'hex'))) return res.status(401).json({ error:'Mot de passe actuel incorrect.' });
      if (body.newPassword !== undefined) { salt = randomBytes(16).toString('hex'); hash = (await scrypt(body.newPassword,salt,64)).toString('hex'); }
    }
    const profile = await enqueue(() => {
      if (sessionFor(req)?.token !== session.token) throw Object.assign(Error('Session expirée. Reconnectez-vous.'), {status:401});
      const current = users.get(session.id);
      if (current.hash !== oldHash || current.salt !== oldSalt) throw Object.assign(Error('Le compte a changé. Réessayez avec le mot de passe actuel.'), {status:409});
      if (body.nick !== undefined) {
        const taken = accountByNick(nickKey(body.nick));
        if (taken && taken[0] !== session.id) throw Object.assign(Error('Ce pseudo est déjà utilisé.'), {status:409});
        const previous = current.nick; current.nick = body.nick.trim();
        const player = seat(session.id);
        if (player) { player.nick = current.nick; if (previous !== current.nick) addLog(`change de pseudo : ${previous} devient ${current.nick}.`, player); }
      }
      if (body.avatar !== undefined) current.avatar = body.avatar;
      if (body.photo !== undefined) current.photo = body.photo;
      if (hash) { current.salt = salt; current.hash = hash; }
      return profileFor(session.id);
    });
    if (hash) {
      const token = issueSession(req,res,session.id);
      for (const socket of io.sockets.sockets.values()) if (socket.data.uid === session.id) {
        if (socket.data.session === session.token) socket.data.session = token;
        else { socket.data.leaveImmediately = true; socket.emit('session-expired'); socket.disconnect(true); }
      }
    }
    res.json({ ok:true, ...profile });
  } catch (error) { res.status(error.status || 503).json({ error:error.status ? error.message : STORAGE_MESSAGE }); }
});
app.get('/api/avatars/:id/:version', (req,res) => {
  if (!sessionFor(req)) return res.status(401).json({ error:'Connectez-vous.' });
  const u = users.get(req.params.id);
  if (!u?.photo || photoUrl(req.params.id,u).split('/').at(-1) !== req.params.version) return res.sendStatus(404);
  res.setHeader('Cache-Control','private, max-age=31536000, immutable');
  res.type('image/jpeg').send(photoBuffer(u.photo));
});
app.get('/api/history', async (req, res) => {
  if (!sessionFor(req)) return res.status(401).json({ error: 'Connectez-vous pour consulter l’historique.' });
  try {
    const hands = await enqueue(() => structuredClone(handHistory), false);
    res.json({ hands });
  } catch { res.status(503).json({ error: STORAGE_MESSAGE }); }
});
app.get('/api/store',async(req,res)=>{
  const session=sessionFor(req);if(!session)return res.status(401).json({error:'Connectez-vous pour accéder à la boutique.'});
  try{const club=await enqueue(()=>structuredClone(clubState(session.id)),false);res.json({items:CATALOG,groups:SHOP_GROUPS,currency:CURRENCY,rules:{welcome:120,win:20,showdown:5,allin:10,swapMs:QUEST_SWAP_MS},club});}
  catch{res.status(503).json({error:STORAGE_MESSAGE});}
});
app.post('/api/store',async(req,res)=>{
  try{
    const session=sessionFor(req);if(!session)return res.status(401).json({error:'Reconnectez-vous pour accéder à la boutique.'});
    if(!consumeAttempt('store:'+session.id,200))return res.status(429).json({error:'Un peu de patience avant de modifier votre collection.'});
    const {action,itemId,slot}=req.body||{};
    const result=await enqueue(()=>{
      if(sessionFor(req)?.token!==session.token)throw Object.assign(Error('Session expirée.'),{status:401});
      const c=users.get(session.id).club,item=ITEMS.get(itemId);
      const invalid=message=>{throw Object.assign(Error(message),{status:400});};
      if(action==='reroll'){
        if(!Number.isInteger(slot)||slot<0||slot>=c.quests.length)invalid('Quête inconnue.');
        if(Date.now()<c.nextSwapAt)invalid('Votre changement gratuit de quête sera bientôt disponible.');
        const old=c.quests[slot],task=QUESTS.find(t=>t.id===old.task);c.quests[slot]=makeQuest(task.group,c.quests.map(q=>q.task));c.nextSwapAt=Date.now()+QUEST_SWAP_MS;
      }else{
        if(!item)invalid('Objet inconnu.');
        if(action==='buy'){
          if(c.owned.includes(itemId))invalid('Vous possédez déjà cet objet.');
          if(c.coins<item.price)invalid(`Il vous manque ${item.price-c.coins} ${CURRENCY}.`);
          coinEntry(c,-item.price,item.name,'purchase');c.owned.push(itemId);
        }else if(action==='equip'||action==='unequip'){
          if(!c.owned.includes(itemId))invalid('Achetez cet objet avant de l’équiper.');
          if(item.category==='emote'){
            if(action==='unequip')c.equipped.emotes=c.equipped.emotes.filter(id=>id!==itemId);
            else if(!c.equipped.emotes.includes(itemId)){if(c.equipped.emotes.length>=8)invalid('Votre roue contient déjà huit émotes. Retirez-en une avant d’en ajouter.');c.equipped.emotes.push(itemId);}
          }else c.equipped[item.category]=action==='unequip'?LOADOUT[item.category]:itemId;
        }else invalid('Action inconnue.');
      }
      c.revision++;return structuredClone(clubState(session.id));
    });
    res.json({ok:true,club:result});
  }catch(error){res.status(error.status||503).json({error:error.status?error.message:STORAGE_MESSAGE});}
});
app.post('/api/logout', async (req, res) => {
  const s = sessionFor(req);
  if (s) {
    sessions.delete(s.token);
    const socket = io.sockets.sockets.get(users.get(s.id).socket);
    if (socket?.data.session === s.token) { socket.data.leaveImmediately = true; socket.disconnect(true); }
    else if (seat(s.id)) await enqueue(() => {
      const p = seat(s.id); if (p) p.disconnectedUntil = 0;
      leave(s.id);
    }).catch(() => {});
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
    const p = seat(session.id);
    if (p?.disconnectedUntil) {
      if (p.disconnectedUntil <= Date.now()) { p.disconnectedUntil = 0; p.turnRemaining = 0; leave(session.id, true); }
      else {
        p.disconnectedUntil = 0;
        if (table.turn === session.id && active() && !table.runout) {
          turnBudget = p.turnRemaining || TURN_MS; turnChanged = true;
        }
        p.turnRemaining = 0; addLog('retrouve sa place après reconnexion.', p);
      }
    }
    socket.data.uid = session.id; socket.data.session = session.token; u.socket = socket.id;
  }).then(() => next(), () => next(Error(storageUnavailable ? STORAGE_MESSAGE : 'Connexion refusée : session invalide ou déjà utilisée.')));
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
  return { me: id, ...profileFor(id), club:clubState(id), wallet: u.wallet, entryThreshold: ENTRY_THRESHOLD, aidThreshold: AID_THRESHOLD,
    historyVersion: handHistory[0]?.id || '',
    bankroll: bankroll(id), profit: bankroll(id) - u.granted, aid: aidStatus(id),
    phase: table.phase, board: table.board, hand: table.hand, turn: table.turn, logs: table.logs,
    deadline: table.deadline, currentBet: table.currentBet, minRaise: table.minRaise,
    runout: table.runout, runoutAt: table.runoutAt,
    pot: table.players.reduce((n, q) => n + q.total, 0), result: table.result, winners: table.winners,
    celebrationMs: table.phase === 'showdown' ? Math.max(0, 3600 - (Date.now() - table.endedAt)) : 0,
    canRaise: !!p && mayRaise(p),
    players: table.players.map(q => ({ id: q.id, nick: q.nick, avatar: users.get(q.id).avatar, photo:photoUrl(q.id), cosmetics:publicCosmetics(q.id), stack: q.stack,
      disconnectedUntil: q.disconnectedUntil || 0,
      bet: q.bet, total: q.total, folded: q.folded, leaving: q.leaving, dealer: q.id === table.dealer,
      cards: q.id === id || (table.reveal && !q.folded) ? q.hole : q.hole.map(() => '??') })) };
}
function broadcast() {
  if (inMutation || storageUnavailable) return;
  for (const s of io.sockets.sockets.values()) if (s.data.uid) s.emit('state', stateFor(s.data.uid));
}
function cleanup() {
  table.players = table.players.filter(p => {
    if (!p.leaving && p.stack > 0 && (users.get(p.id).socket || p.disconnectedUntil > Date.now())) return true;
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
function bestHand(cards) {
  let score = -1, selected = [];
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const hand = [cards[a], cards[b], cards[c], cards[d], cards[e]], value = five(hand);
            if (value > score) { score = value; selected = hand; }
          }
  const category = Math.floor(score / 15 ** 5), rank = c => '23456789TJQKA'.indexOf(c[0]) + 2;
  const count = c => selected.filter(other => rank(other) === rank(c)).length;
  const straight = category === 4 || category === 8;
  const wheel = straight && Math.floor(score / 15 ** 4) % 15 === 5;
  const high = c => wheel && rank(c) === 14 ? 1 : rank(c);
  selected.sort((a, b) => (straight ? 0 : count(b) - count(a)) || high(b) - high(a));
  const combination = selected.filter((c, i) => category === 0 ? i === 0
    : [1,2,3,7].includes(category) ? count(c) > 1 : true);
  return { score, cards: selected, combination };
}
function best(cards) { return bestHand(cards).score; }
function handReason(score) {
  const category = Math.floor(score / 15 ** 5);
  const first = Math.floor(score / 15 ** 4) % 15, second = Math.floor(score / 15 ** 3) % 15;
  const rank = n => ({11:'Valet',12:'Dame',13:'Roi',14:'As'}[n] || String(n));
  return [`Carte haute : ${rank(first)}`, `Paire : ${rank(first)}`, `Double paire : ${rank(first)} et ${rank(second)}`,
    `Brelan : ${rank(first)}`, `Quinte au ${rank(first)}`, `Couleur, ${rank(first)} en tête`,
    `Full : ${rank(first)} par ${rank(second)}`, `Carré : ${rank(first)}`, `Quinte flush au ${rank(first)}`][category];
}
function finish() {
  if (!active()) return;
  clearTimeout(timer); table.turn = null; table.deadline = 0;
  table.runout = false; table.runoutAt = 0;
  const ps = table.players, remaining = live(), gains = new Map(), refunds = new Map();
  const starting=new Map(ps.map(p=>[p.id,{start:p.stack+p.total,allin:p.stack===0&&p.total>0}])),coinRewards=new Map();
  table.reveal = remaining.length > 1;
  // Le tableau est parcouru en premier pour retenir ses cartes lorsqu'elles suffisent à égalité.
  const hands = new Map(remaining.map(p => [p.id, table.reveal ? bestHand([...table.board, ...p.hole]) : null]));
  const scores = new Map(remaining.map(p => [p.id, hands.get(p.id)?.score ?? 0]));
  // Chaque niveau de contribution constitue un pot distinct ; les excédents sont rendus.
  let previous = 0, potNumber = 0;
  const awards = new Map();
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
    const potName = ++potNumber === 1 ? 'Pot principal' : `Pot secondaire ${potNumber - 1}`;
    // En cas de partage, le jeton impair revient au premier gagnant à gauche du bouton.
    const dealerIndex = ps.findIndex(p => p.id === table.dealer);
    winners.sort((a, b) => ((ps.indexOf(a) - dealerIndex - 1 + ps.length) % ps.length)
      - ((ps.indexOf(b) - dealerIndex - 1 + ps.length) % ps.length));
    winners.forEach((p, i) => {
      const gain = Math.floor(amount / winners.length) + (i < amount % winners.length ? 1 : 0);
      p.stack += gain; gains.set(p.id, (gains.get(p.id) || 0) + gain);
      if (!awards.has(p.id)) awards.set(p.id, { pots: [], shared: false });
      awards.get(p.id).pots.push(potName);
      awards.get(p.id).shared ||= winners.length > 1;
    });
  }
  for(const p of ps){
    const score=scores.get(p.id)||0,hand=hands.get(p.id),won=(gains.get(p.id)||0)+(refunds.get(p.id)||0)-p.total>0;
    coinRewards.set(p.id,rewardHand(p.id,{played:true,won,showdown:table.reveal&&!p.folded,reveal:table.reveal,
      invested:p.total,net:(gains.get(p.id)||0)+(refunds.get(p.id)||0)-p.total,streets:p.streetsSeen||0,
      aceUsed:!!hand&&p.hole.some(code=>code[0]==='A'&&hand.cards.includes(code)),
      category:hand?Math.floor(score/15**5):-1,rank:hand?Math.floor(score/15**4)%15:0,
      ...starting.get(p.id),received:gains.get(p.id)||0,dealer:p.id===table.dealer,players:ps.length,board:table.board.length,
      both:!!hand&&p.hole.every(code=>hand.cards.includes(code))},table.handId));
  }
  table.winners = [...gains].map(([id, amount]) => {
    const hand = hands.get(id), player = ps.find(p => p.id === id);
    return { id, nick: users.get(id).nick, avatar: users.get(id).avatar, amount,coins:coinRewards.get(id)||0,cosmetics:publicCosmetics(id),
      reason: table.reveal ? handReason(scores.get(id)) : 'Tous les autres joueurs se sont couchés',
      winningHand: hand ? hand.cards.map(code => ({ code, fromHand: player.hole.includes(code),
        combination: hand.combination.includes(code) })) : [], ...awards.get(id) };
  });
  table.result = gains.size ? [...gains].map(([id, gain]) => `${users.get(id).nick} gagne ${gain} jetons${
    table.reveal ? ` (${labels[Math.floor(scores.get(id) / 15 ** 5)]})` : ''}`).join(' · ')
    : 'Main terminée : mises remboursées.';
  for (const [id, amount] of refunds) addLog(`récupère ${amount} jetons remboursés.`, users.get(id));
  for (const [id, amount] of gains) addLog(`remporte ${amount} jetons${
    table.reveal ? ` avec ${labels[Math.floor(scores.get(id) / 15 ** 5)]}` : ''}.`, users.get(id));
  if (!gains.size) addLog('Main terminée : les mises ont été remboursées.');
  handHistory.unshift({ id: table.handId, number: table.hand, startedAt: table.startedAt, endedAt: Date.now(),
    board: [...table.board], pot: [...gains.values()].reduce((sum, value) => sum + value, 0),
    winners: structuredClone(table.winners), result: table.result,
    players: ps.map(p => ({ id:p.id, nick:p.nick, avatar:users.get(p.id).avatar, dealer:p.id === table.dealer, folded:p.folded,
      cards: table.reveal && !p.folded ? [...p.hole] : [], contribution:p.total,
      won:gains.get(p.id) || 0, refund:refunds.get(p.id) || 0 })), logs: structuredClone(table.handLogs) });
  if (handHistory.length > HISTORY_LIMIT) handHistory.length = HISTORY_LIMIT;
  ps.forEach(p => { p.bet = 0; p.total = 0; });
  table.phase = 'showdown'; table.endedAt = Date.now(); broadcast();
  // Préserver les cartes du résultat jusqu'au prochain départ, rendre immédiatement les jetons sortants.
  cleanup(); broadcast();
}
function setTurn(p) {
  clearTimeout(timer); table.turn = p.id; table.deadline = Date.now() + TURN_MS; turnChanged = true;
  if (p.disconnectedUntil) p.turnRemaining = TURN_MS;
}
function scheduleReconnects() {
  for (const handle of reconnectTimers.values()) clearTimeout(handle);
  reconnectTimers.clear();
  if (storageUnavailable) return;
  for (const p of table.players) if (p.disconnectedUntil) {
    const id = p.id, until = p.disconnectedUntil;
    const handle = setTimeout(() => enqueue(() => {
      const current = seat(id);
      if (!current || current.disconnectedUntil !== until || users.get(id).socket) return;
      current.disconnectedUntil = 0; current.turnRemaining = 0; leave(id, true);
    }).catch(() => {}), Math.max(0, until - Date.now()));
    handle.unref(); reconnectTimers.set(id, handle);
  }
}
function scheduleTurn() {
  clearTimeout(timer);
  if (!active() || storageUnavailable) return;
  if (table.runout) {
    const hand = table.hand, phase = table.phase, deadline = table.runoutAt;
    timer = setTimeout(() => {
      enqueue(() => {
        if (!table.runout || table.hand !== hand || table.phase !== phase || table.runoutAt !== deadline) return;
        if (phase === 'river') return finish();
        dealStreet(); table.pending.clear();
        table.result = table.phase === 'river' ? 'La river est posée… Qui remporte le pot ?' : 'Les mises sont closes. Le suspense continue…';
        runoutDelay = table.phase === 'river' ? RUNOUT_RESULT_MS : RUNOUT_STREET_MS;
      }).catch(() => {});
    }, Math.max(0, deadline - Date.now()));
    return;
  }
  if (!table.turn || seat(table.turn)?.disconnectedUntil) return;
  const id = table.turn, deadline = table.deadline;
  timer = setTimeout(() => {
    enqueue(() => {
      if (table.turn === id && table.deadline === deadline && active()) {
        const p = seat(id); act(p, { type: p.bet === table.currentBet ? 'call' : 'fold' }, true);
      }
    }).catch(() => {});
  }, Math.max(0, deadline - Date.now()));
}
function dealStreet() {
  table.phase = { preflop: 'flop', flop: 'turn', turn: 'river' }[table.phase];
  table.deck.pop(); // Carte brûlée.
  const dealt = Array.from({ length: table.phase === 'flop' ? 3 : 1 }, () => table.deck.pop());
  table.board.push(...dealt);
  table.players.filter(p=>!p.folded).forEach(p=>p.streetsSeen=(p.streetsSeen||0)+1);
  addLog(`${{ flop: 'Flop', turn: 'Turn', river: 'River' }[table.phase]} : ${dealt.map(c =>
    (c[0] === 'T' ? '10' : c[0]) + ({ s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]])).join(' ')}.`);
  table.players.forEach(p => { p.bet = 0; });
  table.currentBet = 0; table.minRaise = BIG; table.acted.clear();
  table.pending = new Set(table.players.filter(canAct).map(p => p.id));
}
function advance(after) {
  if (table.runout) return;
  if (live().length <= 1) return finish();
  const able = table.players.filter(canAct);
  for (const id of table.pending) if (!able.some(p => p.id === id)) table.pending.delete(id);
  const closed = able.length <= 1 && able.every(p => p.bet >= table.currentBet);
  if (closed) table.pending.clear();
  const next = nextAfter(after, p => table.pending.has(p.id));
  if (next) return setTurn(next);
  if (table.phase === 'river') return finish();
  if (closed) {
    // Le serveur révèle chaque rue séparément ; le résultat n'existe qu'après la dernière pause.
    table.runout = true; table.reveal = true; table.turn = null; table.deadline = 0;
    table.result = 'Tapis suivi ! Les mains sont dévoilées, place aux dernières cartes…';
    runoutDelay = RUNOUT_FIRST_MS;
    return;
  }
  dealStreet();
  advance(table.dealer);
}
function start() {
  if (active()) throw Error('Une main est déjà en cours.');
  if (Date.now() - table.endedAt < 4000) throw Error('Patientez quatre secondes entre deux mains.');
  cleanup();
  const ps = table.players;
  if (ps.length < 2) throw Error('Deux joueurs minimum sont nécessaires.');
  if (ps.some(p => p.disconnectedUntil)) throw Error('Un joueur se reconnecte. Sa place est réservée pendant 30 secondes.');
  clearTimeout(timer);
  const dealer = nextAfter(table.dealer, () => true);
  table.dealer = dealer.id; table.hand++; table.phase = 'preflop'; table.board = []; table.winners = [];
  table.handId = randomBytes(12).toString('hex'); table.startedAt = Date.now(); table.handLogs = [];
  table.result = `Main ${table.hand} — petites / grosses blindes : ${SMALL} / ${BIG} jetons.`;
  addLog(`Main ${table.hand} : distribution. ${dealer.nick} est au bouton.`);
  table.reveal = false; table.runout = false; table.runoutAt = 0; table.currentBet = BIG; table.minRaise = BIG; table.acted.clear();
  table.deck = [...'23456789TJQKA'].flatMap(r => [...'shdc'].map(s => r + s));
  for (let i = table.deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [table.deck[i], table.deck[j]] = [table.deck[j], table.deck[i]];
  }
  ps.forEach(p => { p.hole = []; p.folded = false; p.bet = 0; p.total = 0; p.streetsSeen = 0; });
  for (let n = 0; n < 2; n++) ps.forEach(p => p.hole.push(table.deck.pop()));
  const sb = ps.length === 2 ? dealer : nextAfter(dealer.id, () => true);
  const bb = nextAfter(sb.id, () => true);
  pay(sb, SMALL); pay(bb, BIG);
  addLog(`pose la petite blinde : ${sb.bet} jetons${sb.stack === 0 ? ' (tapis)' : ''}.`, sb, {type:sb.stack === 0 ? 'allin' : 'bet', amount:sb.bet});
  addLog(`pose la grosse blinde : ${bb.bet} jetons${bb.stack === 0 ? ' (tapis)' : ''}.`, bb, {type:bb.stack === 0 ? 'allin' : 'bet', amount:bb.bet});
  table.pending = new Set(ps.filter(canAct).map(p => p.id));
  advance(bb.id);
}
function act(p, { type, amount }, automatic = false) {
  if (!active() || table.turn !== p.id || !canAct(p)) throw Error("Ce n'est pas votre tour.");
  if (!['fold', 'call', 'raise'].includes(type)) throw Error('Action inconnue.');
  const timeout = automatic ? ' (délai écoulé)' : '';
  if (type === 'fold') { p.folded = true; addLog(`se couche${timeout}.`, p, {type:'fold'}); }
  if (type === 'call') {
    const paid = Math.min(p.stack, Math.max(0, table.currentBet - p.bet));
    pay(p, paid);
    addLog(paid === 0 ? `check${timeout}.` : p.stack === 0
      ? `fait tapis : ${p.bet} jetons au total (suit ${paid} jetons).`
      : `suit de ${paid} jetons.`, p, {type:paid === 0 ? 'check' : p.stack === 0 ? 'allin' : 'call', amount:paid, total:p.bet});
  }
  if (type === 'raise') {
    const maximum = p.bet + p.stack;
    if (!Number.isSafeInteger(amount) || amount <= table.currentBet || amount > maximum
      || (amount < table.currentBet + table.minRaise && amount !== maximum) || !mayRaise(p))
      throw Error('Relance invalide : minimum indiqué, ou votre tapis si inférieur.');
    const increase = amount - table.currentBet, opening = table.currentBet === 0, paid = amount - p.bet;
    pay(p, amount - p.bet); table.currentBet = amount;
    if (increase >= table.minRaise) {
      table.minRaise = increase;
      table.pending = new Set(table.players.filter(canAct).map(q => q.id));
    } else table.players.filter(q => canAct(q) && q.bet < amount).forEach(q => table.pending.add(q.id));
    addLog(p.stack === 0 ? `fait tapis : ${amount} jetons au total.`
      : opening ? `mise ${amount} jetons.` : `relance à ${amount} jetons.`, p, {type:p.stack === 0 ? 'allin' : 'raise', amount, paid});
  }
  table.acted.set(p.id, table.currentBet); table.pending.delete(p.id); advance(p.id);
}
function leave(id, disconnected = false) {
  const p = seat(id);
  if (!p || p.leaving) return;
  p.leaving = true;
  addLog(disconnected ? 'se déconnecte.' : 'quitte la table.', p);
  if (active()) {
    if (table.runout) { addLog('reste en jeu jusqu’au dévoilement final.', p); return; }
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
          socket.data.leaveImmediately = true; socket.emit('session-expired'); socket.disconnect(true); throw Error('Session expirée.');
        }
        handler(data && typeof data === 'object' ? data : {});
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) { if (typeof ack === 'function') ack({ error: e.message }); }
  });
  enqueue(() => {}, false).then(() => socket.emit('chat-history', chatMessages))
    .catch(() => socket.emit('storage-error', { message: STORAGE_MESSAGE }));
  socket.on('emote',(data,ack)=>{
    try{
      const id=socket.data.uid,session=sessions.get(socket.data.session),u=users.get(id);
      if(storageUnavailable)throw Error(STORAGE_MESSAGE);
      if(!session||session.expires<=Date.now()||session.id!==id||u?.socket!==socket.id)throw Error('Reconnectez-vous pour utiliser vos émotes.');
      if(!seat(id)||seat(id).leaving)throw Error('Rejoignez la table pour utiliser vos émotes.');
      if(Date.now()-(emoteTimes.get(id)||0)<5000)throw Error('Une émote toutes les cinq secondes.');
      const item=ITEMS.get(data?.itemId);if(!item||item.category!=='emote'||!u.club.equipped.emotes.includes(item.id))throw Error('Ajoutez cette émote à votre roue dans la boutique.');
      const time=Date.now();emoteTimes.set(id,time);io.emit('emote',{id:randomBytes(8).toString('hex'),userId:id,nick:u.nick,itemId:item.id,time});
      if(typeof ack==='function')ack({ok:true});
    }catch(error){if(typeof ack==='function')ack({error:error.message});}
  });
  // Le chat ne passe pas par la file des mises : aucun solde ni délai de jeu n'est modifié.
  socket.on('chat', (data, ack) => {
    try {
      if (storageUnavailable) throw Error(STORAGE_MESSAGE);
      const session = sessions.get(socket.data.session), id = socket.data.uid;
      if (!session || session.expires <= Date.now() || session.id !== id || users.get(id)?.socket !== socket.id) throw Error('Reconnectez-vous pour écrire.');
      if (typeof data?.text !== 'string' || data.text.length > 280) throw Error('Votre message doit contenir entre 1 et 280 caractères.');
      const text = data.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/gu, ' ').trim();
      if (!text) throw Error('Écrivez un message avant de l’envoyer.');
      const now = Date.now();
      let limit = chatLimits.get(id);
      if (!limit || limit.until <= now) { limit = { count:0, until:now + 10000 }; chatLimits.set(id, limit); }
      if (limit.count >= 5) throw Error('Un peu de patience : 5 messages maximum en 10 secondes.');
      limit.count++;
      const entry = { id:++chatSequence, userId:id, nick:users.get(id).nick, avatar:users.get(id).avatar, text, time:now };
      chatMessages.push(entry); if (chatMessages.length > 80) chatMessages.shift();
      io.emit('chat-message', entry);
      if (typeof ack === 'function') ack({ ok:true });
    } catch (error) { if (typeof ack === 'function') ack({ error:error.message }); }
  });
  on('claim-aid', () => {
    const id = socket.data.uid, u = users.get(id);
    if (!aidStatus(id).eligible) throw Error(`Seconde chance : hors table, sous ${AID_THRESHOLD} jetons, une fois toutes les 24 h.`);
    u.wallet += 500; u.granted += 500; u.lastAidAt = Date.now();
  });
  on('join', () => {
    const id = socket.data.uid, u = users.get(id);
    if (active()) throw Error('Attendez la fin de la main pour rejoindre.');
    if (seat(id)) throw Error('Vous êtes déjà à table.');
    if (table.players.length >= 6) throw Error('Table complète (6 joueurs).');
    if (u.wallet <= 0) throw Error('Il faut au moins un jeton pour rejoindre. Consultez votre seconde chance.');
    const buyIn = Math.min(u.wallet, ENTRY_THRESHOLD);
    u.wallet -= buyIn;
    table.players.push({ id, nick: u.nick, stack: buyIn, bet: 0, total: 0, hole: [], folded: false, leaving: false, disconnectedUntil: 0, turnRemaining: 0 });
    addLog(`rejoint la table avec ${buyIn} jetons.`, u);
  });
  on('leave', () => leave(socket.data.uid));
  on('start', () => { if (!seat(socket.data.uid) || seat(socket.data.uid).leaving) throw Error('Rejoignez la table.'); start(); });
  on('action', data => { const p = seat(socket.data.uid); if (!p) throw Error('Rejoignez la table.'); act(p, data); });
  socket.on('disconnect', () => {
    const id = socket.data.uid;
    if (!id) return;
    enqueue(() => {
      if (users.get(id).socket !== socket.id) return;
      users.get(id).socket = null;
      const p = seat(id);
      if (!p || p.leaving) return;
      if (socket.data.leaveImmediately) { leave(id, true); return; }
      p.disconnectedUntil = Date.now() + RECONNECT_MS;
      if (active() && !table.runout && table.turn === id) {
        p.turnRemaining = Math.max(1, table.deadline - Date.now()); table.deadline = p.disconnectedUntil;
      }
      addLog('perd la connexion : place réservée pendant 30 secondes.', p);
    }).catch(() => {});
  });
});
const ready = initializeStorage().catch(error => { storageFailed(error); throw Error(STORAGE_MESSAGE); });
ready.catch(() => {});
if (require.main === module) server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {
  console.log(`Poker fictif sur le port ${server.address().port}. Vérifiez /health avant de jouer.`);
});
module.exports = { server, io, table, users, five, best, bestHand, ready,
  closeStorage: () => pool ? pool.end() : Promise.resolve() };
