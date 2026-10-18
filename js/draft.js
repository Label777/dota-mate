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
    if (p.player && typeof p.player === 'object') {
      const pl = p.player, o = { team_name: pl.team_name, team: pl.team };
      /* Игрок за себя: steamid, ник и место в команде. Наблюдатель: те же поля по всем десяти игрокам (team2 / team3, player0..player4). */
      const one = (x) => {
        if (!x || typeof x !== 'object') return null;
        const r = {};
        if (isSteam64(x.steamid)) r.steamid = String(x.steamid);
        if (typeof x.name === 'string' && x.name.trim()) r.name = cleanName(x.name);
        const ts = slotNum(x.team_slot), ps = slotNum(x.player_slot);
        if (ts != null && ts < 5) r.team_slot = ts;
        if (ps != null) r.player_slot = ps;
        return Object.keys(r).length ? r : null;
      };
      const mine = one(pl); if (mine) Object.assign(o, mine);
      for (const t of ['team2', 'team3']) {
        const src = pl[t]; if (!src || typeof src !== 'object') continue;
        const dst = {};
        for (let i = 0; i < 5; i++) { const r = one(src['player' + i]); if (r) dst['player' + i] = r; }
        if (Object.keys(dst).length) o[t] = dst;
      }
      out.player = o;
    }
    /* Герои: у наблюдателя по игрокам, у играющего только свой. Больше из блока hero ничего не берём. */
    if (p.hero && typeof p.hero === 'object') {
      const h = {}, hid = (x) => (x && typeof x === 'object' ? heroId(x.id) : 0);
      if (hid(p.hero)) h.id = hid(p.hero);
      for (const t of ['team2', 'team3']) {
        const src = p.hero[t]; if (!src || typeof src !== 'object') continue;
        const dst = {};
        for (let i = 0; i < 5; i++) { const id = hid(src['player' + i]); if (id) dst['player' + i] = { id }; }
        if (Object.keys(dst).length) h[t] = dst;
      }
      if (Object.keys(h).length) out.hero = h;
    }
    return out;
  }
  /* steamid64 обычных аккаунтов: 17 цифр, от 76561197960265729 (accountid 1) до 76561202255233023 (accountid 4294967295). */
  function isSteam64(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return false;
    const s = String(v);
    if (!/^\d{17}$/.test(s)) return false;
    const n = BigInt(s) - 76561197960265728n;
    return n > 0n && n <= 4294967295n;
  }
  const slotNum = (v) => { const n = num(v); return n != null && Number.isInteger(n) && n >= 0 && n <= 20 ? n : null; };
  const cleanName = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);

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

  return { SIDES, MAX_PICKS, MAX_BANS, MAX_HISTORY, other, empty, clone, heroId, fromGSI, toGSI, pickGSI, isSteam64, taken, isTaken, pickCount, isComplete, isEmpty, addPick, addBan, removeHero, diff, suggest, composition, demoFrames, toHistory, sanitizeHistory, pushHistory, SMOOTH };
});
