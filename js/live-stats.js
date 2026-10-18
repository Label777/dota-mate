/*
 * Dota Mate: сервис статистики игроков для Live Draft Overlay (Player Stats Service + Cache and Request Queue).
 * Только логика, без интерфейса (браузер: DMLiveStats, Node: require). Источник данных подставляется снаружи (DMApi.create).
 *
 * Что делает:
 *  - кэш по accountId (память + необязательное хранилище), TTL берутся из одного места (CONFIG);
 *  - показывает кэш сразу, а обновление делает в фоне (stale-while-revalidate);
 *  - очередь с ограничением параллельности, дедупликация одинаковых запросов, пауза при HTTP 429, экспоненциальный backoff,
 *    лимит попыток (бесконечных повторов нет), защита от частых ручных обновлений;
 *  - привязка заданий к матчу (epoch): задания старого матча не стартуют, а результат старого матча в новый не доставляется;
 *  - расчёт сводки из реально полученных данных: недостающая метрика остаётся null, а не нулём;
 *  - сигналы считает существующая система репутации (DMRep.detectAnomalies / computeReputation): второй системы оценки нет.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./analytics.js'), require('./reputation.js'));
  else root.DMLiveStats = factory(root.DMA, root.DMRep);
})(typeof self !== 'undefined' ? self : this, function (A, R) {
  'use strict';

  /* Все числа, влияющие на запросы и кэш, здесь. */
  var CONFIG = {
    ttlMs: 30 * 60 * 1000,            // столько данные считаются свежими: до этого сеть не трогаем
    staleMs: 24 * 3600 * 1000,        // старше этого кэш не показываем вообще
    minRefreshMs: 60 * 1000,          // ручное обновление одного игрока не чаще раза в минуту
    concurrency: 2,                   // сколько игроков загружается одновременно
    matchLimit: 100,                  // сколько последних матчей берём (один запрос)
    formSize: 20,                     // длина «формы»
    minForKda: 5,                     // меньше матчей K/D/A не показываем
    maxAttempts: 3,                   // попыток загрузки одного игрока подряд
    baseBackoffMs: 8000, maxBackoffMs: 10 * 60 * 1000, rateLimitFloorMs: 30000,
    maxCached: 40                     // сколько игроков хранить в кэше
  };

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }

  /* ---------- сводка из сырых ответов ---------- */
  /**
   * raw: { player, wl, heroes, matches } как их отдаёт слой данных. Ничего не выдумывает:
   * чего нет в ответах, того нет и в результате (null / пустой список).
   * deps: { now (сек), heroName(id) }.
   */
  function summarize(acc, raw, deps) {
    deps = deps || {};
    var nowS = deps.now != null ? deps.now : Math.floor(Date.now() / 1000);
    var prof = raw.player && raw.player.profile && typeof raw.player.profile === 'object' ? raw.player.profile : null;
    var matches = A.newestFirst((raw.matches || []).map(A.normalizeMatch).filter(Boolean));
    var wl = raw.wl && num(raw.wl.win) != null && num(raw.wl.lose) != null ? { win: raw.wl.win, lose: raw.wl.lose, games: raw.wl.win + raw.wl.lose } : null;
    var out = {
      accountId: String(acc), name: prof && prof.personaname ? String(prof.personaname) : null,
      avatar: prof && typeof prof.avatarmedium === 'string' && /^https:\/\/[a-z0-9.\-]+\//i.test(prof.avatarmedium) ? prof.avatarmedium : null,
      rank: raw.player && raw.player.rank_tier ? A.rankTier(raw.player.rank_tier) : null,
      wl: wl, winrate: wl && wl.games > 0 ? wl.win / wl.games : null,
      sample: matches.length, lastMatchAt: matches.length ? matches.reduce(function (a, m) { return m.start != null && m.start > a ? m.start : a; }, 0) || null : null,
      firstMatchAt: null, form: [], formWins: null, kda: null, topHeroes: [], signals: null, matches: matches
    };
    var dated = matches.filter(function (m) { return m.start != null; });
    if (dated.length) out.firstMatchAt = dated[dated.length - 1].start;

    /* Форма: результаты последних матчей. */
    var form = matches.slice(0, CONFIG.formSize);
    out.form = form.map(function (m) { return { id: m.id, win: m.win, start: m.start, hero: m.hero }; });
    out.formWins = form.length ? form.filter(function (m) { return m.win; }).length : null;

    /* K/D/A только по матчам, где все три числа есть. */
    var kd = matches.filter(function (m) { return m.k != null && m.d != null && m.a != null; });
    if (kd.length >= CONFIG.minForKda) {
      var K = mean(kd.map(function (m) { return m.k; })), D = mean(kd.map(function (m) { return m.d; })), Ax = mean(kd.map(function (m) { return m.a; }));
      out.kda = { k: round1(K), d: round1(D), a: round1(Ax), n: kd.length, ratio: D > 0 ? round1((K + Ax) / D) : null };
    }

    /* Три самых частых героя за всё время (OpenDota /players/{id}/heroes). */
    var heroes = Array.isArray(raw.heroes) ? raw.heroes : [];
    out.topHeroes = heroes.filter(function (h) { return num(h.games) > 0 && num(h.hero_id != null ? Number(h.hero_id) : null) != null; })
      .sort(function (a, b) { return b.games - a.games || (num(b.win) || 0) - (num(a.win) || 0); }).slice(0, 3)
      .map(function (h) { return { heroId: Number(h.hero_id), games: h.games, wins: num(h.win), winrate: num(h.win) != null ? h.win / h.games : null }; });

    /* Сигналы: существующая система репутации, без общего «процента руина». Нужны хотя бы 15 матчей с длительностью и смертями. */
    if (matches.length) {
      var an = R.detectAnomalies(matches, { now: nowS, heroName: deps.heroName });
      var rep = R.computeReputation({ matches: matches, now: nowS, anomalies: an, fetchedAt: nowS, comm: { available: false } });
      var list = an.items.filter(function (i) { return i.group === 'anomaly' || i.group === 'fact'; });
      out.signals = {
        ready: an.ready, baselineN: an.baselineN, state: rep.state, stateLabel: rep.stateLabel, confidence: rep.confidence, count: list.length,
        items: list.map(function (i) { return { id: i.id, kind: i.kind, group: i.group, title: i.title, matchId: i.matchId || null, start: i.start || null, hero: i.hero != null ? i.hero : null, facts: i.facts || [], basis: i.basis || '', level: i.level || 'info' }; })
      };
    }
    return out;
  }

  /** Сравнение игры на герое с обычными показателями игрока (в пределах загруженной выборки). Мало данных -> null. */
  function heroCompare(sum, heroId) {
    if (!sum || !sum.matches || heroId == null) return null;
    var all = sum.matches, on = all.filter(function (m) { return m.hero === heroId; });
    if (on.length < 3) return { heroId: heroId, n: on.length, enough: false };
    var kda = function (l) { var x = l.filter(function (m) { return m.k != null && m.d != null && m.a != null; }); return x.length ? { k: round1(mean(x.map(function (m) { return m.k; }))), d: round1(mean(x.map(function (m) { return m.d; }))), a: round1(mean(x.map(function (m) { return m.a; }))), n: x.length } : null; };
    var wr = function (l) { return l.length ? l.filter(function (m) { return m.win; }).length / l.length : null; };
    return { heroId: heroId, enough: true, n: on.length, nAll: all.length, hero: { kda: kda(on), winrate: wr(on) }, usual: { kda: kda(all), winrate: wr(all) } };
  }

  /* ---------- сервис ---------- */
  function errKind(e) { return e && e.code ? e.code : 'api'; }

  function create(opts) {
    var o = Object.assign({
      api: null,                                 // слой данных (DMApi.create)
      heroName: null, now: function () { return Date.now(); },
      setTimer: function (fn, ms) { return setTimeout(fn, ms); }, clearTimer: function (t) { clearTimeout(t); },
      storage: null, key: 'dotamate.live.v1', onUpdate: function () {}, config: {}
    }, opts || {});
    var cfg = Object.assign({}, CONFIG, o.config);
    var cache = new Map();          // acc -> { sum, at, state }
    var entries = new Map();        // acc -> { status, error, attempts, nextTryAt, lastTryAt, fetchedAt }
    var inflight = new Map();       // acc -> Promise
    var queue = [];                 // [{ acc, epoch, resolve, force }]
    var running = 0, curEpoch = 0, pausedUntil = 0, pauseTimer = null, timers = new Set();
    var stats = { requests: 0, cacheHits: 0, cancelled: 0 };

    function load() {
      if (!o.storage) return;
      try {
        var j = JSON.parse(o.storage.getItem(o.key) || 'null');
        if (j && j.v === 1 && j.items) Object.keys(j.items).forEach(function (k) { var it = j.items[k]; if (it && it.sum && it.at && /^\d{1,10}$/.test(k)) cache.set(k, { sum: it.sum, at: it.at }); });
      } catch (e) { /* пустой кэш */ }
    }
    function save() {
      if (!o.storage) return;
      try {
        var keys = Array.from(cache.keys()).sort(function (a, b) { return cache.get(b).at - cache.get(a).at; }).slice(0, cfg.maxCached);
        var items = {}; keys.forEach(function (k) { items[k] = cache.get(k); });
        o.storage.setItem(o.key, JSON.stringify({ v: 1, items: items }));
      } catch (e) { /* хранилище переполнено или недоступно: работаем без постоянного кэша */ }
    }
    load();

    function ent(acc) { var e = entries.get(acc); if (!e) { e = { status: 'none', error: null, attempts: 0, nextTryAt: 0, lastTryAt: 0 }; entries.set(acc, e); } return e; }
    function ageOf(acc) { var c = cache.get(acc); return c ? o.now() - c.at : Infinity; }

    /** Что показывать по игроку прямо сейчас (всегда синхронно). */
    function get(acc) {
      acc = String(acc);
      var c = cache.get(acc), e = ent(acc), age = ageOf(acc);
      var usable = c && age <= cfg.staleMs ? c : null;
      var busy = e.status === 'loading' || e.status === 'queued';
      var status = e.status;
      if (usable && !busy && e.status !== 'rate_limited' && e.status !== 'error' && e.status !== 'private') status = 'ready';
      if (usable && (e.status === 'error' || e.status === 'rate_limited')) status = e.status;          // данные остаются, ошибка видна рядом
      if (!usable && (status === 'none' || status === 'ready')) status = 'none';
      return { accountId: acc, status: status, data: usable ? usable.sum : null, fetchedAt: usable ? usable.at : null, ageMs: usable ? age : null, stale: !!usable && age > cfg.ttlMs,
        refreshing: busy && !!usable, error: e.error, nextTryAt: e.nextTryAt || 0, attempts: e.attempts };
    }

    function notify(acc, epoch) { try { o.onUpdate(acc, get(acc), epoch); } catch (x) { /* ошибка обработчика не должна ломать очередь */ } }

    /* Один шаг загрузки; перед каждым запросом проверяем, не устарело ли задание. */
    async function fetchAll(acc, epoch) {
      var guard = function () { if (epoch !== curEpoch) { var c = new Error('cancelled'); c.cancelled = true; throw c; } };
      var api = o.api, raw = {};
      guard(); stats.requests++; raw.player = await api.getPlayer(acc);
      guard(); stats.requests++; raw.wl = await api.getWinLoss(acc).catch(function (e) { if (errKind(e) === 'rate_limit') throw e; return null; });
      guard(); stats.requests++; raw.heroes = await api.getPlayerHeroes(acc).catch(function (e) { if (errKind(e) === 'rate_limit') throw e; return []; });
      guard(); stats.requests++; raw.matches = await api.getMatches(acc, { limit: cfg.matchLimit, extra: false });
      guard();
      return raw;
    }

    function backoff(n, retryAfter) {
      var b = Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * Math.pow(2, Math.max(0, n - 1)));
      return retryAfter ? Math.max(retryAfter * 1000, cfg.rateLimitFloorMs) : b;
    }
    function later(fn, ms) { var t = o.setTimer(function () { timers.delete(t); fn(); }, ms); timers.add(t); }

    function pump() {
      if (o.now() < pausedUntil) {
        if (!pauseTimer) pauseTimer = o.setTimer(function () { pauseTimer = null; pump(); }, Math.max(50, pausedUntil - o.now()));
        return;
      }
      while (running < cfg.concurrency && queue.length) {
        var job = queue.shift();
        if (job.epoch !== curEpoch) { stats.cancelled++; var e0 = ent(job.acc); if (e0.status === 'queued') e0.status = 'none'; inflight.delete(job.acc); job.resolve(get(job.acc)); continue; }
        run(job);
      }
    }

    function run(job) {
      running++;
      var acc = job.acc, e = ent(acc);
      e.status = 'loading'; e.lastTryAt = o.now(); e.attempts++; notify(acc, job.epoch);
      fetchAll(acc, job.epoch).then(function (raw) {
        var sum = summarize(acc, raw, { now: Math.floor(o.now() / 1000), heroName: o.heroName });
        cache.set(acc, { sum: sum, at: o.now() }); save();
        e.attempts = 0; e.error = null; e.nextTryAt = 0;
        /* Нет ни матчей, ни профиля: это либо приватный профиль, либо игрок без публичных матчей. По ответу различить нельзя. */
        e.status = !raw.matches.length ? 'private' : 'ready';
        if (e.status === 'private') e.error = { kind: 'private', message: 'Нет публичных матчей: профиль скрыт или игрок не играл. Источник не позволяет отличить одно от другого.' };
      }, function (err) {
        if (err && err.cancelled) { stats.cancelled++; e.status = cache.has(acc) ? 'ready' : 'none'; e.attempts = Math.max(0, e.attempts - 1); return; }
        var kind = errKind(err);
        if (kind === 'not_found') { e.status = 'private'; e.error = { kind: 'private', message: 'OpenDota не знает такого аккаунта или профиль скрыт.' }; return; }
        if (kind === 'rate_limit') {
          var wait = backoff(e.attempts, err.retryAfter);
          pausedUntil = Math.max(pausedUntil, o.now() + wait);
          e.status = 'rate_limited'; e.nextTryAt = o.now() + wait; e.error = { kind: 'rate_limit', message: 'OpenDota просит подождать (HTTP 429). Повторю сам через ' + Math.ceil(wait / 1000) + ' с.' };
        } else {
          var w2 = backoff(e.attempts);
          e.status = 'error'; e.nextTryAt = o.now() + w2;
          e.error = { kind: kind, message: kind === 'network' ? 'Нет связи с OpenDota.' : kind === 'timeout' ? 'OpenDota не ответил вовремя.' : kind === 'bad_data' ? 'OpenDota вернул непонятный ответ.' : 'Ошибка OpenDota.' };
        }
        /* Автоповтор: ограниченное число раз и только пока матч тот же. */
        if (e.attempts < cfg.maxAttempts && job.epoch === curEpoch) {
          var ep = job.epoch, delay = Math.max(0, e.nextTryAt - o.now());
          later(function () { if (ep === curEpoch && (ent(acc).status === 'error' || ent(acc).status === 'rate_limited')) request(acc, { epoch: ep, retry: true }); }, delay);
        } else if (e.attempts >= cfg.maxAttempts) { e.error.message += ' Автоповторы закончились, можно обновить вручную.'; e.nextTryAt = 0; }
      }).then(function () {
        running--; inflight.delete(acc);
        if (job.epoch === curEpoch || !job.dropIfStale) notify(acc, job.epoch);
        job.resolve(get(acc)); pump();
      });
    }

    /**
     * Просит данные игрока. Свежий кэш -> сеть не трогаем. Тот же игрок уже в работе -> вернём тот же Promise.
     * opts: { epoch, force, retry }. Возвращает Promise<snapshot>.
     */
    function request(acc, opts) {
      acc = String(acc); opts = opts || {};
      if (!/^\d{1,10}$/.test(acc)) return Promise.resolve({ accountId: acc, status: 'error', data: null, error: { kind: 'invalid', message: 'Некорректный идентификатор.' } });
      var epoch = opts.epoch != null ? opts.epoch : curEpoch, e = ent(acc);
      if (epoch !== curEpoch) { stats.cancelled++; return Promise.resolve(get(acc)); }
      if (inflight.has(acc)) return inflight.get(acc);
      var age = ageOf(acc);
      if (!opts.force && !opts.retry && age <= cfg.ttlMs && e.status !== 'error' && e.status !== 'rate_limited') { stats.cacheHits++; notify(acc, epoch); return Promise.resolve(get(acc)); }
      if (opts.force && o.now() - e.lastTryAt < cfg.minRefreshMs && e.lastTryAt) { return Promise.resolve(Object.assign(get(acc), { tooSoon: true, retryInMs: cfg.minRefreshMs - (o.now() - e.lastTryAt) })); }
      if (!opts.retry && !opts.force && e.status === 'private' && e.lastTryAt && o.now() - e.lastTryAt < cfg.ttlMs) { stats.cacheHits++; return Promise.resolve(get(acc)); }
      e.status = 'queued'; e.error = opts.retry ? e.error : null;
      var p = new Promise(function (resolve) { queue.push({ acc: acc, epoch: epoch, resolve: resolve, force: !!opts.force, dropIfStale: true }); });
      inflight.set(acc, p);
      notify(acc, epoch); pump();
      return p;
    }

    /** Начался новый матч: задания старого матча в очереди не стартуют, результаты старого матча не доставляются в новый. */
    function setEpoch(n) {
      if (n === curEpoch) return;
      curEpoch = n;
      timers.forEach(function (t) { o.clearTimer(t); }); timers.clear();
      queue.slice().forEach(function (j) { if (j.epoch !== curEpoch) { var e = ent(j.acc); if (e.status === 'queued') e.status = 'none'; stats.cancelled++; inflight.delete(j.acc); j.resolve(get(j.acc)); } });
      queue = queue.filter(function (j) { return j.epoch === curEpoch; });
      entries.forEach(function (e) { if (e.status === 'error' || e.status === 'rate_limited') { e.status = 'none'; } });
    }
    /** Матч завершён: ничего больше не запрашиваем и не повторяем. */
    function stop() { setEpoch(curEpoch + 1000000); }

    return { request: request, get: get, setEpoch: setEpoch, stop: stop, stats: function () { return Object.assign({ queued: queue.length, running: running, pausedUntil: pausedUntil }, stats); }, config: cfg, clear: function () { cache.clear(); save(); } };
  }

  return { CONFIG: CONFIG, summarize: summarize, heroCompare: heroCompare, create: create };
});
