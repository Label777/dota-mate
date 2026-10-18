'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sanitize, MAX_LEN } = require('../server/assistant.js');

test('sanitize: чередование ролей, обрезка, пустые и чужие роли отбрасываются', () => {
  assert.equal(sanitize('x'), null);
  assert.equal(sanitize([]), null);
  assert.equal(sanitize([{ role: 'assistant', content: 'привет' }]), null, 'без вопроса пользователя отправлять нечего');
  assert.equal(sanitize([{ role: 'user', content: '   ' }]), null);
  const r = sanitize([{ role: 'system', content: 'взлом' }, { role: 'assistant', content: 'Привет' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'я'.repeat(MAX_LEN + 500) }]);
  assert.equal(r.length, 1); assert.equal(r[0].role, 'user');
  assert.ok(r[0].content.startsWith('a\nb\n') && r[0].content.length <= MAX_LEN * 3);
  const long = []; for (let i = 0; i < 40; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  long.push({ role: 'user', content: 'последний' });
  const t = sanitize(long); assert.ok(t.length <= 12 && t[0].role === 'user' && t[t.length - 1].content.endsWith('последний'));
});

let mock, srv, base, dir, seen = [], mockMode = 'ok';
const free = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function start(env) {
  const port = await free(); const b = 'http://127.0.0.1:' + port;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ai-'));
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), PUBLIC_URL: b, DATA_DIR: d, DEV_LOGIN: '1' }, env), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(b + '/api/assistant/status'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  return { port, b, d, p };
}
const cookie = async (b, acc) => (await fetch(b + '/auth/dev?acc=' + acc, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const post = (b, c, body, extra) => fetch(b + '/api/assistant', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'X-DM': '1' }, c ? { cookie: c } : {}, extra || {}), body: JSON.stringify(body) });

test.before(async () => {
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-api-key'], ver: req.headers['anthropic-version'], body: JSON.parse(b || '{}') });
      if (mockMode === 'fail') { res.statusCode = 500; return res.end('{}'); }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'Зайди в Репутация → Жалобы.' }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  srv = await start({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE: 'http://127.0.0.1:' + mock.address().port, ASSISTANT_MODEL: 'test-model' });
  base = srv.b; dir = srv.d;
});
test.after(() => { if (srv) srv.p.kill(); if (mock) mock.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('статус: доступен, вход не выполнен', async () => {
  const j = await (await fetch(base + '/api/assistant/status')).json();
  assert.deepEqual(j, { available: true, login: false });
});
test('без входа 401, без X-DM 403, плохой JSON 400', async () => {
  assert.equal((await post(base, null, { messages: [{ role: 'user', content: 'привет' }] })).status, 401);
  const c = await cookie(base, '1001');
  assert.equal((await post(base, c, { messages: [] }, { 'X-DM': '' })).status, 403);
  assert.equal((await post(base, c, { messages: [{ role: 'assistant', content: 'hi' }] })).status, 400);
  const r = await fetch(base + '/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DM': '1', cookie: c }, body: '{oops' });
  assert.equal(r.status, 400);
});
test('запрос уходит в API с ключом, промптом и контекстом страницы; ключ в ответе не светится', async () => {
  const c = await cookie(base, '1001'); seen.length = 0;
  const r = await post(base, c, { page: 'rep', messages: [{ role: 'user', content: 'Как подать жалобу?' }] });
  assert.equal(r.status, 200);
  const txt = await r.text(); assert.ok(txt.includes('Жалобы')); assert.ok(!txt.includes('sk-test'));
  const s = seen[0];
  assert.equal(s.url, '/v1/messages'); assert.equal(s.key, 'sk-test'); assert.equal(s.ver, '2023-06-01');
  assert.equal(s.body.model, 'test-model'); assert.ok(s.body.max_tokens <= 1000);
  assert.ok(s.body.system.includes('Dota Mate') && s.body.system.includes('Репутация'));
  assert.deepEqual(s.body.messages, [{ role: 'user', content: 'Как подать жалобу?' }]);
});
test('сбой источника → 502 с понятным сообщением', async () => {
  const c = await cookie(base, '1002'); mockMode = 'fail';
  const r = await post(base, c, { messages: [{ role: 'user', content: 'привет' }] });
  mockMode = 'ok';
  assert.equal(r.status, 502); assert.ok((await r.json()).message.includes('недоступен'));
});
test('лимит сообщений на пользователя', async () => {
  const c = await cookie(base, '1003'); let last = 0;
  for (let i = 0; i < 22; i++) last = (await post(base, c, { messages: [{ role: 'user', content: 'вопрос ' + i }] })).status;
  assert.equal(last, 429);
});
test('без ключа ассистент отключён: статус и 501', async () => {
  const s2 = await start({ ANTHROPIC_API_KEY: '' });
  try {
    assert.equal((await (await fetch(s2.b + '/api/assistant/status')).json()).available, false);
    const c = await cookie(s2.b, '1001');
    assert.equal((await post(s2.b, c, { messages: [{ role: 'user', content: 'привет' }] })).status, 501);
  } finally { s2.p.kill(); fs.rmSync(s2.d, { recursive: true, force: true }); }
});
