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
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (over) return;                              // лишнее читаем и выбрасываем, чтобы ответить 413, а не оборвать соединение
      if (size > (limit || BODY_LIMIT)) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(Object.assign(new Error('too large'), { code: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
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
const OD = (process.env.OPENDOTA_BASE || 'https://api.opendota.com/api').replace(/\/$/, '');   // OPENDOTA_BASE нужен только для тестов с поддельным источником
let chain = Promise.resolve();
function upstream(url) {
  const p = chain.then(() => sleep(250)).then(() => fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'dota-mate/1.0' } }));
  chain = p.catch(() => {});
  return p;
}
const cache = new Map();
const hits = new Map();
function limited(acc, max, weight) {
  const now = Date.now(), arr = (hits.get(acc) || []).filter((t) => t > now - 600000);
  if (arr.length >= (max || 60)) { hits.set(acc, arr); return true; }
  for (let i = 0; i < (weight || 1); i++) arr.push(now);
  hits.set(acc, arr);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return false;
}
const OD_KEY = process.env.OPENDOTA_API_KEY || '';   // необязательно: повышает лимиты OpenDota, в браузер не попадает
const STEAM_KEY = process.env.STEAM_API_KEY || '';     // необязательно: нужен только для разбора ссылок вида /id/имя
const PROJECTS = new Set(['gold_per_min', 'xp_per_min', 'last_hits', 'denies', 'lane_role', 'is_roaming', 'hero_id', 'start_time', 'duration', 'kills', 'deaths', 'assists']);
const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const pick = (o, keys) => { const r = {}; keys.forEach((k) => { if (o && o[k] !== undefined) r[k] = o[k]; }); return r; };
function slimPlayer(j) {
  const pr = (j && j.profile) || null;
  return {
    profile: pr ? pick(pr, ['account_id', 'personaname', 'avatarmedium', 'avatarfull', 'profileurl', 'steamid', 'last_login']) : null,
    rank_tier: j && j.rank_tier != null ? j.rank_tier : null,
    leaderboard_rank: j && j.leaderboard_rank != null ? j.leaderboard_rank : null
  };
}
/** Чистим и упорядочиваем параметры страницы матчей: наружу уходит только то, что мы сами разрешили. */
function matchesQuery(sp) {
  const limit = Math.min(500, Math.max(1, parseInt(sp.get('limit'), 10) || 100));
  const offset = Math.min(100000, Math.max(0, parseInt(sp.get('offset'), 10) || 0));
  const proj = sp.getAll('project').filter((f) => PROJECTS.has(f)).slice(0, 8);
  const inc = /^\d{1,10}$/.test(sp.get('included_account_id') || '') ? `&included_account_id=${sp.get('included_account_id')}` : '';
  return `limit=${limit}&offset=${offset}` + inc + proj.map((f) => `&project=${f}`).join('');
}
async function proxyOD(req, res, url, who) {
  let target, ttl, shape = null, weight = 1;
  const pn = url.pathname;
  let m;
  if ((m = /^\/api\/od\/players\/(\d{1,10})\/matches$/.exec(pn))) {
    target = `${OD}/players/${m[1]}/matches?${matchesQuery(url.searchParams)}`; ttl = 300000; weight = 2;
  } else if ((m = /^\/api\/od\/players\/(\d{1,10})\/peers$/.exec(pn))) {
    const dt = Math.min(365, Math.max(0, parseInt(url.searchParams.get('date'), 10) || 0));
    target = `${OD}/players/${m[1]}/peers` + (dt ? `?date=${dt}` : ''); ttl = 1800000; weight = 2;
  } else if ((m = /^\/api\/od\/players\/(\d{1,10})\/(wl|ratings)$/.exec(pn))) {
    target = `${OD}/players/${m[1]}/${m[2]}`; ttl = m[2] === 'wl' ? 300000 : 3600000;
  } else if ((m = /^\/api\/od\/players\/(\d{1,10})$/.exec(pn))) {
    target = `${OD}/players/${m[1]}`; ttl = 3600000; shape = slimPlayer;
  } else if (pn === '/api/od/heroes') {
    target = `${OD}/heroes`; ttl = 86400000;
  } else if ((m = /^\/api\/od\/matches\/(\d{6,13})$/.exec(pn))) {
    target = `${OD}/matches/${m[1]}`; ttl = 600000;
  } else return json(res, 404, { error: 'not found' });

  const c = cache.get(target);
  if (c && c.t > Date.now()) return send(res, 200, c.body, JSON_H);
  if (limited(who, 300 * weight, weight)) return json(res, 429, { error: 'rate' }, { 'Retry-After': '60' });
  try {
    const r = await upstream(OD_KEY ? target + (target.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(OD_KEY) : target);
    let body = await r.text();
    if (r.ok) {
      if (shape) {
        try { body = JSON.stringify(shape(JSON.parse(body))); } catch (e) { return json(res, 502, { error: 'bad upstream' }); }
      }
      cache.set(target, { t: Date.now() + ttl, body });
      if (cache.size > 400) cache.delete(cache.keys().next().value);
      return send(res, 200, body, JSON_H);
    }
    const ra = r.headers.get('retry-after');
    return json(res, r.status === 429 ? 429 : r.status === 404 ? 404 : 502, { error: 'upstream ' + r.status }, r.status === 429 && ra ? { 'Retry-After': ra } : undefined);
  } catch (e) { return json(res, 502, { error: 'upstream unreachable' }); }
}

/** Ссылка вида steamcommunity.com/id/имя -> SteamID64. Работает только с STEAM_API_KEY (официальный Steam Web API). */
const vanityCache = new Map();
async function resolveVanity(res, name, who) {
  if (!STEAM_KEY) return json(res, 501, { error: 'no_key' });
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(name)) return json(res, 400, { error: 'bad name' });
  const hit = vanityCache.get(name);
  if (hit && hit.t > Date.now()) return json(res, 200, hit.v);
  if (limited(who + ':v', 30)) return json(res, 429, { error: 'rate' });
  try {
    const r = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(STEAM_KEY)}&vanityurl=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return json(res, 502, { error: 'steam ' + r.status });
    const j = (await r.json()).response || {};
    const v = j.success === 1 && /^\d{17}$/.test(String(j.steamid)) ? { steam64: String(j.steamid) } : { steam64: null };
    vanityCache.set(name, { t: Date.now() + 3600000, v });
    if (vanityCache.size > 500) vanityCache.delete(vanityCache.keys().next().value);
    return json(res, 200, v);
  } catch (e) { return json(res, 502, { error: 'steam unreachable' }); }
}

