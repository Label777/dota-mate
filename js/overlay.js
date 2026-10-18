/*
 * Dota Mate: Live Draft Intelligence Overlay (интерфейс и связка модулей).
 *
 *   Dota 2 (GSI) -> Dota Mate Bridge (127.0.0.1, SSE) -> эта страница -> DMLive (состояние матча, личности)
 *                                                                      -> DMLiveStats (кэш, очередь, OpenDota, сигналы репутации)
 *
 * Страница запускается отдельно (overlay.html): в окне браузера, в «приложении» Chrome/Edge или в обёртке overlay-app (Electron).
 * Данные игроков берутся только из того, что реально пришло из игры и из OpenDota. Если Steam ID нет, карточка так и говорит.
 */
(function () {
  'use strict';
  var Live = window.DMLive, LS = window.DMLiveStats, Draft = window.DMDraft, A = window.DMA;
  var LS_BRIDGE = 'dotamate.bridge.v1', LS_CFG = 'dotamate.overlay.v1', LS_STATS = 'dotamate.live.v1';
  var HOST_RE = /^(127\.0\.0\.1|localhost):\d{4,5}$/, TOKEN_RE = /^[A-Za-z0-9._-]{8,128}$/;
  var IMG = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/';
  var SITE = 'https://label777.github.io/dota-mate/';
  var EMBED = /[?&]embed=1/.test(location.search) || !!window.dotamateOverlay;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  /* ---------- хранилище ---------- */
  function jget(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function jset(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* без хранилища работаем в памяти */ } }
  var DEFAULTS = { mode: 'compact', collapsed: false, scale: 1, opacity: 0.96, anim: true, hotkey: 'Alt+Shift+D', pos: null, width: 760,
    metrics: { wr: true, kda: true, heroes: true, form: true, signals: true } };
  function loadCfg() {
    var c = jget(LS_CFG) || {}, d = JSON.parse(JSON.stringify(DEFAULTS));
    var num = function (v, lo, hi, def) { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
    d.mode = c.mode === 'full' ? 'full' : 'compact'; d.collapsed = !!c.collapsed;
    d.scale = num(c.scale, 0.7, 1.5, 1); d.opacity = num(c.opacity, 0.4, 1, 0.96); d.anim = c.anim !== false;
    d.hotkey = typeof c.hotkey === 'string' && /^((Ctrl|Alt|Shift)\+){0,3}[A-Z0-9]$/.test(c.hotkey) ? c.hotkey : DEFAULTS.hotkey;
    d.width = num(c.width, 420, 1400, 760);
    if (c.pos && isFinite(c.pos.x) && isFinite(c.pos.y)) d.pos = { x: c.pos.x, y: c.pos.y };
    if (c.metrics && typeof c.metrics === 'object') Object.keys(d.metrics).forEach(function (k) { if (typeof c.metrics[k] === 'boolean') d.metrics[k] = c.metrics[k]; });
    return d;
  }

  /* ---------- состояние ---------- */
  var U = { cfg: loadCfg(), conn: { status: 'off', note: '', lastAt: 0, packets: 0 }, snap: null, sel: null, settings: false, manual: null, hidden: false,
    heroes: null, lanes: {}, toast: '', toastT: null, retry: 0, retryT: null, es: null, refreshAt: 0, tick: 0 };
  var api = window.DMApi.create({ storage: window.localStorage });
  var session = Live.createSession();
  var stats = LS.create({
    api: api, storage: window.localStorage, key: LS_STATS,
    heroName: function (id) { return heroName(id); },
    onUpdate: function (acc, e, epoch) { onStats(acc, e, epoch); }
  });

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pl(n, a, b, c) { return A.plural(n, a, b, c); }
  function heroName(id) { var h = U.heroes && U.heroes[id]; return h ? h.name : 'Герой #' + id; }
  function loadHeroes() {
    api.getHeroes().then(function (list) {
      var m = {};
      list.forEach(function (h) {
        var id = Number(h.id); if (!(id > 0) || !h.name) return;
        var slug = String(h.name).replace(/^npc_dota_hero_/, '');
        m[id] = { name: h.localized_name || slug, slug: /^[a-z0-9_]+$/.test(slug) ? slug : '' };
      });
      U.heroes = m; render();
    }, function () { /* без имён героев показываем номера */ });
  }
  function ago(ms) {
    if (ms == null) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 45) return 'только что';
    if (s < 3600) return Math.round(s / 60) + ' мин назад';
    if (s < 86400) return Math.round(s / 3600) + ' ч назад';
    var d = Math.round(s / 86400); return d + ' ' + pl(d, 'день', 'дня', 'дней') + ' назад';
  }
  function dayStr(ts) { return ts ? new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function pct(v) { return v == null ? null : Math.round(v * 100) + '%'; }

  /* ---------- связь статистики и состояния матча ---------- */
  function onStats(acc, e, epoch) {
    if (epoch !== session.epoch()) return;      // ответ относится к другому матчу
    var st = e.status;
    if (st === 'ready') session.setStats(acc, 'ready');
    else if (st === 'loading' || st === 'queued' || st === 'rate_limited') session.setStats(acc, 'loading');
    else if (st === 'private') session.setStats(acc, 'private', e.error && e.error.message);
    else if (st === 'error') session.setStats(acc, 'error', e.error && e.error.message);
    schedule();
  }
  function onPacket(slim, at) {
    var r = session.push(slim, at);
    if (r.newMatch) { stats.setEpoch(r.epoch); U.sel = null; U.manual = null; U.lanes = {}; }
    var snap = session.snapshot();
    if (snap.phase === 'finished' || snap.lifecycle === 'finished') stats.stop();
    else r.newIds.forEach(function (acc) { stats.request(acc, { epoch: r.epoch }); });
    if (r.changed || r.newIds.length) schedule();
  }

  /* ---------- подключение к мосту ---------- */
  function bridgeCfg() { var c = jget(LS_BRIDGE); return c && HOST_RE.test(c.host || '') && TOKEN_RE.test(c.token || '') ? c : null; }
  function disconnect() { if (U.es) { try { U.es.close(); } catch (e) { /* уже закрыт */ } U.es = null; } clearTimeout(U.retryT); }
  function connect(host, token) {
    if (!HOST_RE.test(host) || !TOKEN_RE.test(token)) { U.conn.note = 'Адрес вида 127.0.0.1:7777, токен от 8 символов (буквы, цифры, . _ -).'; render(); return false; }
    disconnect(); jset(LS_BRIDGE, { host: host, token: token });
    U.conn = { status: 'connecting', note: '', lastAt: 0, packets: 0 };
    var es;
    try { es = new EventSource('http://' + host + '/stream?t=' + encodeURIComponent(token)); } catch (e) { U.conn.status = 'off'; U.conn.note = 'Браузер не позволил открыть соединение с мостом.'; render(); return false; }
    U.es = es;
    es.addEventListener('hello', function () { U.retry = 0; U.conn.status = 'on'; U.conn.note = ''; session.setTransport('connected'); render(); });
    es.addEventListener('gsi', function (ev) {
      var j; try { j = JSON.parse(ev.data); } catch (e) { return; }
      if (!j || typeof j !== 'object' || !j.gsi || typeof j.gsi !== 'object') return;      // проверяем структуру сообщения
      U.conn.lastAt = Date.now(); U.conn.packets++; U.conn.status = 'on'; session.setTransport('connected');
      onPacket(j.gsi, Date.now());
    });
    es.onerror = function () {
      if (U.es !== es) return;
      es.close(); U.es = null; U.conn.status = 'off';
      U.conn.note = U.retry === 0 ? 'Нет связи с мостом. Проверьте, что он запущен, адрес и токен верны.' : U.conn.note;
      session.setTransport('lost'); render();
      U.retry = Math.min(U.retry + 1, 6);
      U.retryT = setTimeout(function () { var c = bridgeCfg(); if (c) connect(c.host, c.token); }, Math.min(30000, 2000 * U.retry));
    };
    render(); return true;
  }

  /* ---------- вид ---------- */
  var PHASE_TEXT = { idle: 'Жду матч', draft_detected: 'Драфт обнаружен', resolving_players: 'Определяю игроков', loading_stats: 'Загружаю статистику', ready: 'Готово', in_game: 'Матч идёт', finished: 'Матч завершён', disconnected: 'Мост не подключён' };
  var SIDE_LABEL = { radiant: 'Radiant', dire: 'Dire' };
  var LANES = { 1: 'Лёгкая линия', 2: 'Мид', 3: 'Сложная линия', 4: 'Лес' };

  function portrait(id, cls) {
    var h = U.heroes && U.heroes[id], ini = heroName(id).replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    return '<span class="ov-hi ' + (cls || '') + '" data-tip="' + esc(heroName(id)) + '"><span class="ov-ph" aria-hidden="true">' + esc(ini) + '</span>' +
      (h && h.slug ? '<img src="' + IMG + esc(h.slug) + '.png" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '') + '</span>';
  }
  function profileHref(acc) { return (location.protocol === 'file:' || !/^https?:$/.test(location.protocol) ? SITE : new URL('index.html', location.href).href) + '#/profile/' + acc; }

  function formStrip(form) {
    if (!form.length) return '';
    var w = form.filter(function (m) { return m.win; }).length;
    return '<div class="ov-form" role="img" aria-label="Форма: ' + w + ' ' + pl(w, 'победа', 'победы', 'побед') + ' из ' + form.length + '">' +
      form.slice().reverse().map(function (m) { return '<i class="' + (m.win ? 'w' : 'l') + '" data-tip="' + (m.win ? 'Победа' : 'Поражение') + (m.start ? ', ' + dayStr(m.start) : '') + '"></i>'; }).join('') + '</div>';
  }
  function signalChip(sig) {
    if (!sig) return '';
    if (!sig.ready && !sig.count) return '<span class="ov-chip" data-tip="Для поиска отклонений нужно хотя бы 15 матчей с длительностью и смертями; загружено ' + sig.baselineN + '. Мало данных не значит подозрительно.">сигналы: мало данных</span>';
    if (!sig.count) return '<span class="ov-chip ok" data-tip="Среди загруженных матчей отклонений от собственных обычных показателей не найдено. Это не гарантия.">сигналов нет</span>';
    return '<span class="ov-chip warn" data-tip="Есть матчи, которые стоит посмотреть. Это сигнал для проверки, а не вывод о нарушении. Подробности по нажатию на карточку.">требует проверки: ' + sig.count + '</span>';
  }

  function cardHtml(slot) {
    var id = slot.identity, acc = id.accountId, M = U.cfg.metrics, full = U.cfg.mode === 'full';
    var e = acc ? stats.get(acc) : null, d = e && e.data;
    var sel = U.sel === slot.key ? ' sel' : '';
    var who = id.name || (d && d.name) || (acc ? 'Игрок ' + acc : '');
    var cls = 'ov-card st-' + id.state + sel + (slot.self ? ' me' : '');
    var h = '<article class="' + cls + '" data-k="' + esc(slot.key) + '">';
    if (!acc) {
      var txt = id.state === 'pending' ? 'Ждём Steam ID' : 'Игрок не идентифицирован';
      h += '<div class="ov-top"><b class="ov-nm muted" data-tip="' + esc(id.reason) + '">' + txt + '</b>' + (slot.heroId ? portrait(slot.heroId, 'sm') : '') +
        '<button type="button" class="ov-btn sm" data-a="ov-manual" data-side="' + slot.side + '" data-tip="Указать Steam ID, Account ID или ссылку на профиль самому">Указать</button></div>' +
        (full ? '<p class="ov-note">' + esc(id.reason) + '</p>' : '');
      return h + '</article>';
    }
    var src = id.source === 'manual' ? 'указан вручную' : id.source === 'local' ? 'это вы (из игры)' : 'из игры';
    h += '<button type="button" class="ov-open" data-a="ov-sel" data-k="' + esc(slot.key) + '" aria-expanded="' + (U.sel === slot.key) + '" aria-label="Подробности: ' + esc(who) + '">' +
      '<span class="ov-top"><b class="ov-nm">' + esc(who) + '</b>' + (slot.heroId ? portrait(slot.heroId, 'sm') : '') + '</span></button>' +
      '<div class="ov-sub"><span data-tip="Steam ID: ' + esc(id.steamId) + '. Источник: ' + src + '. Ник из игры может отличаться от ника в OpenDota.">ID ' + esc(acc) + ' · ' + src + '</span>' +
      (d && d.rank ? '<span class="ov-chip">' + esc(d.rank.label) + '</span>' : '') + '</div>';
    if (id.state === 'private') h += '<p class="ov-note">Профиль приватный или статистика не предоставлена источником. ' + esc(id.reason || '') + '</p>';
    else if (!d) {
      if (e.status === 'error' || e.status === 'rate_limited') h += '<p class="ov-note err">' + esc(e.error ? e.error.message : 'Не удалось загрузить статистику.') + '</p><div class="ov-act"><button type="button" class="ov-btn" data-a="ov-retry" data-acc="' + esc(acc) + '">Повторить</button></div>';
      else h += '<div class="ov-skel" aria-busy="true"><i></i><i></i><i></i></div><p class="ov-note">Загружаю статистику из OpenDota…</p>';
    } else {
      if (M.wr || M.kda) {
        h += '<div class="ov-row">';
        if (M.wr && d.winrate != null) h += '<span class="ov-m" data-tip="Все публичные матчи игрока по OpenDota: ' + d.wl.win + ' побед, ' + d.wl.lose + ' поражений."><em>WR</em><b>' + pct(d.winrate) + '</b><small>' + d.wl.games + ' игр</small></span>';
        if (M.kda && d.kda) h += '<span class="ov-m" data-tip="Среднее по ' + d.kda.n + ' последним матчам. KDA сам по себе ничего не доказывает."><em>K/D/A</em><b>' + d.kda.k + '/' + d.kda.d + '/' + d.kda.a + '</b><small>' + d.kda.n + ' матчей</small></span>';
        h += '</div>';
      }
      if (M.heroes && d.topHeroes.length) h += '<div class="ov-heroes">' + d.topHeroes.map(function (t) {
        return '<span class="ov-hr" data-tip="' + esc(heroName(t.heroId)) + ': ' + t.games + ' игр' + (t.winrate != null ? ', ' + pct(t.winrate) + ' побед' : '') + ' (за всё время)">' + portrait(t.heroId, 'sm') + '<b>' + t.games + '</b><small>' + (t.winrate != null ? pct(t.winrate) : '—') + '</small></span>';
      }).join('') + '</div>';
      if (M.form && d.form.length) h += formStrip(d.form);
      if (M.signals) h += '<div class="ov-row">' + signalChip(d.signals) + '</div>';
      if (full) h += '<p class="ov-fresh">' + (d.sample ? d.sample + ' ' + pl(d.sample, 'матч', 'матча', 'матчей') + ' в выборке · ' : '') + 'последний матч ' + (d.lastMatchAt ? dayStr(d.lastMatchAt) : '—') + '</p>';
      h += '<p class="ov-fresh' + (e.stale ? ' stale' : '') + '">' + (e.refreshing ? 'Обновляю… ' : '') + 'Обновлено ' + ago(e.ageMs) + ' · OpenDota' + (e.stale ? ' · данные устарели' : '') +
        (e.status === 'error' || e.status === 'rate_limited' ? ' · ' + esc(e.error ? e.error.message : '') : '') + '</p>';
    }
    return h + '</article>';
  }

  function teamHtml(side, snap) {
    var picks = snap.draft ? snap.draft.picks[side] : [], bans = snap.draft ? snap.draft.bans[side] : [];
    var slots = snap.slots.filter(function (s) { return s.side === side; });
    var head = '<header class="ov-th"><h2>' + SIDE_LABEL[side] + (snap.mySide === side ? ' <span class="ov-chip">вы</span>' : '') + '</h2>' +
      '<div class="ov-picks" aria-label="Выбранные герои ' + SIDE_LABEL[side] + '">' + (picks.length ? picks.map(function (id) { return portrait(id, 'sm'); }).join('') : '<small>героев пока нет</small>') + '</div>' +
      (U.cfg.mode === 'full' && bans.length ? '<div class="ov-bans" aria-label="Баны"><small>баны</small>' + bans.map(function (id) { return portrait(id, 'xs'); }).join('') + '</div>' : '') + '</header>';
    return '<section class="ov-team ' + side + '" aria-label="' + SIDE_LABEL[side] + '">' + head + '<div class="ov-cards">' + slots.map(cardHtml).join('') + '</div></section>';
  }

  function detailHtml(snap) {
    var slot = snap.slots.filter(function (s) { return s.key === U.sel; })[0];
    if (!slot || !slot.identity.accountId) return '';
    var acc = slot.identity.accountId, e = stats.get(acc), d = e.data;
    var who = slot.identity.name || (d && d.name) || 'Игрок ' + acc;
    var h = '<aside class="ov-detail" aria-label="Подробности игрока"><header class="ov-dh"><div><h3>' + esc(who) + '</h3><small>Account ID ' + esc(acc) + ' · Steam ID ' + esc(slot.identity.steamId) + '</small></div>' +
      '<div class="ov-dact"><a class="ov-btn" href="' + esc(profileHref(acc)) + '" target="_blank" rel="noopener">Полный профиль</a><button type="button" class="ov-btn ic" data-a="ov-close-detail" aria-label="Закрыть подробности">×</button></div></header>';
    if (!d) return h + '<p class="ov-note">' + (slot.identity.state === 'private' ? 'Профиль приватный или статистика не предоставлена источником.' : 'Статистика ещё не загружена.') + '</p></aside>';
    var sig = d.signals;
    h += '<p class="ov-src">Источник: OpenDota, обновлено ' + ago(e.ageMs) + (e.stale ? ' (устарело)' : '') + '. Выборка: ' + d.sample + ' ' + pl(d.sample, 'матч', 'матча', 'матчей') + (d.firstMatchAt ? ', ' + dayStr(d.firstMatchAt) + ' – ' + dayStr(d.lastMatchAt) : '') + '.</p>';

    /* герои и сравнение на выбранном герое */
    var hid = slot.heroId || (d.topHeroes[0] && d.topHeroes[0].heroId), cmp = hid ? LS.heroCompare(d, hid) : null;
    if (d.topHeroes.length) h += '<h4>Любимые герои <small>за всё время</small></h4><ul class="ov-hl">' + d.topHeroes.map(function (t) { return '<li>' + portrait(t.heroId, 'xs') + '<b>' + esc(heroName(t.heroId)) + '</b><span>' + t.games + ' игр' + (t.winrate != null ? ', ' + pct(t.winrate) : '') + '</span></li>'; }).join('') + '</ul>';
    if (hid) {
      h += '<h4>На герое ' + esc(heroName(hid)) + ' <small>' + (slot.heroId ? 'выбран сейчас' : 'самый частый') + '</small></h4>';
      if (!cmp || !cmp.enough) h += '<p class="ov-note">Недостаточно данных: в выборке ' + (cmp ? cmp.n : 0) + ' ' + pl(cmp ? cmp.n : 0, 'матч', 'матча', 'матчей') + ' на этом герое (нужно хотя бы 3).</p>';
      else {
        var f = function (x) { return x ? x.k + '/' + x.d + '/' + x.a : '—'; };
        h += '<table class="ov-tb"><thead><tr><th></th><th>K/D/A</th><th>WR</th><th>Матчей</th></tr></thead><tbody><tr><th>На герое</th><td>' + f(cmp.hero.kda) + '</td><td>' + (pct(cmp.hero.winrate) || '—') + '</td><td>' + cmp.n + '</td></tr>' +
          '<tr><th>Обычно</th><td>' + f(cmp.usual.kda) + '</td><td>' + (pct(cmp.usual.winrate) || '—') + '</td><td>' + cmp.nAll + '</td></tr></tbody></table><p class="ov-note">Сравнение только по загруженной выборке. Малый опыт на герое или низкий WR не признак саботажа.</p>';
      }
    }
    /* линия */
    var ln = U.lanes[acc];
    if (ln && ln.state === 'ok') h += '<h4>Линия <small>по lane_role OpenDota</small></h4><p>' + (ln.top ? esc(ln.top) : 'Недостаточно данных') + '</p>' + (ln.note ? '<p class="ov-note">' + esc(ln.note) + '</p>' : '');
    else h += '<div class="ov-act"><button type="button" class="ov-btn" data-a="ov-lanes" data-acc="' + esc(acc) + '"' + (ln && ln.state === 'loading' ? ' disabled' : '') + '>' + (ln && ln.state === 'loading' ? 'Загружаю…' : ln && ln.state === 'err' ? 'Повторить загрузку линий' : 'Определить линию') + '</button><small>несколько дополнительных запросов к OpenDota</small></div>';

    /* последние матчи */
    h += '<h4>Последние матчи</h4>';
    var ms = d.matches.slice(0, 10);
    h += ms.length ? '<table class="ov-tb ml"><thead><tr><th>Итог</th><th>Дата</th><th>Герой</th><th>K/D/A</th></tr></thead><tbody>' + ms.map(function (m) {
      return '<tr><td class="' + (m.win ? 'w' : 'l') + '">' + (m.win ? 'Победа' : 'Пораж.') + '</td><td>' + dayStr(m.start) + '</td><td>' + (m.hero ? esc(heroName(m.hero)) : '—') + '</td><td>' + (m.k != null && m.d != null && m.a != null ? m.k + '/' + m.d + '/' + m.a : '—') + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="ov-note">Нет публичных матчей.</p>';

    /* сигналы */
    h += '<h4>Сигналы <small>методика из раздела «Репутация»</small></h4>';
    if (!sig) h += '<p class="ov-note">Нет данных для анализа.</p>';
    else {
      h += '<p>' + esc(sig.stateLabel) + '. Достоверность: ' + esc(sig.confidence.label.toLowerCase()) + '. ' + esc(sig.confidence.reason) + '</p>';
      if (!sig.ready) h += '<p class="ov-note">Для поиска отклонений от собственной нормы нужно хотя бы 15 матчей с длительностью и смертями, загружено ' + sig.baselineN + '. Отсутствие данных не считается подозрительным.</p>';
      if (sig.items.length) h += '<ul class="ov-sg">' + sig.items.slice(0, 6).map(function (i) {
        return '<li class="' + (i.group === 'anomaly' ? 'an' : 'ft') + '"><b>' + esc(i.title) + '</b><small>' + (i.start ? dayStr(i.start) : '') + (i.hero != null ? ' · ' + esc(heroName(i.hero)) : '') + ' · выборка ' + sig.baselineN + '</small>' +
          '<ul>' + i.facts.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul><p class="ov-note">' + esc(i.basis) + '</p>' +
          '<p class="ov-note">Другие объяснения: сбой связи, особенности героя и роли, сложный матч. ' + (i.matchId ? '<a href="https://www.opendota.com/matches/' + esc(i.matchId) + '" target="_blank" rel="noopener">Матч ' + esc(i.matchId) + '</a>' : '') + '</p></li>';
      }).join('') + '</ul>' + (sig.items.length > 6 ? '<p class="ov-note">Показаны 6 из ' + sig.items.length + '. Остальные в полном профиле.</p>' : '');
      else if (sig.ready) h += '<p class="ov-note">Отклонений от собственных обычных показателей среди загруженных матчей нет. Анализ видит только публичную статистику.</p>';
    }
    return h + '</aside>';
  }

  function headerHtml(snap) {
    var phase = snap.phase, txt = PHASE_TEXT[phase] || phase, c = U.conn;
    var live = c.status === 'on' && snap.lastPacketAt && Date.now() - snap.lastPacketAt > 60000 ? 'Dota 2 давно не присылала данные' : '';
    var cls = phase === 'disconnected' ? 'bad' : phase === 'ready' || phase === 'in_game' ? 'ok' : '';
    return '<header class="ov-h"><div class="ov-brand"><b>Dota Mate</b><span>Драфт</span></div>' +
      '<div class="ov-status ' + cls + '" role="status" aria-live="polite"><i></i>' + esc(txt) + (snap.counts.identified ? ' · ' + snap.counts.identified + '/10 игроков' : '') + (live ? ' · ' + live : '') + '</div>' +
      '<div class="ov-ctl">' +
        '<button type="button" class="ov-btn ic" data-a="ov-refresh" data-tip="Обновить статистику (не чаще раза в минуту)" aria-label="Обновить статистику">⟳</button>' +
        '<button type="button" class="ov-btn" data-a="ov-mode" aria-pressed="' + (U.cfg.mode === 'full') + '" data-tip="Переключить вид карточек: компактный или подробный">Вид: ' + (U.cfg.mode === 'full' ? 'подробный' : 'компактный') + '</button>' +
        '<button type="button" class="ov-btn ic" data-a="ov-settings" aria-expanded="' + U.settings + '" data-tip="Настройки" aria-label="Настройки">⚙</button>' +
        '<button type="button" class="ov-btn ic" data-a="ov-collapse" aria-expanded="' + !U.cfg.collapsed + '" data-tip="' + (U.cfg.collapsed ? 'Развернуть' : 'Свернуть') + '" aria-label="' + (U.cfg.collapsed ? 'Развернуть' : 'Свернуть') + '">' + (U.cfg.collapsed ? '▾' : '▴') + '</button>' +
        '<button type="button" class="ov-btn ic" data-a="ov-hide" data-tip="Скрыть (' + esc(U.cfg.hotkey) + ')" aria-label="Скрыть оверлей">×</button>' +
      '</div></header>';
  }

  function stateBanner(snap) {
    var c = U.conn, cfg = bridgeCfg();
    if (!cfg) return '<div class="ov-banner"><b>Bridge не подключён</b><p>Запустите <code>node dota-mate-bridge.js</code>, откройте настройки (⚙) и введите адрес и токен из консоли моста. Скачать мост можно на странице «Драфт» сайта.</p><button type="button" class="ov-btn pri" data-a="ov-settings">Открыть настройки</button></div>';
    if (c.status === 'off') return '<div class="ov-banner bad"><b>Bridge не подключён</b><p>' + esc(c.note || 'Нет связи с мостом.') + ' Переподключаюсь автоматически. Уже загруженная статистика остаётся на экране.</p></div>';
    if (c.status === 'connecting') return '<div class="ov-banner"><b>Подключаюсь к мосту…</b></div>';
    if (snap.phase === 'idle') return '<div class="ov-banner"><b>Жду матч</b><p>' + (c.packets ? 'Мост получает данные от Dota 2, но драфта пока нет.' : 'Мост подключён, данных от Dota 2 ещё нет. Проверьте параметр запуска -gamestateintegration и файл cfg.') + '</p></div>';
    return '';
  }

  function settingsHtml() {
    var c = bridgeCfg(), M = U.cfg.metrics;
    var chk = function (k, t) { return '<label class="ov-ck"><input type="checkbox" data-s="m-' + k + '"' + (M[k] ? ' checked' : '') + '> ' + t + '</label>'; };
    return '<aside class="ov-set" aria-label="Настройки оверлея"><h3>Настройки</h3>' +
      '<form data-f="conn" class="ov-fm"><label>Адрес моста<input name="host" value="' + esc(c ? c.host : '127.0.0.1:7777') + '" autocomplete="off" spellcheck="false"></label>' +
      '<label>Токен<input name="token" value="' + esc(c ? c.token : '') + '" autocomplete="off" spellcheck="false" type="password"></label>' +
      '<div class="ov-act"><button class="ov-btn pri" type="submit">Подключиться</button><button class="ov-btn" type="button" data-a="ov-disc">Отключить</button></div>' + (U.conn.note ? '<p class="ov-note err">' + esc(U.conn.note) + '</p>' : '') + '</form>' +
      '<label class="ov-rg">Масштаб ' + Math.round(U.cfg.scale * 100) + '%<input type="range" min="70" max="150" step="5" value="' + Math.round(U.cfg.scale * 100) + '" data-s="scale"></label>' +
      '<label class="ov-rg">Прозрачность ' + Math.round(U.cfg.opacity * 100) + '%<input type="range" min="40" max="100" step="5" value="' + Math.round(U.cfg.opacity * 100) + '" data-s="opacity"></label>' +
      '<label class="ov-ck"><input type="checkbox" data-s="anim"' + (U.cfg.anim ? ' checked' : '') + '> Анимации</label>' +
      '<fieldset><legend>Показывать на карточке</legend>' + chk('wr', 'Винрейт') + chk('kda', 'K/D/A') + chk('heroes', 'Любимые герои') + chk('form', 'Форма') + chk('signals', 'Сигналы') + '</fieldset>' +
      '<label>Горячая клавиша скрытия<input data-s="hotkey" value="' + esc(U.cfg.hotkey) + '" readonly aria-describedby="ov-hk"></label><small id="ov-hk">Нажмите поле и нужное сочетание (Ctrl/Alt/Shift + буква или цифра).</small>' +
      '<div class="ov-act"><button class="ov-btn" type="button" data-a="ov-reset-pos">Сбросить положение</button><button class="ov-btn" type="button" data-a="ov-clear-cache">Очистить кэш статистики</button></div>' +
      '<p class="ov-note">Оверлей слушает только ваш локальный мост. Игровые данные никуда не отправляются; запросы статистики идут в OpenDota.</p></aside>';
  }

  function manualHtml() {
    if (!U.manual) return '';
    return '<div class="ov-modal" role="dialog" aria-label="Указать игрока вручную"><form data-f="manual" class="ov-fm"><h3>Указать игрока вручную · ' + SIDE_LABEL[U.manual.side] + '</h3>' +
      '<p class="ov-note">Игра не передала Steam ID. Вставьте ID, который вы знаете сами: Account ID, Steam ID или ссылку на профиль (OpenDota, Steam). Ники не принимаются. Карточка будет подписана «указан вручную».</p>' +
      '<label>Account ID, Steam ID или ссылка<input name="id" autocomplete="off" spellcheck="false" autofocus></label>' + (U.manual.err ? '<p class="ov-note err">' + esc(U.manual.err) + '</p>' : '') +
      '<div class="ov-act"><button class="ov-btn pri" type="submit">Добавить</button><button class="ov-btn" type="button" data-a="ov-manual-cancel">Отмена</button></div></form></div>';
  }

  /* ---------- отрисовка ---------- */
  var raf = 0;
  function schedule() { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; render(); }); }
  function render() {
    var root = $('#ov-root'); if (!root) return;
    var snap = U.snap = session.snapshot();
    root.hidden = U.hidden && EMBED;
    var fb = $('#ov-show'); if (fb) fb.hidden = !U.hidden || EMBED;
    var panel = $('#ov-panel');
    panel.dataset.mode = U.cfg.mode; panel.dataset.collapsed = U.cfg.collapsed ? '1' : '0'; panel.hidden = U.hidden;
    root.dataset.anim = U.cfg.anim ? '1' : '0';
    root.style.setProperty('--ov-scale', U.cfg.scale); root.style.setProperty('--ov-op', U.cfg.opacity);
    var active = document.activeElement, keep = active && active.closest && active.closest('[data-f]') ? { name: active.name, v: active.value } : null;
    var body = '';
    if (!U.cfg.collapsed) {
      body = stateBanner(snap) + '<div class="ov-main"><div class="ov-teams">' + teamHtml('radiant', snap) + teamHtml('dire', snap) + '</div>' + detailHtml(snap) + '</div>' +
        footNote(snap);
    }
    panel.innerHTML = headerHtml(snap) + (U.settings ? settingsHtml() : '') + body + manualHtml() + '<div class="ov-toast" role="status" aria-live="polite">' + esc(U.toast) + '</div>';
    if (keep && keep.name) { var el = panel.querySelector('[name="' + keep.name + '"]'); if (el && keep.v != null) { el.value = keep.v; el.focus(); } }
    applyPos();
  }
  /** Одна общая строка про недоступные Steam ID вместо девяти одинаковых пояснений. */
  function footNote(snap) {
    if (stateBanner(snap) || U.cfg.mode === 'full') return '';
    var miss = snap.slots.filter(function (x) { return x.identity.state === 'unavailable' || x.identity.state === 'pending'; })[0];
    return miss ? '<p class="ov-foot">' + esc(miss.identity.reason) + ' Карточку можно заполнить вручную кнопкой «Указать».</p>' : '';
  }
  function toast(t) { U.toast = t; render(); clearTimeout(U.toastT); U.toastT = setTimeout(function () { U.toast = ''; render(); }, 3500); }

  /* ---------- положение и размер (вне Electron) ---------- */
  function applyPos() {
    var panel = $('#ov-panel'); if (!panel) return;
    if (EMBED) { panel.style.left = panel.style.top = ''; panel.style.width = ''; return; }
    var w = Math.min(U.cfg.width, window.innerWidth - 8);
    panel.style.width = w + 'px';
    var p = U.cfg.pos || { x: Math.max(4, (window.innerWidth - w * U.cfg.scale) / 2), y: 8 };
    panel.style.left = Math.max(0, Math.min(p.x, window.innerWidth - 80)) + 'px'; panel.style.top = Math.max(0, Math.min(p.y, window.innerHeight - 40)) + 'px';
  }
  function saveCfg() { jset(LS_CFG, U.cfg); }
  function startDrag(ev) {
    if (EMBED || ev.button !== 0 || ev.target.closest('button,a,input')) return;
    var panel = $('#ov-panel'), r = panel.getBoundingClientRect(), dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    var move = function (e) { U.cfg.pos = { x: e.clientX - dx, y: e.clientY - dy }; applyPos(); };
    var up = function () { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); saveCfg(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }

  /* ---------- действия ---------- */
  function refreshAll() {
    var left = 60000 - (Date.now() - U.refreshAt);
    if (U.refreshAt && left > 0) { toast('Обновлять можно раз в минуту, осталось ' + Math.ceil(left / 1000) + ' с.'); return; }
    var snap = session.snapshot(), ids = snap.slots.filter(function (s) { return s.identity.accountId; });
    if (snap.lifecycle === 'finished') { toast('Матч завершён, обновление остановлено. Начнётся новый матч, и данные загрузятся сами.'); return; }
    if (!ids.length) { toast('Пока нет игроков с известным Steam ID.'); return; }
    U.refreshAt = Date.now();
    ids.forEach(function (s) { stats.request(s.identity.accountId, { epoch: snap.epoch, force: true }).then(function (r) { if (r && r.tooSoon) toast('Этот игрок обновлялся меньше минуты назад.'); }); });
    toast('Обновляю статистику…');
  }
  function loadLanes(acc) {
    U.lanes[acc] = { state: 'loading' }; render();
    var epoch = session.epoch();
    api.getMatches(acc, { limit: 60 }).then(function (rows) {
      if (epoch !== session.epoch()) return;
      var ms = rows.map(A.normalizeMatch).filter(Boolean).filter(function (m) { return m.laneRole != null && LANES[m.laneRole]; });
      if (ms.length < 10) { U.lanes[acc] = { state: 'ok', top: null, note: 'Линия известна только для ' + ms.length + ' матчей, нужно хотя бы 10.' }; }
      else {
        var cnt = {}; ms.forEach(function (m) { cnt[m.laneRole] = (cnt[m.laneRole] || 0) + 1; });
        var best = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; })[0];
        U.lanes[acc] = { state: 'ok', top: LANES[best] + ': ' + cnt[best] + ' из ' + ms.length + ' матчей с данными о линии', note: 'Это линия, а не роль: различить кор и саппорта по этим данным нельзя.' };
      }
      render();
    }, function () { U.lanes[acc] = { state: 'err' }; render(); });
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-a]'); if (!t) return;
    var a = t.dataset.a;
    switch (a) {
      case 'ov-sel': U.sel = U.sel === t.dataset.k ? null : t.dataset.k; render(); break;
      case 'ov-close-detail': U.sel = null; render(); break;
      case 'ov-mode': U.cfg.mode = U.cfg.mode === 'full' ? 'compact' : 'full'; saveCfg(); render(); break;
      case 'ov-collapse': U.cfg.collapsed = !U.cfg.collapsed; saveCfg(); render(); break;
      case 'ov-settings': U.settings = !U.settings; render(); break;
      case 'ov-hide': hide(); break;
      case 'ov-show': show(); break;
      case 'ov-refresh': refreshAll(); break;
      case 'ov-retry': if (session.snapshot().lifecycle === 'finished') { toast('Матч завершён, повторы остановлены.'); break; } stats.request(t.dataset.acc, { epoch: session.epoch(), force: true }).then(function (r) { if (r && r.tooSoon) toast('Повторить можно через ' + Math.ceil(r.retryInMs / 1000) + ' с.'); }); break;
      case 'ov-lanes': loadLanes(t.dataset.acc); break;
      case 'ov-manual': U.manual = { side: t.dataset.side, err: '' }; render(); break;
      case 'ov-manual-cancel': U.manual = null; render(); break;
      case 'ov-disc': disconnect(); jset(LS_BRIDGE, null); U.conn = { status: 'off', note: '', lastAt: 0, packets: 0 }; session.setTransport('lost'); render(); break;
      case 'ov-reset-pos': U.cfg.pos = null; saveCfg(); render(); break;
      case 'ov-clear-cache': stats.clear(); toast('Кэш статистики очищен.'); break;
    }
  }
  function onSubmit(ev) {
    var f = ev.target.closest('[data-f]'); if (!f) return;
    ev.preventDefault();
    var fd = new FormData(f);
    if (f.dataset.f === 'conn') { if (connect(String(fd.get('host') || '').trim(), String(fd.get('token') || '').trim())) U.settings = false; render(); }
    if (f.dataset.f === 'manual') {
      var r = session.addManual(U.manual.side, String(fd.get('id') || ''));
      if (!r.ok) { U.manual.err = { bad_id: 'Не похоже на Account ID, Steam ID или ссылку на профиль.', duplicate: 'Этот игрок уже в списке.', side_full: 'В этой команде уже пять игроков.', no_match: 'Матч ещё не начался.' }[r.reason] || 'Не удалось добавить.'; render(); return; }
      U.manual = null; stats.request(r.accountId, { epoch: session.epoch() }); render();
    }
  }
  function onChange(ev) {
    var t = ev.target; if (!t.dataset || !t.dataset.s) return;
    var k = t.dataset.s;
    if (k === 'scale') U.cfg.scale = Number(t.value) / 100;
    else if (k === 'opacity') U.cfg.opacity = Number(t.value) / 100;
    else if (k === 'anim') U.cfg.anim = t.checked;
    else if (k.indexOf('m-') === 0) U.cfg.metrics[k.slice(2)] = t.checked;
    saveCfg(); render();
  }
  function fmtKey(e) {
    var key = e.key.length === 1 ? e.key.toUpperCase() : '';
    if (!/^[A-Z0-9]$/.test(key)) return null;
    return (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + key;
  }
  function onKey(ev) {
    var t = ev.target;
    if (t && t.dataset && t.dataset.s === 'hotkey') {
      if (ev.key === 'Tab') return;
      ev.preventDefault();
      var k = fmtKey(ev);
      if (k && /\+/.test(k)) { U.cfg.hotkey = k; saveCfg(); setNativeHotkey(); render(); }
      return;
    }
    if (ev.key === 'Escape') { if (U.manual) { U.manual = null; render(); } else if (U.sel) { U.sel = null; render(); } return; }
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (fmtKey(ev) === U.cfg.hotkey) { ev.preventDefault(); U.hidden ? show() : hide(); }
  }
  function hide() { U.hidden = true; if (window.dotamateOverlay && window.dotamateOverlay.hide) window.dotamateOverlay.hide(); render(); }
  function show() { U.hidden = false; if (window.dotamateOverlay && window.dotamateOverlay.show) window.dotamateOverlay.show(); render(); }
  function setNativeHotkey() { if (window.dotamateOverlay && window.dotamateOverlay.setHotkey) window.dotamateOverlay.setHotkey(U.cfg.hotkey); }

  /* ---------- подсказки (data-tip) ---------- */
  function initTips() {
    var tip = document.createElement('div'); tip.id = 'ov-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true; document.body.appendChild(tip);
    var cur = null;
    document.addEventListener('pointerover', function (e) {
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || t === cur) return; cur = t;
      tip.textContent = t.dataset.tip; tip.hidden = false;
      var r = t.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2)) + 'px';
      tip.style.top = (r.bottom + h + 8 > window.innerHeight ? Math.max(4, r.top - h - 6) : r.bottom + 6) + 'px';
    });
    document.addEventListener('pointerout', function (e) { if (cur && !(e.relatedTarget && cur.contains(e.relatedTarget))) { cur = null; tip.hidden = true; } });
    document.addEventListener('scroll', function () { cur = null; tip.hidden = true; }, true);
    /* Не загрузилась картинка героя (нет сети, блокировщик): остаются инициалы. */
    document.addEventListener('error', function (e) { var t = e.target; if (t && t.tagName === 'IMG' && t.closest('.ov-hi')) t.remove(); }, true);
  }

  /* ---------- запуск ---------- */
  function boot() {
    var root = $('#ov-root');
    if (EMBED) document.documentElement.classList.add('embed');
    var q = new URLSearchParams(location.search), qb = q.get('b'), qt = q.get('t');
    if (qb && qt && HOST_RE.test(qb) && TOKEN_RE.test(qt)) { jset(LS_BRIDGE, { host: qb, token: qt }); try { history.replaceState(null, '', location.pathname); } catch (e) { /* адресная строка недоступна */ } }
    root.addEventListener('click', onClick); root.addEventListener('submit', onSubmit); root.addEventListener('change', onChange); root.addEventListener('input', function (e) { if (e.target.dataset && e.target.dataset.s === 'scale') { U.cfg.scale = Number(e.target.value) / 100; root.style.setProperty('--ov-scale', U.cfg.scale); } });
    document.addEventListener('keydown', onKey);
    $('#ov-panel').addEventListener('pointerdown', function (e) { if (e.target.closest('.ov-h')) startDrag(e); });
    $('#ov-show').addEventListener('click', show);
    window.addEventListener('resize', applyPos);
    if (window.dotamateOverlay && window.dotamateOverlay.onToggle) window.dotamateOverlay.onToggle(function (visible) { U.hidden = !visible; render(); });
    setNativeHotkey(); initTips(); loadHeroes();
    var c = bridgeCfg(); if (c) connect(c.host, c.token);
    render();
    setInterval(function () { if (!U.cfg.collapsed && !U.hidden) render(); }, 30000);     // обновляет «N мин назад»
    window.DMOverlay = { state: function () { return U; }, session: session, stats: stats, push: onPacket };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
