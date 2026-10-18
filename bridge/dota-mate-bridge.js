#!/usr/bin/env node
'use strict';
/* Dota Mate: локальный мост драфта (один файл, без зависимостей, нужен Node.js 18+).
   Файл собран из js/draft.js, server/gsi-hub.js и tools/gsi-bridge.js командой "node tools/build-bridge.js". Не правьте его руками.
   Мост слушает только 127.0.0.1, принимает данные Game State Integration от Dota 2 и отдаёт странице «Драфт» только блок draft,
   часть map и сторону игрока. В интернет он ничего не отправляет. Подробности: README проекта, раздел «Драфт». */
const __M = {};
__M.draft = (function () { const module = { exports: {} }; const exports = module.exports;
/* Dota Mate: драфт героев. Модель, разбор данных Game State Integration (GSI) из клиента Dota 2, ручной ввод, события, подсказки.
   Чистая логика без DOM и сети: работает в браузере, в Node (тесты) и в локальном мосте tools/gsi-bridge.js.

   Формат блока draft в GSI взят из описаний открытых библиотек (xzion/dota2-gsi, antonpup/Dota2GSI):
     draft: { activeteam, pick, activeteam_time_remaining, radiant_bonus_time, dire_bonus_time,
              team2 (Radiant) и team3 (Dire): { home_team, pick0_id … pick4_id, pick0_class …, ban0_id … ban6_id, ban0_class … } }
   Игра может прислать поля не во всех режимах и не во всех фазах, поэтому разбор терпим к отсутствию любых полей. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMDraft = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIDES = ['radiant', 'dire'];
  const MAX_PICKS = 5, MAX_BANS = 7, MAX_HERO_ID = 1000, MAX_HISTORY = 50;
  const SIDE_BY_TEAM = { 2: 'radiant', 3: 'dire' };
  const other = (side) => (side === 'radiant' ? 'dire' : 'radiant');

  function empty() {
    return { picks: { radiant: [], dire: [] }, bans: { radiant: [], dire: [] }, slugs: {}, active: null, pickFlag: null, timeLeft: null, bonus: { radiant: null, dire: null }, mySide: null, gameState: null, matchId: null, source: 'manual' };
  }
  const clone = (s) => JSON.parse(JSON.stringify(s));
  const heroId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= MAX_HERO_ID ? n : 0; };
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const slugOf = (cls) => (typeof cls === 'string' && /^npc_dota_hero_[a-z0-9_]{1,40}$/.test(cls) ? cls.slice(14) : '');

  /* ---------- GSI ---------- */
  function readTeam(t, slugs) {
    const out = { picks: [], bans: [] };
    if (!t || typeof t !== 'object') return out;
    const slot = (re) => Object.keys(t).map((k) => { const m = re.exec(k); return m ? Number(m[1]) : -1; }).filter((n) => n >= 0 && n < 20).sort((a, b) => a - b);
    for (const [kind, key] of [['picks', 'pick'], ['bans', 'ban']]) {
      for (const n of slot(new RegExp('^' + key + '(\\d+)_id$'))) {
        const id = heroId(t[key + n + '_id']);
        if (!id) continue;
        if (!out[kind].includes(id)) out[kind].push(id);
        const sl = slugOf(t[key + n + '_class']);
        if (sl) slugs[id] = sl;
      }
    }
    out.picks = out.picks.slice(0, MAX_PICKS); out.bans = out.bans.slice(0, MAX_BANS);
    return out;
  }
  const sideName = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).toLowerCase();
    return s === 'radiant' || s === '2' ? 'radiant' : s === 'dire' || s === '3' ? 'dire' : null;
  };
  const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? true : v === false || v === 0 || v === '0' || v === 'false' ? false : null);

  /* Разбор тела запроса GSI. Возвращает { hasDraft, state, gameState, matchId, mySide }.
     hasDraft = false, если игра не прислала блок draft (например, не фаза выбора героев). */
  function fromGSI(p) {
    const res = { hasDraft: false, state: null, gameState: null, matchId: null, mySide: null };
    if (!p || typeof p !== 'object') return res;
    const m = p.map && typeof p.map === 'object' ? p.map : {};
    const pl = p.player && typeof p.player === 'object' ? p.player : {};
    res.gameState = typeof m.game_state === 'string' ? m.game_state.slice(0, 60) : null;
    res.matchId = m.matchid != null && /^\d{1,20}$/.test(String(m.matchid)) && String(m.matchid) !== '0' ? String(m.matchid) : null;
    res.mySide = sideName(pl.team_name) || sideName(pl.team);
    const d = p.draft;
    if (!d || typeof d !== 'object') return res;
    const has = d.team2 || d.team3 || d.activeteam !== undefined;
    if (!has) return res;
    const slugs = {};
    const r = readTeam(d.team2, slugs), di = readTeam(d.team3, slugs);
    const st = empty();
    st.picks.radiant = r.picks; st.picks.dire = di.picks; st.bans.radiant = r.bans; st.bans.dire = di.bans;
    st.slugs = slugs;
    st.active = sideName(d.activeteam);
    st.pickFlag = flag(d.pick);
    st.timeLeft = num(d.activeteam_time_remaining);
    st.bonus = { radiant: num(d.radiant_bonus_time), dire: num(d.dire_bonus_time) };
    st.mySide = res.mySide; st.gameState = res.gameState; st.matchId = res.matchId; st.source = 'gsi';
    res.hasDraft = true; res.state = st;
    return res;
  }

  /* Какие ключи GSI нужны сайту. Остальное (золото, предметы, позиция героя) мост выбрасывает и дальше не передаёт. */
  function pickGSI(p) {
    const out = {};
    if (!p || typeof p !== 'object') return out;
    if (p.draft && typeof p.draft === 'object') out.draft = p.draft;
    if (p.map && typeof p.map === 'object') out.map = { game_state: p.map.game_state, matchid: p.map.matchid, game_time: p.map.game_time, clock_time: p.map.clock_time };
    if (p.player && typeof p.player === 'object') out.player = { team_name: p.player.team_name, team: p.player.team };
    return out;
  }

  /* Обратное преобразование: состояние -> тело GSI. Нужно демо-режиму моста и тестам. */
  function toGSI(s) {
    const team = (side, home) => {
      const t = { home_team: home };
      s.picks[side].forEach((id, i) => { t['pick' + i + '_id'] = id; if (s.slugs && s.slugs[id]) t['pick' + i + '_class'] = 'npc_dota_hero_' + s.slugs[id]; });
      s.bans[side].forEach((id, i) => { t['ban' + i + '_id'] = id; if (s.slugs && s.slugs[id]) t['ban' + i + '_class'] = 'npc_dota_hero_' + s.slugs[id]; });
      return t;
    };
    const p = { map: { game_state: s.gameState || 'DOTA_GAMERULES_STATE_HERO_SELECTION' }, draft: { activeteam: s.active === 'radiant' ? 2 : s.active === 'dire' ? 3 : 0, pick: s.pickFlag === null ? false : s.pickFlag, activeteam_time_remaining: s.timeLeft == null ? 0 : s.timeLeft, radiant_bonus_time: s.bonus.radiant == null ? 0 : s.bonus.radiant, dire_bonus_time: s.bonus.dire == null ? 0 : s.bonus.dire, team2: team('radiant', true), team3: team('dire', false) } };
    if (s.matchId) p.map.matchid = s.matchId;
    if (s.mySide) p.player = { team_name: s.mySide };
    return p;
  }

  /* ---------- состав и ручной ввод ---------- */
  const all = (s) => [].concat(s.picks.radiant, s.picks.dire, s.bans.radiant, s.bans.dire);
  const taken = (s) => new Set(all(s));
  const isTaken = (s, id) => taken(s).has(id);
  const pickCount = (s) => s.picks.radiant.length + s.picks.dire.length;
  const isComplete = (s) => s.picks.radiant.length >= MAX_PICKS && s.picks.dire.length >= MAX_PICKS;
  const isEmpty = (s) => all(s).length === 0;

  function add(s, kind, side, id) {
    id = heroId(id);
    if (!id || !SIDES.includes(side) || (kind !== 'picks' && kind !== 'bans')) return null;
    if (isTaken(s, id)) return null;
    if (s[kind][side].length >= (kind === 'picks' ? MAX_PICKS : MAX_BANS)) return null;
    const n = clone(s); n[kind][side].push(id);
    return n;
  }
  const addPick = (s, side, id) => add(s, 'picks', side, id);
  const addBan = (s, side, id) => add(s, 'bans', side, id);
  function removeHero(s, id) {
    const n = clone(s); let hit = false;
    for (const k of ['picks', 'bans']) for (const side of SIDES) { const l = n[k][side].filter((x) => x !== id); if (l.length !== n[k][side].length) hit = true; n[k][side] = l; }
    return hit ? n : null;
  }

  /* Что изменилось между двумя снимками: выборы, баны, смена хода, новый драфт. */
  function diff(prev, next) {
    const ev = [];
    const had = prev ? taken(prev) : new Set();
    const resetLike = prev && ((prev.matchId && next.matchId && prev.matchId !== next.matchId) || (all(next).length < all(prev).length));
    if (resetLike) { ev.push({ type: 'reset' }); }
    const base = resetLike ? new Set() : had;
    for (const side of SIDES) for (const id of next.bans[side]) if (!base.has(id)) ev.push({ type: 'ban', side, hero: id });
    for (const side of SIDES) for (const id of next.picks[side]) if (!base.has(id)) ev.push({ type: 'pick', side, hero: id });
    if (next.active && (!prev || prev.active !== next.active) && !isComplete(next)) ev.push({ type: 'turn', side: next.active });
    if (isComplete(next) && !(prev && isComplete(prev)) && !resetLike) ev.push({ type: 'done' });
    return ev;
  }

  /* ---------- подсказки ---------- */
  /* matchups: { [enemyHeroId]: [{hero_id, games_played, wins}] } из OpenDota /heroes/{id}/matchups:
       строки описывают, как герой enemy сыграл против hero_id (wins = победы enemy). Поэтому винрейт кандидата против enemy = 1 − wins/games.
     Сглаживание: (победы + K/2) / (игры + K) тянет малые выборки к 50%. */
  const SMOOTH = 50;
  function suggest(o) {
    const s = o.state, side = o.side || s.mySide || 'radiant', enemy = s.picks[other(side)];
    const meta = o.meta || {}, matchups = o.matchups || {}, personal = o.personal || {};
    const used = taken(s), f = o.filter || {};
    const ids = (o.pool && o.pool.length ? o.pool : Object.keys(meta).map(Number)).filter((id) => !used.has(id));
    const out = [];
    for (const id of ids) {
      const m = meta[id] || {};
      if (f.attr && m.attr !== f.attr) continue;
      if (f.role && !(m.roles || []).includes(f.role)) continue;
      const vs = [];
      for (const e of enemy) {
        const row = (matchups[e] || []).find((r) => Number(r.hero_id) === id);
        if (!row || !(row.games_played > 0)) continue;
        const g = row.games_played, w = g - row.wins;
        vs.push({ enemy: e, games: g, rate: (w + SMOOTH / 2) / (g + SMOOTH), raw: w / g });
      }
      const score = vs.length ? vs.reduce((a, x) => a + x.rate, 0) / vs.length : null;
      const p = personal[id] ? { games: personal[id].games | 0, wins: personal[id].win | 0 } : null;
      out.push({ id, score, vs, covered: vs.length, total: enemy.length, games: vs.reduce((a, x) => a + x.games, 0), personal: p && p.games ? { games: p.games, rate: p.wins / p.games } : null });
    }
    const by = o.sort === 'mine'
      ? (a, b) => ((b.personal ? b.personal.games : -1) - (a.personal ? a.personal.games : -1)) || ((b.score || 0) - (a.score || 0))
      : (a, b) => ((b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score)) || ((b.personal ? b.personal.games : 0) - (a.personal ? a.personal.games : 0));
    out.sort(by);
    return out.slice(0, o.limit || 12);
  }

  /* Состав команды по готовым данным героев: сколько силовых, ловких, умных, универсальных и какие роли. */
  function composition(s, side, meta) {
    const c = { n: s.picks[side].length, attr: { str: 0, agi: 0, int: 0, all: 0 }, roles: {}, unknown: 0 };
    for (const id of s.picks[side]) {
      const m = meta && meta[id];
      if (!m) { c.unknown++; continue; }
      if (c.attr[m.attr] !== undefined) c.attr[m.attr]++;
      for (const r of m.roles || []) c.roles[r] = (c.roles[r] || 0) + 1;
    }
    return c;
  }

  /* ---------- демонстрация: заранее записанная последовательность, не реальный матч ---------- */
  function demoFrames() {
    const F = [], s0 = empty(); s0.source = 'demo'; s0.mySide = 'radiant'; s0.gameState = 'DOTA_GAMERULES_STATE_HERO_SELECTION';
    let s = s0;
    const seq = [
      ['bans', 'radiant', 14], ['bans', 'dire', 74], ['bans', 'radiant', 129], ['bans', 'dire', 44],
      ['picks', 'radiant', 2], ['picks', 'dire', 8], ['picks', 'dire', 26], ['picks', 'radiant', 29], ['picks', 'radiant', 5],
      ['picks', 'dire', 35], ['picks', 'dire', 67], ['picks', 'radiant', 91], ['picks', 'radiant', 7], ['picks', 'dire', 31]
    ];
    F.push(clone(s));
    for (const [kind, side, id] of seq) {
      s = add(s, kind, side, id); s.active = other(side); s.timeLeft = 30; s.bonus = { radiant: 130, dire: 130 };
      F.push(clone(s));
    }
    s = clone(s); s.active = null; s.timeLeft = null; F.push(s);
    return F;
  }

  /* ---------- история ---------- */
  function toHistory(s, now) {
    return { id: String(now || Date.now()), ts: Math.floor((now || Date.now()) / 1000), picks: clone(s.picks), bans: clone(s.bans), mySide: s.mySide, matchId: s.matchId, source: s.source, slugs: s.slugs };
  }
  function sanitizeHistory(list) {
    const out = [];
    for (const h of Array.isArray(list) ? list : []) {
      if (!h || typeof h !== 'object' || !h.picks || !h.bans) continue;
      const ids = (a) => (Array.isArray(a) ? a.map(heroId).filter(Boolean) : []);
      const e = { id: String(h.id || '').slice(0, 20), ts: Math.max(0, Math.trunc(Number(h.ts) || 0)), picks: { radiant: ids(h.picks.radiant).slice(0, MAX_PICKS), dire: ids(h.picks.dire).slice(0, MAX_PICKS) }, bans: { radiant: ids(h.bans.radiant).slice(0, MAX_BANS), dire: ids(h.bans.dire).slice(0, MAX_BANS) }, mySide: sideName(h.mySide), matchId: h.matchId && /^\d{1,20}$/.test(String(h.matchId)) ? String(h.matchId) : null, source: ['manual', 'gsi', 'demo'].includes(h.source) ? h.source : 'manual', slugs: {} };
      if (h.slugs && typeof h.slugs === 'object') for (const [k, v] of Object.entries(h.slugs)) if (heroId(k) && /^[a-z0-9_]{1,40}$/.test(v)) e.slugs[k] = v;
      if (e.id && (e.picks.radiant.length || e.picks.dire.length)) out.push(e);
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, MAX_HISTORY);
  }
  function pushHistory(list, s, now) {
    const h = toHistory(s, now);
    const dup = list.find((x) => x.matchId && x.matchId === h.matchId);
    const rest = dup ? list.filter((x) => x !== dup) : list;
    return sanitizeHistory([h].concat(rest));
  }

  return { SIDES, MAX_PICKS, MAX_BANS, MAX_HISTORY, other, empty, clone, heroId, fromGSI, toGSI, pickGSI, taken, isTaken, pickCount, isComplete, isEmpty, addPick, addBan, removeHero, diff, suggest, composition, demoFrames, toHistory, sanitizeHistory, pushHistory, SMOOTH };
});

