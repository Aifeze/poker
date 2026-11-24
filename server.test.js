const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes, scryptSync } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const password = 'mot-de-passe-de-test';
const loadout = {
  back:'back-classic', victory:'victory-classic', bet:'bet-classic', allin:'allin-classic',
  arrival:'arrival-classic', frame:'frame-classic', table:'table-classic', emotes:['emote-hi']
};
function legacyAccount(nick, wallet, coins, style, progress) {
  const id = nick.toLowerCase();
  const salt = randomBytes(16).toString('hex');
  const equipped = {...loadout, ...style};
  const quests = [
    ['play',3,progress], ['see',2], ['flops',3], ['rivers',2],
    ['pair',1], ['two',1], ['trips',1], ['straight',1],
    ['show',1], ['crowd',1], ['signature',1], ['deep',1]
  ].map(([task,target,progress = 0]) => ({id:randomBytes(12).toString('hex'),task,target,progress}));
  return {id,nick,salt,hash:scryptSync(password,salt,64).toString('hex'),wallet,granted:1000,lastAidAt:0,avatar:'nova',
    club:{version:1,revision:7,coins,equipped,quests,nextSwapAt:0,lastHand:'',feed:[],
      owned:[...new Set([...Object.values(loadout).flat(), ...Object.values(equipped).flat()])],
      stats:{hands:0,wins:0,quests:0,earned:coins,streak:0}}};
}