/* ---------- маршруты ---------- */
const INDEX = path.join(__dirname, 'index.html');

async function handle(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname, method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, fs.readFileSync(INDEX), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  const asset = method === 'GET' && /^\/(js|css)\/[A-Za-z0-9._-]+\.(js|css)$/.exec(p);
  if (asset) {
    const f = path.join(__dirname, p);
    if (!f.startsWith(path.join(__dirname, asset[1]) + path.sep) || !fs.existsSync(f)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return send(res, 200, fs.readFileSync(f), { 'Content-Type': (asset[2] === 'js' ? 'text/javascript' : 'text/css') + '; charset=utf-8', 'Cache-Control': 'no-cache' });
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

  /* Публичные данные OpenDota доступны и без входа (для поиска любого игрока), лимит считается по адресу или по аккаунту. */
  if (method === 'GET' && (p.startsWith('/api/od/') || p === '/api/steam/resolve')) {
    const s0 = session(req);
    const who = s0 ? s0.acc : 'ip:' + (req.socket.remoteAddress || '');
    if (p === '/api/steam/resolve') return resolveVanity(res, url.searchParams.get('vanity') || '', who);
    return proxyOD(req, res, url, who);
  }

  /* Запрос разбора матча у OpenDota: открытая операция, только с этого же сайта, строго ограниченная по частоте. */
  const rq = method === 'POST' && /^\/api\/od\/request\/(\d{6,13})$/.exec(p);
  if (rq) {
    if (!sameSiteOk(req)) return json(res, 403, { error: 'forbidden' });
    const s0 = session(req), who = (s0 ? s0.acc : 'ip:' + (req.socket.remoteAddress || '')) + ':req';
    if (limited(who, 30)) return json(res, 429, { error: 'rate' }, { 'Retry-After': '60' });
    try {
      const r = await fetch(`${OD}/request/${rq[1]}` + (OD_KEY ? '?api_key=' + encodeURIComponent(OD_KEY) : ''), { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'dota-mate/1.0' } });
      const t = await r.text();
      return r.ok ? send(res, 200, t, JSON_H) : json(res, r.status === 429 ? 429 : 502, { error: 'upstream ' + r.status });
    } catch (e) { return json(res, 502, { error: 'upstream unreachable' }); }
  }

  /* Ассистент (ИИ): только для вошедших, с лимитами. Без ANTHROPIC_API_KEY отключён, сайт показывает встроенную справку. */
  if (p === '/api/assistant/status' && method === 'GET') {
    return json(res, 200, { available: assistant.enabled, login: !!session(req) });
  }
  if (p === '/api/assistant' && method === 'POST') {
    if (!sameSiteOk(req)) return json(res, 403, { error: 'forbidden' });
    if (!assistant.enabled) return json(res, 501, { error: 'unavailable', message: 'Ассистент не настроен на этом сервере.' });
    const sa = session(req);
    if (!sa) return json(res, 401, { error: 'auth', message: 'Войдите через Steam, чтобы писать ассистенту.' });
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json only' });
    if (limited(sa.acc + ':ai', 20) || limited('global:ai', 300)) return json(res, 429, { error: 'rate_limit', message: 'Слишком много сообщений. Подождите несколько минут.' }, { 'Retry-After': '120' });
    let b;
    try { b = JSON.parse(await readBody(req, 32 * 1024)); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: 'bad body' }); }
    const msgs = require('./server/assistant.js').sanitize(b && b.messages);
    if (!msgs) return json(res, 400, { error: 'validation', message: 'Напишите сообщение.' });
    try { return json(res, 200, { reply: await assistant.ask(msgs, { page: b.page }) }); }
    catch (e) { return json(res, e.code === 'rate' ? 429 : 502, { error: 'upstream', message: 'Ассистент сейчас недоступен. Попробуйте позже.' }); }
  }

  /* Сообщество: жалобы, модерация, обжалования, список наблюдения. Все проверки выполняются в server/community.js. */
  if (p.startsWith('/api/c/') || p === '/api/c') {
    const s0 = session(req);
    const who = s0 ? s0.acc : 'ip:' + (req.socket.remoteAddress || '');
    const sub = p.slice(6) || '/';
    if (!community) {
      if (method === 'GET' && sub === '/status') return json(res, 200, { available: false, reason: communityError });
      return json(res, 501, { error: 'unavailable', message: 'Функции сообщества отключены: ' + communityError });
    }
    if (method !== 'GET' && !sameSiteOk(req)) return json(res, 403, { error: 'forbidden', message: 'Запрос отклонён: нужен заголовок X-DM и тот же сайт.' });
    if (limited(who + ':c' + (method === 'GET' ? 'r' : 'w'), method === 'GET' ? 600 : 120)) return json(res, 429, { error: 'rate_limit', message: 'Слишком много запросов, подождите минуту.' }, { 'Retry-After': '60' });
    let body = {};
    if (method === 'POST' || method === 'PUT') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json only' });
      try { body = JSON.parse((await readBody(req, 20 * 1024)) || '{}'); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: 'bad body' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'bad body' });
    }
    const user = s0 ? { acc: s0.acc } : null;
    const q = {}; url.searchParams.forEach((v, k) => { q[k] = v; });
    const r = await community.route(method, sub, { user, query: q, body });
    return json(res, r.status, r.body);
  }

  if (p.startsWith('/api/')) {
    const s = session(req);
    if (!s) return json(res, 401, { error: 'no session' });

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

/* ---------- ассистент ---------- */
const assistant = require('./server/assistant.js').create({
  key: process.env.ANTHROPIC_API_KEY || '', base: (process.env.ANTHROPIC_BASE || 'https://api.anthropic.com').replace(/\/$/, ''),
  model: process.env.ASSISTANT_MODEL || 'claude-sonnet-5-5',
  prompt: (() => { try { return fs.readFileSync(path.join(__dirname, 'server', 'assistant-prompt.txt'), 'utf8'); } catch (e) { return ''; } })()
});

/* ---------- сообщество (SQLite) ---------- */
let community = null, communityError = '';
async function fetchMatchDetail(id) {
  const target = `${OD}/matches/${id}`, c = cache.get(target);
  let text;
  if (c && c.t > Date.now()) text = c.body;
  else {
    const r = await upstream(OD_KEY ? target + '?api_key=' + encodeURIComponent(OD_KEY) : target);
    if (r.status === 404) throw Object.assign(new Error('not found'), { code: 'not_found' });
    if (!r.ok) throw Object.assign(new Error('upstream ' + r.status), { code: 'upstream' });
    text = await r.text();
    cache.set(target, { t: Date.now() + 600000, body: text });
  }
  return JSON.parse(text);
}
try {
  const dbm = require('./server/db.js');
  const db = dbm.open(process.env.DB_FILE || path.join(DATA, 'dotamate.sqlite'));
  const mods = require('./server/community.js').parseModerators(process.env.MODERATORS);
  community = require('./server/community.js').create({ db, fetchMatch: fetchMatchDetail, moderators: mods, log: (e) => console.error('community:', e) });
  console.log('Сообщество: база готова, модераторов: ' + mods.size + (mods.size ? '' : ' (задайте MODERATORS, иначе модерация недоступна)'));
} catch (e) {
  communityError = e.code === 'NO_SQLITE' ? 'нужен Node.js 22.5 или новее (модуль node:sqlite)' : String(e.message || e).slice(0, 200);
  console.error('Сообщество отключено: ' + communityError);
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.end();
  });
}).listen(PORT, () => console.log(`Dota Mate: ${PUBLIC_URL} (порт ${PORT})${DEV_LOGIN ? ' [DEV_LOGIN включён]' : ''}`));
