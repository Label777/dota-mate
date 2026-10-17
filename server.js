'use strict';
/*
 * Dota Mate: сервер без внешних зависимостей (Node.js 18+).
 *  - вход через Steam OpenID (пароль Steam сайт не видит, API-ключ не нужен)
 *  - сессии в подписанной cookie
 *  - хранение состояния каждого пользователя в отдельном JSON-файле
 *  - прокси к OpenDota (только матчи самого пользователя и сами матчи)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = PUBLIC_URL.startsWith('https://');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS = path.join(DATA, 'users');
const DEV_LOGIN = process.env.DEV_LOGIN === '1'; // только для локальной проверки
const OFF = 76561197960265728n;
const SESSION_DAYS = 30;
const BODY_LIMIT = 2 * 1024 * 1024;

fs.mkdirSync(USERS, { recursive: true });

/* ---------- секрет для подписи сессий ---------- */
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA, 'secret.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* создаём ниже */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

/* ---------- утилиты ---------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const good = Buffer.from(crypto.createHmac('sha256', SECRET).update(body).digest('base64url'));
  if (mac.length !== good.length || !crypto.timingSafeEqual(mac, good)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p.acc !== 'string' || !/^\d{1,10}$/.test(p.acc) || !(p.exp > Date.now())) return null;
    return p;
  } catch (e) { return null; }
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const sessionCookie = (token, maxAge) =>
  `dm_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`;
const session = (req) => verify(cookies(req).dm_session);

const SEC_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https://*.steamstatic.com https://*.akamaihd.net; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({}, SEC_HEADERS, headers || {}));
  res.end(body);
}
function json(res, code, obj, headers) {
  send(res, code, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Защита от запросов с чужих сайтов: нужен свой заголовок и совпадающий Origin. */
function sameSiteOk(req) {
  if (req.headers['x-dm'] !== '1') return false;
  const o = req.headers.origin;
  return !o || o === new URL(PUBLIC_URL).origin;
}

/* ---------- хранилище ---------- */
const userFile = (acc) => path.join(USERS, acc + '.json');
function readUser(acc) {
  try { return JSON.parse(fs.readFileSync(userFile(acc), 'utf8')); } catch (e) { return { meta: { acc }, state: null }; }
}
function writeUser(acc, obj) {
  const f = userFile(acc), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/* ---------- Steam OpenID ---------- */
const STEAM = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const RETURN_TO = PUBLIC_URL + '/auth/steam/return';
const usedNonces = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of usedNonces) if (v < t) usedNonces.delete(k); }, 600000).unref();

