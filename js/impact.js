/* Dota Mate: MVP и худший игрок матча.
   Чистая логика без DOM и сети (браузер и Node-тесты). Вход: компактная запись матча DMPerf.fromDetail (10 игроков) и,
   по возможности, бенчмарки героев OpenDota. Выход: оценка каждого игрока, MVP, худший игрок, полнота данных, объяснения.

   Принципы.
   1. Ничего не выдумываем. Показатель, которого нет в данных, не участвует в расчёте, и вес остальных пересчитывается.
   2. Роль не угадываем по имени героя. Роль учитывается двумя честными способами: (а) цифры игрока сравниваются с типичными
      для ЕГО героя (процентили /benchmarks OpenDota), (б) показатели саппорта (лечение, оглушения, варды) и урон по строениям
      работают только как бонус: они могут поднять оценку, но их отсутствие у керри её не снижает.
   3. Победа команды даёт небольшой бонус и никогда не решает исход одна.
   4. Статус «худший игрок» означает худший статистический результат в матче, а не саботаж и не руин.
   5. Результат зависит только от входных данных и версии алгоритма (ALGO): повторный расчёт даёт то же самое.
   6. Слабые данные дают пометку «предварительно», а если сравнивать нечего, статус не назначается. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMImpact = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ALGO = 'impact-1';              // версия алгоритма: меняется при любой правке формул или порогов
  var MIN_DUR = 600;                  // секунд: короче не оцениваем
  var MIN_PLAYERS = 10;               // участников в записи матча
  var MIN_ELIGIBLE = 8;               // игроков, которых можно честно сравнивать
  var MIN_COMPLETE = 0.66;            // доля имеющихся показателей игрока
  var MIN_COMPONENTS = 3;             // минимум независимых показателей у игрока
  var MARGIN = 1.0;                   // разрыв между первым и вторым местом (баллы), меньше которого лидера нет
  var MIN_MVP = 60;                   // оценка MVP ниже этого порога статус не получает
  var MIN_WEAK = 55;                  // индекс слабости ниже этого порога статус не получает
  var W_MVP = { kp: 0.26, surv: 0.14, eff: 0.10, dmg: 0.25, econ: 0.25 };
  var W_WEAK = { kp: 0.20, surv: 0.30, eff: 0.10, dmg: 0.20, econ: 0.20 };
  var BONUS = { util: 12, obj: 6, win: 4 };

  var NAMES = { kp: 'участие в убийствах команды', surv: 'смерти относительно матча', eff: 'KDA', dmg: 'урон по героям', econ: 'золото и опыт в минуту' };
  var REASONS = {
    short: 'Матч короче 10 минут: не оцениваем.',
    no_stats: 'Нет статистики матча.',
    players: 'В записи матча меньше десяти игроков.',
    few_eligible: 'Слишком мало игроков с полными данными для честного сравнения.',
    not_all: 'Часть игроков исключена из сравнения (вышли из матча или данные неполные).',
    no_damage: 'У части игроков нет данных об уроне по героям.',
    no_bench: 'Для части героев нет бенчмарков OpenDota: экономика и урон не нормализованы по герою.'
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v) { v = Number(v); return isFinite(v) && v >= 0 ? v : null; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function pc(v) { return Math.round(v * 100) + '%'; }

  /** Процентиль значения v по таблице [[p, значение]…] (линейная интерполяция, за краями ограничиваем). 0..1. */
  function percentile(table, v) {
    if (!table || !table.length || !isFinite(v)) return null;
    var first = table[0], last = table[table.length - 1];
    if (v <= first[1]) return first[1] > 0 ? clamp(first[0] * (v / first[1]), 0, first[0]) : first[0] / 2;
    if (v >= last[1]) return last[0] + (1 - last[0]) * (last[1] > 0 ? clamp((v - last[1]) / last[1], 0, 1) : 0.5);
    for (var i = 1; i < table.length; i++) {
      var a = table[i - 1], b = table[i];
      if (v <= b[1]) return b[1] === a[1] ? b[0] : a[0] + (b[0] - a[0]) * ((v - a[1]) / (b[1] - a[1]));
    }
    return last[0];
  }
  /** Доля значений списка, которые не больше v (с поправкой на равенство). */
  function rankPct(list, v) {
    if (!list.length) return null;
    var below = 0, eq = 0;
    list.forEach(function (x) { if (x < v) below++; else if (x === v) eq++; });
    return (below + eq / 2) / list.length;
  }
  function wmean(comps, weights) {
    var s = 0, w = 0;
    Object.keys(weights).forEach(function (k) { if (comps[k] != null) { s += weights[k] * comps[k]; w += weights[k]; } });
    return w > 0 ? s / w : null;
  }
  function countComps(c) { return Object.keys(NAMES).filter(function (k) { return c[k] != null; }).length; }

  /** Подпись входных данных: если она не изменилась, сохранённый результат можно не пересчитывать. */
  function signature(rec, opts) {
    opts = opts || {};
    var heroes = rec && rec.p ? rec.p.map(function (r) { var b = opts.bench && opts.bench[r.h]; return b && (b.hero_damage_per_min || b.gold_per_min || b.xp_per_min) ? r.h : 0; }).filter(Boolean).sort(function (a, b) { return a - b; }) : [];
    return [ALGO, rec && rec.p ? rec.p.length : 0, opts.dur || (rec && rec.dur) || 0, opts.winner == null ? 'x' : opts.winner, heroes.join(',')].join('|');
  }

  function empty(reason, extra) {
    var out = {
      algo: ALGO, status: 'insufficient', reason: reason, final: false, prelim: [], completeness: 0, eligible: 0, extended: false, players: [],
      mvp: { state: 'nodata', text: 'Недостаточно данных для определения MVP' },
      worst: { state: 'nodata', text: 'Недостаточно данных' }
    };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }

  /* ---------- основной расчёт ---------- */

  /**
   * rec: запись DMPerf.fromDetail. opts: {bench: {героId: benchFrom(...)}, dur, winner: 0|1|null (сторона-победитель, 1 = Radiant)}.
   * Возвращает результат (см. шапку файла). Не меняет входные данные.
   */
  function evaluate(rec, opts) {
    opts = opts || {};
    if (!rec || !Array.isArray(rec.p) || !rec.p.length) return empty('no_stats');
    var all = rec.p, dur = num(opts.dur) || num(rec.dur) || 0, mins = dur / 60;
    var winner = opts.winner === 0 || opts.winner === 1 ? opts.winner : (rec.rw === 0 || rec.rw === 1 ? rec.rw : null);
    if (dur < MIN_DUR) return empty('short', { dur: dur });
    if (all.length < MIN_PLAYERS) return empty('players', { dur: dur });

    /* 1. Полнота данных и допуск к сравнению */
    var pl = all.map(function (r, i) {
      var active = r.g > 0 || r.x > 0 || r.lh > 0;   // у настоящего игрока в матче от 10 минут всегда есть золото или опыт
      var have = (active ? 6 : 0) + (r.hd != null ? 1 : 0) + (r.hh != null ? 1 : 0) + (r.td != null ? 1 : 0);
      var c = have / 9, leaver = r.lv >= 2;
      return { i: i, r: r, active: active, compl: c, leaver: leaver, ok: active && !leaver && c >= MIN_COMPLETE, comps: {}, bonus: { util: 0, obj: 0, win: 0 }, why: '' };
    });
    if (!pl.some(function (x) { return x.active; })) return empty('no_stats', { dur: dur });
    var elig = pl.filter(function (x) { return x.ok; });
    var completeness = r1(pl.reduce(function (s, x) { return s + x.compl; }, 0) / pl.length * 100) / 100;
    var extended = all.some(function (r) { return r.st != null || r.ob != null || r.se != null; });
    if (elig.length < MIN_ELIGIBLE) return empty('few_eligible', { dur: dur, completeness: completeness, eligible: elig.length, players: pl.map(slim) });

    /* 2. Контекст матча */
    var teamK = { 0: 0, 1: 0 }, teamD = { 0: 0, 1: 0 }, teamN = { 0: 0, 1: 0 };
    all.forEach(function (r) { teamK[r.r] += r.k; teamD[r.r] += r.d; teamN[r.r]++; });
    var avgD = all.reduce(function (s, r) { return s + r.d; }, 0) / all.length;
    function refDeaths(side) { return Math.max(1, (avgD + teamD[side] / Math.max(1, teamN[side])) / 2); }
    var peerList = function (fn) { return elig.map(function (x) { return fn(x.r); }).filter(function (v) { return v != null; }); };
    var effOf = function (r) { return (r.k + r.s) / Math.max(1, r.d); };
    var effList = peerList(effOf);
    var dmgEffOf = function (r) { return r.hd == null ? null : r.hd / Math.max(1, r.g * mins); };
    var dmgEffList = peerList(dmgEffOf);
    var tdList = peerList(function (r) { return r.td == null ? null : r.td / mins; });
    var stList = peerList(function (r) { return r.st == null ? null : r.st / mins; });
    var wardList = peerList(function (r) { return r.ob == null && r.se == null ? null : ((r.ob || 0) + (r.se || 0)) / mins; });
    var hhList = peerList(function (r) { return r.hh == null ? null : r.hh / mins; });

    /* 3. Показатели каждого допущенного игрока */
    elig.forEach(function (x) {
      var r = x.r, b = opts.bench && opts.bench[r.h], c = x.comps, raw = x.raw = {};
      raw.kp = teamK[r.r] > 0 ? (r.k + r.s) / teamK[r.r] : null;
      raw.ref = refDeaths(r.r);
      raw.kda = r.d > 0 ? (r.k + r.s) / r.d : r.k + r.s;
      c.kp = raw.kp == null ? null : clamp((raw.kp - 0.3) / 0.6, 0, 1);
      c.surv = clamp(1 - (r.d / raw.ref - 0.4) / 1.6, 0, 1);
      c.eff = effList.length >= 4 ? rankPct(effList, effOf(r)) : null;
      c.dmg = null; c.econ = null; x.src = { dmg: null };
      if (r.hd != null) {
        if (b && b.hero_damage_per_min) { c.dmg = percentile(b.hero_damage_per_min, r.hd / mins); x.src.dmg = 'hero'; }
        else if (dmgEffList.length >= 4) { c.dmg = rankPct(dmgEffList, dmgEffOf(r)); x.src.dmg = 'match'; }
      }
      var ep = [];
      if (b && b.gold_per_min) ep.push(percentile(b.gold_per_min, r.g));
      if (b && b.xp_per_min) ep.push(percentile(b.xp_per_min, r.x));
      ep = ep.filter(function (v) { return v != null; });
      if (ep.length) c.econ = ep.reduce(function (s, v) { return s + v; }, 0) / ep.length;

      /* бонусы: только вверх */
      var up = function (p) { return p == null ? 0 : Math.max(0, 2 * p - 1); };
      var ub = [], parts = [];
      if (r.hh != null && r.hh > 0) {
        var ph = b && b.hero_healing_per_min ? percentile(b.hero_healing_per_min, r.hh / mins) : (hhList.filter(function (v) { return v > 0; }).length >= 3 ? rankPct(hhList, r.hh / mins) : null);
        if (ph != null) { ub.push(up(ph)); if (up(ph) > 0.3) parts.push('лечение'); }
      }
      if (r.st != null && r.st > 0 && stList.length >= MIN_ELIGIBLE) { var pst = rankPct(stList, r.st / mins); ub.push(up(pst)); if (up(pst) > 0.3) parts.push('контроль (оглушения)'); }
      if ((r.ob != null || r.se != null) && wardList.length >= MIN_ELIGIBLE && ((r.ob || 0) + (r.se || 0)) > 0) { var pw = rankPct(wardList, ((r.ob || 0) + (r.se || 0)) / mins); ub.push(up(pw)); if (up(pw) > 0.3) parts.push('варды'); }
      ub.sort(function (a, b2) { return b2 - a; });
      x.bonus.util = ub.length ? r1(BONUS.util * Math.min(1, 0.65 * ub[0] + 0.35 * (ub[1] || 0))) : 0;
      x.utilParts = parts;
      if (r.td != null && tdList.length >= MIN_ELIGIBLE) x.bonus.obj = r1(BONUS.obj * up(rankPct(tdList, r.td / mins)));
      if (winner != null && r.r === winner) x.bonus.win = BONUS.win;

      var gm = wmean(c, W_MVP), gw = wmean(c, W_WEAK);
      x.enough = countComps(c) >= MIN_COMPONENTS && gm != null;
      x.mvp = x.enough ? r1(clamp(100 * gm + x.bonus.util + x.bonus.obj + x.bonus.win, 0, 100)) : null;
      x.weak = x.enough ? r1(clamp(100 * (1 - gw) - x.bonus.util - x.bonus.obj, 0, 100)) : null;
      if (!x.enough) x.ok = false;
    });
    var pool = elig.filter(function (x) { return x.ok; });
    if (pool.length < MIN_ELIGIBLE) return empty('few_eligible', { dur: dur, completeness: completeness, eligible: pool.length, players: pl.map(slim) });

    /* 4. Предварительная или окончательная оценка */
    var prelim = [];
    if (pool.length < all.length) prelim.push('not_all');
    if (pool.some(function (x) { return x.comps.dmg == null; })) prelim.push('no_damage');
    if (pool.some(function (x) { return x.src.dmg !== 'hero' || x.comps.econ == null; })) prelim.push('no_bench');

    /* 5. Назначение статусов */
    var mvp = pick(pool, 'mvp', MIN_MVP, true, null);
    var worst = pick(pool, 'weak', MIN_WEAK, false, mvp.state === 'assigned' ? mvp.i : -1);
    var res = {
      algo: ALGO, status: 'ok', reason: null, final: prelim.length === 0, prelim: prelim, completeness: completeness, eligible: pool.length, extended: extended,
      dur: dur, winner: winner, players: pl.map(slim), mvp: mvp, worst: worst
    };
    describe(res, pool, avgD, mins);
    return res;
  }

  function slim(x) {
    return { i: x.i, h: x.r.h, r: x.r.r, mvp: x.mvp == null ? null : x.mvp, weak: x.weak == null ? null : x.weak, c: r1(x.compl * 100) / 100, e: x.ok ? 1 : 0, lv: x.leaver ? 1 : 0 };
  }

  /** Лидер по ключу key среди pool. Ничья или разрыв меньше MARGIN: лидера нет. Порог: слабее min статус не получает. */
  function pick(pool, key, min, isMvp, skipIdx) {
    var list = pool.filter(function (x) { return x.i !== skipIdx; }).sort(function (a, b) { return b[key] - a[key] || a.i - b.i; });
    var top = list[0], second = list[1];
    var out = { state: 'none', text: isMvp ? 'Нет выраженного MVP' : 'Нет выраженного отстающего' };
    if (!top) return { state: 'nodata', text: isMvp ? 'Недостаточно данных для определения MVP' : 'Недостаточно данных' };
    if (top[key] < min) return out;
    var contenders = list.filter(function (x) { return top[key] - x[key] < MARGIN; });
    if (contenders.length > 1) {
      return { state: 'tie', text: 'Нет однозначного лидера', contenders: contenders.map(function (x) { return x.i; }), score: top[key], margin: r1(top[key] - (second ? second[key] : 0)) };
    }
    return { state: 'assigned', i: top.i, h: top.r.h, r: top.r.r, a: top.r.a, score: top[key], margin: r1(top[key] - (second ? second[key] : 0)), text: '' };
  }

  /* ---------- объяснения по реальным цифрам ---------- */
  function describe(res, pool, avgD, mins) {
    var by = {}; pool.forEach(function (x) { by[x.i] = x; });
    function fill(st, isMvp) {
      if (st.state !== 'assigned') return;
      var x = by[st.i], r = x.r, c = x.comps, why = [], used = [];
      Object.keys(NAMES).forEach(function (k) { if (c[k] != null) used.push(NAMES[k]); });
      if (x.bonus.util > 0) used.push('вклад поддержки (' + (x.utilParts.length ? x.utilParts.join(', ') : 'лечение, оглушения, варды') + ')');
      if (x.bonus.obj > 0) used.push('урон по строениям');
      if (x.bonus.win > 0) used.push('победа команды (контекст)');
      var items = [];
      if (isMvp) {
        if (c.kp != null && c.kp >= 0.55) items.push([c.kp, 'высокое участие в убийствах команды (' + pc(x.raw.kp) + ')']);
        if (c.dmg != null && c.dmg >= 0.65) items.push([c.dmg, x.src.dmg === 'hero' ? 'урон по героям выше, чем у ' + pc(c.dmg) + ' игроков на этом герое' : 'высокий урон относительно полученного золота']);
        if (c.econ != null && c.econ >= 0.65) items.push([c.econ, 'золото и опыт выше типичных для героя (' + pc(c.econ) + ')']);
        if (c.surv >= 0.7) items.push([c.surv, 'мало смертей: ' + r.d + ' при ориентире ' + r1(x.raw.ref) + ' по матчу']);
        if (c.eff != null && c.eff >= 0.75) items.push([c.eff, 'сильный KDA ' + r.k + '/' + r.d + '/' + r.s]);
        if (x.bonus.util >= 3) items.push([0.7 + x.bonus.util / 100, 'заметный вклад поддержки: ' + (x.utilParts.length ? x.utilParts.join(', ') : 'лечение, контроль, варды')]);
        if (x.bonus.obj >= 2) items.push([0.6 + x.bonus.obj / 100, 'урон по строениям выше, чем у большинства']);
        items.sort(function (a, b) { return b[0] - a[0]; });
        why = items.slice(0, 3).map(function (v) { return v[1]; });
        if (!why.length) why.push('лучший суммарный результат среди игроков с полными данными');
        if (x.bonus.win > 0) why.push('команда победила (небольшой бонус)');
      } else {
        if (c.surv <= 0.35) items.push([1 - c.surv, r.d + ' ' + plural(r.d, 'смерть', 'смерти', 'смертей') + ' при ориентире ' + r1(x.raw.ref) + ' по матчу']);
        if (c.kp != null && c.kp <= 0.35) items.push([1 - c.kp, 'низкое участие в убийствах команды (' + pc(x.raw.kp) + ')']);
        if (c.dmg != null && c.dmg <= 0.35) items.push([1 - c.dmg, x.src.dmg === 'hero' ? 'урон по героям ниже, чем у ' + pc(1 - c.dmg) + ' игроков на этом герое' : 'низкий урон относительно полученного золота']);
        if (c.econ != null && c.econ <= 0.35) items.push([1 - c.econ, 'золото и опыт ниже типичных для героя']);
        if (c.eff != null && c.eff <= 0.3) items.push([1 - c.eff, 'низкий KDA ' + r.k + '/' + r.d + '/' + r.s]);
        items.sort(function (a, b) { return b[0] - a[0]; });
        why = items.slice(0, 3).map(function (v) { return v[1]; });
        if (!why.length) why.push('самый слабый суммарный результат среди игроков с полными данными');
      }
      st.why = why;
      st.used = used;
      st.text = capital(why.join(', ')) + '.';
      st.comps = {}; Object.keys(c).forEach(function (k) { if (c[k] != null) st.comps[k] = r1(c[k] * 100) / 100; });
      st.bonus = { util: x.bonus.util, obj: x.bonus.obj, win: x.bonus.win };
      st.stats = { k: r.k, d: r.d, s: r.s, g: Math.round(r.g), x: Math.round(r.x), hd: r.hd, hh: r.hh, td: r.td };
    }
    fill(res.mvp, true); fill(res.worst, false);
  }
  function capital(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function plural(n, a, b, c) { var m = n % 100, d = n % 10; return m > 10 && m < 15 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c; }

  /* ---------- привязка и сводка ---------- */

  /** Статус игрока в результате res: 'mvp' | 'worst' | null. ref: {i} (индекс в записи) или {h, r, a} (герой, сторона, аккаунт). */
  function statusOf(res, ref) {
    if (!res || res.status !== 'ok' || !ref) return null;
    function same(st) {
      if (!st || st.state !== 'assigned') return false;
      if (ref.i != null) return st.i === ref.i;
      if (ref.a != null && st.a != null) return String(ref.a) === String(st.a);
      return ref.h != null && st.h === ref.h && ref.r === st.r;
    }
    return same(res.mvp) ? 'mvp' : same(res.worst) ? 'worst' : null;
  }

  /** Можно ли использовать сохранённый результат: та же версия алгоритма и те же входные данные (signature). */
  function reusable(entry, sig) { return !!(entry && entry.algo === ALGO && entry.sig === sig); }

  var MIN_SHARE = 5;   // матчей с вердиктом, начиная с которых показываем долю

  /**
   * items: [{res, ref}]. Сколько матчей оценено, сколько раз игрок был MVP и худшим.
   * Доля показывается только при достаточной истории (enough).
   */
  function playerOf(res, ref) {
    if (!res || !res.players || !ref) return null;
    for (var k = 0; k < res.players.length; k++) {
      var p = res.players[k];
      if (ref.i != null ? p.i === ref.i : (p.h === ref.h && p.r === ref.r)) return p;
    }
    return null;
  }

  function summarize(items) {
    var out = { total: 0, judged: 0, excluded: 0, prelim: 0, mvp: 0, worst: 0, mvpShare: null, worstShare: null, enough: false, algos: {} };
    (items || []).forEach(function (it) {
      out.total++;
      var res = it && it.res;
      if (!res || res.status !== 'ok') return;
      var pp = playerOf(res, it.ref);
      if (!pp || !pp.e) { out.excluded++; return; }   // игрока нет в записи или он не входил в сравнение
      out.judged++; out.algos[res.algo] = (out.algos[res.algo] || 0) + 1;
      if (!res.final) out.prelim++;
      var s = statusOf(res, it.ref);
      if (s === 'mvp') out.mvp++; else if (s === 'worst') out.worst++;
    });
    out.enough = out.judged >= MIN_SHARE;
    if (out.enough) { out.mvpShare = out.mvp / out.judged; out.worstShare = out.worst / out.judged; }
    return out;
  }

  return { ALGO: ALGO, MIN_DUR: MIN_DUR, MIN_PLAYERS: MIN_PLAYERS, MIN_ELIGIBLE: MIN_ELIGIBLE, MIN_COMPLETE: MIN_COMPLETE, MARGIN: MARGIN, MIN_MVP: MIN_MVP, MIN_WEAK: MIN_WEAK,
    MIN_SHARE: MIN_SHARE, W_MVP: W_MVP, W_WEAK: W_WEAK, BONUS: BONUS, NAMES: NAMES, REASONS: REASONS, percentile: percentile, rankPct: rankPct,
    signature: signature, reusable: reusable, evaluate: evaluate, statusOf: statusOf, summarize: summarize };
});
