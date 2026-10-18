'use strict';
/* Интеграция: настоящий server.js + поддельный OpenDota, настоящая SQLite-база во временной папке. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const NOW = Math.floor(Date.now() / 1000);
let od, srv, base, dir, odHits = 0;
const players = [1001, 2002, 3003, 9009].map((a, i) => ({ account_id: a, hero_id: i + 1, player_slot: i, kills: 1, deaths: a === 2002 ? 18 : 2, assists: 3 }));

function freePort() { return new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function cookieFor(acc) {
  const r = await fetch(base + '/auth/dev?acc=' + acc, { redirect: 'manual' });
  return r.headers.get('set-cookie').split(';')[0];
}
const call = (method, p, o) => fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, o && o.cookie ? { Cookie: o.cookie } : {}, o && o.csrf === false ? {} : { 'X-DM': '1' }), body: o && o.body ? JSON.stringify(o.body) : undefined });
const rep = { target: '2002', matchId: '7000000001', category: 'feeding', description: 'Умышленно умирал всю игру подряд', evidence: [], consent: true };

test.before(async () => {
  od = http.createServer((req, res) => {
    odHits++;
    const m = /^\/matches\/(\d+)/.exec(req.url);
    if (m && m[1] === '7000000001') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ match_id: 7000000001, start_time: NOW - 3600, duration: 2400, players })); }
    let q;
    if ((q = /^\/heroes\/(\d+)\/matchups$/.exec(req.url))) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify([2, 3, 4, 5, 6].map((h) => ({ hero_id: h, games_played: 100 + h, wins: 40 + h, лишнее: 1 })))); }
    if ((q = /^\/players\/(\d+)\/heroes$/.exec(req.url))) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify([{ hero_id: 2, games: 10, win: 6, last_played: 1700000000, with_games: 3 }])); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => od.listen(0, '127.0.0.1', r));
  const port = await freePort();
  base = 'http://127.0.0.1:' + port;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), PUBLIC_URL: base, DATA_DIR: dir, DEV_LOGIN: '1', MODERATORS: '9009', OPENDOTA_BASE: 'http://127.0.0.1:' + od.address().port }), stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/c/status'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
});
test.after(() => { if (srv) srv.kill(); if (od) od.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('статус публичен и показывает, что сообщество доступно', async () => {
  const j = await (await call('GET', '/api/c/status')).json();
  assert.equal(j.available, true); assert.equal(j.user, null);
});
test('жалоба без входа → 401; без заголовка X-DM → 403', async () => {
  assert.equal((await call('POST', '/api/c/reports', { body: rep })).status, 401);
  const c = await cookieFor('1001');
  assert.equal((await call('POST', '/api/c/reports', { body: rep, cookie: c, csrf: false })).status, 403);
});
test('полный цикл: жалоба → подтверждение → публичная отметка → обжалование → снятие', async () => {
  const user = await cookieFor('1001'), target = await cookieFor('2002'), mod = await cookieFor('9009');
  const st = await (await call('GET', '/api/c/status', { cookie: mod })).json();
  assert.equal(st.user.moderator, true);
  const r = await call('POST', '/api/c/reports', { body: rep, cookie: user });
  assert.equal(r.status, 201);
  const id = (await r.json()).id;
  assert.equal((await call('POST', '/api/c/reports', { body: rep, cookie: user })).status, 409, 'повторная отправка отклонена');
  assert.equal((await call('GET', '/api/c/mod/reports', { cookie: user })).status, 403);
  let pub = await (await call('GET', '/api/c/player/2002')).json();
  assert.deepEqual(pub.confirmed, []); assert.equal(pub.unconfirmed.hidden, true);
  const ok = await call('POST', `/api/c/mod/reports/${id}/status`, { cookie: mod, body: { to: 'confirmed', reason: 'Реплей подтверждает умышленные смерти', publicReason: 'Умышленные смерти' } });
  assert.equal(ok.status, 200);
  pub = await (await call('GET', '/api/c/player/2002')).json();
  assert.equal(pub.confirmed.length, 1);
  const ap = await call('POST', '/api/c/appeals', { cookie: target, body: { reportId: id, text: 'Не согласен, это была смена стратегии' } });
  assert.equal(ap.status, 201);
  pub = await (await call('GET', '/api/c/player/2002')).json();
  assert.equal(pub.confirmed.length, 0); assert.equal(pub.disputed.length, 1);
  const dec = await call('POST', `/api/c/mod/appeals/${(await ap.json()).id}`, { cookie: mod, body: { decision: 'revoke', reason: 'Повторная проверка: умысла нет' } });
  assert.equal(dec.status, 200);
  pub = await (await call('GET', '/api/c/player/2002')).json();
  assert.equal(pub.disputed.length, 0);
  const log = await (await call('GET', '/api/c/mod/log', { cookie: mod })).json();
  assert.ok(log.log.length >= 4);
});
test('несуществующий матч → 404, чужой Steam ID в матче → 422, плохой JSON → 400', async () => {
  const c = await cookieFor('3003');
  assert.equal((await call('POST', '/api/c/reports', { cookie: c, body: Object.assign({}, rep, { matchId: '7000000009', target: '1001' }) })).status, 404);
  assert.equal((await call('POST', '/api/c/reports', { cookie: c, body: Object.assign({}, rep, { target: '4444' }) })).status, 422);
  const r = await fetch(base + '/api/c/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DM': '1', Cookie: c }, body: '{oops' });
  assert.equal(r.status, 400);
});
test('чужой Origin отклоняется', async () => {
  const c = await cookieFor('3003');
  const r = await fetch(base + '/api/c/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DM': '1', Origin: 'https://evil.example', Cookie: c }, body: JSON.stringify({ target: '123456' }) });
  assert.equal(r.status, 403);
});
test('сервер не раскрывает автора жалобы в публичной сводке', async () => {
  const txt = await (await call('GET', '/api/c/player/2002')).text();
  assert.ok(!txt.includes('1001'));
});

test('слишком большое тело запроса отклоняется (413)', async () => {
  const c = await cookieFor('3003');
  const r = await call('POST', '/api/c/reports', { cookie: c, body: Object.assign({}, rep, { description: 'я'.repeat(30000) }) });
  assert.equal(r.status, 413);
});

test('состояние аккаунта: теги и заметки по героям сохраняются, неверная форма отвергается', async () => {
  const c = await cookieFor('4004');
  const st = { v: 1, me: { acc: '4004' }, matches: [], reviews: {}, pnotes: {}, tags: { 1: ['party', 'c:Бегун'] }, heroNotes: { 1: { Pudge: 'фидит' } }, snooze: { 1: 1900000000 } };
  assert.equal((await call('PUT', '/api/state', { cookie: c, body: st })).status, 200);
  const got = (await (await call('GET', '/api/state', { cookie: c })).json()).state;
  assert.deepEqual(got.tags, { 1: ['party', 'c:Бегун'] });
  assert.deepEqual(got.heroNotes, { 1: { Pudge: 'фидит' } });
  for (const bad of [{ tags: [] }, { tags: null }, { tags: 'x' }, { heroNotes: [] }, { snooze: 5 }]) {
    assert.equal((await call('PUT', '/api/state', { cookie: c, body: Object.assign({}, st, bad) })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('PUT', '/api/state', { cookie: c, body: { v: 1, matches: [], reviews: {}, pnotes: {} } })).status, 200, 'старое состояние без новых полей принимается');
  const other = await cookieFor('5005');
  assert.deepEqual((await (await call('GET', '/api/state', { cookie: other })).json()).state, null, 'чужие данные недоступны');
});

test('прокси OpenDota: матчапы героя и герои игрока отдаются сжатыми, лишние пути закрыты', async () => {
  const m = await (await call('GET', '/api/od/heroes/14/matchups')).json();
  assert.ok(Array.isArray(m) && m.length > 3);
  assert.deepEqual(Object.keys(m[0]).sort(), ['games_played', 'hero_id', 'wins'], 'лишние поля отброшены');
  const h = await (await call('GET', '/api/od/players/1001/heroes')).json();
  assert.deepEqual(Object.keys(h[0]).sort(), ['games', 'hero_id', 'last_played', 'win']);
  for (const bad of ['/api/od/heroes/abc/matchups', '/api/od/heroes/99999/matchups', '/api/od/players/12345678901/heroes', '/api/od/heroes/14/matchups/x', '/api/od/heroes/14']) {
    assert.equal((await call('GET', bad)).status, 404, bad);
  }
});