function steamRedirectUrl() {
  const p = new URLSearchParams({
    'openid.ns': NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': RETURN_TO,
    'openid.realm': PUBLIC_URL,
    'openid.identity': NS + '/identifier_select',
    'openid.claimed_id': NS + '/identifier_select',
  });
  return STEAM + '?' + p.toString();
}
async function verifySteam(q) {
  const need = ['claimed_id', 'identity', 'return_to', 'response_nonce', 'op_endpoint'];
  const signed = String(q.get('openid.signed') || '').split(',');
  if (q.get('openid.mode') !== 'id_res' || q.get('openid.ns') !== NS) throw new Error('bad mode');
  if (q.get('openid.return_to') !== RETURN_TO) throw new Error('bad return_to');
  if (q.get('openid.op_endpoint') !== STEAM) throw new Error('bad endpoint');
  if (!need.every((k) => signed.includes(k))) throw new Error('unsigned fields');
  const claimed = q.get('openid.claimed_id') || '';
  const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed);
  if (!m || q.get('openid.identity') !== claimed) throw new Error('bad identity');
  const nonce = q.get('openid.response_nonce') || '';
  if (!nonce || usedNonces.has(nonce)) throw new Error('replayed nonce');

  const p = new URLSearchParams();
  for (const [k, v] of q) if (k.startsWith('openid.')) p.set(k, v);
  p.set('openid.mode', 'check_authentication');
  const r = await fetch(STEAM, { method: 'POST', body: p, signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  if (!/^\s*is_valid\s*:\s*true\s*$/m.test(text)) throw new Error('steam rejected');
  usedNonces.set(nonce, Date.now() + 3600000);
  const acc = BigInt(m[1]) - OFF;
  if (acc <= 0n || acc > 4294967295n) throw new Error('bad id');
  return acc.toString();
}
async function fetchProfile(acc) {
  try {
    const r = await fetch('https://api.opendota.com/api/players/' + acc, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return {};
    const j = await r.json();
    const pr = (j && j.profile) || {};
    let avatar = '';
    try {
      const u = new URL(pr.avatarfull || '');
      if (u.protocol === 'https:' && /(steamstatic\.com|akamaihd\.net)$/.test(u.hostname)) avatar = u.href;
    } catch (e) { /* без аватара */ }
    return { name: String(pr.personaname || '').slice(0, 40), avatar };
  } catch (e) { return {}; }
}

/* ---------- прокси OpenDota ---------- */
const OD = 'https://api.opendota.com/api';
let chain = Promise.resolve();
function upstream(url) {
  const p = chain.then(() => sleep(250)).then(() => fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'dota-mate/1.0' } }));
  chain = p.catch(() => {});
  return p;
}
const cache = new Map();
const hits = new Map();
function limited(acc, max) {
  const now = Date.now(), arr = (hits.get(acc) || []).filter((t) => t > now - 600000);
  if (arr.length >= (max || 60)) { hits.set(acc, arr); return true; }
  arr.push(now); hits.set(acc, arr); return false;
}
async function proxyOD(req, res, url, sess) {
  let target, ttl, slim = false;
  let m = /^\/api\/od\/players\/(\d+)\/matches$/.exec(url.pathname);
  if (m) {
    if (m[1] !== sess.acc) return json(res, 403, { error: 'forbidden' });
    const n = Math.min(30, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 15));
    target = `${OD}/players/${m[1]}/matches?limit=${n}`; ttl = 60000;
  } else if ((m = /^\/api\/od\/players\/(\d{1,10})$/.exec(url.pathname))) {
    target = `${OD}/players/${m[1]}`; ttl = 6 * 3600000; slim = true;
  } else if ((m = /^\/api\/od\/matches\/(\d{6,13})$/.exec(url.pathname))) {
    target = `${OD}/matches/${m[1]}`; ttl = 600000;
  } else return json(res, 404, { error: 'not found' });

  if (slim ? limited(sess.acc + ':p', 200) : limited(sess.acc)) return json(res, 429, { error: 'rate' });
  const c = cache.get(target);
  if (c && c.t > Date.now()) return send(res, 200, c.body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  try {
    const r = await upstream(target);
    let body = await r.text();
    if (r.ok) {
      if (slim) {
        try {
          const j = JSON.parse(body), pr = (j && j.profile) || null;
          body = JSON.stringify({ profile: pr ? { personaname: pr.personaname, avatarmedium: pr.avatarmedium, avatarfull: pr.avatarfull } : null });
        } catch (e) { return json(res, 502, { error: 'bad upstream' }); }
      }
      cache.set(target, { t: Date.now() + ttl, body });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return send(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    return json(res, r.status === 429 ? 429 : r.status === 404 ? 404 : 502, { error: 'upstream ' + r.status });
  } catch (e) { return json(res, 502, { error: 'upstream unreachable' }); }
}

/* ---------- маршруты ---------- */
const INDEX = path.join(__dirname, 'index.html');

async function handle(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname, method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, fs.readFileSync(INDEX), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  if (method === 'GET' && p === '/auth/steam') {
    return send(res, 302, '', { Location: steamRedirectUrl() });
  }
  if (method === 'GET' && p === '/auth/steam/return') {
    try {
      const acc = await verifySteam(url.searchParams);
      const prof = await fetchProfile(acc);
      const u = readUser(acc);
      u.meta = Object.assign({}, u.meta, { acc, name: prof.name || (u.meta && u.meta.name) || '', avatar: prof.avatar || '', seen: Date.now() });
      writeUser(acc, u);
      const token = sign({ acc, exp: Date.now() + SESSION_DAYS * 86400000 });
      return send(res, 302, '', { Location: '/', 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
    } catch (e) {
      return send(res, 400, '<meta charset="utf-8"><title>Dota Mate</title><body style="font-family:sans-serif;background:#13151a;color:#e8e6e1;padding:32px"><h1>Не удалось войти через Steam</h1><p>Попробуйте ещё раз.</p><p><a style="color:#e9a2a6" href="/">Вернуться на сайт</a></p>', { 'Content-Type': 'text/html; charset=utf-8' });
    }
  }
  if (DEV_LOGIN && method === 'GET' && p === '/auth/dev') {
    const acc = url.searchParams.get('acc') || '';
    if (!/^\d{1,10}$/.test(acc)) return json(res, 400, { error: 'bad acc' });
    const u = readUser(acc); u.meta = Object.assign({}, u.meta, { acc, name: 'Dev ' + acc });
    writeUser(acc, u);
    return send(res, 302, '', { Location: '/', 'Set-Cookie': sessionCookie(sign({ acc, exp: Date.now() + 86400000 }), 86400) });
  }
  if (method === 'POST' && p === '/auth/logout') {
    if (!sameSiteOk(req)) return json(res, 403, { error: 'forbidden' });
    return send(res, 204, '', { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (p === '/api/session' && method === 'GET') {
    const s = session(req);
    if (!s) return json(res, 401, { server: true, error: 'no session' });
    const meta = readUser(s.acc).meta || {};
    return json(res, 200, { server: true, user: { acc: s.acc, name: meta.name || '', avatar: meta.avatar || '' } });
  }

  if (p.startsWith('/api/')) {
    const s = session(req);
    if (!s) return json(res, 401, { error: 'no session' });
    if (p.startsWith('/api/od/') && method === 'GET') return proxyOD(req, res, url, s);

    if (p === '/api/state' && method === 'GET') {
      return json(res, 200, { state: readUser(s.acc).state || null });
    }
    if (p === '/api/state' && method === 'PUT') {
      if (!sameSiteOk(req)) return json(res, 403, { error: 'forbidden' });
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json only' });
      let st;
      try { st = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: 'bad body' }); }
      if (!st || typeof st !== 'object' || st.v !== 1 || !Array.isArray(st.matches) || st.matches.length > 5000 ||
          typeof st.reviews !== 'object' || typeof st.pnotes !== 'object') return json(res, 400, { error: 'bad state' });
      st.demo = false;
      st.me = Object.assign({}, st.me, { acc: s.acc });
      const u = readUser(s.acc);
      u.state = st;
      writeUser(s.acc, u);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/account' && method === 'DELETE') {
      if (!sameSiteOk(req)) return json(res, 403, { error: 'forbidden' });
      try { fs.unlinkSync(userFile(s.acc)); } catch (e) { /* уже удалён */ }
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    return json(res, 404, { error: 'not found' });
  }
  return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.end();
  });
}).listen(PORT, () => console.log(`Dota Mate: ${PUBLIC_URL} (порт ${PORT})${DEV_LOGIN ? ' [DEV_LOGIN включён]' : ''}`));
