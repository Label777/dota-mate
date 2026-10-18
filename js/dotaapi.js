/*
 * Dota Mate: слой данных. Интерфейс не знает, откуда приходят данные.
 *
 * Контракт источника (его реализует create() ниже, а при смене источника достаточно написать другой create()):
 *   getHeroes()                      -> [{id, name, localized_name, ...}]
 *   getPlayer(acc)                   -> {profile, rank_tier, leaderboard_rank, computed_mmr, ...}
 *   getWinLoss(acc)                  -> {win, lose}
 *   getMatches(acc, {limit, offset}) -> [{match_id, player_slot, radiant_win, start_time, ...}]
 *   getRatings(acc)                  -> [{time, solo_competitive_rank, competitive_rank, match_id}]
 *   getMatchDetail(matchId)          -> подробный матч с players[]
 *   requestParse(matchId)            -> просит источник разобрать матч (позиции, линии)
 *   clearCache()
 * Ошибки: ApiError с полем code: invalid | not_found | rate_limit | network | timeout | api | bad_data.
 *
 * Эндпоинты OpenDota: /heroes, /players/{id}, /players/{id}/wl, /players/{id}/matches, /players/{id}/ratings, /matches/{id}.
 *
 * Про /players/{id}/matches. Без параметра project OpenDota отдаёт основные поля (hero_id, start_time, kills, deaths, assists,
 * duration, game_mode, lobby_type, party_size, leaver_status). GPM, XPM, добитые крипы и роль линии доступны только через project.
 * Проверка живого API показала, что сервер применяет только один project за запрос, поэтому getMatches сначала берёт основной
 * список, затем пробует запросить все дополнительные поля одним запросом и, если ответ неполный, запрашивает их по одному.
 * Ключей в коде нет: прямой доступ идёт без ключа, а при запуске с server.js запросы идут через его прокси.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMApi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIRECT_BASE = 'https://api.opendota.com/api';
  var EXTRA_FIELDS = ['gold_per_min', 'xp_per_min', 'last_hits', 'denies', 'lane_role'];
  var TTL = { heroes: 7 * 864e5, player: 36e5, wl: 6e5, matches: 6e5, ratings: 36e5, detail: 864e5 };

  function ApiError(code, message, extra) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message;
    if (extra) for (var k in extra) this[k] = extra[k];
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var ACC = /^\d{1,10}$/;
  function checkAcc(acc) {
    if (!ACC.test(String(acc))) throw new ApiError('invalid', 'Некорректный Steam ID.');
    return String(acc);
  }

  /**
   * opts: {base, fetch, storage, now(), sleep(ms), minInterval (мс между запросами), timeout (мс), prefix}
   * Запросы идут по одному с паузой minInterval. Повторные одинаковые запросы берутся из кэша или присоединяются
   * к уже идущему, поэтому перерисовка интерфейса сеть не нагружает.
   */
  function create(opts) {
    var o = {
      base: DIRECT_BASE,
      fetch: typeof fetch !== 'undefined' ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : self) : null,
      storage: null,
      now: function () { return Date.now(); },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      minInterval: 1000, timeout: 15000, prefix: 'dm.api.'
    };
    for (var k in (opts || {})) o[k] = opts[k];

    var mem = new Map(), inflight = new Map(), chain = Promise.resolve(), lastStart = 0;
    var multi = null; // true: сервер понимает несколько project сразу; false: только по одному; null: ещё не проверяли
    var stats = { requests: 0, cacheHits: 0 };

    function schedule(task) {
      var run = chain.then(function () {
        var wait = Math.max(0, lastStart + o.minInterval - o.now());
        return (wait ? o.sleep(wait) : Promise.resolve()).then(function () { lastStart = o.now(); return task(); });
      });
      chain = run.catch(function () { });
      return run;
    }

    function request(path, init) {
      var url = o.base + path;
      return schedule(function () {
        var attempt = 0;
        function once() {
          var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          var timer = ctl ? setTimeout(function () { ctl.abort(); }, o.timeout) : null;
          stats.requests++;
          return Promise.resolve().then(function () { var opt = Object.assign({}, init || {}); if (ctl) opt.signal = ctl.signal; return o.fetch(url, opt); })
            .then(function (res) {
              if (timer) clearTimeout(timer);
              if (res.status === 429) {
                var ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
                throw new ApiError('rate_limit', 'Превышен лимит запросов.', { status: 429, retryAfter: ra > 0 ? ra : null });
              }
              if (res.status === 404) throw new ApiError('not_found', 'Не найдено.', { status: 404 });
              if (res.status >= 500 && attempt < 1) { attempt++; return o.sleep(1200).then(once); }
              if (!res.ok) throw new ApiError('api', 'Ошибка API (HTTP ' + res.status + ').', { status: res.status });
              return res.json().catch(function () { throw new ApiError('bad_data', 'Ответ API не удалось разобрать.'); });
            }, function (err) {
              if (timer) clearTimeout(timer);
              if (attempt < 1 && !(init && init.method === 'POST')) { attempt++; return o.sleep(800).then(once); }
              var aborted = err && err.name === 'AbortError';
              throw new ApiError(aborted ? 'timeout' : 'network', aborted ? 'Сервер не ответил вовремя.' : 'Нет связи с сервером данных.');
            });
        }
        return once();
      });
    }

    function readCache(key, ttl) {
      var e = mem.get(key);
      if (!e && o.storage) {
        try { var raw = o.storage.getItem(o.prefix + key); if (raw) { e = JSON.parse(raw); mem.set(key, e); } } catch (x) { e = null; }
      }
      return e && e.t + ttl > o.now() ? e : null;
    }
    function dropStored() {
      if (!o.storage) return;
      try {
        var del = [];
        for (var i = 0; i < o.storage.length; i++) { var kk = o.storage.key(i); if (kk && kk.indexOf(o.prefix) === 0) del.push(kk); }
        del.forEach(function (kk) { o.storage.removeItem(kk); });
      } catch (x) { /* хранилище недоступно */ }
    }
    function writeCache(key, v, persist) {
      var e = { t: o.now(), v: v };
      mem.set(key, e);
      if (mem.size > 200) mem.delete(mem.keys().next().value);
      if (persist === false || !o.storage) return;
      try { o.storage.setItem(o.prefix + key, JSON.stringify(e)); }
      catch (x) { dropStored(); try { o.storage.setItem(o.prefix + key, JSON.stringify(e)); } catch (y) { /* без постоянного кэша */ } }
    }

    function cached(key, ttl, path, copts) {
      copts = copts || {};
      if (!copts.force) {
        var hit = readCache(key, ttl);
        if (hit) { stats.cacheHits++; return Promise.resolve(hit.v); }
      }
      if (inflight.has(key)) return inflight.get(key);
      var p = request(path).then(function (v) { writeCache(key, v, copts.persist); return v; });
      var clean = function () { inflight.delete(key); };
      p.then(clean, clean);
      inflight.set(key, p);
      return p;
    }

    function arr(v) {
      if (!Array.isArray(v)) throw new ApiError('bad_data', 'Ожидался список, получено другое.');
      return v;
    }

    function capsRead() {
      if (multi != null) return;
      if (!o.storage) return;
      try { var c = JSON.parse(o.storage.getItem(o.prefix + 'caps') || 'null'); if (c && typeof c.multi === 'boolean') multi = c.multi; } catch (x) { /* без памяти о возможностях */ }
    }
    function capsWrite(v) {
      multi = v;
      if (!o.storage) return;
      try { o.storage.setItem(o.prefix + 'caps', JSON.stringify({ multi: v })); } catch (x) { /* не критично */ }
    }
    function matchesPath(acc, limit, offset, fields) {
      return '/players/' + acc + '/matches?limit=' + limit + '&offset=' + offset + (fields || []).map(function (f) { return '&project=' + f; }).join('');
    }
    /** Переносит дополнительные поля из ответа с project в основной список по match_id. */
    function mergeRows(rows, extra) {
      var by = {};
      rows.forEach(function (r) { by[r.match_id] = r; });
      extra.forEach(function (e) {
        var r = by[e && e.match_id];
        if (!r) return;
        EXTRA_FIELDS.forEach(function (f) { if (e[f] != null) r[f] = e[f]; });
      });
    }
    function hasField(rows, f) { return rows.some(function (r) { return r[f] != null; }); }

    /** Дополняет основной список полями GPM, XPM, last_hits, denies, lane_role. */
    function enrich(acc, limit, offset, rows, c, onProgress) {
      var tag = acc + ':' + offset + ':' + limit;
      capsRead();
      var first = Promise.resolve(false);
      if (multi !== false) {
        first = cached('matchesx:' + tag, TTL.matches, matchesPath(acc, limit, offset, EXTRA_FIELDS), c).then(arr).then(function (ex) {
          mergeRows(rows, ex);
          var full = !ex.length || ex.some(function (r) { return r.gold_per_min !== undefined && r.xp_per_min !== undefined && r.last_hits !== undefined; });
          capsWrite(full);
          return full;
        });
      }
      return first.then(function (done) {
        if (done) { if (onProgress) onProgress(rows, EXTRA_FIELDS.length, EXTRA_FIELDS.length); return rows; }
        var seq = Promise.resolve(), n = 0;
        EXTRA_FIELDS.forEach(function (f) {
          seq = seq.then(function () {
            if (hasField(rows, f)) { n++; return null; }
            return cached('matches:' + f + ':' + tag, TTL.matches, matchesPath(acc, limit, offset, [f]), c).then(arr).then(function (ex) {
              mergeRows(rows, ex);
              n++;
              if (onProgress) onProgress(rows, n, EXTRA_FIELDS.length);
            });
          });
        });
        return seq.then(function () { return rows; });
      });
    }

    return {
      base: o.base,
      stats: stats,
      getHeroes: function (c) { return cached('heroes', TTL.heroes, '/heroes', c).then(arr); },
      getPlayer: function (acc, c) { acc = checkAcc(acc); return cached('player:' + acc, TTL.player, '/players/' + acc, c); },
      getWinLoss: function (acc, c) { acc = checkAcc(acc); return cached('wl:' + acc, TTL.wl, '/players/' + acc + '/wl', c); },
      /**
       * Страница матчей игрока. q: {limit, offset, onBase(rows), onProgress(rows, done, total), extra:false}.
       * onBase вызывается, как только пришли основные поля (интерфейс может показать таблицу), onProgress после каждого
       * дополнительного поля. extra:false оставляет только основные поля.
       */
      getMatches: function (acc, q, c) {
        acc = checkAcc(acc); q = q || {};
        var limit = Math.min(500, Math.max(1, q.limit | 0 || 100)), offset = Math.max(0, q.offset | 0);
        return cached('matches:' + acc + ':' + offset + ':' + limit, TTL.matches, matchesPath(acc, limit, offset), c).then(arr).then(function (base) {
          var rows = base.map(function (r) { return Object.assign({}, r); });
          if (q.onBase) q.onBase(rows);
          if (q.extra === false || !rows.length) return rows;
          return enrich(acc, limit, offset, rows, c, q.onProgress);
        });
      },
      getRatings: function (acc, c) { acc = checkAcc(acc); return cached('ratings:' + acc, TTL.ratings, '/players/' + acc + '/ratings', c).then(arr); },
      getMatchDetail: function (id, c) {
        if (!/^\d{4,13}$/.test(String(id))) throw new ApiError('invalid', 'Некорректный номер матча.');
        return cached('detail:' + id, TTL.detail, '/matches/' + id, Object.assign({ persist: false }, c || {}));
      },
      /** Просит OpenDota разобрать матч (POST /request/{id}). Разбор занимает минуты; результат ничем не кэшируется. */
      requestParse: function (id) {
        if (!/^\d{4,13}$/.test(String(id))) throw new ApiError('invalid', 'Некорректный номер матча.');
        var h = o.base === DIRECT_BASE ? undefined : { 'X-DM': '1' };
        return request('/request/' + id, { method: 'POST', headers: h });
      },
      clearCache: function () { mem.clear(); multi = null; dropStored(); }
    };
  }

  return { create: create, ApiError: ApiError, DIRECT_BASE: DIRECT_BASE, EXTRA_FIELDS: EXTRA_FIELDS, TTL: TTL };
});
