/*
 * Dota Mate: интерфейс раздела «Профиль игрока».
 * Зависит от DMA (js/analytics.js, расчёты) и DMApi (js/dotaapi.js, источник данных).
 * Хозяин (index.html) передаёт в init() несколько функций: esc, ico, base, server, heroName, myAcc, copy, toast.
 * Модуль сам рисует внутрь #me-root и сам обрабатывает свои события (атрибуты data-pa, data-pf), поэтому
 * остальной код сайта не затрагивается. Сеть вызывается только при действиях пользователя, не при отрисовке.
 */
(function () {
  'use strict';
  var A = window.DMA, API = window.DMApi, H = null;
  var LS = 'dotamate.profile.v1', POS_LS = 'dotamate.pos.';
  var C = { win: '#4a93c6', loss: '#d36c43', kda: '#9d7fcb' }; // проверены validate_palette.js для тёмной поверхности
  var PAGE = 100;
  var P = blank();
  var apis = {};

  function blank() {
    return {
      input: '', phase: 'idle', err: null, acc: null, steam64: null, profile: null, rank: null, lb: null, wl: null,
      pages: {}, matches: [], hasMore: true, nextOffset: 0, mstate: 'idle', merr: null, enrich: null, moreLoading: false,
      period: '30', minMatches: 5, tf: { hero: 'all', result: 'all', pos: 'all', period: 'all', flag: 'all' }, shown: 25, recPos: 'all',
      cmp: [], open: {}, posMap: {}, job: null, posMsg: '', ratings: undefined, heroes: null, token: 0, formErr: ''
    };
  }

  /* ---------- вспомогательное ---------- */
  var e = function (s) { return H.esc(s); };
  var ico = function (n, c) { return H.ico(n, c); };
  var $r = function () { return document.getElementById('me-root'); };
  function now() { return Math.floor(Date.now() / 1000); }
  function offMin() { return -new Date().getTimezoneOffset(); }
  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function pct(v) { return Math.round(v * 100) + '%'; }
  function pl(n, a, b, c) { return A.plural(n, a, b, c); }
  function nf(n) { return Number(n).toLocaleString('ru-RU'); }
  function dur(s) { s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60, p = function (n) { return (n < 10 ? '0' : '') + n; }; return h ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x); }
  function dt(ts) { return new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function dday(ts) { return new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function dIdx(d) { return new Date(d * 864e5).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  function store(k, v) {
    try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (x) { /* хранилище недоступно */ }
    return null;
  }
  function api() {
    var base = H.base();
    if (!apis[base]) {
      var st = null; try { st = window.localStorage; } catch (x) { st = null; }
      apis[base] = API.create({ base: base, storage: st, minInterval: H.server() ? 250 : 1000 });
    }
    return apis[base];
  }
  function heroName(id) {
    var n = H.heroName(id);
    if (n) return n;
    var h = P.heroes && P.heroes[id];
    return h && h.name ? h.name : 'Герой #' + id;
  }
  var AVRE = /^https:\/\/([a-z0-9-]+\.)+(steamstatic\.com|akamaihd\.net)\//;
  function pic(url, name, cls) {
    var ini = String(name || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
    return '<span class="pic ' + (cls || '') + '" aria-hidden="true">' + e(ini) + (url && AVRE.test(url) ? '<img src="' + e(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') + '</span>';
  }
  function hic(id, cls) {
    var h = P.heroes && P.heroes[id], slug = h && /^[a-z0-9_]+$/.test(h.slug) ? h.slug : null;
    var nm = H.heroName(id) || (h && h.name) || '', ini = nm.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    return '<span class="hic ' + (cls || '') + '" aria-hidden="true">' + e(ini) + (slug ? '<img src="https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/' + slug + '.png" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') + '</span>';
  }
  function sgn(v) { v = Math.round(v); return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v); }
  function scoreCls(v) { return v >= 8 ? 'up' : v <= -8 ? 'dn' : ''; }
  function scoreCell(m) {
    var r = P.sc && P.sc.scores && P.sc.scores[m.id];
    if (!r) return '<span class="na" title="' + e(P.sc && P.sc.ready ? 'Для этой игры не хватает данных (нужны два показателя из K/D/A, GPM, XPM)' : 'Нужно не меньше 8 матчей с данными K/D/A, GPM и XPM') + '">—</span>';
    var nm = { kda: '(K+A)/D', gpm: 'GPM', xpm: 'XPM' }, parts = Object.keys(r.parts).map(function (k) { return nm[k] + ' ' + sgn(r.parts[k]); }).join(', ');
    var tip = 'Оценка ' + sgn(r.v) + ' из ±50: 0 значит «сыграл как обычно». ' + parts + '. База: ' + (r.basis === 'hero' ? 'твои средние на этом герое' : 'твои средние по всем загруженным матчам') + '.';
    return '<span class="sc ' + scoreCls(r.v) + '" title="' + e(tip) + '">' + sgn(r.v) + '</span>';
  }
  function posLabel(p) { return p >= 1 && p <= 5 ? p + ' · ' + A.POS_NAMES[p] : 'Не определена'; }
  function periodDays() { return P.period === 'all' ? null : Number(P.period); }
  function periodList() { return P.period === 'all' ? P.matches : A.filterMatches(P.matches, { periodDays: Number(P.period), now: now() }); }
  function periodName() { return P.period === '7' ? '7 дней' : P.period === '30' ? '30 дней' : 'всё загруженное время'; }

  /* ---------- сохранение последнего профиля ---------- */
  function saved() { var s = store(LS); return s && typeof s === 'object' ? s : {}; }
  function remember() {
    var s = saved(), pr = P.profile || {};
    var item = { acc: P.acc, name: String(pr.personaname || '').slice(0, 40), avatar: AVRE.test(pr.avatarfull || '') ? pr.avatarfull : '', at: now() };
    var list = [item].concat((s.recent || []).filter(function (x) { return x.acc !== P.acc; })).slice(0, 5);
    store(LS, { last: item, recent: list, minMatches: P.minMatches });
  }
  function loadPos(acc) { var m = store(POS_LS + acc); return m && typeof m === 'object' ? m : {}; }
  function savePos() {
    var ids = Object.keys(P.posMap);
    if (ids.length > 3000) ids.sort().slice(0, ids.length - 3000).forEach(function (k) { delete P.posMap[k]; });
    store(POS_LS + P.acc, P.posMap);
  }

  /* ---------- загрузка данных ---------- */
  function errInfo(x) {
    var c = x && x.code;
    if (c === 'not_found') return { t: 'Игрок не найден', d: 'OpenDota не знает такого аккаунта. Проверьте ID. Если аккаунт новый или данные скрыты, у OpenDota может не быть записей о нём.', retry: false };
    if (c === 'rate_limit') return { t: 'Превышен лимит запросов', d: 'OpenDota временно ограничил число запросов' + (x.retryAfter ? ' (повторите через ' + x.retryAfter + ' с)' : '') + '. Подождите минуту и повторите.', retry: true };
    if (c === 'network') return { t: 'Нет связи с OpenDota', d: 'Не удалось выполнить запрос. Проверьте подключение к интернету или попробуйте позже.', retry: true };
    if (c === 'timeout') return { t: 'OpenDota долго не отвечает', d: 'Запрос прерван по таймауту. Попробуйте ещё раз.', retry: true };
    if (c === 'bad_data') return { t: 'Неожиданный ответ API', d: 'OpenDota вернул данные в неизвестном формате. Попробуйте позже.', retry: true };
    if (c === 'invalid') return { t: 'Некорректный Steam ID', d: 'Проверьте введённые данные.', retry: false };
    return { t: 'Ошибка API', d: 'OpenDota ответил ошибкой' + (x && x.status ? ' (код ' + x.status + ')' : '') + '. Данные сейчас недоступны, попробуйте позже.', retry: true };
  }
  function rebuild() {
    var seen = {}, list = [];
    Object.keys(P.pages).map(Number).sort(function (a, b) { return a - b; }).forEach(function (off) {
      P.pages[off].forEach(function (r) {
        var m = A.normalizeMatch(r);
        if (!m || seen[m.id]) return;
        seen[m.id] = 1;
        var p = P.posMap[m.id];
        m.pos = p >= 1 && p <= 5 ? p : null;
        m.role = p === 'c' ? 'core' : p === 's' ? 'support' : null;
        list.push(m);
      });
    });
    P.matches = A.newestFirst(list);
    P.sc = A.matchScores(P.matches);
  }
  function active(tok) { return tok === P.token; }

  async function lookup(acc, o) {
    o = o || {};
    var tok = ++P.token, keep = { input: P.input, minMatches: P.minMatches };
    P = Object.assign(blank(), keep, { token: tok, phase: 'finding', acc: acc, period: P.period, recPos: 'all' });
    P.posMap = loadPos(acc);
    if (H.onOpen) H.onOpen(acc);
    var a = api();
    if (o.refresh) a.clearCache();
    render();
    try {
      var heroesP = a.getHeroes().then(function (list) {
        var m = {};
        list.forEach(function (h) { if (h && h.id != null) m[h.id] = { slug: String(h.name || '').replace(/^npc_dota_hero_/, ''), name: h.localized_name || '' }; });
        return m;
      }).catch(function () { return null; });
      var pl0 = await a.getPlayer(acc);
      if (!active(tok)) return;
      var prof = pl0 && pl0.profile;
      if (!prof) { P.phase = 'error'; P.err = { t: 'Профиль не найден', d: 'OpenDota не вернул профиль для этого ID. Проверьте номер. Если аккаунт новый или скрыт, данных о нём может не быть.', retry: false }; render(); return; }
      P.profile = prof; P.steam64 = String(BigInt(acc) + 76561197960265728n);
      P.rank = A.rankTier(pl0.rank_tier); P.lb = pl0.leaderboard_rank || null;
      P.phase = 'ready'; P.mstate = 'loading';
      remember();
      render();
      a.getWinLoss(acc).then(function (w) { if (active(tok) && w && typeof w.win === 'number') { P.wl = { win: w.win, lose: w.lose }; render(); } }).catch(function () { });
      P.heroes = await heroesP;
      if (!active(tok)) return;
      await loadMatches(tok);
    } catch (x) {
      if (!active(tok)) return;
      P.phase = 'error'; P.err = errInfo(x); render();
    }
  }

  async function loadMatches(tok) {
    var a = api(), offset = P.nextOffset;
    if (P.moreLoading) return;
    P.moreLoading = true; if (P.mstate !== 'ok') P.mstate = 'loading'; P.merr = null;
    render();
    try {
      var rows = await a.getMatches(P.acc, {
        limit: PAGE, offset: offset,
        onBase: function (r) { if (!active(tok)) return; P.pages[offset] = r; P.enrich = { done: 0, total: 5 }; rebuild(); P.mstate = 'ok'; render(); },
        onProgress: function (r, d, t) { if (!active(tok)) return; P.pages[offset] = r; P.enrich = d < t ? { done: d, total: t } : null; rebuild(); render(); }
      });
      if (!active(tok)) return;
      P.pages[offset] = rows; P.enrich = null;
      P.hasMore = rows.length >= PAGE; P.nextOffset = offset + rows.length;
      rebuild();
      P.mstate = P.matches.length ? 'ok' : 'empty';
      P.moreLoading = false;
      if (P.ratings === undefined) loadRatings(tok);
      if (!Object.keys(P.posMap).length) setTimeout(function () { if (active(tok)) runPosJob(20); }, 0);
    } catch (x) {
      if (!active(tok)) return;
      P.moreLoading = false; P.enrich = null;
      if (P.matches.length) { P.mstate = 'ok'; P.merr = errInfo(x); } else { P.mstate = 'error'; P.merr = errInfo(x); }
    }
    render();
  }
  function loadRatings(tok) {
    P.ratings = null;
    api().getRatings(P.acc).then(function (r) { if (active(tok)) { P.ratings = r || []; render(); } }).catch(function () { if (active(tok)) { P.ratings = []; render(); } });
  }

  async function runPosJob(limit) {
    if (P.job) return;
    var tok = P.token, a = api(), acc = P.acc;
    var todo = P.matches.filter(function (m) { return !(m.id in P.posMap); })    .slice(0, limit || 30);
    if (!todo.length) { if (!limit) P.posMsg = 'Для всех загруженных матчей позиция уже проверена.'; render(); return; }
    P.job = { done: 0, total: todo.length, found: 0, roles: 0, stop: false }; P.posMsg = ''; render();
    for (var i = 0; i < todo.length; i++) {
      if (!active(tok) || P.job.stop) break;
      try {
        var d = await a.getMatchDetail(todo[i].id);
        var r = A.inferPosition(d && d.players, acc);
        if (r.pos >= 1 && r.pos <= 5) { P.posMap[todo[i].id] = r.pos; P.job.found++; }
        else {
          var ro = A.inferRole(d && d.players, acc);
          P.posMap[todo[i].id] = ro.role === 'core' ? 'c' : ro.role === 'support' ? 's' : 0;
          if (ro.role) P.job.roles++;
        }
      } catch (x) {
        if (x.code === 'not_found') P.posMap[todo[i].id] = 0;
        else { P.posMsg = x.code === 'rate_limit' ? 'Лимит запросов OpenDota исчерпан. Продолжите чуть позже: уже найденные позиции сохранены.' : 'Не удалось получить часть матчей. Попробуйте ещё раз.'; break; }
      }
      if (!active(tok)) return;
      P.job.done++;
      if (P.job.done % 4 === 0) { savePos(); rebuild(); render(); }
    }
    if (!active(tok)) return;
    var job = P.job; P.job = null; savePos(); rebuild();
    if (!P.posMsg && !limit) P.posMsg = 'Проверено матчей: ' + job.done + '. Точная позиция определена в ' + job.found + (job.roles ? ', только роль «кор» или «саппорт» по золоту команды — в ' + job.roles : '') + '. ' + (job.found < job.done ? 'Остальные матчи OpenDota не разобрал, поэтому линии неизвестны. Их можно отправить на разбор кнопкой ниже.' : '');
    render();
  }

  /** Отправляет до 10 самых свежих неразобранных матчей на разбор OpenDota (по клику; повтор не раньше чем через сутки). */
  async function requestParses() {
    if (P.job || P.parsing) return;
    var tok = P.token, a = api(), key = 'dotamate.parsereq.' + P.acc, sent = store(key) || {}, t = now();
    var todo = P.matches.filter(function (m) { return !(P.posMap[m.id] >= 1) && m.id in P.posMap && !(sent[m.id] > t - 86400); }).slice(0, 10);
    if (!todo.length) { P.posMsg = 'Нет матчей, которые стоит отправлять на разбор: либо всё определено, либо запрос уже отправлялся за последние сутки.'; render(); return; }
    P.parsing = true; P.posMsg = 'Отправляю матчи на разбор…'; render();
    var ok = 0, msg = '';
    for (var i = 0; i < todo.length; i++) {
      try { await a.requestParse(todo[i].id); sent[todo[i].id] = t; ok++; }
      catch (x) { msg = x.code === 'rate_limit' ? 'Лимит запросов исчерпан.' : 'Не удалось отправить часть запросов.'; break; }
    }
    store(key, sent);
    if (!active(tok)) return;
    P.parsing = false;
    P.posMsg = 'Отправлено на разбор: ' + ok + ' ' + pl(ok, 'матч', 'матча', 'матчей') + '. ' + msg + (ok ? ' OpenDota разбирает матчи в очереди, обычно это занимает от нескольких минут до часа. Потом нажмите «Перепроверить неточные».' : '');
    render();
  }

  /* ---------- ввод и поиск ---------- */
  async function submit(raw) {
    var r = A.parsePlayerInput(raw);
    P.formErr = '';
    if (r.ok) { P.input = raw; await lookup(r.acc); return; }
    if (r.code === 'vanity') {
      if (H.server()) {
        try {
          var res = await fetch('/api/steam/resolve?vanity=' + encodeURIComponent(r.vanity));
          if (res.status === 501) P.formErr = 'Ссылки с именем (/id/' + r.vanity + ') на этом сервере не разбираются: не задан STEAM_API_KEY. Вставьте ссылку вида steamcommunity.com/profiles/7656119… или числовой ID.';
          else if (res.ok) {
            var j = await res.json();
            if (j.steam64) { var rr = A.parsePlayerInput(j.steam64); if (rr.ok) { await lookup(rr.acc); return; } }
            P.formErr = 'Steam не нашёл профиль с именем «' + r.vanity + '».';
          } else P.formErr = 'Не удалось разобрать ссылку через Steam. Вставьте ссылку вида steamcommunity.com/profiles/7656119… или числовой ID.';
        } catch (x) { P.formErr = 'Не удалось связаться с сервером. Вставьте ссылку вида steamcommunity.com/profiles/7656119… или числовой ID.'; }
      } else P.formErr = 'Ссылка с именем (/id/' + r.vanity + ') не содержит числового ID, а разобрать её без ключа Steam API нельзя. Откройте профиль в Steam и скопируйте числовой SteamID64 (17 цифр) либо ссылку вида /profiles/7656119….';
    } else if (r.code === 'empty') P.formErr = 'Введите Steam ID, SteamID64 или ссылку на профиль.';
    else P.formErr = 'Не удалось распознать ввод. Подходят: SteamID64 (17 цифр, начинается с 7656119…), числовой Steam ID, STEAM_0:X:Y, [U:1:N] или ссылка вида steamcommunity.com/profiles/…, opendota.com/players/…, dotabuff.com/players/….';
    renderSearch();
  }

  /* ---------- графики ---------- */
  var W = 400, HT = 190, M = { l: 34, r: 10, t: 12, b: 24 };
  function sx(i, n) { return M.l + (n <= 1 ? (W - M.l - M.r) / 2 : (W - M.l - M.r) * i / (n - 1)); }
  function ticks(max, n) { var out = [], step = max / n; for (var i = 0; i <= n; i++) out.push(i * step); return out; }
  function tipAttr(t, x) { return ' data-tip="' + e(t) + '" data-x="' + x + '"'; }
  function chartFrame(inner, label, desc) {
    return '<svg viewBox="0 0 ' + W + ' ' + HT + '" role="img" aria-label="' + e(label) + '"><desc>' + e(desc || '') + '</desc>' + inner + '<line class="xh" x1="0" x2="0" y1="' + M.t + '" y2="' + (HT - M.b) + '" visibility="hidden"/></svg>';
  }
  function xLabels(items, n) { // items: [{i, label}] -- подписи по оси X, не более 5
    var step = Math.max(1, Math.ceil(items.length / 5)), out = '';
    items.forEach(function (it, k) {
      if (k % step && k !== items.length - 1) return;
      var x = sx(it.i, n), anchor = it.i === 0 ? 'start' : it.i === n - 1 ? 'end' : 'middle';
      out += '<text x="' + x + '" y="' + (HT - 6) + '" text-anchor="' + anchor + '">' + e(it.label) + '</text>';
    });
    return out;
  }
  function yGrid(max, fmt, n) {
    var out = '';
    ticks(max, n || 4).forEach(function (v) {
      var y = M.t + (HT - M.t - M.b) * (1 - v / max);
      out += '<line class="' + (v === 0 ? 'axis' : 'grid') + '" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (M.l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + e(fmt(v)) + '</text>';
    });
    return out;
  }
  /** Круглый максимум оси и число делений: целые подписи без дробей вроде 5.5. */
  function niceScale(v) {
    var m = Math.max(2, Math.ceil(v));
    if (m <= 4) return { max: m, n: m };
    m = Math.ceil(m / 4) * 4;
    return { max: m, n: 4 };
  }
  function yPos(v, max) { return M.t + (HT - M.t - M.b) * (1 - v / max); }

  /** Линия по точкам [{v|null, tip, label}] с разрывами на пустых значениях. */
  function lineChart(pts, o) {
    var n = pts.length, max = o.max, d = '', pen = false, marks = '', hit = '', refl = '';
    var colW = n > 1 ? (W - M.l - M.r) / (n - 1) : 40;
    pts.forEach(function (p, i) {
      var x = sx(i, n);
      if (p.v == null) { pen = false; }
      else {
        var y = yPos(Math.min(p.v, max), max);
        d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); pen = true;
        if (n <= 40 || i === n - 1) marks += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" fill="' + o.color + '" stroke="#1b1e25" stroke-width="2"/>';
      }
      hit += '<rect class="hit"' + tipAttr(p.tip, x.toFixed(1)) + ' x="' + (x - colW / 2).toFixed(1) + '" y="' + M.t + '" width="' + colW.toFixed(1) + '" height="' + (HT - M.t - M.b) + '"/>';
    });
    if (o.ref != null) { var ry = yPos(o.ref, max); refl = '<line class="grid" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + ry + '" y2="' + ry + '" stroke-dasharray="4 4" style="stroke:#566073"/><text x="' + (W - M.r) + '" y="' + (ry - 4) + '" text-anchor="end">' + e(o.refLabel || '') + '</text>'; }
    var extra = o.extra || '';
    return chartFrame(yGrid(max, o.fmt, o.yn) + refl + (d ? '<path d="' + d + '" fill="none" stroke="' + o.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' : '') + extra + marks + xLabels(o.x, n) + hit, o.label, o.desc);
  }

  function chartWinrate(ts, list) {
    var pts = ts.points.map(function (p) {
      var lab = ts.bucket === 'week' ? 'Неделя с ' + dIdx(p.startDay) : dIdx(p.startDay);
      return { v: p.cumWr == null ? null : p.cumWr * 100, tip: lab + '\nВинрейт нарастающим итогом: ' + (p.cumWr == null ? 'нет матчей' : pct(p.cumWr) + ' (' + p.cumN + ' ' + pl(p.cumN, 'матч', 'матча', 'матчей') + ')') + (p.n ? '\nЗа ' + (ts.bucket === 'week' ? 'неделю' : 'день') + ': ' + p.w + ' п. / ' + p.l + ' пор.' : '') };
    });
    var x = ts.points.map(function (p, i) { return { i: i, label: dIdx(p.startDay) }; });
    var svg = lineChart(pts, { max: 100, color: C.win, fmt: function (v) { return Math.round(v) + '%'; }, yn: 4, ref: 50, refLabel: '50%', x: x, label: 'Винрейт нарастающим итогом за ' + periodName(), desc: 'Линия показывает долю побед с начала периода к концу каждого дня.' });
    var rows = ts.points.filter(function (p) { return p.n; }).map(function (p) { return '<tr><td>' + e(dIdx(p.startDay)) + '</td><td>' + p.w + ' / ' + p.l + '</td><td>' + pct(p.cumWr) + '</td></tr>'; }).join('');
    return svg + '<details><summary>Таблица значений</summary><div class="mini-wrap"><table class="mini"><thead><tr><th>' + (ts.bucket === 'week' ? 'Неделя' : 'День') + '</th><th>П / Пор</th><th>Винрейт итого</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
  }

  function chartWL(ts) {
    var pts = ts.points, n = pts.length, sc = niceScale(Math.max.apply(null, pts.map(function (p) { return p.n; }))), max = sc.max;
    var inner = yGrid(max, function (v) { return Math.round(v); }, sc.n);
    var colW = (W - M.l - M.r) / n, bw = Math.max(2, Math.min(24, colW - 2)), hit = '', bars = '';
    var uh = HT - M.t - M.b;
    pts.forEach(function (p, i) {
      var cx = M.l + colW * (i + 0.5), x = cx - bw / 2, hW = uh * p.w / max, hL = uh * p.l / max, base = HT - M.b;
      if (p.w) bars += '<rect x="' + x.toFixed(1) + '" y="' + (base - hW).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hW.toFixed(1) + '" rx="2" fill="' + C.win + '"/>';
      if (p.l) bars += '<rect x="' + x.toFixed(1) + '" y="' + (base - hW - hL - (p.w ? 2 : 0)).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hL.toFixed(1) + '" rx="2" fill="' + C.loss + '"/>';
      var lab = ts.bucket === 'week' ? 'Неделя с ' + dIdx(p.startDay) : dIdx(p.startDay);
      hit += '<rect class="hit"' + tipAttr(lab + '\nПобед: ' + p.w + '\nПоражений: ' + p.l, cx.toFixed(1)) + ' x="' + (cx - colW / 2).toFixed(1) + '" y="' + M.t + '" width="' + colW.toFixed(1) + '" height="' + uh + '"/>';
    });
    var labs = pts.map(function (p, i) { return { i: i, label: dIdx(p.startDay) }; }), step = Math.max(1, Math.ceil(labs.length / 5)), xl = '';
    labs.forEach(function (it, k) { if (k % step) return; xl += '<text x="' + (M.l + colW * (it.i + 0.5)).toFixed(1) + '" y="' + (HT - 6) + '" text-anchor="' + (it.i === 0 ? 'start' : 'middle') + '">' + e(it.label) + '</text>'; });
    var rows = pts.filter(function (p) { return p.n; }).map(function (p) { return '<tr><td>' + e(dIdx(p.startDay)) + '</td><td>' + p.w + '</td><td>' + p.l + '</td></tr>'; }).join('');
    return chartFrame(inner + bars + xl + hit, 'Победы и поражения по ' + (ts.bucket === 'week' ? 'неделям' : 'дням'), 'Столбики показывают число побед и поражений за каждый ' + (ts.bucket === 'week' ? 'период в неделю' : 'день') + '.') +
      '<div class="legend"><span><i style="background:' + C.win + '"></i>Победы</span><span><i style="background:' + C.loss + '"></i>Поражения</span></div>' +
      '<details><summary>Таблица значений</summary><div class="mini-wrap"><table class="mini"><thead><tr><th>' + (ts.bucket === 'week' ? 'Неделя' : 'День') + '</th><th>Победы</th><th>Поражения</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
  }

  function chartKda(series) {
    var n = series.length, vmax = Math.max.apply(null, series.map(function (s) { return s.v; })), sc = niceScale(vmax), max = sc.max;
    var pts = series.map(function (s, i) {
      return { v: s.ma, tip: dt(s.match.start) + ' · ' + heroName(s.match.hero) + '\n' + s.match.k + '/' + s.match.d + '/' + s.match.a + ' · (K+A)/D = ' + f1(s.v) + (s.ma != null ? '\nСреднее за 5 матчей: ' + f1(s.ma) : '') };
    });
    var dots = series.map(function (s, i) { return '<circle cx="' + sx(i, n).toFixed(1) + '" cy="' + yPos(Math.min(s.v, max), max).toFixed(1) + '" r="2.5" fill="#7d8592" opacity=".75"/>'; }).join('');
    var x = series.map(function (s, i) { return { i: i, label: dIdx(Math.floor((s.match.start + offMin() * 60) / 86400)) }; });
    var svg = lineChart(pts, { max: max, color: C.kda, fmt: function (v) { return String(Math.round(v)); }, yn: sc.n, x: x, extra: dots, label: 'Динамика (K+A)/D по матчам', desc: 'Серые точки: показатель каждого матча. Линия: скользящее среднее за 5 матчей.' });
    var rows = series.slice().reverse().map(function (s) { return '<tr><td>' + e(dt(s.match.start)) + '</td><td>' + s.match.k + '/' + s.match.d + '/' + s.match.a + '</td><td>' + f1(s.v) + '</td></tr>'; }).join('');
    return svg + '<div class="legend"><span><i style="background:#7d8592"></i>Матч</span><span><i style="background:' + C.kda + '"></i>Среднее за 5 матчей</span></div>' +
      '<details><summary>Таблица значений</summary><div class="mini-wrap"><table class="mini"><thead><tr><th>Матч</th><th>K/D/A</th><th>(K+A)/D</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
  }

  function chartMmr(r) {
    var pts = r.map(function (x) { return { t: x.time, v: x.solo_competitive_rank }; });
    var lo = Math.min.apply(null, pts.map(function (p) { return p.v; })), hi = Math.max.apply(null, pts.map(function (p) { return p.v; }));
    var pad = Math.max(20, Math.round((hi - lo) * 0.15)), mn = Math.floor((lo - pad) / 100) * 100, mx = Math.ceil((hi + pad) / 100) * 100, rng = mx - mn;
    var n = pts.length, d = '', hit = '', marks = '', colW = (W - M.l - M.r) / Math.max(1, n - 1);
    pts.forEach(function (p, i) {
      var x = sx(i, n), y = yPos(p.v - mn, rng);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      if (n <= 40 || i === n - 1) marks += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" fill="' + C.win + '" stroke="#1b1e25" stroke-width="2"/>';
      hit += '<rect class="hit"' + tipAttr(dday(p.t) + '\nMMR: ' + p.v, x.toFixed(1)) + ' x="' + (x - colW / 2).toFixed(1) + '" y="' + M.t + '" width="' + colW.toFixed(1) + '" height="' + (HT - M.t - M.b) + '"/>';
    });
    var inner = yGrid(rng, function (v) { return Math.round(v + mn); }, 4) + '<path d="' + d + '" fill="none" stroke="' + C.win + '" stroke-width="2" stroke-linejoin="round"/>' + marks +
      xLabels(pts.map(function (p, i) { return { i: i, label: new Date(p.t * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) }; }), n) + hit;
    return chartFrame(inner, 'MMR по данным, которые игрок указал на профиле', 'Значения из списка рейтинга OpenDota.');
  }

  function streakStrip(list) {
    var c = A.chrono(list).slice(-60);
    if (!c.length) return '';
    var cells = c.map(function (m) { return '<i class="' + (m.win ? 'w' : 'l') + '" data-tip="' + e(dt(m.start) + ' · ' + heroName(m.hero) + '\n' + (m.win ? 'Победа' : 'Поражение')) + '"></i>'; }).join('');
    return '<div class="strip" role="img" aria-label="Последние ' + c.length + ' матчей слева направо от старых к новым: ' + c.filter(function (m) { return m.win; }).length + ' побед">' + cells + '</div>';
  }

  /* ---------- секции ---------- */
  function kpi(k, v, s, cls, main) { return '<div class="kpi' + (main ? ' main' : '') + '"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>'; }
  function na(why) { return '<span class="na" title="' + e(why || 'Нет данных') + '">—</span>'; }
  function cnt(n) { return n + ' ' + pl(n, 'матч', 'матча', 'матчей'); }

  function secSearch() {
    var s = saved(), chips = '';
    var mine = H.myAcc();
    if (mine && mine !== P.acc) chips += '<button type="button" class="chip" data-pa="open" data-acc="' + e(mine) + '"><span class="pic" aria-hidden="true">' + ico('user') + '</span>Мой профиль</button>';
    (s.recent || []).filter(function (x) { return x.acc !== P.acc && x.acc !== mine; }).slice(0, 4).forEach(function (x, i) {
      chips += '<button type="button" class="chip" data-pa="open" data-acc="' + e(x.acc) + '" title="Steam ID ' + e(x.acc) + '">' + pic(x.avatar, x.name) + e(x.name || x.acc) + (i === 0 && s.last && s.last.acc === x.acc ? '<span class="sm">&nbsp;последний</span>' : '') + '</button>';
    });
    return '<section class="card me-search"><form id="me-form" novalidate><label for="me-in">Steam ID, SteamID64 или ссылка на профиль Steam</label>' +
      '<div class="me-row"><input id="me-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="7656119… или steamcommunity.com/profiles/…" value="' + e(P.input) + '"' + (P.formErr ? ' aria-invalid="true" aria-describedby="me-ferr"' : '') + '>' +
      '<button class="btn primary" type="submit"' + (P.phase === 'finding' ? ' disabled' : '') + '>' + ico('search') + 'Найти игрока</button></div>' +
      (P.formErr ? '<div class="banner soft me-err" id="me-ferr" role="alert">' + ico('alert') + '<p>' + e(P.formErr) + '</p></div>' : '<p class="sm hint">Данные берутся у OpenDota из публичных профилей. Пароль Steam не нужен и не запрашивается.</p>') +
      '</form>' + (chips ? '<div class="me-quick"><span class="lbl">Быстро открыть:</span>' + chips + '</div>' : '') + '</section>';
  }

  function secHead() {
    var pr = P.profile, total = P.wl ? P.wl.win + P.wl.lose : null;
    var ids = '<span class="sm">Steam ID <span class="mono">' + e(P.acc) + '</span> <button class="iconbtn" type="button" data-pa="copy" data-t="' + e(P.acc) + '" aria-label="Скопировать Steam ID">' + ico('copy') + '</button></span>' +
      '<span class="sm">SteamID64 <span class="mono">' + e(P.steam64) + '</span> <button class="iconbtn" type="button" data-pa="copy" data-t="' + e(P.steam64) + '" aria-label="Скопировать SteamID64">' + ico('copy') + '</button></span>';
    var rank = P.rank ? '<span class="rank" title="Ранг из профиля OpenDota">' + ico('star') + e(P.rank.label) + '</span>' : '';
    var lb = P.lb ? '<span class="rank" title="Место в рейтинге Immortal">Immortal #' + e(P.lb) + '</span>' : '';
    var sum = P.wl && total ? '<p class="sm" style="margin-top:8px">Всего у OpenDota по аккаунту: ' + nf(total) + ' ' + pl(total, 'матч', 'матча', 'матчей') + ', ' + nf(P.wl.win) + ' побед, ' + nf(P.wl.lose) + ' поражений' + (total ? ' (' + pct(P.wl.win / total) + ')' : '') + '.</p>' : '';
    return '<section class="card"><div class="me-head">' + pic(pr.avatarfull, pr.personaname) + '<div class="who"><h2>' + e(pr.personaname || 'Без имени') + '</h2><div class="me-ids">' + ids + '</div><div class="me-links">' + rank + lb +
      '<a class="btn sm2" href="https://steamcommunity.com/profiles/' + e(P.steam64) + '" target="_blank" rel="noopener noreferrer">' + ico('ext') + 'Профиль Steam</a>' +
      '<a class="btn sm2" href="https://www.opendota.com/players/' + e(P.acc) + '" target="_blank" rel="noopener noreferrer">' + ico('ext') + 'OpenDota</a>' +
      '<button class="btn sm2" type="button" data-pa="refresh">' + ico('refresh') + 'Обновить данные</button></div>' + sum + '</div></div></section>';
  }

  function covBanner(list) {
    var c = A.coverage(P.matches, P.wl ? P.wl.win + P.wl.lose : null, P.hasMore);
    if (c.complete || !P.matches.length) return '';
    var txt = 'Загружено матчей: ' + nf(c.loaded) + (c.total ? ' из ' + nf(c.total) : '') + (c.oldest ? ' (самый ранний от ' + dday(c.oldest) + ')' : '') + '. Это не вся история аккаунта, поэтому показатели «за всё время» и серии считаются только по загруженному.';
    var covered = A.coversPeriod(P.matches, periodDays(), now(), P.hasMore);
    if (periodDays() && !covered) txt = 'Загруженные матчи не доходят до начала периода «' + periodName() + '» (самый ранний от ' + (c.oldest ? dday(c.oldest) : '—') + '): показатели за период могут быть неполными.';
    else if (periodDays() && covered) return '';
    return '<div class="banner warn" role="note">' + ico('info') + '<div style="flex:1"><p>' + e(txt) + '</p></div>' + (P.hasMore ? '<button class="btn sm2" type="button" data-pa="more" ' + (P.moreLoading ? 'disabled' : '') + '>' + (P.moreLoading ? 'Загружаю…' : 'Загрузить ещё ' + PAGE) + '</button>' : '') + '</div>';
  }

  function secStats(list) {
    var s = A.summarize(list), st = A.streaks(P.matches), stP = A.streaks(list);
    var seg = '<div class="seg" role="group" aria-label="Период статистики">' + [['7', '7 дней'], ['30', '30 дней'], ['all', 'Всё время']].map(function (x) { return '<button type="button" data-pa="period" data-v="' + x[0] + '" aria-pressed="' + (P.period === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>';
    var body;
    if (!list.length) {
      body = '<div class="empty sm-empty">' + ico('list') + '<b>За этот период матчей нет</b><p>' + (P.hasMore ? 'В загруженной истории нет матчей за ' + e(periodName()) + '. Попробуйте «Всё время» или загрузите более ранние матчи.' : 'У игрока нет матчей за ' + e(periodName()) + '.') + '</p></div>';
    } else {
      var kda = s.kdaN ? '<span style="color:#8fd1ae">' + f1(s.k) + '</span> / <span style="color:#f0a0a4">' + f1(s.d) + '</span> / ' + f1(s.a) : na();
      var part = function (n, tot) { return n < tot ? 'по ' + n + ' из ' + tot + ' матчей' : ''; };
      var cur = st.current.len ? st.current.len + ' ' + (st.current.type === 'win' ? pl(st.current.len, 'победа', 'победы', 'побед') : pl(st.current.len, 'поражение', 'поражения', 'поражений')) : '—';
      body = '<div class="kpis">' +
        kpi('Матчей', nf(s.n), 'за ' + e(periodName()), '', true) +
        kpi('Винрейт', pct(s.winrate), s.wins + ' п. / ' + s.losses + ' пор.', s.winrate >= 0.5 ? 'w' : 'l', true) +
        kpi('K / D / A', kda, s.kdaN ? '(K+A)/D = ' + f1(s.kdaRatio) + (part(s.kdaN, s.n) ? ', ' + part(s.kdaN, s.n) : '') : 'нет данных') +
        kpi('GPM / XPM', s.gpmN || s.xpmN ? (s.gpmN ? Math.round(s.gpm) : '—') + ' / ' + (s.xpmN ? Math.round(s.xpm) : '—') : na(), s.gpmN || s.xpmN ? (part(Math.min(s.gpmN || s.n, s.xpmN || s.n), s.n) || 'средние за период') : (P.enrich ? 'загружаю…' : 'нет данных')) +
        kpi('Длительность', s.durN ? dur(s.dur) : na(), 'средняя' + (part(s.durN, s.n) ? ', ' + part(s.durN, s.n) : '')) +
        kpi('Текущая серия', cur, st.current.len ? 'по последним загруженным матчам' : '', st.current.type === 'win' ? 'w' : st.current.type === 'loss' ? 'l' : '') +
        kpi('Лучшая серия побед', stP.longestWin ? stP.longestWin + ' ' + pl(stP.longestWin, 'победа', 'победы', 'побед') : '0', 'в матчах периода' + (A.coversPeriod(P.matches, periodDays(), now(), P.hasMore) ? '' : ', без учёта незагруженных'), '') +
        (function () {
          var sv = list.map(function (m) { return P.sc.scores[m.id]; }).filter(Boolean).map(function (r) { return r.v; });
          if (!sv.length) return kpi('Оценка игр', na('Нужно не меньше 8 матчей с данными K/D/A, GPM и XPM'), 'нет данных', '');
          var avg = sv.reduce(function (x, y) { return x + y; }, 0) / sv.length;
          return kpi('Оценка игр', sgn(avg), 'среднее за период, шкала −50…+50, 0 — как обычно' + (sv.length < list.length ? ', по ' + sv.length + ' из ' + list.length : ''), scoreCls(avg) === 'up' ? 'w' : scoreCls(avg) === 'dn' ? 'l' : '');
        })() +
        '</div>';
    }
    return '<section><div class="sec-h"><h2>Личная статистика</h2>' + seg + '</div>' + covBanner(list) + body + '</section>';
  }

  function secInsights() {
    var ins = A.buildInsights({ matches: P.matches, now: now(), minMatches: P.minMatches, heroName: heroName, coverage: A.coverage(P.matches, P.wl ? P.wl.win + P.wl.lose : null, P.hasMore) });
    var icon = { good: 'check', warn: 'alert', info: 'info' };
    var list = '<ul class="ins">' + ins.map(function (i) { return '<li class="' + i.level + '">' + ico(icon[i.level] || 'info') + '<span>' + e(i.text) + '</span></li>'; }).join('') + '</ul>';
    var posKnown = {}; P.matches.forEach(function (m) { if (m.pos) posKnown[m.pos] = 1; });
    var opts = '<option value="all">Любая позиция</option>' + Object.keys(posKnown).sort().map(function (p) { return '<option value="' + p + '"' + (String(P.recPos) === p ? ' selected' : '') + '>' + e(posLabel(Number(p))) + '</option>'; }).join('');
    var rec = A.recommendHeroes(P.matches, { minMatches: P.minMatches, pos: P.recPos === 'all' ? null : Number(P.recPos), limit: 5 });
    var recHtml = rec.items.length ? '<div class="recs">' + rec.items.map(function (h) {
      return '<div class="rec">' + hic(h.heroId, 'lg') + '<div><b>' + e(heroName(h.heroId)) + '</b><p class="why">' + e(A.explainHero(h, rec.overall, 'best').replace('выше твоего среднего', h.winrate > rec.overall ? 'выше твоего среднего' : 'на уровне твоего среднего')) + '</p></div></div>';
    }).join('') + '</div>' : '<p class="sm">' + e(rec.reason || 'Недостаточно данных.') + '</p>';
    return '<section class="cols2"><div class="card"><div class="sec-h"><h2>Твой игровой анализ</h2></div>' + list + '<p class="sm" style="margin-top:12px">Выводы строятся по правилам из статистики загруженных матчей и показывают корреляции, а не причины.</p></div>' +
      '<div class="card"><div class="sec-h"><h2>На чём играть дальше</h2><label class="field-inline sm">Позиция <select class="sel" data-pf="recPos" aria-label="Позиция для рекомендаций">' + opts + '</select></label></div>' + recHtml +
      '<p class="sm" style="margin-top:12px">Герои с результатом не ниже твоего среднего при выборке не меньше ' + cnt(P.minMatches) + '. Порядок учитывает размер выборки.</p></div></section>';
  }

  function secCharts(list) {
    var days = periodDays(), n = now();
    var w7 = A.summarize(A.filterMatches(P.matches, { periodDays: 7, now: n })), w30 = A.summarize(A.filterMatches(P.matches, { periodDays: 30, now: n }));
    var cmpLine = '<p class="me-note">Последние 7 дней: ' + (w7.n ? '<b>' + pct(w7.winrate) + '</b> (' + cnt(w7.n) + ')' : 'матчей нет') + '. Последние 30 дней: ' + (w30.n ? '<b>' + pct(w30.winrate) + '</b> (' + cnt(w30.n) + ')' : 'матчей нет') + '.</p>';
    if (!list.length) return '<section><div class="sec-h"><h2>Прогресс</h2></div><div class="card">' + cmpLine + '<div class="empty sm-empty">' + ico('list') + '<b>Для графиков нет матчей за период</b><p>Выберите «Всё время» или загрузите более ранние матчи.</p></div></div></section>';
    var ts = A.timeSeries(list, { periodDays: days, now: n, offMin: offMin() });
    var kd = A.kdaSeries(list, { window: 5, limit: 60 });
    var r = Array.isArray(P.ratings) ? P.ratings.filter(function (x) { return x && typeof x.solo_competitive_rank === 'number' && typeof x.time === 'number'; }).sort(function (a, b) { return a.time - b.time; }) : [];
    var mmr = r.length >= 2 ? '<div class="card chart"><h3>MMR</h3><p class="cap">Значения, которые игрок открыл на своём профиле (OpenDota, solo MMR). Не оценка сайта.</p>' + chartMmr(r) + '</div>' : '';
    var mmrNote = r.length >= 2 ? '' : '<p class="me-note" style="margin-top:12px">' + (P.ratings === null ? 'Проверяю историю MMR…' : 'История MMR недоступна: игрок не открыл её в профиле, а сайт не подменяет её оценками. Вместо неё выше показаны винрейт и победы.') + '</p>';
    return '<section><div class="sec-h"><h2>Прогресс <small>' + e(periodName()) + '</small></h2></div>' + cmpLine + '<div class="charts" style="margin-top:12px">' +
      '<div class="card chart"><h3>Винрейт нарастающим итогом</h3><p class="cap">Доля побед с начала периода по каждый день. Пунктир: 50%.</p>' + chartWinrate(ts, list) + (ts.truncated ? '<p class="sm">Показаны последние 52 недели.</p>' : '') + '</div>' +
      '<div class="card chart"><h3>Победы и поражения по ' + (ts.bucket === 'week' ? 'неделям' : 'дням') + '</h3><p class="cap">Сколько матчей выиграно и проиграно.</p>' + chartWL(ts) + '</div>' +
      '<div class="card chart"><h3>Динамика K/D/A</h3><p class="cap">Показатель (K+A)/D по матчам, последние до 60.</p>' + (kd.length >= 2 ? chartKda(kd) : '<p class="sm">Нужно хотя бы 2 матча с данными K/D/A.</p>') + '</div>' +
      '<div class="card chart"><h3>Серии побед и поражений</h3><p class="cap">Последние матчи слева направо, от старых к новым.</p>' + streakStrip(list) +
      '<div class="legend"><span><i style="background:' + C.win + '"></i>Победа</span><span><i style="background:' + C.loss + '"></i>Поражение</span></div>' + (function () { var s = A.streaks(list); return '<div class="runs"><span>Текущая: <b>' + (s.current.len ? s.current.len + ' ' + (s.current.type === 'win' ? 'П' : 'Пор') : '—') + '</b></span><span>Лучшая серия побед: <b>' + s.longestWin + '</b></span><span>Худшая серия поражений: <b>' + s.longestLoss + '</b></span></div>'; })() + '</div>' +
      mmr + '</div>' + mmrNote + '</section>';
  }

  function heroRow(h, overall, kind) {
    var dots = h.recent.map(function (w) { return '<i class="' + (w ? 'w' : 'l') + '"></i>'; }).join('');
    return '<div class="hrow"><div class="top1">' + hic(h.heroId) + '<span class="nm">' + e(heroName(h.heroId)) + '</span><span class="wr">' + pct(h.winrate) + '</span></div>' +
      '<div class="wbar" aria-hidden="true"><i style="width:' + Math.round(h.winrate * 100) + '%"></i></div>' +
      '<div class="meta"><span>' + cnt(h.n) + ' · ' + h.wins + ' п. / ' + h.losses + ' пор.</span>' + (h.kdaN ? '<span>K/D/A ' + f1(h.k) + ' / ' + f1(h.d) + ' / ' + f1(h.a) + '</span>' : '') +
      (h.gpmN ? '<span>GPM ' + Math.round(h.gpm) + '</span>' : '') + (h.xpmN ? '<span>XPM ' + Math.round(h.xpm) + '</span>' : '') +
      '<span class="dots10" role="img" aria-label="Последние ' + h.recent.length + ' игр от старых к новым" title="Последние ' + h.recent.length + ' игр: слева старые">' + dots + '</span></div>' +
      '<p class="why">' + e(A.explainHero(h, overall, kind)) + '</p></div>';
  }
  function secHeroes(list) {
    var s = A.summarize(list), hs = A.heroStats(list), cl = A.classifyHeroes(hs, s.winrate, { minMatches: P.minMatches });
    var step = '<div class="field-inline sm">Минимум матчей на герое <div class="stepper"><button type="button" data-pa="min" data-v="-1" aria-label="Уменьшить порог">−</button><output aria-live="polite">' + P.minMatches + '</output><button type="button" data-pa="min" data-v="1" aria-label="Увеличить порог">+</button></div></div>';
    var head = '<div class="sec-h"><h2>Герои <small>' + e(periodName()) + '</small></h2>' + step + '</div>';
    if (!list.length) return '<section>' + head + '<div class="empty sm-empty">' + ico('users') + '<b>Нет матчей за период</b><p>Выберите другой период.</p></div></section>';
    var grp = function (key, title, icon, items, kind, empty) {
      var all = P.open[key], show = all ? items : items.slice(0, 4);
      return '<div class="card hgroup ' + ({ best: 'best', dev: 'dev', worst: 'worst' }[key]) + '"><h3>' + ico(icon) + title + '</h3>' +
        (items.length ? show.map(function (h) { return heroRow(h, s.winrate, kind); }).join('') + (items.length > 4 ? '<button class="btn ghost sm2" type="button" data-pa="open-g" data-g="' + key + '">' + (all ? 'Свернуть' : 'Показать все (' + items.length + ')') + '</button>' : '') : '<p class="sm">' + e(empty) + '</p>') + '</div>';
    };
    var low = cl.lowSample.length;
    return '<section>' + head +
      (cl.qualifying ? '' : '<div class="banner soft" role="note">' + ico('info') + '<p>Нет героев как минимум с ' + cnt(P.minMatches) + ' за период. Нужно больше игр, либо уменьшите порог.</p></div>') +
      '<div class="hgroups">' +
      grp('best', 'Лучшие герои', 'check', cl.best, 'best', 'Нет героев, у которых результат заметно и достоверно выше среднего при выборке не меньше ' + P.minMatches + '.') +
      grp('dev', 'Герои для развития', 'refresh', cl.develop, 'develop', 'Нет героев, у которых результат немного ниже среднего при достаточной выборке.') +
      grp('worst', 'Худшие результаты', 'alert', cl.worst, 'worst', 'Нет героев с заметно низким винрейтом при выборке не меньше ' + P.minMatches + '.') +
      '</div><p class="me-note" style="margin-top:12px">Средний винрейт за период: ' + pct(s.winrate) + '. Герои с матчами меньше порога (' + low + ') в категории не попадают: по ним мало данных для уверенного вывода. Цветные метки: последние до 10 игр (синий: победа, оранжевый: поражение). Статистика описывает прошлые игры и не объясняет причины результатов.</p></section>';
  }

  function secPositions(list) {
    var ps = A.positionStats(list, { minMatches: P.minMatches });
    var head = '<div class="sec-h"><h2>Позиции <small>' + e(periodName()) + '</small></h2></div>';
    var unkList = list.filter(function (m) { return !m.pos; });
    var coreL = unkList.filter(function (m) { return m.role === 'core'; }), supL = unkList.filter(function (m) { return m.role === 'support'; });
    var rest = unkList.filter(function (m) { return !m.role; });
    var xr = function (name, l, hint) {
      var r = A.summarize(l);
      return '<tr class="unk"><td title="' + e(hint) + '">' + e(name) + '</td><td>' + r.n + '</td><td>' + (r.n ? pct(r.winrate) + '<span class="bar2" aria-hidden="true"><i style="width:' + Math.round(r.winrate * 100) + '%"></i></span>' : '—') + '</td><td>' + (r.kdaN ? f1(r.k) + ' / ' + f1(r.d) + ' / ' + f1(r.a) : '—') + '</td><td>' + (r.gpmN ? Math.round(r.gpm) : '—') + '</td><td>' + (r.xpmN ? Math.round(r.xpm) : '—') + '</td><td></td></tr>';
    };
    var extra = (coreL.length ? xr('Кор (1–3), точная позиция неизвестна', coreL, 'Оценка по золоту команды: матч не разобран OpenDota') : '') + (supL.length ? xr('Саппорт (4–5), точная позиция неизвестна', supL, 'Оценка по золоту команды: матч не разобран OpenDota') : '') + xr('Не определена', rest, 'Нет данных или матч ещё не проверен');
    var rows = [1, 2, 3, 4, 5].map(function (p) {
      var r = ps.rows[p], isBest = ps.best === p, sel = P.cmp.indexOf(p) >= 0;
      return '<tr class="' + (isBest ? 'best' : '') + (p === 0 ? ' unk' : '') + '"><td>' + (p ? '<b>' + p + '</b> · ' + A.POS_NAMES[p] : 'Не определена') + (isBest ? ' <span class="tag">лучшая</span>' : '') + '</td><td>' + r.n + '</td><td>' + (r.n ? pct(r.winrate) + '<span class="bar2" aria-hidden="true"><i style="width:' + Math.round(r.winrate * 100) + '%"></i></span>' : '—') + '</td><td>' + (r.kdaN ? f1(r.k) + ' / ' + f1(r.d) + ' / ' + f1(r.a) : '—') + '</td><td>' + (r.gpmN ? Math.round(r.gpm) : '—') + '</td><td>' + (r.xpmN ? Math.round(r.xpm) : '—') + '</td><td>' + (p && r.n ? '<button class="btn sm2" type="button" data-pa="cmp" data-p="' + p + '" aria-pressed="' + sel + '"' + (sel ? ' style="border-color:var(--red-hi)"' : '') + '>' + (sel ? 'Выбрана' : 'Сравнить') + '</button>' : '') + '</td></tr>';
    }).join('') + extra;
    var table = '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>Позиция</th><th>Матчей</th><th>Винрейт</th><th>K / D / A</th><th>GPM</th><th>XPM</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    var cmp = '';
    if (P.cmp.length === 2) {
      var a = ps.rows[P.cmp[0]], b = ps.rows[P.cmp[1]];
      var line = function (name, va, vb, fmt, better) {
        if (va == null || vb == null) return '<div>' + name + '</div><div>' + (va == null ? '—' : fmt(va)) + '</div><div>' + (vb == null ? '—' : fmt(vb)) + '</div><div class="d">нет данных</div>';
        var d = vb - va, cls = Math.abs(d) < 1e-9 ? '' : ((d > 0) === better ? 'up' : 'dn');
        return '<div>' + name + '</div><div>' + fmt(va) + '</div><div>' + fmt(vb) + '</div><div class="d ' + cls + '">' + (d > 0 ? '+' : d < 0 ? '−' : '') + fmt(Math.abs(d), true) + '</div>';
      };
      var pcf = function (v, d) { return d ? f1(v * 100) + ' п. п.' : pct(v); };
      var nf1 = function (v) { return f1(v); }, ni = function (v) { return String(Math.round(v)); };
      cmp = '<div class="card flat" style="margin-top:12px"><h3>Сравнение: ' + e(A.POS_NAMES[P.cmp[0]]) + ' и ' + e(A.POS_NAMES[P.cmp[1]]) + '</h3><div class="cmp"><div class="h">Показатель</div><div class="h">' + e(A.POS_NAMES[P.cmp[0]]) + '</div><div class="h">' + e(A.POS_NAMES[P.cmp[1]]) + '</div><div class="h">Разница</div>' +
        line('Матчи', a.n, b.n, function (v) { return String(v); }, true) + line('Винрейт', a.winrate, b.winrate, pcf, true) + line('(K+A)/D', a.kdaRatio, b.kdaRatio, nf1, true) + line('GPM', a.gpm, b.gpm, ni, true) + line('XPM', a.xpm, b.xpm, ni, true) + '</div>' +
        (Math.min(a.n, b.n) < P.minMatches ? '<p class="sm" style="margin-top:8px">На одной из позиций меньше ' + cnt(P.minMatches) + ': различия могут быть случайными.</p>' : '') + '</div>';
    } else if (P.cmp.length === 1) cmp = '<p class="sm" style="margin-top:10px">Выберите вторую позицию для сравнения.</p>';
    var best = ps.best ? '<p style="margin-top:12px">Лучшие результаты в этот период: <b>' + e(posLabel(ps.best)) + '</b>, ' + pct(ps.rows[ps.best].winrate) + ' побед за ' + cnt(ps.rows[ps.best].n) + (ps.rows[ps.best].n < 10 ? ' (выборка небольшая)' : '') + '. Сравнение учитывает размер выборки: позиции с малым числом игр не выигрывают случайно.</p>' :
      '<p class="sm" style="margin-top:12px">' + (ps.known === 0 ? 'Позиции пока не определены, поэтому сравнивать нечего.' : ps.qualifying.length === 1 ? 'Достаточно данных только по одной позиции, сравнивать пока не с чем.' : 'Ни по одной позиции нет ' + cnt(P.minMatches) + ': данных для сравнения недостаточно.') + '</p>';
    var job = P.job ? '<div class="jobline"><div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="' + P.job.total + '" aria-valuenow="' + P.job.done + '"><i style="width:' + Math.round(100 * P.job.done / P.job.total) + '%"></i></div><span class="sm">Проверяю матчи ' + P.job.done + ' из ' + P.job.total + '</span><button class="btn sm2" type="button" data-pa="job-stop">Остановить</button></div>' :
      '<div class="jobline"><button class="btn" type="button" data-pa="job">' + ico('search') + 'Определить позиции</button>' + (Object.keys(P.posMap).some(function (k) { return !(P.posMap[k] >= 1); }) ? '<button class="btn ghost" type="button" data-pa="job-reset">Перепроверить неточные</button><button class="btn ghost" type="button" data-pa="parse-req">Отправить на разбор в OpenDota</button>' : '') + '<span class="sm">Определено: ' + ps.known + ' из ' + P.matches.filter(function (m) { return true; }).length + ' загруженных матчей. Новые матчи проверяются автоматически (по 20), кнопка проверяет ещё до 30.</span></div>';
    return '<section class="card">' + head + '<p class="me-note" style="margin-bottom:12px">OpenDota не отдаёт позицию напрямую. Сайт определяет её по разбору матча: три героя команды с наибольшим золотом считаются кор-ролями, линии из разбора распределяют их по 1, 2 и 3, остальные двое получают 4 и 5. Если матч не разобран, линий нет: тогда показывается только роль «кор» или «саппорт» по золоту команды (со знаком ≈, это оценка), а точная позиция остаётся неизвестной. Разбор можно запросить у OpenDota: он занимает несколько минут, затем нажмите «Перепроверить неточные».</p>' + table + best + cmp + job +
      (P.posMsg ? '<div class="banner soft" style="margin-top:12px" role="status">' + ico('info') + '<p>' + e(P.posMsg) + '</p></div>' : '') + '</section>';
  }

  /* Отметки репутации по матчам: считаются тем же модулем, что и карточка репутации. */
  function repFlags() {
    var R = window.DMRep, key = P.acc + ':' + P.matches.length;
    if (P.flagKey === key && P.flagsV) return P.flagsV;
    var out = {};
    if (R && P.matches.length) {
      R.detectAnomalies(P.matches, { now: now(), heroName: heroName }).items.forEach(function (i) {
        if (!i.matchId) return;
        var f = out[i.matchId] = out[i.matchId] || {};
        if (i.group === 'anomaly') f.anomaly = true; else if (i.group === 'fact') f.fact = true;
      });
      var marks = window.DMRepUI && DMRepUI.marks ? DMRepUI.marks(P.acc) : {};
      Object.keys(marks).forEach(function (id) { (out[id] = out[id] || {}).marked = marks[id]; });
    }
    P.flagKey = key; P.flagsV = out;
    return out;
  }
  function matchCell(m, flags) {
    var f = flags[m.id] || {}, tags = '';
    if (f.marked) tags += '<span class="rp-b s-bad" title="Решение модератора по этому матчу">' + (f.marked === 'disputed' ? 'оспаривается' : 'модератор') + '</span> ';
    if (f.anomaly) tags += '<span class="rp-b s-warn" title="Статистическое отклонение от собственной нормы игрока">аномалия</span> ';
    if (f.fact) tags += '<span class="rp-b s-neutral" title="Отметка самой игры (выход или потеря связи)">факт игры</span> ';
    return tags + '<a href="#/match/' + e(m.id) + '" title="Подробный отчёт по матчу">Отчёт</a>';
  }

  function secMatches() {
    var heroIds = {}; P.matches.forEach(function (m) { if (m.hero != null) heroIds[m.hero] = 1; });
    var hopts = Object.keys(heroIds).map(Number).sort(function (a, b) { return heroName(a).localeCompare(heroName(b)); });
    var f = P.tf, o = { now: now() };
    if (f.period !== 'all') o.periodDays = Number(f.period);
    if (f.hero !== 'all') o.hero = f.hero;
    if (f.result !== 'all') o.result = f.result;
    if (f.pos !== 'all') o.pos = (f.pos === 'core' || f.pos === 'support') ? f.pos : Number(f.pos);
    var list = A.filterMatches(P.matches, o), flags = repFlags();
    if (f.flag === 'anomaly') list = list.filter(function (m) { return flags[m.id] && (flags[m.id].anomaly || flags[m.id].fact); });
    else if (f.flag === 'marked') list = list.filter(function (m) { return flags[m.id] && flags[m.id].marked; });
    var vis = list.slice(0, P.shown);
    var sel = function (key, label, opts) { return '<label>' + label + '<select class="sel" data-pf="tf.' + key + '">' + opts.map(function (x) { return '<option value="' + e(x[0]) + '"' + (String(f[key]) === String(x[0]) ? ' selected' : '') + '>' + e(x[1]) + '</option>'; }).join('') + '</select></label>'; };
    var filters = '<div class="filters me-f">' +
      sel('hero', 'Герой', [['all', 'Все герои']].concat(hopts.map(function (id) { return [id, heroName(id)]; }))) +
      sel('result', 'Результат', [['all', 'Все'], ['win', 'Победы'], ['loss', 'Поражения']]) +
      sel('pos', 'Позиция', [['all', 'Любая'], ['1', '1 · Carry'], ['2', '2 · Mid'], ['3', '3 · Offlane'], ['4', '4 · Soft Support'], ['5', '5 · Hard Support'], ['core', 'Кор (по золоту)'], ['support', 'Саппорт (по золоту)'], ['0', 'Не определена']]) +
      sel('period', 'Период', [['all', 'Всё загруженное'], ['7', '7 дней'], ['30', '30 дней']]) +
      sel('flag', 'Отметки', [['all', 'Все матчи'], ['anomaly', 'Аномалии и факты игры'], ['marked', 'Решения модераторов']]) +
      '<button class="btn ghost sm2" type="button" data-pa="tf-reset">Сбросить</button></div>';
    var head = '<div class="mt-h"><span>Герой</span><span>Результат</span><span>Дата</span><span>Время</span><span>K / D / A</span><span>GPM / XPM</span><span>Добито</span><span>Позиция</span><span>Оценка</span><span>Отчёт</span></div>';
    var rows = vis.map(function (m) {
      var gx = m.gpm != null || m.xpm != null ? (m.gpm != null ? Math.round(m.gpm) : '—') + ' / ' + (m.xpm != null ? Math.round(m.xpm) : '—') : null;
      return '<div class="mt-r"><div class="hero">' + hic(m.hero) + '<b>' + e(m.hero != null ? heroName(m.hero) : 'Неизвестный герой') + '</b></div><span class="res ' + (m.win ? 'win' : 'loss') + '">' + (m.win ? 'Победа' : 'Поражение') + '</span>' +
        '<div class="meta"><span>' + (m.start != null ? e(dt(m.start)) : na()) + '</span><span><span class="c-lab">Время</span>' + (m.dur != null ? dur(m.dur) : na()) + '</span>' +
        '<span class="kda"><span class="c-lab">K/D/A</span>' + (m.k != null && m.d != null && m.a != null ? m.k + '<i> / </i>' + m.d + '<i> / </i>' + m.a : na()) + '</span>' +
        '<span><span class="c-lab">GPM/XPM</span>' + (gx || (P.enrich ? '<span class="na">…</span>' : na('OpenDota не отдал GPM/XPM для этого матча'))) + '</span>' +
        '<span><span class="c-lab">Добито</span>' + (m.lh != null ? m.lh + (m.dn != null ? ' <span class="na">/ ' + m.dn + '</span>' : '') : (P.enrich ? '<span class="na">…</span>' : na())) + '</span>' +
        '<span><span class="c-lab">Поз.</span>' + (m.pos ? '<span title="' + e(A.POS_NAMES[m.pos]) + '">' + m.pos + ' · ' + e(A.POS_NAMES[m.pos]) + '</span>' : m.role ? '<span title="Оценка по золоту команды: матч не разобран OpenDota, точная позиция неизвестна">≈ ' + (m.role === 'core' ? 'Кор' : 'Саппорт') + '</span>' : '<span class="na">Не определена</span>') + '</span><span><span class="c-lab">Оценка</span>' + scoreCell(m) + '</span><span class="rp-mcell">' + matchCell(m, flags) + '</span></div></div>';
    }).join('');
    var more = '';
    if (list.length > vis.length) more = '<button class="btn" type="button" data-pa="show-more">Показать ещё ' + Math.min(25, list.length - vis.length) + '</button>';
    else if (P.hasMore) more = '<button class="btn" type="button" data-pa="more"' + (P.moreLoading ? ' disabled' : '') + '>' + (P.moreLoading ? 'Загружаю…' : 'Загрузить более ранние матчи') + '</button>';
    var body = list.length ? '<div class="mt">' + head + rows + (more ? '<div class="mt-more">' + more + '</div>' : '') + '</div>' :
      '<div class="empty sm-empty">' + ico('search') + '<b>Ничего не найдено</b><p>Под выбранные фильтры не подходит ни один из ' + nf(P.matches.length) + ' загруженных матчей.' + (P.hasMore ? ' Возможно, нужные матчи ещё не загружены.' : '') + '</p><div class="actions" style="justify-content:center"><button class="btn" type="button" data-pa="tf-reset">Сбросить фильтры</button>' + (P.hasMore ? '<button class="btn" type="button" data-pa="more">Загрузить ещё</button>' : '') + '</div></div>';
    var enrich = P.enrich ? '<div class="banner soft" role="status">' + ico('info') + '<p>Добираю GPM, XPM и добитых крипов: ' + P.enrich.done + ' из ' + P.enrich.total + ' запросов. Таблица уже готова, цифры появятся по мере загрузки.</p></div>' : '';
    return '<section class="card"><div class="sec-h"><h2>Последние матчи <small>показано ' + vis.length + ' из ' + nf(list.length) + (list.length !== P.matches.length ? ' подходящих' : '') + '</small></h2></div>' + enrich + filters + body +
      '<p class="sm" style="margin-top:12px">Оценка игры от −50 до +50: 0 значит «сыграл как обычно», плюс лучше, минус хуже. Считается по (K+A)/D, GPM и XPM относительно твоих же средних (на герое, если на нём от 5 матчей, иначе по всем загруженным матчам), результат матча не учитывается. Это сравнение с самим собой, а не с другими игроками. Изменение MMR по матчам OpenDota не отдаёт, «—» означает, что данных нет.</p></section>';
  }

  function secRep() {
    if (!window.DMRepUI) return '';
    var tok = P.token;
    return DMRepUI.profileCard(P.acc, P.matches, P.profile, function () { if (active(tok)) { P.flagKey = null; renderBody(); } });
  }

  function secMatchesState() {
    if (P.mstate === 'loading' && !P.matches.length) return '<div class="sk-row"><div class="skel k"></div><div class="skel h2"></div><div class="skel h2"></div></div>';
    if (P.mstate === 'error') return '<div class="banner" role="alert">' + ico('alert') + '<div style="flex:1"><b>' + e(P.merr.t) + '</b><p class="sm" style="margin-top:2px">' + e(P.merr.d) + '</p></div>' + (P.merr.retry ? '<button class="btn sm2" type="button" data-pa="retry-m">Повторить</button>' : '') + '</div>';
    if (P.mstate === 'empty') return '<div class="empty">' + ico('list') + '<b>Матчей нет</b><p>OpenDota не вернул ни одного матча для этого аккаунта. Скорее всего, игрок скрыл историю (в настройках Dota 2 выключено «Открытые данные матчей») или ещё не играл. Данные закрытого профиля получить нельзя.</p></div>';
    var list = periodList();
    var err = P.merr ? '<div class="banner warn" role="alert">' + ico('alert') + '<div style="flex:1"><b>' + e(P.merr.t) + '</b><p class="sm" style="margin-top:2px">' + e(P.merr.d) + ' Показано то, что уже загружено.</p></div>' + (P.merr.retry ? '<button class="btn sm2" type="button" data-pa="more">Повторить</button>' : '') + '</div>' : '';
    return err + secRep() + secStats(list) + secInsights() + secCharts(list) + secHeroes(list) + secPositions(list) + secMatches();
  }

  /* ---------- отрисовка ---------- */
  function renderSearch() {
    var el = document.getElementById('me-search');
    if (!el) return;
    var focus = document.activeElement && document.activeElement.id === 'me-in';
    el.innerHTML = secSearch();
    if (focus) { var i = document.getElementById('me-in'); i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (x) { /* ok */ } }
  }
  function renderBody() {
    var el = document.getElementById('me-body');
    if (!el) return;
    var h;
    if (P.phase === 'idle') h = '<div class="empty">' + ico('user') + '<b>Найдите игрока</b><p>Введите Steam ID или ссылку на профиль Steam, чтобы увидеть историю матчей, статистику по героям и позициям и персональные рекомендации. Все цифры считаются из реальных данных OpenDota.</p></div>';
    else if (P.phase === 'finding') h = '<div class="sk-row" aria-busy="true" role="status"><span class="sm">Ищу игрока в OpenDota…</span><div class="skel h1"></div><div class="skel k"></div><div class="skel h2"></div></div>';
    else if (P.phase === 'error') h = '<div class="banner" role="alert">' + ico('alert') + '<div style="flex:1"><b>' + e(P.err.t) + '</b><p class="sm" style="margin-top:2px">' + e(P.err.d) + '</p></div>' + (P.err.retry ? '<button class="btn sm2" type="button" data-pa="retry">Повторить</button>' : '') + '</div>';
    else h = secHead() + secMatchesState();
    var y = window.scrollY;
    el.innerHTML = h;
    if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
  }
  function render() { if (!$r()) return; renderSearch(); renderBody(); }
  function mount() {
    var r = $r(); if (!r) return;
    r.innerHTML = '<div class="pagehead"><div><h1>Найти профиль</h1><p>Поиск любого игрока по Steam ID или ссылке: история матчей, герои, позиции и прогресс по открытым данным OpenDota. Свой профиль открывается по аватару в шапке.</p></div></div><div id="me-search"></div><div id="me-body" class="pf"></div>';
    if (!P.input) { var s = saved(); if (s.minMatches) P.minMatches = Math.min(30, Math.max(2, s.minMatches | 0)); }
    render();
  }

  /* ---------- события ---------- */
  var tip = null;
  function showTip(t, ev) {
    if (!tip) { tip = document.createElement('div'); tip.id = 'me-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.textContent = t.getAttribute('data-tip'); tip.style.display = 'block';
    var r = t.getBoundingClientRect(), x = ev && ev.clientX != null && ev.clientX > 0 ? ev.clientX : r.left + r.width / 2, y = r.top;
    var w = tip.offsetWidth, hh = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
    tip.style.top = Math.max(8, y - hh - 8) + 'px';
    var svg = t.closest && t.closest('svg'), line = svg && svg.querySelector('.xh');
    if (line && t.getAttribute('data-x')) { line.setAttribute('x1', t.getAttribute('data-x')); line.setAttribute('x2', t.getAttribute('data-x')); line.setAttribute('visibility', 'visible'); }
  }
  function hideTip() {
    if (tip) tip.style.display = 'none';
    var r = $r(); if (r) r.querySelectorAll('.xh').forEach(function (l) { l.setAttribute('visibility', 'hidden'); });
  }
  document.addEventListener('pointerover', function (ev) { var t = ev.target.closest && ev.target.closest('#me-root [data-tip]'); if (t) showTip(t, ev); });
  document.addEventListener('pointermove', function (ev) { var t = ev.target.closest && ev.target.closest('#me-root [data-tip]'); if (t && tip && tip.style.display === 'block') showTip(t, ev); });
  document.addEventListener('pointerout', function (ev) { if (ev.target.closest && ev.target.closest('#me-root [data-tip]')) hideTip(); });
  document.addEventListener('pointerdown', function (ev) { if (!(ev.target.closest && ev.target.closest('#me-root [data-tip]'))) hideTip(); });
  window.addEventListener('scroll', hideTip, { passive: true });

  document.addEventListener('submit', function (ev) {
    if (ev.target.id !== 'me-form') return;
    ev.preventDefault();
    submit(document.getElementById('me-in').value);
  });
  document.addEventListener('input', function (ev) { if (ev.target.id === 'me-in') P.input = ev.target.value; });
  document.addEventListener('change', function (ev) {
    var t = ev.target; if (!t.dataset || !t.dataset.pf || !t.closest('#me-root')) return;
    var k = t.dataset.pf;
    if (k === 'recPos') P.recPos = t.value;
    else if (k.indexOf('tf.') === 0) { P.tf[k.slice(3)] = t.value; P.shown = 25; }
    renderBody();
  });
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('#me-root [data-pa]'); if (!t) return;
    var a = t.dataset.pa;
    switch (a) {
      case 'open': P.input = ''; lookup(t.dataset.acc); break;
      case 'retry': lookup(P.acc); break;
      case 'refresh': lookup(P.acc, { refresh: true }); break;
      case 'retry-m': P.mstate = 'loading'; loadMatches(P.token); break;
      case 'more': loadMatches(P.token); break;
      case 'show-more': P.shown += 25; renderBody(); break;
      case 'period': P.period = t.dataset.v; P.cmp = []; renderBody(); break;
      case 'min': P.minMatches = Math.min(30, Math.max(2, P.minMatches + Number(t.dataset.v))); store(LS, Object.assign(saved(), { minMatches: P.minMatches })); renderBody(); break;
      case 'open-g': P.open[t.dataset.g] = !P.open[t.dataset.g]; renderBody(); break;
      case 'tf-reset': P.tf = { hero: 'all', result: 'all', pos: 'all', period: 'all', flag: 'all' }; P.shown = 25; renderBody(); break;
      case 'cmp': { var p = Number(t.dataset.p), i = P.cmp.indexOf(p); if (i >= 0) P.cmp.splice(i, 1); else P.cmp = P.cmp.concat(p).slice(-2); renderBody(); break; }
      case 'job': runPosJob(); break;
      case 'parse-req': requestParses(); break;
      case 'job-stop': if (P.job) P.job.stop = true; break;
      case 'job-reset': Object.keys(P.posMap).forEach(function (k) { if (!(P.posMap[k] >= 1)) delete P.posMap[k]; }); savePos(); rebuild(); P.posMsg = ''; renderBody(); break;
      case 'copy': H.copy(t.dataset.t); break;
    }
  });
  document.addEventListener('error', function (ev) { var t = ev.target; if (t && t.tagName === 'IMG' && t.closest && t.closest('#me-root')) t.remove(); }, true);

  window.DMProfile = {
    init: function (host) { H = host; },
    view: function () { return '<div id="me-root" class="pf"></div>'; },
    mount: mount,
    current: function () { return P.acc; },
    /** Вкладка «Найти профиль»: чистый поиск. Запросы идущего поиска отменяются, число матчей для статистики сохраняется. */
    reset: function () { var t = P.token + 1, mm = P.minMatches; P = blank(); P.token = t; P.minMatches = mm; },
    open: function (acc) { P.input = ''; if ($r()) lookup(String(acc)); else setTimeout(function () { lookup(String(acc)); }, 0); },
    _state: function () { return P; }
  };
})();