async function startServer(directory, t) {
  const child = spawn(process.execPath, ['-e', `
    const {server, ready} = require('./server');
    ready.then(() => server.listen(0, '127.0.0.1', () => process.send(server.address().port)))
      .catch(() => process.exit(1));
  `], {
    cwd:__dirname, stdio:['ignore','ignore','pipe','ipc'],
    env:{...process.env, DATABASE_URL:'', RENDER:'', POKER_DATA_DIR:directory}
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  const stop = async () => {
    child.kill();
    await exited;
  };
  t.after(stop);
  const port = await Promise.race([
    once(child, 'message').then(([port]) => port),
    exited.then(([code]) => { throw Error(`Server stopped during startup (${code})\n${errors}`); })
  ]);
  return {stop, url:`http://127.0.0.1:${port}`};
}

async function api(server, route, {cookie, body, status = 200} = {}) {
  const headers = {'Content-Type':'application/json'};
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(server.url + '/api/' + route, {
    headers, method:body ? 'POST' : 'GET', body:JSON.stringify(body), signal:AbortSignal.timeout(5000)
  });
  const json = await response.json();
  assert.ok([status].flat().includes(response.status), `${route} (${response.status}): ${JSON.stringify(json)}`);
  return {json,status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}

async function playerSocket(server, cookie) {
  const poll = new URL('/socket.io/?EIO=4&transport=polling', server.url);
  const request = async body => {
    const response = await fetch(poll, {
      headers:{Cookie:cookie}, method:body ? 'POST' : 'GET', body, signal:AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const open = await request();
  assert.equal(open[0], '0');
  poll.searchParams.set('sid', JSON.parse(open.slice(1)).sid);
  assert.equal(await request('40'), 'ok');
  let state;
  async function receive(match) {
    while (true) {
      let result;
      for (const packet of (await request()).split('\x1e')) {
        if (packet === '2') await request('3');
        if (packet.startsWith('42["state",')) state = JSON.parse(packet.slice(2))[1];
        if (match(packet)) result = packet;
      }
      if (result) return result;
    }
  }
  await receive(packet => packet.startsWith('40'));
  return {
    async stateWhen(match) {
      if (!state || !match(state)) await receive(() => state && match(state));
      return state;
    },
    async send(event, data = {}) {
      assert.equal(await request('421' + JSON.stringify([event,data])), 'ok');
      const packet = await receive(frame => frame.startsWith('431'));
      assert.deepEqual(JSON.parse(packet.slice(3)), [{ok:true}]);
    }
  };
}

test('legacy accounts can share assets while keeping their personal poker and club progress', {timeout:30000}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'poker-test-'));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  const lydia = legacyAccount('Lydia', 923, 300, {back:'back-azure',victory:'victory-fireworks'}, 2);
  const marc = legacyAccount('Marc', 1577, 180, {back:'back-azure',emotes:['emote-coffee']}, 0);
  // Also cover a save from before club features existed.
  const {club, ...ancienneRose} = legacyAccount('Rose', 1300, 0, {}, 0);
  const file = path.join(directory,'accounts.json');
  const legacy = {version:1,capitalResetVersion:2,users:[lydia,marc,ancienneRose]};
  await fs.writeFile(file, JSON.stringify(legacy));
  let server = await startServer(directory, t);
  const store = async cookie => (await api(server,'store',{cookie})).json.club;
  const auth = async (nick, route = 'login') => (await api(server,route,{body:{nick,password}})).cookie;
  const link = (cookie, nicks, status = 200, currentPassword = password) =>
    api(server,'profile/link',{cookie,status,body:{currentPassword,accounts:nicks.map(nick =>
      typeof nick === 'string' ? {nick,password} : nick)}});
  const purchase = (cookie,itemId,status = 200) => api(server,'store',{cookie,status,body:{action:'buy',itemId}});
  const a = await auth('Lydia'), b = await auth('Marc'), c = await auth('Rose'), d = await auth('Mila','register');
  const beforeA = await store(a), beforeB = await store(b);
  const migrated = JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.capitalResetVersion, legacy.capitalResetVersion);
  assert.equal((await store(c)).coins, 120);
  for (const old of [lydia,marc,ancienneRose]) {
    const account = migrated.users.find(user => user.id === old.id);
    for (const field of ['nick','avatar','wallet','granted','lastAidAt','salt','hash']) assert.equal(account[field], old[field]);
  }
  assert.equal(beforeA.coins, 300);
  assert.equal(beforeB.coins, 180);
  assert.deepEqual(beforeA.equipped, lydia.club.equipped);
  assert.deepEqual(beforeB.equipped, marc.club.equipped);

  await link(null, ['Marc'], 401);
  await link(a, ['Marc'], 401, 'mauvais-primaire');
  await link(a, [{nick:'Marc',password:'mauvais-secondaire'}], 401);
  await link(a, ['lydia','Marc'], 400);
  assert.deepEqual(await store(a), beforeA);
  assert.deepEqual(await store(b), beforeB);

  const socketA = await playerSocket(server, a);
  const socketB = await playerSocket(server, b);
  assert.equal((await socketA.stateWhen(s => s.club.coins === 300)).wallet, 923);
  assert.equal((await socketB.stateWhen(s => s.club.coins === 180)).wallet, 1577);
  const shared = (await link(a, ['Marc'])).json.club;
  assert.equal(shared.coins, 480);
  assert.deepEqual(shared.owned, [...new Set([...beforeA.owned, ...beforeB.owned])]);
  assert.deepEqual(shared.purseMembers, ['Lydia','Marc']);
  assert.deepEqual(shared.quests, beforeA.quests);
  const updatedB = await socketB.stateWhen(s => s.club.coins === 480);
  assert.equal(updatedB.wallet, 1577);
  assert.ok(updatedB.club.revision > beforeB.revision);
  assert.deepEqual(updatedB.club.quests, beforeB.quests);
  assert.deepEqual(updatedB.club.equipped, beforeB.equipped);
  await link(a, ['Marc'], 409);
  assert.equal((await store(a)).coins, 480);

  // Concurrent purchase requests for the same item debit the shared purse once.
  const purchases = await Promise.all([a,b].map(cookie => purchase(cookie,'back-emerald',[200,400])));
  assert.deepEqual(purchases.map(result => result.status).sort(), [200,400]);
  assert.match(purchases.find(result => result.status === 400).json.error, /déjà cet objet/);
  const purchasedB = await socketB.stateWhen(s => s.club.coins === 380);
  assert.ok(purchasedB.club.revision > updatedB.club.revision);
  for (const cookie of [a,b]) {
    const saved = await store(cookie);
    assert.equal(saved.coins, 380);
    assert.ok(saved.owned.includes('back-emerald'));
  }
  await api(server,'store',{cookie:b,body:{action:'equip',itemId:'victory-fireworks'}});
  assert.equal((await store(b)).equipped.victory, 'victory-fireworks');
  assert.equal((await store(a)).equipped.back, 'back-azure');
  await api(server,'store',{cookie:b,body:{action:'unequip',itemId:'back-azure'}});
  assert.equal((await store(b)).equipped.back, 'back-classic');
  assert.equal((await store(a)).equipped.back, 'back-azure');

  await socketA.send('join');
  await socketB.send('join');
  await socketA.send('start');
  const hand = await socketA.stateWhen(s => s.phase === 'preflop');
  await (hand.turn === hand.me ? socketA : socketB).send('action',{type:'fold'});
  const afterA = await store(a), afterB = await store(b);
  assert.equal(afterA.coins, 424); // 20 for the win and 24 for Lydia's completed quest.
  assert.equal(afterB.coins, 424);
  assert.equal(afterA.stats.quests, 1);
  assert.equal(afterB.stats.quests, 0);
  assert.equal(afterB.quests[0].progress, 1);
  assert.ok(afterA.feed.some(entry => entry.kind === 'quest' && entry.amount === 24));
  assert.ok(!afterB.feed.some(entry => entry.kind === 'quest'));

  await link(c, ['Mila']);
  await link(a, ['Marc','Rose'], 409);
  await link(a, ['Rose','Mila'], 409);
  assert.equal((await store(c)).coins, 240);
  const all = (await link(a, ['Marc','Rose','Mila'])).json.club;
  assert.equal(all.coins, 664);
  assert.deepEqual(all.purseMembers, ['Lydia','Marc','Rose','Mila']);
  for (const cookie of [a,b,c,d]) assert.equal((await store(cookie)).coins, 664);
  await auth('Sol','register');
  const savedBeforeFailure = await fs.readFile(file,'utf8');
  await fs.mkdir(file + '.tmp'); // Force a write failure before the primary save is replaced.
  await link(a, ['Marc','Rose','Mila','Sol'], 503);
  assert.equal(await fs.readFile(file,'utf8'), savedBeforeFailure);
  await fs.rmdir(file + '.tmp');

  await server.stop();
  server = await startServer(directory, t);
  const restarted = await Promise.all(['Lydia','Marc','Rose','Mila'].map(nick => auth(nick)));
  for (const cookie of restarted) {
    const state = await store(cookie);
    assert.equal(state.coins, 664);
    assert.deepEqual(state.owned, all.owned);
    assert.deepEqual(state.purseMembers, all.purseMembers);
  }
  assert.deepEqual((await store(restarted[0])).quests, afterA.quests);
  assert.deepEqual((await store(restarted[1])).equipped, afterB.equipped);
  const sol = await store(await auth('Sol'));
  assert.equal(sol.coins, 120);
  assert.deepEqual(sol.purseMembers, ['Sol']);
});
