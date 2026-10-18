'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHub, cfgText } = require('../server/gsi-hub.js');
const Draft = require('../js/draft.js');

const TOKEN = 'test-token-0123456789';
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function req(port, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const r = http.request({ agent: false, host: '127.0.0.1', port, path: p, method, headers: Object.assign({}, o.headers) }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => (o.tolerant ? resolve({ status: e.code }) : reject(e))); if (o.body) r.write(o.body); r.end();
  });
}
/* Открывает поток SSE и собирает события. */
function sse(port, p) {
  const events = []; let buf = '';
  return new Promise((resolve, reject) => {
    const r = http.get({ agent: false, host: '127.0.0.1', port, path: p }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(blk), dt = /^data: (.*)$/m.exec(blk);
          if (ev && dt) events.push({ event: ev[1], data: JSON.parse(dt[1]) });
        }
      });
      resolve({ status: res.statusCode, headers: res.headers, events, close: () => r.destroy() });
    });
    r.on('error', reject);
  });
}
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 3000)) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

const gsiBody = (extra) => JSON.stringify(Object.assign({
  auth: { token: TOKEN }, provider: { name: 'Dota 2' },
  map: { matchid: '77', game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION', game_time: 0, customgamename: 'x' },
  player: { steamid: '76561197960265729', team_name: 'radiant', gold: 500, kills: 3 },
  hero: { xpos: 1 }, items: { slot0: { name: 'item_blink' } },
  draft: { activeteam: 2, pick: true, activeteam_time_remaining: 20, team2: { pick0_id: 2, pick0_class: 'npc_dota_hero_axe' }, team3: { ban0_id: 14 } }
}, extra || {}));

let hub, port;
test.before(async () => { hub = createHub({ token: TOKEN, heartbeat: 100 }); port = await hub.listen(0); });
test.after(() => hub.close());

test('cfg содержит порт, токен и только нужные разделы', () => {
  const c = cfgText({ port: 7777, token: 'abc12345' });
  assert.match(c, /"uri"\s+"http:\/\/127\.0\.0\.1:7777\/gsi"/);
  assert.match(c, /"token"\s+"abc12345"/);
  assert.match(c, /"draft"\s+"1"/);
  for (const off of ['hero', 'items', 'abilities', 'buildings', 'wearables']) assert.equal(new RegExp('"' + off + '"').test(c), false, off + ' не запрашивается');
  assert.throws(() => createHub({ token: 'short' }), /токен/);
});

test('пакет GSI принимается, в поток уходит только нужное', async () => {
  const s = await sse(port, '/stream?t=' + TOKEN);
  assert.equal(s.status, 200);
  assert.match(s.headers['content-type'], /text\/event-stream/);
  assert.equal(s.headers['access-control-allow-origin'], '*');
  assert.equal(s.headers['access-control-allow-private-network'], 'true');
  assert.ok(await until(() => s.events.some((e) => e.event === 'hello')));
  const r = await req(port, 'POST', '/gsi', { body: gsiBody() });
  assert.equal(r.status, 200);
  assert.ok(await until(() => s.events.some((e) => e.event === 'gsi')));
  const g = s.events.find((e) => e.event === 'gsi').data.gsi;
  assert.deepEqual(Object.keys(g).sort(), ['draft', 'map', 'player']);
  const txt = JSON.stringify(g);
  for (const leak of ['76561197960265729', 'item_blink', 'xpos', 'gold', 'kills', TOKEN, 'customgamename']) assert.equal(txt.includes(leak), false, leak);
  const parsed = Draft.fromGSI(g);
  assert.equal(parsed.hasDraft, true);
  assert.deepEqual(parsed.state.picks.radiant, [2]); assert.deepEqual(parsed.state.bans.dire, [14]);
  assert.equal(parsed.state.mySide, 'radiant');
  s.close();
});

test('новый клиент сразу получает последний пакет', async () => {
  const s = await sse(port, '/stream?t=' + TOKEN);
  assert.ok(await until(() => s.events.some((e) => e.event === 'gsi')));
  assert.equal(s.events[0].event, 'hello'); assert.equal(s.events[0].data.draftSeen, true);
  s.close();
});

test('неверный токен, мусор и большие тела отвергаются', async () => {
  const before = hub.stat.rejected;
  assert.equal((await req(port, 'POST', '/gsi', { body: gsiBody({ auth: { token: 'wrong-token-000000' } }) })).status, 401);
  assert.equal((await req(port, 'POST', '/gsi', { body: JSON.stringify({ draft: {} }) })).status, 401, 'без auth тоже');
  assert.equal((await req(port, 'POST', '/gsi', { body: 'не json' })).status, 400);
  assert.equal((await req(port, 'POST', '/gsi', { body: '[1]' })).status, 401);
  assert.equal(hub.stat.rejected >= before + 4, true);
  const big = await req(port, 'POST', '/gsi', { body: JSON.stringify({ auth: { token: TOKEN }, pad: 'x'.repeat(300 * 1024) }), tolerant: true });
  assert.ok(big.status === 413 || big.status === 'ECONNRESET', 'тело больше 256 КБ отклоняется: ' + big.status);
  assert.equal((await req(port, 'GET', '/stream')).status, 401);
  assert.equal((await req(port, 'GET', '/stream?t=nope')).status, 401);
  assert.equal((await req(port, 'GET', '/status?t=nope')).status, 401);
  assert.equal((await req(port, 'GET', '/other')).status, 404);
});

test('запросы с чужим Host (DNS rebinding) отклоняются, preflight разрешён', async () => {
  assert.equal((await req(port, 'GET', '/status?t=' + TOKEN, { headers: { Host: 'evil.example:' + port } })).status, 421);
  assert.equal((await req(port, 'GET', '/status?t=' + TOKEN, { headers: { Host: 'localhost:' + port } })).status, 200);
  const o = await req(port, 'OPTIONS', '/stream');
  assert.equal(o.status, 204); assert.equal(o.headers['access-control-allow-private-network'], 'true');
});

test('статус показывает счётчики и состояние игры', async () => {
  const j = JSON.parse((await req(port, 'GET', '/status?t=' + TOKEN)).body);
  assert.equal(j.bridge, 1); assert.equal(j.draftSeen, true); assert.equal(j.gameState, 'DOTA_GAMERULES_STATE_HERO_SELECTION');
  assert.ok(j.packets >= 1 && j.rejected >= 4);
});

test('подсказка, если в фазе выбора героев блок draft не пришёл', async () => {
  const logs = []; const h = createHub({ token: TOKEN, log: (m) => logs.push(m) }); const p = await h.listen(0);
  await req(p, 'POST', '/gsi', { body: JSON.stringify({ auth: { token: TOKEN }, map: { game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION' } }) });
  await req(p, 'POST', '/gsi', { body: JSON.stringify({ auth: { token: TOKEN }, map: { game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION' } }) });
  assert.equal(logs.filter((m) => /блок draft не пришёл/.test(m)).length, 1, 'сообщение выводится один раз');
  assert.equal(logs.some((m) => /первый пакет/.test(m)), true);
  assert.equal(h.stat.draftSeen, false);
  await h.close();
});

test('утилита: демо-режим проигрывает драфт, --install записывает cfg, неверная папка отвергается', async () => {
  const dp = await freePort(), tok = 'cli-token-abcdef123456';
  const cli = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'gsi-bridge.js'), '--demo', '--quiet', '--port', String(dp), '--token', tok], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; cli.stdout.on('data', (c) => { out += c; });
  try {
    assert.ok(await until(() => out.includes('Мост драфта Dota Mate запущен'), 15000), out);
    assert.match(out, new RegExp('#/draft\\?b=127\\.0\\.0\\.1:' + dp + '&t=' + tok));
    const s = await sse(dp, '/stream?t=' + tok);
    assert.ok(await until(() => s.events.filter((e) => e.event === 'gsi').length >= 3, 20000));
    const counts = s.events.filter((e) => e.event === 'gsi').map((e) => Draft.taken(Draft.fromGSI(e.data.gsi).state).size);
    assert.ok(Math.max(...counts) > Math.min(...counts), 'драфт в демо продвигается: ' + counts);
    s.close();
  } finally { cli.kill(); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-gsi-'));
  try {
    const r1 = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'gsi-bridge.js'), '--install', dir, '--token', tok], { stdio: ['ignore', 'pipe', 'pipe'] });
    let e1 = ''; r1.stderr.on('data', (c) => { e1 += c; });
    assert.equal(await new Promise((r) => r1.on('exit', r)), 1); assert.match(e1, /нет game\/dota/);
    fs.mkdirSync(path.join(dir, 'game', 'dota'), { recursive: true });
    const r2 = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'gsi-bridge.js'), '--install', dir, '--token', tok, '--port', '7799'], { stdio: 'ignore' });
    assert.equal(await new Promise((r) => r2.on('exit', r)), 0);
    const f = fs.readFileSync(path.join(dir, 'game', 'dota', 'cfg', 'gamestate_integration', 'gamestate_integration_dotamate.cfg'), 'utf8');
    assert.match(f, new RegExp(tok)); assert.match(f, /127\.0\.0\.1:7799\/gsi/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