return module.exports; })();
__M.hub = (function () { const module = { exports: {} }; const exports = module.exports;
/* Локальный мост GSI: принимает данные от клиента Dota 2 на 127.0.0.1 и отдаёт их странице Dota Mate потоком событий (SSE).
   Ничего не уходит в интернет: страница сама подключается к этому адресу. Из пакета GSI передаются только draft, часть map и team_name игрока. */
const http = require('node:http');
const crypto = require('node:crypto');
const Draft = __M.draft;

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

return module.exports; })();
(function () {
/* Dota Mate: локальный мост драфта. Запускается на вашем компьютере, ничего не отправляет в интернет.
   Использование:
     node tools/gsi-bridge.js                          запустить мост и показать ссылку для сайта
     node tools/gsi-bridge.js --install "<папка>"       записать cfg в "<папка>/game/dota/cfg/gamestate_integration/"
     node tools/gsi-bridge.js --demo                    без Dota 2: проигрывает записанный демо-драфт
   Параметры: --port 7777  --token <строка>  --site https://label777.github.io/dota-mate/ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHub, cfgText } = __M.hub;
const Draft = __M.draft;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const CFG_NAME = 'gamestate_integration_dotamate.cfg';
const HELP = `Dota Mate: локальный мост драфта. Запускается на вашем компьютере, ничего не отправляет в интернет.
Использование:
  node dota-mate-bridge.js                          запустить мост и показать ссылку для сайта
  node dota-mate-bridge.js --install "<папка игры>"  записать cfg в "<папка>/game/dota/cfg/gamestate_integration/"
  node dota-mate-bridge.js --demo                    без Dota 2: проигрывает записанный демо-драфт
Параметры: --port 7777  --token <строка>  --site https://label777.github.io/dota-mate/  --quiet`;

function loadToken() {
  const given = opt('token', '');
  if (given) return given;
  const f = path.join(os.homedir(), '.dota-mate-bridge.json');
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && typeof j.token === 'string' && j.token.length >= 16) return j.token; } catch (e) { /* создадим */ }
  const token = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(f, JSON.stringify({ token }), { mode: 0o600 }); } catch (e) { /* без сохранения токен будет новым при каждом запуске */ }
  return token;
}

