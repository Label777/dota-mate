/*
 * Dota Mate: расчёты для раздела «Профиль игрока».
 * Только чистые функции: без DOM, сети и хранилищ. Работает в браузере (глобальная DMA)
 * и в Node (require), поэтому покрыт тестами в папке tests/.
 *
 * Правило для всех показателей: если данных нет, значение null, а не 0.
 * Средние считаются только по матчам, где поле есть, и рядом возвращается их число (…N).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var OFF = 76561197960265728n;
  var DAY = 86400;
  var POS_NAMES = { 1: 'Carry', 2: 'Mid', 3: 'Offlane', 4: 'Soft Support', 5: 'Hard Support' };
  var POS_SHORT = { 1: 'Позиция 1', 2: 'Позиция 2', 3: 'Позиция 3', 4: 'Позиция 4', 5: 'Позиция 5' };
  var DEFAULTS = { minMatches: 5, margin: 0.05 };
  /* z для односторонней проверки «надёжно ли результат отличается от 50%» (95%). */
  var Z1 = 1.645;

  /** Порядок по надёжности: сначала выборки не меньше max(10, 2 * минимум), внутри группы по нижней границе интервала. */
  function byReliability(min) {
    var solid = Math.max(10, min * 2);
    return function (a, b) {
      var ta = a.n >= solid ? 0 : 1, tb = b.n >= solid ? 0 : 1;
      return ta - tb || b.wLow - a.wLow || b.n - a.n;
    };
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function posName(p) { return POS_NAMES[p] || 'Не определена'; }

  /* ---------- ввод игрока ---------- */

  function fromAcc(acc, kind) {
    if (acc <= 0n || acc > 4294967295n) return { ok: false, code: 'invalid' };
    return { ok: true, acc: acc.toString(), steam64: (acc + OFF).toString(), kind: kind };
  }

  /** Steam ID (32 бита), SteamID64, STEAM_0:Y:Z, [U:1:N] или ссылка. */
  function parsePlayerInput(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v) return { ok: false, code: 'empty' };
    var m;
    if ((m = /^STEAM_[0-5]:([01]):(\d{1,10})$/i.exec(v))) return fromAcc(BigInt(m[2]) * 2n + BigInt(m[1]), 'steamid2');
    if ((m = /^\[U:1:(\d{1,10})\]$/i.exec(v))) return fromAcc(BigInt(m[1]), 'steam3');
    if (/^\d+$/.test(v)) {
      if (v.length > 20) return { ok: false, code: 'invalid' };
      var b = BigInt(v);
      return b >= OFF ? fromAcc(b - OFF, 'steam64') : fromAcc(b, 'steam32');
    }
    var u = v;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
    var url;
    try { url = new URL(u); } catch (e) { return { ok: false, code: 'invalid' }; }
    var host = url.hostname.toLowerCase().replace(/^www\./, '');
    var path = url.pathname.replace(/\/+$/, '');
    if (host === 'steamcommunity.com') {
      if ((m = /^\/profiles\/(\d{17})(?:\/|$)/.exec(path))) return fromAcc(BigInt(m[1]) - OFF, 'url');
      if ((m = /^\/id\/([A-Za-z0-9_-]{2,32})(?:\/|$)/.exec(path))) return { ok: false, code: 'vanity', vanity: m[1] };
      return { ok: false, code: 'invalid' };
    }
    if (host === 'dotabuff.com' || host === 'opendota.com' || host === 'stratz.com') {
      if ((m = /^\/players\/(\d{1,10})(?:\/|$)/.exec(path))) return fromAcc(BigInt(m[1]), 'url');
    }
    return { ok: false, code: 'invalid' };
  }

  /* ---------- нормализация матчей ---------- */

  /** Строка ответа /players/{id}/matches в удобный вид. Недостающие поля остаются null. */
  function normalizeMatch(r) {
    if (!r || r.match_id == null) return null;
    var slot = num(r.player_slot);
    var rw = typeof r.radiant_win === 'boolean' ? r.radiant_win : null;
    var win = slot != null && rw != null ? (slot < 128) === rw : null;
    if (win == null) return null;
    return {
      id: String(r.match_id), start: num(r.start_time), dur: num(r.duration), win: win,
      hero: num(r.hero_id), k: num(r.kills), d: num(r.deaths), a: num(r.assists),
      gpm: num(r.gold_per_min), xpm: num(r.xp_per_min), lh: num(r.last_hits), dn: num(r.denies),
      laneRole: num(r.lane_role), roam: typeof r.is_roaming === 'boolean' ? r.is_roaming : null,
      mode: num(r.game_mode), lobby: num(r.lobby_type), party: num(r.party_size), leaver: num(r.leaver_status),
      pos: null, role: null
    };
  }

  function chrono(list) {
    return list.slice().sort(function (a, b) {
      var d = (a.start == null ? 0 : a.start) - (b.start == null ? 0 : b.start);
      if (d) return d;
      return a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }
  function newestFirst(list) { return chrono(list).reverse(); }

  /** Матчи за период и по фильтрам. opts: {periodDays, now, hero, result:'win'|'loss', pos:1..5|0, since, until}. */
  function filterMatches(list, opts) {
    opts = opts || {};
    var from = opts.periodDays ? opts.now - opts.periodDays * DAY : opts.since != null ? opts.since : null;
    var out = list.filter(function (m) {
      if (from != null && (m.start == null || m.start < from)) return false;
      if (opts.until != null && (m.start == null || m.start >= opts.until)) return false;
      if (opts.hero != null && opts.hero !== 'all' && m.hero !== Number(opts.hero)) return false;
      if (opts.result === 'win' && !m.win) return false;
      if (opts.result === 'loss' && m.win) return false;
      if (opts.pos != null && opts.pos !== 'all') {
        if (opts.pos === 'core' || opts.pos === 'support') { if (m.pos || m.role !== opts.pos) return false; }
        else if ((m.pos || 0) !== Number(opts.pos)) return false;
      }
      return true;
    });
    return newestFirst(out);
  }

  /* ---------- сводка ---------- */

  function avgOf(list, key) {
    var s = 0, c = 0;
    for (var i = 0; i < list.length; i++) { var v = list[i][key]; if (v != null) { s += v; c++; } }
    return { v: c ? s / c : null, n: c };
  }

  function summarize(list) {
    var n = list.length, wins = 0;
    for (var i = 0; i < n; i++) if (list[i].win) wins++;
    var k = avgOf(list, 'k'), d = avgOf(list, 'd'), a = avgOf(list, 'a');
    var sk = 0, sd = 0, sa = 0, kn = 0;
    for (var j = 0; j < n; j++) {
      var m = list[j];
      if (m.k != null && m.d != null && m.a != null) { sk += m.k; sd += m.d; sa += m.a; kn++; }
    }
    var g = avgOf(list, 'gpm'), x = avgOf(list, 'xpm'), l = avgOf(list, 'lh'), dn = avgOf(list, 'dn'), du = avgOf(list, 'dur');
    return {
      n: n, wins: wins, losses: n - wins, winrate: n ? wins / n : null,
      k: kn ? sk / kn : null, d: kn ? sd / kn : null, a: kn ? sa / kn : null, kdaN: kn,
      kdaRatio: kn ? (sk + sa) / Math.max(sd, 1) : null,
      gpm: g.v, gpmN: g.n, xpm: x.v, xpmN: x.n, lh: l.v, lhN: l.n, dn: dn.v, dnN: dn.n, dur: du.v, durN: du.n,
      kAvgAny: k.v, dAvgAny: d.v, aAvgAny: a.v
    };
  }

  /** Серии побед и поражений. current: самая свежая серия, longestWin/longestLoss по всей переданной истории. */
  function streaks(list) {
    var c = chrono(list), best = { win: 0, loss: 0 }, run = 0, type = null;
    for (var i = 0; i < c.length; i++) {
      var t = c[i].win ? 'win' : 'loss';
      if (t === type) run++; else { type = t; run = 1; }
      if (run > best[t]) best[t] = run;
    }
    return { current: c.length ? { type: type, len: run } : { type: null, len: 0 }, longestWin: best.win, longestLoss: best.loss };
  }

  /* ---------- доверительные интервалы ---------- */

  /** Интервал Уилсона для доли побед (95%): учитывает размер выборки. */
  function wilson(wins, n, z) {
    if (!n) return { lower: null, upper: null };
    z = z || 1.96;
    var p = wins / n, z2 = z * z, den = 1 + z2 / n, centre = p + z2 / (2 * n);
    var adj = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return { lower: (centre - adj) / den, upper: (centre + adj) / den };
  }

  /* ---------- герои ---------- */

  function heroStats(list) {
    var by = {};
    chrono(list).forEach(function (m) {
      if (m.hero == null) return;
      (by[m.hero] = by[m.hero] || []).push(m);
    });
    return Object.keys(by).map(function (id) {
      var ms = by[id], s = summarize(ms), w = wilson(s.wins, s.n, Z1);
      var last5 = ms.slice(-5), l5w = last5.filter(function (m) { return m.win; }).length;
      return Object.assign({
        heroId: Number(id), wLow: w.lower, wHigh: w.upper,
        recent: ms.slice(-10).map(function (m) { return m.win; }),
        last5: { w: l5w, l: last5.length - l5w }
      }, s);
    });
  }

  /**
   * Лучшие, герои для развития, худшие результаты.
   * Берутся только герои с n >= minMatches. Выше или ниже среднего аккаунта считается с запасом margin.
   * Лучшие: винрейт выше среднего на margin и выше 50%; порядок по надёжности (крупные выборки выше, затем нижняя граница интервала Уилсона).
   * Худшие: ниже среднего на margin и ниже 50%, порядок по верхней границе интервала.
   * Для развития: остальные герои с достаточной выборкой, у которых результат ниже среднего; чаще игранные выше.
   */
  function classifyHeroes(heroes, overall, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var res = { best: [], develop: [], worst: [], lowSample: [], qualifying: 0 };
    if (overall == null) return res;
    var q = heroes.filter(function (h) { return h.n >= opts.minMatches; });
    res.qualifying = q.length;
    var used = {};
    res.best = q.filter(function (h) { return h.winrate >= overall + opts.margin && h.winrate > 0.5; })
      .sort(byReliability(opts.minMatches));
    res.best.forEach(function (h) { used[h.heroId] = 1; });
    res.worst = q.filter(function (h) { return !used[h.heroId] && h.winrate <= overall - opts.margin && h.winrate < 0.5; })
      .sort(function (a, b) { return a.wHigh - b.wHigh || b.n - a.n; });
    res.worst.forEach(function (h) { used[h.heroId] = 1; });
    res.develop = q.filter(function (h) { return !used[h.heroId] && h.winrate < overall; })
      .sort(function (a, b) { return b.n - a.n || a.winrate - b.winrate; });
    res.lowSample = heroes.filter(function (h) { return h.n < opts.minMatches; })
      .sort(function (a, b) { return b.n - a.n; });
    res.best.forEach(function (h) { h.confident = h.wLow > 0.5; });
    res.worst.forEach(function (h) { h.confident = h.wHigh < 0.5; });
    return res;
  }

  function pct(v) { return Math.round(v * 100) + '%'; }
  function plural(n, a, b, c) {
    var x = Math.abs(n) % 100, k = x % 10;
    return x > 10 && x < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c;
  }
  function matchesWord(n) { return n + ' ' + plural(n, 'матч', 'матча', 'матчей'); }
  function fix1(v) { return (Math.round(v * 10) / 10).toFixed(1); }

  /** Короткое объяснение для героя. kind: best | develop | worst. */
  function explainHero(h, overall, kind) {
    var base = pct(h.winrate) + ' побед за ' + matchesWord(h.n);
    var avg = ' (твой средний винрейт ' + pct(overall) + ')';
    var t;
    if (kind === 'best') t = base + ': выше твоего среднего' + avg + '.';
    else if (kind === 'worst') t = base + ': ниже твоего среднего' + avg + '.';
    else t = base + ': немного ниже твоего среднего' + avg + '. Героя играешь часто, поэтому здесь больше всего данных для работы над результатом.';
    if (h.n < 10) t += ' Выборка небольшая, вывод предварительный.';
    else if (kind === 'best' && !h.confident) t += ' Разница пока в пределах случайных колебаний.';
    return t;
  }

  /* ---------- позиции ---------- */

  /**
   * Позиция игрока в матче по данным парса: линия (lane_role) и золото внутри команды.
   * Метод: трое с максимальным золотом считаются кора-игроками, двое остальных саппортами.
   * Среди кор-игроков линии должны быть ровно {лёгкая, мид, сложная}: лёгкая = 1, мид = 2, сложная = 3.
   * Среди саппортов: на лёгкой линии = 5, на сложной = 4; если линии не различают, у того, у кого золота больше, позиция 4.
   * Если данных парса нет или картина противоречива, возвращается null, позиция остаётся «Не определена».
   */
  function inferPosition(players, accountId) {
    if (!Array.isArray(players)) return { pos: null, why: 'no_players' };
    var isRad = function (p) { return p.isRadiant != null ? !!p.isRadiant : num(p.player_slot) != null && p.player_slot < 128; };
    var me = players.filter(function (p) { return String(p.account_id) === String(accountId); })[0];
    if (!me) return { pos: null, why: 'not_in_match' };
    var team = players.filter(function (p) { return isRad(p) === isRad(me); });
    if (team.length !== 5) return { pos: null, why: 'team_size' };
    var gold = function (p) { var g = num(p.net_worth); return g != null ? g : num(p.total_gold); };
    for (var i = 0; i < 5; i++) {
      if (gold(team[i]) == null) return { pos: null, why: 'no_gold' };
      if (num(team[i].lane_role) == null) return { pos: null, why: 'not_parsed' };
    }
    var sorted = team.slice().sort(function (a, b) { return gold(b) - gold(a); });
    var cores = sorted.slice(0, 3), sups = sorted.slice(3);
    var lanes = cores.map(function (p) { return p.lane_role; }).sort().join(',');
    if (lanes !== '1,2,3') return { pos: null, why: 'core_lanes' };
    if (cores.indexOf(me) >= 0) return { pos: me.lane_role, why: 'core' };
    var hi = sups[0], lo = sups[1], posHi = 4, posLo = 5;
    if (hi.lane_role === 1 && lo.lane_role === 3) { posHi = 5; posLo = 4; }
    return { pos: me === hi ? posHi : posLo, why: 'support' };
  }

  /**
   * Грубая роль, когда матч не разобран и линий нет: по золоту внутри команды трое с наибольшим считаются кор-игроками,
   * двое остальных саппортами. Это оценка по золоту, а не точная позиция 1–5; точная позиция остаётся неизвестной.
   * Возвращает {role: 'core'|'support'|null, why}.
   */
  function inferRole(players, accountId) {
    if (!Array.isArray(players)) return { role: null, why: 'no_players' };
    var isRad = function (p) { return p.isRadiant != null ? !!p.isRadiant : num(p.player_slot) != null && p.player_slot < 128; };
    var me = players.filter(function (p) { return String(p.account_id) === String(accountId); })[0];
    if (!me) return { role: null, why: 'not_in_match' };
    var team = players.filter(function (p) { return isRad(p) === isRad(me); });
    if (team.length !== 5) return { role: null, why: 'team_size' };
    var gold = function (p) { var g = num(p.net_worth); if (g == null) g = num(p.total_gold); return g != null ? g : num(p.gold_per_min); };
    for (var i = 0; i < 5; i++) if (gold(team[i]) == null) return { role: null, why: 'no_gold' };
    var sorted = team.slice().sort(function (a, b) { return gold(b) - gold(a); });
    var rank = sorted.indexOf(me);
    // граница между третьим и четвёртым должна быть заметной, иначе роль спорная
    var gap = gold(sorted[2]) - gold(sorted[3]);
    if ((rank === 2 || rank === 3) && gap < 0.03 * gold(sorted[2])) return { role: null, why: 'close_gold' };
    return { role: rank < 3 ? 'core' : 'support', why: 'gold' };
  }

  function positionStats(list, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var by = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
    list.forEach(function (m) { by[m.pos >= 1 && m.pos <= 5 ? m.pos : 0].push(m); });
    var rows = {};
    [0, 1, 2, 3, 4, 5].forEach(function (p) {
      var s = summarize(by[p]), w = wilson(s.wins, s.n, Z1);
      rows[p] = Object.assign({ pos: p, wLow: w.lower, wHigh: w.upper }, s);
    });
    var known = list.length - rows[0].n;
    var q = [1, 2, 3, 4, 5].filter(function (p) { return rows[p].n >= opts.minMatches; });
    var rel = byReliability(opts.minMatches);
    q.sort(function (a, b) { return rel(rows[a], rows[b]); });
    return { rows: rows, known: known, unknown: rows[0].n, total: list.length, qualifying: q, best: q.length >= 2 ? q[0] : null };
  }

  /* ---------- оценка сыгранной игры ---------- */

  var SCORE_MIN = 8, SCORE_HERO_MIN = 5, SCORE_CLAMP = 3;
  function scoreMetrics(m) {
    var o = {};
    if (m.k != null && m.d != null && m.a != null) o.kda = Math.log((m.k + m.a) / Math.max(m.d, 1) + 1);
    if (m.gpm != null) o.gpm = m.gpm;
    if (m.xpm != null) o.xpm = m.xpm;
    return o;
  }
  function meanStd(vals) {
    var n = vals.length, mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
    var v = vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / n;
    return { n: n, mean: mean, std: Math.sqrt(v) };
  }
  /**
   * Оценка игры относительно собственного уровня игрока: 0 = сыграл как обычно, плюс лучше, минус хуже.
   * Считается по (K+A)/D, GPM и XPM (результат матча в оценку не входит). Для каждого показателя берётся отклонение от среднего
   * в единицах обычного разброса игрока; оценка = среднее отклонение, ограниченное диапазоном −3…+3.
   * База сравнения: средние по этому герою, если на нём не меньше 5 матчей, иначе средние по всем загруженным матчам.
   * Разброс всегда общий по всем матчам, чтобы маленькая выборка по герою не раздувала оценку.
   * Нужно не меньше 8 матчей с данными и хотя бы два показателя у самой игры. Иначе оценки нет (null), а не 0.
   * Возвращает {ready, n, scores: {matchId: {v, basis: 'hero'|'all', parts}}}.
   */
  function matchScores(list) {
    var cols = { kda: [], gpm: [], xpm: [] }, rows = list.map(function (m) { return { m: m, x: scoreMetrics(m) }; });
    rows.forEach(function (r) { Object.keys(cols).forEach(function (k) { if (r.x[k] != null) cols[k].push(r.x[k]); }); });
    var usable = rows.filter(function (r) { return Object.keys(r.x).length >= 2; }).length;
    if (usable < SCORE_MIN) return { ready: false, n: usable, scores: {} };
    var all = {};
    Object.keys(cols).forEach(function (k) { if (cols[k].length >= SCORE_MIN) all[k] = meanStd(cols[k]); });
    var byHero = {};
    rows.forEach(function (r) {
      if (r.m.hero == null) return;
      var h = byHero[r.m.hero] = byHero[r.m.hero] || { kda: [], gpm: [], xpm: [] };
      Object.keys(h).forEach(function (k) { if (r.x[k] != null) h[k].push(r.x[k]); });
    });
    var scores = {};
    rows.forEach(function (r) {
      var parts = {}, sum = 0, cnt = 0, heroUsed = false, hs = r.m.hero != null ? byHero[r.m.hero] : null;
      Object.keys(all).forEach(function (k) {
        if (r.x[k] == null) return;
        var base = all[k].mean;
        if (hs && hs[k].length >= SCORE_HERO_MIN) { base = meanStd(hs[k]).mean; heroUsed = true; }
        var sd = Math.max(all[k].std, Math.abs(all[k].mean) * 0.05, 1e-6);
        var z = (r.x[k] - base) / sd;
        parts[k] = z; sum += z; cnt++;
      });
      if (cnt < 2) return;
      var v = Math.max(-SCORE_CLAMP, Math.min(SCORE_CLAMP, sum / cnt));
      scores[r.m.id] = { v: Math.round(v * 10) / 10, basis: heroUsed ? 'hero' : 'all', parts: parts };
    });
    return { ready: true, n: usable, scores: scores };
  }

  /* ---------- ряды для графиков ---------- */

  function dayIndex(ts, offMin) { return Math.floor((ts + offMin * 60) / DAY); }

  /**
   * Ряд по дням (или неделям, если период «всё время» длиннее 62 дней).
   * Дни без матчей остаются в ряду с n = 0 и wr = null, винрейт нарастающим итогом (cumWr) считается с первого матча периода.
   * opts: {periodDays|null, now (сек), offMin (смещение часового пояса, мин)}
   */
  function timeSeries(list, opts) {
    var off = opts.offMin || 0, today = dayIndex(opts.now, off);
    var items = list.filter(function (m) { return m.start != null; });
    var first;
    if (opts.periodDays) first = today - opts.periodDays + 1;
    else {
      if (!items.length) return { bucket: 'day', points: [], truncated: false };
      first = Math.min.apply(null, items.map(function (m) { return dayIndex(m.start, off); }));
    }
    var span = today - first + 1, weekly = !opts.periodDays && span > 62, truncated = false;
    var key = function (d) { return weekly ? Math.floor((d + 3) / 7) : d; };
    var kFirst = key(first), kLast = key(today);
    if (weekly && kLast - kFirst + 1 > 52) { kFirst = kLast - 51; truncated = true; }
    var points = [];
    for (var k = kFirst; k <= kLast; k++) {
      points.push({ key: k, startDay: weekly ? k * 7 - 3 : k, endDay: weekly ? k * 7 + 3 : k, w: 0, l: 0, n: 0, wr: null, cumWr: null, kda: null, _k: 0, _d: 0, _a: 0, _kn: 0 });
    }
    var idx = {};
    points.forEach(function (p, i) { idx[p.key] = i; });
    chrono(items).forEach(function (m) {
      var i = idx[key(dayIndex(m.start, off))];
      if (i == null) return;
      var p = points[i];
      p.n++; if (m.win) p.w++; else p.l++;
      if (m.k != null && m.d != null && m.a != null) { p._k += m.k; p._d += m.d; p._a += m.a; p._kn++; }
    });
    var cw = 0, cn = 0;
    points.forEach(function (p) {
      cw += p.w; cn += p.n;
      p.wr = p.n ? p.w / p.n : null;
      p.cumWr = cn ? cw / cn : null;
      p.cumN = cn;
      p.kda = p._kn ? (p._k + p._a) / Math.max(p._d, 1) : null;
      delete p._k; delete p._d; delete p._a; delete p._kn;
    });
    return { bucket: weekly ? 'week' : 'day', points: points, truncated: truncated };
  }

  /** (K+A)/D по матчам в хронологическом порядке и скользящее среднее. */
  function kdaSeries(list, opts) {
    opts = Object.assign({ window: 5, limit: 60 }, opts || {});
    var c = chrono(list).filter(function (m) { return m.k != null && m.d != null && m.a != null; });
    c = c.slice(-opts.limit);
    var vals = c.map(function (m) { return (m.k + m.a) / Math.max(m.d, 1); });
    return c.map(function (m, i) {
      var from = Math.max(0, i - opts.window + 1), sub = vals.slice(from, i + 1);
      return { match: m, v: vals[i], ma: sub.length >= Math.min(opts.window, 3) ? sub.reduce(function (a, b) { return a + b; }, 0) / sub.length : null };
    });
  }

  /** Последние N дней против предыдущих N дней. */
  function compareWindows(list, opts) {
    var days = opts.days || 7, now = opts.now;
    var r = filterMatches(list, { since: now - days * DAY, now: now });
    var p = filterMatches(list, { since: now - 2 * days * DAY, until: now - days * DAY, now: now });
    var sr = summarize(r), sp = summarize(p);
    var min = opts.min || 5;
    return {
      recent: sr, prev: sp, enough: sr.n >= min && sp.n >= min,
      diffPP: sr.n && sp.n ? (sr.winrate - sp.winrate) * 100 : null
    };
  }

  /* ---------- охват данных ---------- */

  /** Что загружено и насколько это полная история. total: сумма побед и поражений из /wl, если известна. */
  function coverage(list, total, hasMore) {
    var starts = list.map(function (m) { return m.start; }).filter(function (v) { return v != null; });
    var oldest = starts.length ? Math.min.apply(null, starts) : null;
    var newest = starts.length ? Math.max.apply(null, starts) : null;
    var complete = total != null ? list.length >= total : hasMore === false;
    return { loaded: list.length, total: total, oldest: oldest, newest: newest, complete: complete };
  }

  /** Покрывает ли загруженная история период целиком: найден матч старше начала периода или история закончилась. */
  function coversPeriod(list, periodDays, now, hasMore) {
    if (!periodDays) return hasMore === false;
    if (hasMore === false) return true;
    var cut = now - periodDays * DAY;
    return list.some(function (m) { return m.start != null && m.start < cut; });
  }

  /* ---------- рекомендации ---------- */

  function buildInsights(ctx) {
    var list = ctx.matches, now = ctx.now, min = ctx.minMatches || DEFAULTS.minMatches;
    var hn = ctx.heroName || function (id) { return 'герой #' + id; };
    var out = [];
    var all = summarize(list);
    if (all.n < min) {
      out.push({ id: 'few', level: 'info', text: 'Для анализа нужно хотя бы ' + matchesWord(min) + ', сейчас загружено ' + all.n + '. Выводы появятся после следующих игр или при загрузке более ранней истории.' });
      return out;
    }
    if (ctx.coverage && !ctx.coverage.complete && ctx.coverage.total != null) {
      out.push({ id: 'cov', level: 'info', text: 'Анализ построен по ' + ctx.coverage.loaded + ' из ' + ctx.coverage.total + ' матчей аккаунта. Загрузите больше матчей, чтобы учесть всю историю.' });
    }
    var cw = compareWindows(list, { now: now, days: 7, min: min });
    if (cw.enough) {
      var a = Math.round(cw.recent.winrate * 100), b = Math.round(cw.prev.winrate * 100), d = cw.diffPP;
      var tail = a + '% (' + matchesWord(cw.recent.n) + ') против ' + b + '% (' + matchesWord(cw.prev.n) + ') за предыдущие 7 дней.';
      if (d <= -10) out.push({ id: 'trend', level: 'warn', text: 'За последние 7 дней результаты ухудшились: ' + tail });
      else if (d >= 10) out.push({ id: 'trend', level: 'good', text: 'За последние 7 дней результаты улучшились: ' + tail });
      else out.push({ id: 'trend', level: 'info', text: 'За последние 7 дней результаты в целом на прежнем уровне: ' + tail });
    } else {
      out.push({ id: 'trend', level: 'info', text: 'Чтобы сравнить последние 7 дней с предыдущими 7, нужно не меньше ' + matchesWord(min) + ' в каждом периоде. Сейчас: ' + cw.recent.n + ' и ' + cw.prev.n + '.' });
    }
    var m30 = filterMatches(list, { periodDays: 30, now: now }), s30 = summarize(m30), ps = positionStats(m30, { minMatches: min });
    if (m30.length && ps.known === 0) {
      out.push({ id: 'pos', level: 'info', text: 'Позиции за 30 дней пока не определены (' + ps.unknown + ' из ' + m30.length + ' матчей). Нажмите «Определить позиции» в разделе позиций: расчёт идёт по данным разбора матча.' });
    } else if (ps.best) {
      var r = ps.rows[ps.best], diff = Math.round((r.winrate - s30.winrate) * 100);
      var cmp = diff > 0 ? 'выше среднего по аккаунту на ' + diff + ' п. п.' : diff < 0 ? 'ниже среднего по аккаунту на ' + Math.abs(diff) + ' п. п.' : 'на уровне среднего по аккаунту';
      out.push({ id: 'pos', level: diff > 0 ? 'good' : 'info', text: 'Твоя лучшая позиция за последние 30 дней — ' + posName(ps.best) + ': ' + pct(r.winrate) + ' побед за ' + matchesWord(r.n) + ', ' + cmp + '.' + (r.n < 10 ? ' Выборка небольшая.' : '') });
    } else if (ps.qualifying.length === 1) {
      var q1 = ps.rows[ps.qualifying[0]];
      out.push({ id: 'pos', level: 'info', text: 'За 30 дней достаточно данных только по одной позиции (' + posName(q1.pos) + ', ' + matchesWord(q1.n) + '), сравнивать позиции пока не с чем.' });
    } else if (m30.length) {
      out.push({ id: 'pos', level: 'info', text: 'Позиции определены в ' + ps.known + ' из ' + m30.length + ' матчей за 30 дней, но ни по одной нет ' + matchesWord(min) + ': для сравнения позиций данных недостаточно.' });
    }
    var hs = heroStats(list), cl = classifyHeroes(hs, all.winrate, { minMatches: min });
    if (cl.best[0]) {
      var h = cl.best[0];
      out.push({ id: 'best', level: 'good', text: 'На ' + hn(h.heroId) + ' у тебя ' + explainHero(h, all.winrate, 'best') });
    }
    if (cl.worst[0]) {
      var w = cl.worst[0];
      out.push({ id: 'worst', level: 'warn', text: 'На ' + hn(w.heroId) + ' у тебя ' + explainHero(w, all.winrate, 'worst') });
    }
    if (cl.lowSample[0] && cl.lowSample[0].n >= 2) {
      var ls = cl.lowSample[0];
      out.push({ id: 'low', level: 'info', text: 'На ' + hn(ls.heroId) + ' мало матчей (' + ls.n + ' из ' + min + ' нужных): пока недостаточно данных для уверенного вывода.' });
    }
    var st = streaks(list);
    if (st.current.len >= 3) {
      out.push({ id: 'streak', level: st.current.type === 'win' ? 'good' : 'warn', text: 'Текущая серия: ' + st.current.len + ' ' + (st.current.type === 'win' ? plural(st.current.len, 'победа', 'победы', 'побед') : plural(st.current.len, 'поражение', 'поражения', 'поражений')) + ' подряд.' });
    }
    return out;
  }

  /**
   * «На чём играть дальше»: герои с достаточной выборкой и результатом не ниже среднего по аккаунту.
   * Порядок по надёжности: выборки не меньше max(10, 2 * минимум) идут первыми, внутри группы по нижней границе
   * интервала Уилсона. pos 1..5 ограничивает матчи с известной позицией.
   */
  function recommendHeroes(list, opts) {
    opts = Object.assign({ minMatches: DEFAULTS.minMatches, limit: 5, pos: null }, opts || {});
    var overall = summarize(list).winrate;
    var pool = opts.pos ? list.filter(function (m) { return m.pos === opts.pos; }) : list;
    if (overall == null || !list.length) return { items: [], overall: overall, reason: 'Нет загруженных матчей.' };
    if (opts.pos && !pool.length) return { items: [], overall: overall, reason: 'Нет матчей с определённой позицией «' + posName(opts.pos) + '». Определите позиции в разделе позиций.' };
    var hs = heroStats(pool).filter(function (h) { return h.n >= opts.minMatches; });
    if (!hs.length) return { items: [], overall: overall, reason: 'Нет героев как минимум с ' + matchesWord(opts.minMatches) + (opts.pos ? ' на позиции «' + posName(opts.pos) + '»' : '') + '. Нужно больше игр или меньший порог.' };
    var good = hs.filter(function (h) { return h.winrate >= overall; })
      .sort(byReliability(opts.minMatches)).slice(0, opts.limit);
    if (!good.length) return { items: [], overall: overall, reason: 'Среди героев с достаточной выборкой нет результатов не ниже твоего среднего винрейта (' + pct(overall) + ').' };
    return { items: good, overall: overall, reason: null };
  }

  /* ---------- ранг ---------- */

  var MEDALS = ['', 'Herald', 'Guardian', 'Crusader', 'Archon', 'Legend', 'Ancient', 'Divine', 'Immortal'];
  function rankTier(t) {
    t = num(t);
    if (t == null || t < 10) return null;
    var medal = Math.floor(t / 10), stars = t % 10;
    if (!MEDALS[medal]) return null;
    return { medal: MEDALS[medal], stars: stars, label: MEDALS[medal] + (medal < 8 && stars ? ' ' + stars : '') };
  }

  return {
    POS_NAMES: POS_NAMES, POS_SHORT: POS_SHORT, DEFAULTS: DEFAULTS,
    Z1: Z1, byReliability: byReliability,
    parsePlayerInput: parsePlayerInput, normalizeMatch: normalizeMatch, chrono: chrono, newestFirst: newestFirst,
    filterMatches: filterMatches, summarize: summarize, streaks: streaks, wilson: wilson,
    heroStats: heroStats, classifyHeroes: classifyHeroes, explainHero: explainHero,
    matchScores: matchScores, inferPosition: inferPosition, inferRole: inferRole, positionStats: positionStats, posName: posName,
    timeSeries: timeSeries, kdaSeries: kdaSeries, compareWindows: compareWindows,
    coverage: coverage, coversPeriod: coversPeriod, buildInsights: buildInsights, recommendHeroes: recommendHeroes,
    rankTier: rankTier, plural: plural, pct: pct
  };
});
