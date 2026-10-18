'use strict';
/* Локальный мост GSI: принимает данные от клиента Dota 2 на 127.0.0.1 и отдаёт их странице Dota Mate потоком событий (SSE).
   Ничего не уходит в интернет: страница сама подключается к этому адресу. Из пакета GSI передаются только draft, часть map, сторона и Steam ID игрока (у наблюдателя всех игроков) и id героев. */
const http = require('node:http');
const crypto = require('node:crypto');
const Draft = require('../js/draft.js');

const MAX_BODY = 256 * 1024, MAX_CLIENTS = 10, HEARTBEAT_MS = 15000;

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Содержимое файла gamestate_integration_dotamate.cfg. Включены только нужные разделы. */
function cfgText(o) {
  const port = o.port || 7777, token = String(o.token || '');
  return `"Dota Mate Draft"
{
    "uri"           "http://127.0.0.1:${port}/gsi"
    "timeout"       "5.0"
    "buffer"        "0.1"
    "throttle"      "0.1"
    "heartbeat"     "5.0"
    "data"
    {
        "provider"      "0"
        "map"           "1"
        "player"        "1"
        "hero"          "1"
        "draft"         "1"
    }
    "auth"
    {
        "token"         "${token}"
    }
}
`;
}

function createHub(opts) {
  const o = Object.assign({ token: '', host: '127.0.0.1', log: () => {} }, opts);
  if (!o.token || String(o.token).length < 8) throw new Error('Нужен токен не короче 8 символов');
  const clients = new Set();
  const stat = { packets: 0, rejected: 0, lastAt: 0, draftSeen: false, gameState: null, lastDraftAt: 0 };
  let latest = null, lastKey = '', hintShown = false, boundPort = 0;

  const cors = (extra) => Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {});
  const json = (res, code, obj, extra) => { res.writeHead(code, cors(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra))); res.end(JSON.stringify(obj)); };

  /* Защита от DNS rebinding: принимаем только запросы, адресованные локальному хосту и нашему порту. */
  const hostOk = (req) => {
    const h = String(req.headers.host || '').toLowerCase();
    return h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}` || h === `[::1]:${boundPort}`;
  };
  const tokenOk = (url) => safeEq(url.searchParams.get('t') || '', o.token);

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const c of clients) { try { c.write(`event: gsi\ndata: ${data}\n\n`); } catch (e) { clients.delete(c); } }
  }

  function describe(st) {
    const f = (l) => l.length ? l.join(',') : '—';
    return `Radiant: выбор ${f(st.picks.radiant)}, баны ${f(st.bans.radiant)}; Dire: выбор ${f(st.picks.dire)}, баны ${f(st.bans.dire)}`;
  }

  function ingest(body) {
    let p;
    try { p = JSON.parse(body); } catch (e) { stat.rejected++; return 400; }
    if (!p || typeof p !== 'object') { stat.rejected++; return 400; }
    const auth = p.auth && typeof p.auth === 'object' ? p.auth.token : '';
    if (!safeEq(auth || '', o.token)) { stat.rejected++; if (stat.rejected === 1) o.log('Пакет с неверным токеном отклонён. Проверьте, что файл cfg создан этим мостом.'); return 401; }
    const first = stat.packets === 0;
    stat.packets++; stat.lastAt = Date.now();
    const slim = Draft.pickGSI(p);
    const r = Draft.fromGSI(slim);
    if (r.gameState) stat.gameState = r.gameState;
    if (first) o.log('Получен первый пакет от Dota 2. Связь работает.');
    if (r.hasDraft) {
      stat.draftSeen = true; stat.lastDraftAt = Date.now();
      const key = JSON.stringify([r.state.picks, r.state.bans, r.state.active]);
      if (key !== lastKey) { lastKey = key; o.log('Драфт: ' + describe(r.state)); }
    } else if (!hintShown && r.gameState === 'DOTA_GAMERULES_STATE_HERO_SELECTION') {
      hintShown = true;
      o.log('Игра в фазе выбора героев, но блок draft не пришёл. Возможно, этот режим или клиент его не отдаёт. Ведите драфт на сайте вручную.');
    }
    latest = { gsi: slim, at: Date.now() };
    broadcast({ gsi: slim, at: latest.at });
    return 200;
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
    if (!hostOk(req)) { res.writeHead(421, { 'Content-Type': 'text/plain' }); return res.end('bad host'); }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors()); return res.end(); }

    if (req.method === 'POST' && url.pathname === '/gsi') {
      let size = 0, chunks = [], dead = false;
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { dead = true; res.writeHead(413); res.end(); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { if (dead) return; const code = ingest(Buffer.concat(chunks).toString('utf8')); res.writeHead(code); res.end(); });
      req.on('error', () => {});
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      if (!tokenOk(url)) return json(res, 401, { error: 'token' });
      return json(res, 200, { bridge: 1, packets: stat.packets, rejected: stat.rejected, lastAt: stat.lastAt, draftSeen: stat.draftSeen, gameState: stat.gameState, clients: clients.size });
    }
    if (req.method === 'GET' && url.pathname === '/stream') {
      if (!tokenOk(url)) return json(res, 401, { error: 'token' });
      if (clients.size >= MAX_CLIENTS) return json(res, 503, { error: 'busy' });
      res.writeHead(200, cors({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }));
      res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ bridge: 1, packets: stat.packets, lastAt: stat.lastAt, draftSeen: stat.draftSeen })}\n\n`);
      if (latest) res.write(`event: gsi\ndata: ${JSON.stringify(latest)}\n\n`);
      clients.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* закроется ниже */ } }, o.heartbeat || HEARTBEAT_MS);
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  server.keepAliveTimeout = 5000;

  return {
    server, stat, ingest, clients,
    listen(port) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port || 0, o.host, () => { boundPort = server.address().port; resolve(boundPort); }); }); },
    close() { for (const c of clients) { try { c.end(); } catch (e) { /* уже закрыт */ } } clients.clear(); return new Promise((r) => server.close(r)); }
  };
}

module.exports = { createHub, cfgText, MAX_BODY };
