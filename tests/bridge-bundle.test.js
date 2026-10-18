'use strict';
/* Единый файл моста bridge/dota-mate-bridge.js: актуален, автономен (запускается из пустой папки) и работает так же, как исходники. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { build } = require('../tools/build-bridge.js');

const BUNDLE = path.join(__dirname, '..', 'bridge', 'dota-mate-bridge.js');
const get = (port, p) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: p, agent: false }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b })); }).on('error', reject); });
const freePort = () => new Promise((res) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('собранный файл совпадает с исходниками (после правок выполните node tools/build-bridge.js)', () => {
  assert.strictEqual(fs.readFileSync(BUNDLE, 'utf8'), build());
});

test('в собранном файле нет относительных require', () => {
  assert.ok(!/require\('\.\.?\//.test(fs.readFileSync(BUNDLE, 'utf8')));
});

test('--help работает из пустой папки', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-bridge-'));
  fs.copyFileSync(BUNDLE, path.join(dir, 'dota-mate-bridge.js'));
  const r = spawnSync(process.execPath, [path.join(dir, 'dota-mate-bridge.js'), '--help'], { encoding: 'utf8', cwd: dir, timeout: 15000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /локальный мост драфта/);
});

test('мост из одного файла принимает демо-пакеты и не пускает без токена', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-bridge-'));
  fs.copyFileSync(BUNDLE, path.join(dir, 'dota-mate-bridge.js'));
  const port = await freePort(), token = 'bundle-token-0123456789';
  const p = spawn(process.execPath, [path.join(dir, 'dota-mate-bridge.js'), '--port', String(port), '--token', token, '--demo', '--quiet'], { cwd: dir, env: Object.assign({}, process.env, { HOME: dir, USERPROFILE: dir }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  try {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) { try { ok = (await get(port, '/status?t=' + token)).status === 200; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(ok, 'мост не запустился: ' + out);
    assert.strictEqual((await get(port, '/status?t=wrong-wrong-wrong')).status, 401);
    const st = JSON.parse((await get(port, '/status?t=' + token)).body);
    assert.ok(st.packets >= 1, 'демо должно присылать пакеты: ' + JSON.stringify(st));
    assert.match(out, new RegExp('#/draft\\?b=127\\.0\\.0\\.1:' + port + '&t=' + token));
    assert.match(out, /никуда не отправляются/);
  } finally { p.kill(); await new Promise((r) => p.once('exit', r)); }
});
