/* Dota Mate: автоматическая оценка игры игрока по статистике матча.
   Чистая логика без DOM и сети (браузер и Node-тесты).

   Что считаем. Для каждого игрока в матче берутся его цифры (золото и опыт в минуту, урон по героям, убийства, смерти, помощь) и
   сравниваются с тем, как на ЭТОМ герое обычно играют в публичных матчах OpenDota (/benchmarks, процентили). Так роль и герой
   учтены без догадок: у саппорта планка по золоту ниже, чем у кора. Если данных по герою нет, игрок сравнивается с остальными
   девятью участниками матча (источник помечается «match»).

   Оценка 0..100 = 60% «вклад по меркам героя» + 20% участие в убийствах команды + 20% «живучесть» (смерти против среднего по матчу).
   Звёзды = 1 + 4 * оценка / 100. Это эвристика по цифрам: она не видит общение, тильт, троллинг и решения, поэтому не заменяет вашу оценку.
   Выход из матча (leaver_status >= 2) ограничивает оценку сверху. Матчи короче 10 минут не считаются. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMPerf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var MIN_DUR = 600;                 // секунд: короче не оцениваем
  var W = { impact: 0.6, part: 0.2, surv: 0.2 };
  /* метрики бенчмарков OpenDota: ключ бенчмарка -> поле записи игрока и способ перевода в «в минуту» */
  var METRICS = [
    { key: 'gold_per_min', f: 'g', perMin: false },
    { key: 'xp_per_min', f: 'x', perMin: false },
    { key: 'hero_damage_per_min', f: 'hd', perMin: true },
    { key: 'kills_per_min', f: 'k', perMin: true },
    { key: 'hero_healing_per_min', f: 'hh', perMin: true, onlyIfPositive: true }
  ];
  var LEAVER_CAP = 15;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function n0(v) { v = Number(v); return isFinite(v) && v >= 0 ? v : 0; }
  function nOrNull(v) { v = Number(v); return v != null && isFinite(v) && v >= 0 ? v : null; }
  function round1(v) { return Math.round(v * 10) / 10; }

  /* ---------- запись матча ---------- */

  /** Компактная запись из ответа OpenDota /matches/{id}. meAcc нужен, чтобы знать, какая сторона ваша. null, если данных нет. */
  function fromDetail(j, meAcc) {
    if (!j || !Array.isArray(j.players) || j.players.length < 2 || j.match_id == null) return null;
    var rec = { v: VERSION, id: String(j.match_id), dur: n0(j.duration), mr: null, p: [] };
    for (var i = 0; i < Math.min(j.players.length, 12); i++) {
      var q = j.players[i];
      if (!q || !(Number(q.hero_id) > 0)) return null;
      var radiant = q.isRadiant != null ? !!q.isRadiant : Number(q.player_slot) < 128;
      var acc = q.account_id != null && /^\d{1,10}$/.test(String(q.account_id)) ? String(q.account_id) : null;
      var r = { h: Number(q.hero_id) | 0, r: radiant ? 1 : 0, a: acc, k: n0(q.kills) | 0, d: n0(q.deaths) | 0, s: n0(q.assists) | 0,
        g: n0(q.gold_per_min), x: n0(q.xp_per_min), hd: nOrNull(q.hero_damage), hh: nOrNull(q.hero_healing), lh: n0(q.last_hits) | 0,
        td: nOrNull(q.tower_damage), lv: n0(q.leaver_status) | 0 };
      rec.p.push(r);
      if (meAcc != null && acc === String(meAcc)) rec.mr = r.r;
    }
    return rec;
  }

  /** Бенчмарки героя: оставляем только нужные метрики и пары [процентиль, значение] по возрастанию. */
  function benchFrom(payload) {
    var res = payload && payload.result;
    if (!res || typeof res !== 'object') return null;
    var out = {};
    METRICS.forEach(function (m) {
      var rows = Array.isArray(res[m.key]) ? res[m.key] : [];
      var t = rows.map(function (r) { return [Number(r.percentile), Number(r.value)]; }).filter(function (r) { return isFinite(r[0]) && isFinite(r[1]) && r[0] > 0 && r[0] <= 1; })
        .sort(function (a, b) { return a[0] - b[0]; }).slice(0, 30);
      if (t.length >= 3) out[m.key] = t;
    });
    return Object.keys(out).length ? out : null;
  }

  /** Процентиль значения v по таблице [[p, значение]…]: линейная интерполяция, за краями ограничиваем. 0..1. */
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

  /** Процентиль внутри списка значений (доля участников, у которых значение не больше, с поправкой на равенство). */
  function rankPct(list, v) {
    if (!list.length) return null;
    var below = 0, eq = 0;
    list.forEach(function (x) { if (x < v) below++; else if (x === v) eq++; });
    return (below + eq / 2) / list.length;
  }

  /* ---------- оценка матча ---------- */

  function perMinValue(m, r, mins) {
    var raw = r[m.f];
    if (raw == null) return null;
    return m.perMin ? raw / mins : raw;
  }

  /**
   * Оценки всех игроков записи. bench: {heroId: benchFrom(...)}. dur в секундах (если не задан, берётся из записи).
   * Возвращает массив по rec.p: {score, stars, imp, part, surv, src:'hero'|'match', leaver, pos, short}.
   * score и stars равны null, если матч слишком короткий.
   */
  function scoreMatch(rec, bench, dur) {
    dur = n0(dur) || rec.dur;
    var mins = dur / 60;
    var all = rec.p;
    var short = dur < MIN_DUR;
    var teamK = { 0: 0, 1: 0 }, goldRank = {};
    all.forEach(function (r) { teamK[r.r] += r.k; });
    [0, 1].forEach(function (side) {
      all.map(function (r, i) { return { i: i, g: r.g, side: r.r }; }).filter(function (x) { return x.side === side; })
        .sort(function (a, b) { return b.g - a.g; }).forEach(function (x, k) { goldRank[x.i] = k + 1; });
    });
    var deathsAvg = all.reduce(function (s, r) { return s + r.d; }, 0) / Math.max(1, all.length);
    return all.map(function (r, i) {
      var out = { score: null, stars: null, imp: null, part: null, surv: null, src: 'match', leaver: r.lv >= 2, pos: goldRank[i] || null, short: short };
      if (short) return out;
      var b = bench && bench[r.h];
      var vals = [], usedBench = false;
      METRICS.forEach(function (m) {
        var v = perMinValue(m, r, mins);
        if (v == null || (m.onlyIfPositive && !(v > 0))) return;
        var p = null;
        if (b && b[m.key]) { p = percentile(b[m.key], v); if (p != null) usedBench = true; }
        else {
          var peers = all.map(function (x) { return perMinValue(m, x, mins); }).filter(function (x) { return x != null; });
          if (peers.length >= 4) p = rankPct(peers, v);
        }
        if (p != null) vals.push(p);
      });
      if (!vals.length) return out;
      var imp = vals.reduce(function (s, x) { return s + x; }, 0) / vals.length;
      var part = teamK[r.r] > 0 ? clamp(((r.k + r.s) / teamK[r.r] - 0.3) / 0.6, 0, 1) : 0.5;
      var ratio = r.d / Math.max(deathsAvg, 1);
      var surv = clamp(1 - (ratio - 0.4) / 1.6, 0, 1);
      var score = 100 * (W.impact * imp + W.part * part + W.surv * surv);
      if (r.lv >= 2) score = Math.min(score, LEAVER_CAP);
      out.imp = imp; out.part = part; out.surv = surv; out.src = usedBench ? 'hero' : 'match';
      out.score = round1(score); out.stars = starsOf(score);
      return out;
    });
  }

  function starsOf(score) { return score == null ? null : round1(1 + 4 * clamp(score, 0, 100) / 100); }

  /* ---------- привязка к игрокам сайта ---------- */

  /**
   * Находит запись игрока в rec для игрока p матча сайта. heroId: имя героя -> номер (может вернуть undefined).
   * Сначала по Steam ID, потом (для скрытых и ручных) по герою и стороне: в матче каждый герой один.
   */
  function findRecord(rec, p, heroId) {
    if (!rec || !p) return -1;
    var i, sid = p.sid != null ? String(p.sid) : '';
    if (/^\d+$/.test(sid)) for (i = 0; i < rec.p.length; i++) if (rec.p[i].a === sid) return i;
    if (rec.mr == null) return -1;
    var h = heroId ? heroId(p.hero) : null;
    if (!h) return -1;
    var side = p.ally ? rec.mr : 1 - rec.mr;
    for (i = 0; i < rec.p.length; i++) if (rec.p[i].h === h && rec.p[i].r === side) return i;
    return -1;
  }

  /* ---------- по нескольким матчам ---------- */

  /** items: [{score, stars, src, leaver, short, ts}]. Среднее по оценённым матчам и надёжность. */
  function aggregate(items) {
    var ok = items.filter(function (x) { return x && x.score != null; });
    if (!ok.length) return { n: 0, score: null, stars: null, conf: 'none', hero: 0, leavers: 0, trend: null };
    var sum = ok.reduce(function (s, x) { return s + x.score; }, 0);
    var score = round1(sum / ok.length);
    var ordered = ok.slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    var trend = null;
    if (ordered.length >= 4) {
      var h = Math.floor(ordered.length / 2), a = ordered.slice(0, h), b = ordered.slice(h);
      var avg = function (l) { return l.reduce(function (s, x) { return s + x.score; }, 0) / l.length; };
      var d = avg(b) - avg(a);
      trend = d >= 5 ? 'up' : d <= -5 ? 'down' : 'flat';
    }
    return { n: ok.length, score: score, stars: starsOf(score), conf: ok.length >= 5 ? 'good' : ok.length >= 3 ? 'ok' : 'low',
      hero: ok.filter(function (x) { return x.src === 'hero'; }).length, leavers: ok.filter(function (x) { return x.leaver; }).length, trend: trend };
  }

  var CONF = { good: 'достаточно данных', ok: 'данных немного', low: 'мало данных', none: 'нет данных' };
  var TREND = { up: 'в последних матчах лучше, чем в первых', down: 'в последних матчах хуже, чем в первых', flat: 'без заметной динамики' };

  /** Слово для звёзд: как читать число. */
  function verdict(stars) {
    if (stars == null) return '';
    return stars >= 4.2 ? 'очень сильная игра' : stars >= 3.5 ? 'сильная игра' : stars >= 2.7 ? 'ровная игра' : stars >= 2 ? 'слабая игра' : 'очень слабая игра';
  }

  /** Короткий разбор оценки одного матча для подсказки: из чего сложилось. */
  function explain(s) {
    if (!s || s.score == null) return s && s.short ? 'Матч короче 10 минут: не оцениваем.' : 'Нет данных для оценки.';
    var pc = function (v) { return Math.round(v * 100) + '%'; };
    var parts = ['Вклад ' + pc(s.imp) + (s.src === 'hero' ? ' (по меркам героя)' : ' (внутри матча)'), 'участие в убийствах ' + pc(s.part), 'живучесть ' + pc(s.surv)];
    return parts.join(', ') + (s.leaver ? '. Вышел из матча: оценка ограничена.' : '.');
  }

  return { VERSION: VERSION, MIN_DUR: MIN_DUR, W: W, METRICS: METRICS, CONF: CONF, TREND: TREND, fromDetail: fromDetail, benchFrom: benchFrom, percentile: percentile,
    rankPct: rankPct, scoreMatch: scoreMatch, starsOf: starsOf, findRecord: findRecord, aggregate: aggregate, verdict: verdict, explain: explain };
});