async function main() {
  if (flag('help') || flag('h')) { console.log(HELP); return; }
  const port = Number(opt('port', 7777)), token = loadToken(), site = opt('site', 'https://label777.github.io/dota-mate/');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('Порт должен быть от 1024 до 65535.'); process.exit(1); }
  const cfg = cfgText({ port, token });

  const inst = opt('install', '');
  if (inst) {
    const dir = path.join(inst, 'game', 'dota', 'cfg', 'gamestate_integration');
    try {
      if (!fs.existsSync(path.join(inst, 'game', 'dota'))) { console.error(`В папке «${inst}» нет game/dota. Укажите папку игры, например: ...\\steamapps\\common\\dota 2 beta`); process.exit(1); }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CFG_NAME), cfg);
      console.log('Файл записан: ' + path.join(dir, CFG_NAME));
      console.log('Дальше: добавьте в Steam → Dota 2 → Свойства → Параметры запуска: -gamestateintegration, перезапустите Dota 2 и запустите мост без --install.');
    } catch (e) { console.error('Не удалось записать файл: ' + e.message); process.exit(1); }
    return;
  }

  const hub = createHub({ token, log: (m) => console.log('[' + new Date().toLocaleTimeString() + '] ' + m) });
  try { await hub.listen(port); } catch (e) { console.error(e.code === 'EADDRINUSE' ? `Порт ${port} занят. Запустите с другим: --port 7778 (и пересоздайте cfg с тем же портом).` : e.message); process.exit(1); }
  const link = `${site.replace(/\/?$/, '/')}#/draft?b=127.0.0.1:${port}&t=${token}`;
  console.log('Мост драфта Dota Mate запущен на 127.0.0.1:' + port + '. Данные никуда не отправляются.');
  console.log('\n1. Откройте сайт по этой ссылке (токен сохранится в браузере):\n   ' + link);
  console.log('\n2. Файл cfg для Dota 2. Положите в game/dota/cfg/gamestate_integration/' + CFG_NAME + '\n   или выполните: node ' + path.basename(process.argv[1] || 'dota-mate-bridge.js') + ' --install "<папка игры>"');
  if (!flag('quiet')) console.log('\n' + cfg);
  console.log('3. В Steam добавьте параметр запуска Dota 2: -gamestateintegration\n');

  if (flag('demo')) {
    const frames = Draft.demoFrames();
    let i = 0;
    console.log('Демо-режим: проигрываю записанный драфт, это не реальный матч.');
    const tick = () => { const f = frames[Math.min(i, frames.length - 1)]; i++; const body = Draft.toGSI(f); body.auth = { token }; hub.ingest(JSON.stringify(body)); if (i >= frames.length) i = 0; };
    tick(); setInterval(tick, 1500);
  } else console.log('Жду данные от Dota 2…');
  process.on('SIGINT', () => { hub.close().then(() => process.exit(0)); });
}
main();

})();
