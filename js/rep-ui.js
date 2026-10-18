/*
 * Dota Mate: интерфейс раздела «Репутация» (ядро и страницы без серверной части).
 * Страницы: Поиск, Матч, Эпизоды, Хронология, Party Safety, Сеть, Публичный отчёт.
 * Страницы сообщества (жалобы, обжалования, наблюдение, модерация) лежат в js/rep-ui2.js и регистрируются через DMRepUI.register.
 * Зависимости: DMA (analytics.js), DMApi (dotaapi.js), DMRep (reputation.js), DMComm (community.js).
 * Правило: статистику считает браузер по открытым данным OpenDota; решения, жалобы и права проверяет только сервер.
 */
(function () {
  'use strict';
  var A = window.DMA, API = window.DMApi, R = window.DMRep, C = window.DMComm, H = null;
  var LS = 'dotamate.rep.v1';
  var S = { tab: 'home', param: '', cache: {}, heroes: null, apis: {}, pages: {}, order: [], mod: false, user: null, srv: null };

  /* ---------- вспомогательное ---------- */
  function e(s) { return H.esc(s); }
  function ico(n, c) { return H.ico(n, c); }
  function now() { return Math.floor(Date.now() / 1000); }
  function nf(n) { return Number(n).toLocaleString('ru-RU'); }
  function pl(n, a, b, c) { return A.plural(n, a, b, c); }
  function dt(ts) { return ts ? new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function dday(ts) { return ts ? new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function dur(s) { s = Math.max(0, Math.round(s)); var m = Math.floor(s / 60), x = s % 60; return m + ':' + (x < 10 ? '0' : '') + x; }
  function store(v) {
    try { if (v === undefined) return JSON.parse(localStorage.getItem(LS) || 'null') || {}; localStorage.setItem(LS, JSON.stringify(v)); } catch (x) { /* хранилище недоступно */ }
    return {};
  }
  function api() {
    var base = H.base();
    if (!S.apis[base]) {
      var st = null; try { st = window.localStorage; } catch (x) { st = null; }
      S.apis[base] = API.create({ base: base, storage: st, minInterval: H.server() ? 250 : 1000 });
    }
    return S.apis[base];
  }
  function errText(x) {
    var c = x && x.code;
    if (c === 'not_found') return 'OpenDota не знает такого игрока или матча. Проверьте номер: если данные закрыты или матч слишком новый, записей может не быть.';
    if (c === 'rate_limit') return 'OpenDota временно ограничил число запросов. Подождите минуту и повторите.';
    if (c === 'network') return 'Нет связи с OpenDota. Проверьте подключение и повторите.';
    if (c === 'timeout') return 'OpenDota долго не отвечает. Попробуйте ещё раз.';
    if (c === 'invalid') return 'Некорректный идентификатор.';
    return 'Источник данных вернул ошибку. Попробуйте позже.';
  }
  function heroName(id) {
    var n = H.heroName(id);
    if (n) return n;
    return S.heroes && S.heroes[id] ? S.heroes[id] : (id != null ? 'Герой #' + id : 'Неизвестный герой');
  }
  function loadHeroes() {
    if (S.heroes) return Promise.resolve(S.heroes);
    return api().getHeroes().then(function (l) { var m = {}; l.forEach(function (h) { if (h && h.id != null) m[h.id] = h.localized_name || ''; }); S.heroes = m; return m; }).catch(function () { S.heroes = {}; return S.heroes; });
  }
  function parseAcc(raw) {
    var r = A.parsePlayerInput(raw);
    if (r.ok) return { ok: true, acc: String(r.acc) };
    if (r.code === 'vanity') return { ok: false, msg: 'Ссылки вида steamcommunity.com/id/имя нужно сначала превратить в числовой ID (профиль → «Скопировать URL страницы»). Введите Steam ID, SteamID64 или ссылку /profiles/….' };
    if (r.code === 'empty') return { ok: false, msg: 'Введите Steam ID, SteamID64 или ссылку на профиль.' };
    return { ok: false, msg: 'Не удалось распознать идентификатор. Допустимы Steam ID, SteamID64 и ссылки steamcommunity.com/profiles/….' };
  }
  function safeUrl(u) { return /^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? u : null; }
  function link(hash, text, cls) { return '<a class="' + (cls || 'btn sm2') + '" href="#/' + e(hash) + '" data-rp-link="1">' + text + '</a>'; }
  function pageLink(tab, param) { return '#/' + tab + (param ? '/' + param : ''); }
  function shareUrl(tab, param) { return location.href.split('#')[0] + pageLink(tab, param); }
  function badge(cls, text) { return '<span class="rp-b ' + cls + '">' + e(text) + '</span>'; }

  /* ---------- память (последние поиски) ---------- */
  function rememberMatch(id, extra) {
    var s = store(), l = (s.matches || []).filter(function (x) { return x.id !== id; });
    l.unshift(Object.assign({ id: id, at: now() }, extra || {}));
    s.matches = l.slice(0, 8); store(s);
  }
  function recentPlayers() {
    try { var p = JSON.parse(localStorage.getItem('dotamate.profile.v1') || 'null'); return (p && p.recent) || []; } catch (x) { return []; }
  }

  /* ---------- загрузка игрока и расчёт ---------- */
  function communityOn() { return C.status().then(function (st) { S.srv = st; S.user = st.user || null; S.mod = !!(st.user && st.user.moderator); return st; }); }

  /** Загружает игрока и считает всё, что нужно разделу. Результат кэшируется на 5 минут (force обходит кэш). */
  function loadPlayer(acc, force) {
    var c = S.cache[acc];
    if (!force && c && Date.now() - c.at < 300000) return c.p;
    var a = api();
    if (force) a.clearCache();
    var p = (async function () {
      await loadHeroes();
      var pl0 = await a.getPlayer(acc);
      var rows = await a.getMatches(acc, { limit: 100, extra: false });
      var nowS = now();
      var matches = A.newestFirst(rows.map(A.normalizeMatch).filter(Boolean));
      var an = R.detectAnomalies(matches, { now: nowS, heroName: heroName });
      var st = await communityOn();
      var sum = st.available ? await C.summary(acc) : null;
      var comm = C.toComm(sum);
      var rep = R.computeReputation({ matches: matches, now: nowS, anomalies: an, fetchedAt: nowS, comm: comm });
      return { acc: acc, profile: pl0 && pl0.profile || null, rank: A.rankTier(pl0 && pl0.rank_tier), matches: matches, an: an, sum: sum, comm: comm, rep: rep, fetchedAt: nowS, communityAvailable: !!st.available };
    })();
    S.cache[acc] = { p: p, at: Date.now() };
    p.catch(function () { delete S.cache[acc]; });
    return p;
  }
  function who(d) { return (d.profile && d.profile.personaname) || ('Игрок ' + d.acc); }

  /* ---------- общие блоки ---------- */
  var STATE_CLS = { insufficient: 's-neutral', no_signals: 's-ok', needs_review: 's-warn', confirmed: 's-bad', stale: 's-neutral' };
  var STATE_HINT = {
    insufficient: 'Данных слишком мало, чтобы что-то утверждать. Это не плохая и не хорошая репутация.',
    no_signals: 'Статистических сигналов не найдено. Это не гарантия: анализ видит только публичную статистику матчей.',
    needs_review: 'Есть повод посмотреть матчи самому. Это не вывод о нарушении.',
    confirmed: 'Есть эпизоды, подтверждённые модератором с обоснованием.',
    stale: 'Последние матчи старые, сигналы могут не отражать текущее поведение.'
  };
  function stateBadge(rep) { return badge(STATE_CLS[rep.state] || 's-neutral', rep.stateLabel); }
  function confBadge(conf) { return badge(conf.level === 'high' ? 's-ok' : conf.level === 'medium' ? 's-neutral' : 's-low', 'Достоверность: ' + conf.label.toLowerCase()); }

  function kv(k, v, hint) { return '<div class="rp-kv"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (hint ? '<div class="h">' + hint + '</div>' : '') + '</div>'; }

  /** Карточка репутации. d = результат loadPlayer (или собранный из профиля). */
  function repCard(d, o) {
    o = o || {};
    var rep = d.rep, W = R.WEIGHTS;
    var unc = rep.hiddenReports ? 'скрыты (мало)' : d.communityAvailable === false ? 'нет данных' : String(rep.unconfirmedReports || 0);
    var uncHint = rep.hiddenReports ? 'счётчик показывается при ≥2 авторах и ≥2 матчах' : d.communityAvailable === false ? 'нужен сервер Dota Mate' : 'жалобы без решения модератора';
    var grid = '<div class="rp-grid">' +
      kv('Уровень риска', rep.risk ? e(rep.risk) : '<span class="na">не оценивается</span>', rep.risk ? 'ориентир, не приговор' : 'нет оснований для оценки') +
      kv('Достоверность', e(rep.confidence.label), e(rep.confidence.reason)) +
      kv('Матчей с сигналами', String(rep.uniqueSignalMatches), 'уникальные матчи') +
      kv('Подтверждено модератором', d.communityAvailable === false ? '<span class="na">нет данных</span>' : String(rep.confirmedCount), d.communityAvailable === false ? 'нужен сервер Dota Mate' : 'эпизодов') +
      kv('Неподтверждённые жалобы', unc, uncHint) +
      kv('Последняя проверка', e(dt(rep.lastCheck)), 'данные OpenDota на этот момент') + '</div>';
    var exp = rep.score == null ? '<p class="sm">Экспериментальный индекс не рассчитан: недостаточно данных.</p>' :
      '<div class="rp-score" title="Экспериментальный индекс, метод открыт ниже"><span class="lbl">Экспериментальный индекс</span><div class="bar"><i style="width:' + rep.score + '%"></i></div><b>' + rep.score + ' / 100</b></div><p class="sm">' + e(rep.scoreNote) + '</p>';
    var why = '<details class="rp-why"><summary>Почему сформирована эта оценка?</summary>' +
      (rep.factors.length ? '<table class="rp-tbl"><thead><tr><th>Основание</th><th>Баллы</th></tr></thead><tbody>' + rep.factors.map(function (f) { return '<tr><td><b>' + e(f.label) + '</b><div class="sm">' + e(f.detail) + '</div></td><td class="num">+' + f.points + '</td></tr>'; }).join('') + '</tbody></table>' : '<p>Ни одно основание баллов не дало.</p>') +
      '<p class="sm"><b>Что не учитывается:</b> ' + rep.notCounted.map(e).join('; ') + '.</p>' +
      '<p class="sm"><b>Как считается:</b> подтверждённый модератором эпизод ' + W.confirmedEach + ' (максимум ' + W.confirmedCap + '), матч с необычным числом смертей ' + W.outlierEach + ' (максимум ' + W.outlierCap + '), повторяемость ' + W.patternEach + ' (максимум ' + W.patternCap + '), доля покинутых матчей ' + W.abandon10 + '–' + W.abandon20 + ', неподтверждённые жалобы ' + W.reportsEach + ' за независимую пару «автор + матч» (максимум ' + W.reportsCap + '). Без подтверждения модератора итог не превышает ' + (W.outlierCap + W.patternCap + W.abandon20 + W.reportsCap) + ' и уровень «Высокий» недостижим.</p>' +
      '<p class="sm">Правила: поражения и низкий K/D/A баллов не дают; жалоба не равна нарушению; много жалоб от одного автора считаются одной; одинаковые матчи не суммируются; при малой выборке достоверность низкая.</p></details>';
    var acts = o.noActions ? '' : '<div class="rp-acts">' +
      link('episodes/' + d.acc, ico('list') + 'Эпизоды') + link('timeline/' + d.acc, ico('refresh') + 'Хронология') + link('network/' + d.acc, ico('users') + 'Сеть') +
      link('report/' + d.acc, ico('ext') + 'Публичный отчёт') +
      '<button class="btn sm2" type="button" data-rp="watch" data-acc="' + e(d.acc) + '">' + ico('star') + 'В наблюдение</button>' +
      '<button class="btn sm2 danger" type="button" data-rp="report-to" data-acc="' + e(d.acc) + '">' + ico('alert') + 'Сообщить об эпизоде</button></div>';
    return '<section class="card rp-card ' + (STATE_CLS[rep.state] || '') + '" aria-label="Репутация и поведение"><div class="sec-h"><h2>Репутация и поведение</h2><span>' + stateBadge(rep) + ' ' + confBadge(rep.confidence) + '</span></div>' +
      '<p class="rp-hint">' + e(STATE_HINT[rep.state]) + '</p>' + grid + exp +
      (rep.notes.length ? '<ul class="rp-notes">' + rep.notes.map(function (n) { return '<li>' + e(n) + '</li>'; }).join('') + '</ul>' : '') +
      why + acts + '</section>';
  }

  /** Карточка для страницы профиля: считает по уже загруженным там матчам (с GPM/XPM), сообщество подгружает асинхронно. */
  function profileCard(acc, matches, profile, rerender) {
    acc = String(acc);
    var c = S.cache['pc:' + acc];
    if (!c || Date.now() - c.at > 120000) {
      c = S.cache['pc:' + acc] = { at: Date.now(), sum: undefined };
      communityOn().then(function (st) { return st.available ? C.summary(acc) : null; }).then(function (sum) { c.sum = sum; if (rerender) rerender(); }, function () { c.sum = null; if (rerender) rerender(); });
    }
    if (!matches || !matches.length) return '';
    var nowS = now(), an = R.detectAnomalies(matches, { now: nowS, heroName: heroName });
    var comm = c.sum === undefined ? { available: false } : C.toComm(c.sum);
    var rep = R.computeReputation({ matches: matches, now: nowS, anomalies: an, fetchedAt: nowS, comm: comm });
    var d = { acc: acc, rep: rep, an: an, communityAvailable: c.sum !== undefined ? !!c.sum : false };
    return repCard(d) + anomalyBox(an, acc, matches);
  }
  function anomalyBox(an, acc) {
    var list = an.items.filter(function (i) { return i.group !== 'info' || i.kind === 'performance_low'; }).slice(0, 5);
    if (!an.ready && !an.items.length) return '<p class="sm rp-foot">Для поиска статистических отклонений нужно хотя бы 15 матчей с длительностью и числом смертей. Сейчас: ' + an.baselineN + '.</p>';
    if (!list.length) return '<p class="sm rp-foot">Отклонений от собственных обычных показателей среди загруженных матчей не найдено. ' + link('episodes/' + acc, 'Все эпизоды', 'rp-a') + '</p>';
    return '<p class="sm rp-foot">Матчей с отметками: ' + new Set(an.items.map(function (i) { return i.matchId; })).size + '. ' + link('episodes/' + acc, 'Открыть эпизоды', 'rp-a') + '</p>';
  }

  /* ---------- эпизоды ---------- */
  var GROUP_LABEL = { fact: 'Факт игры', anomaly: 'A · Статистическая аномалия', info: 'Справочная отметка' };
  function episodeCard(i, d) {
    var cls = i.group === 'anomaly' ? 'e-warn' : i.group === 'fact' ? 'e-fact' : 'e-info';
    return '<article class="rp-ep ' + cls + '"><header><span>' + badge(i.group === 'anomaly' ? 's-warn' : 's-neutral', GROUP_LABEL[i.group] || 'Отметка') + ' <b>' + e(i.title) + '</b></span>' +
      '<span class="sm">' + (i.start ? e(dt(i.start)) : '') + (i.hero != null ? ' · ' + e(heroName(i.hero)) : '') + '</span></header>' +
      '<ul>' + i.facts.map(function (f) { return '<li>' + e(f) + '</li>'; }).join('') + '</ul><p class="sm">' + e(i.basis) + '</p>' +
      '<footer><span class="sm">Статус: автоматический сигнал, человеком не проверялся. Источник: OpenDota, расчёт Dota Mate.</span><span>' +
      (i.matchId ? link('match/' + i.matchId, 'Матч ' + e(i.matchId)) + ' <button class="btn sm2 danger" type="button" data-rp="report-to" data-acc="' + e(d.acc) + '" data-mid="' + e(i.matchId) + '">Сообщить</button>' : '') + '</span></footer></article>';
  }
  function markCard(m, d, kind) {
    var cat = R.CATEGORIES[m.category] || m.category;
    return '<article class="rp-ep ' + (kind === 'disputed' ? 'e-info' : 'e-bad') + '"><header><span>' + badge(kind === 'disputed' ? 's-neutral' : 's-bad', kind === 'disputed' ? 'Оспаривается' : 'Подтверждён модератором') + ' <b>' + e(cat) + '</b></span><span class="sm">' + e(dday(m.decidedAt)) + '</span></header>' +
      (m.reason ? '<p>' + e(m.reason) + '</p>' : '<p class="sm">Модератор не добавил публичного пояснения.</p>') +
      '<footer><span class="sm">' + (kind === 'disputed' ? 'Игрок оспорил отметку; пока решения нет, она в оценку не входит.' : 'Решение принято человеком; проверить его можно в матче.') + '</span><span>' + link('match/' + m.matchId, 'Матч ' + e(m.matchId)) + (m.id ? ' <button class="btn sm2 ghost" type="button" data-rp="appeal-to" data-id="' + e(m.id) + '">Оспорить или сообщить об ошибке</button>' : '') + '</span></footer></article>';
  }

  /* ---------- каркас страниц ---------- */
  function register(id, def) { def.id = id; S.pages[id] = def; if (S.order.indexOf(id) < 0) S.order.push(id); }
  function root() { return document.getElementById('rp-root'); }
  function page() { return S.pages[S.tab] || S.pages.home; }

  var ORDER = ['home', 'match', 'episodes', 'timeline', 'reports', 'party', 'watchlist', 'network', 'appeals', 'mod', 'report'];
  function shell() {
    var p = page();
    var tabs = ORDER.filter(function (id) { return S.pages[id] && (!S.pages[id].visible || S.pages[id].visible()); }).map(function (id) {
      var d = S.pages[id];
      return '<a class="rp-tab" href="' + pageLink(id, id === S.tab ? S.param : '') + '" data-rp-link="1"' + (id === S.tab ? ' aria-current="page"' : '') + '>' + e(d.label) + '</a>';
    }).join('');
    return '<div class="pagehead"><div><h1>' + e(p.title) + '</h1><p>' + e(p.desc) + '</p></div></div><nav class="rp-tabs" aria-label="Разделы репутации">' + tabs + '</nav><div id="rp-form"></div><div id="rp-res" aria-live="polite"></div>';
  }
  function renderForm() { var el = document.getElementById('rp-form'); if (el) el.innerHTML = page().form ? page().form() : ''; }
  function renderRes() {
    var el = document.getElementById('rp-res');
    if (!el) return;
    var y = window.scrollY;
    el.innerHTML = page().res();
    if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
  }
  function mount() {
    var r = root(); if (!r) return;
    r.innerHTML = shell(); renderForm(); renderRes();
    if (!S.srv) communityOn().then(function () { var rr = root(); if (rr && page().needsStatus) { renderForm(); renderRes(); } var t = rr && rr.querySelector('.rp-tabs'); if (t) { var tmp = document.createElement('div'); tmp.innerHTML = shell(); t.innerHTML = tmp.querySelector('.rp-tabs').innerHTML; } });
  }
  /** Переход на страницу. Вызывается маршрутизатором хозяина и самими страницами. */
  function nav(tab, param) {
    if (!S.pages[tab]) tab = 'home';
    S.tab = tab; S.param = param || '';
    var p = S.pages[tab];
    if (p.go) p.go(S.param);
    mount();
  }
  var toastFn = function (m) { if (H && H.toast) H.toast(m); };
  var ctx = { e: e, ico: ico, now: now, nf: nf, pl: pl, dt: dt, dday: dday, dur: dur, api: api, errText: errText, heroName: heroName, loadHeroes: loadHeroes, parseAcc: parseAcc, safeUrl: safeUrl, link: link, pageLink: pageLink, shareUrl: shareUrl, badge: badge,
    kv: kv, repCard: repCard, stateBadge: stateBadge, confBadge: confBadge, episodeCard: episodeCard, markCard: markCard, loadPlayer: loadPlayer, who: who, communityOn: communityOn, rememberMatch: rememberMatch, recentPlayers: recentPlayers, store: store,
    renderRes: renderRes, renderForm: renderForm, nav: nav, state: S, toast: function (m) { toastFn(m); }, host: function () { return H; }, root: root, GROUP_LABEL: GROUP_LABEL, STATE_CLS: STATE_CLS };

  /* ---------- события (общие для всех страниц) ---------- */
  function within(t) { return t.closest && t.closest('#rp-root, #me-root'); }
  document.addEventListener('submit', function (ev) {
    var f = ev.target; if (!f.dataset || !f.dataset.rpform || !within(f)) return;
    ev.preventDefault();
    var p = S.pages[f.dataset.rpform]; if (p && p.submit) p.submit(f);
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target; if (!t.dataset || !t.dataset.rpset || !within(t)) return;
    var p = page(); if (p.set) p.set(t.dataset.rpset, t.type === 'checkbox' ? t.checked : t.value, t);
  });
  document.addEventListener('input', function (ev) {
    var t = ev.target; if (!t.dataset || !t.dataset.rpin || !within(t)) return;
    var p = page(); if (p.input) p.input(t.dataset.rpin, t.value, t);
  });
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('a[data-rp-link]');
    if (a && within(a)) { /* обычный переход по hash: маршрутизатор хозяина сам вызовет nav */ return; }
    var t = ev.target.closest && ev.target.closest('[data-rp]'); if (!t || !within(t)) return;
    var name = t.dataset.rp;
    if (name === 'copy') { H.copy(t.dataset.t); return; }
    if (name === 'watch') { var w = S.pages.watchlist; if (w && w.quickAdd) w.quickAdd(t.dataset.acc); return; }
    if (name === 'appeal-to') { var ap = S.pages.appeals; if (ap && ap.prefill) ap.prefill(t.dataset.id); location.hash = pageLink('appeals'); return; }
    if (name === 'report-to') { var r = S.pages.reports; if (r && r.prefill) r.prefill(t.dataset.acc, t.dataset.mid || ''); location.hash = pageLink('reports'); return; }
    var p = page(); if (p.act) p.act(name, t, ev);
  });

  /* ================= СТРАНИЦА: ПОИСК ================= */
  var home = { err: '', merr: '' };
  register('home', {
    label: 'Поиск', title: 'Репутация игроков', desc: 'Проверка игрока или матча по открытым данным OpenDota и по решениям модераторов Dota Mate. Без догадок: только факты, отклонения от собственной нормы и проверенные решения.',
    form: function () {
      return '<section class="card rp-search"><div class="rp-two">' +
        '<form data-rpform="home" data-kind="player" novalidate><label for="rp-pin">Игрок: Steam ID, SteamID64 или ссылка на профиль</label><div class="me-row"><input id="rp-pin" type="text" autocomplete="off" spellcheck="false" placeholder="7656119… или steamcommunity.com/profiles/…"' + (home.err ? ' aria-invalid="true"' : '') + '><button class="btn primary" type="submit">' + ico('search') + 'Найти игрока</button></div>' + (home.err ? '<p class="rp-err" role="alert">' + e(home.err) + '</p>' : '') + '</form>' +
        '<form data-rpform="home" data-kind="match" novalidate><label for="rp-min">Матч: Match ID</label><div class="me-row"><input id="rp-min" type="text" inputmode="numeric" autocomplete="off" placeholder="например 7712345678"' + (home.merr ? ' aria-invalid="true"' : '') + '><button class="btn primary" type="submit">' + ico('search') + 'Открыть матч</button></div>' + (home.merr ? '<p class="rp-err" role="alert">' + e(home.merr) + '</p>' : '') + '</form></div></section>';
    },
    res: function () {
      var rp = recentPlayers(), rm = store().matches || [];
      var pl0 = rp.length ? '<div class="rp-list">' + rp.map(function (x) { return '<a class="chip" href="#/profile/' + e(x.acc) + '" data-rp-link="1">' + e(x.name || x.acc) + '</a>'; }).join('') + '</div>' : '<p class="sm">Пока пусто. Здесь появятся игроки, которых вы открывали в этом браузере.</p>';
      var ml = rm.length ? '<div class="rp-list">' + rm.map(function (x) { return '<a class="chip" href="#/match/' + e(x.id) + '" data-rp-link="1">Матч ' + e(x.id) + '</a>'; }).join('') + '</div>' : '<p class="sm">Пока пусто. Здесь появятся матчи, которые вы открывали.</p>';
      return '<section class="card"><div class="sec-h"><h2>Недавние профили</h2></div>' + pl0 + '<div class="sec-h" style="margin-top:14px"><h2>Недавние матчи</h2></div>' + ml + '</section>' +
        '<section class="card"><div class="sec-h"><h2>Как устроена репутация</h2></div>' +
        '<div class="rp-how"><div><b>Факты игры</b><p>Отметки самой игры: выход из матча, потеря связи. Причина из них не видна.</p></div>' +
        '<div><b>Отклонения от собственной нормы</b><p>Матч, где смертей заметно больше, чем обычно у этого игрока (и у него на этом герое). Это статистика, не обвинение.</p></div>' +
        '<div><b>Жалобы сообщества</b><p>Жалоба не равна нарушению. Её видно публично только при двух независимых авторах и двух разных матчах, и она остаётся непроверенной.</p></div>' +
        '<div><b>Решения модераторов</b><p>Только они делают эпизод «подтверждённым». Решение можно оспорить, и отметку снимают, если она ошибочна.</p></div></div>' +
        '<p class="sm">Поражения, низкий K/D/A и число жалоб от одного автора баллов не дают. При малой выборке оценки нет. Итог по умолчанию не бывает «Высоким» без подтверждения модератором. Подробная формула раскрывается в блоке «Почему сформирована эта оценка?» на странице игрока.</p></section>';
    },
    submit: function (f) {
      var v = f.querySelector('input').value;
      if (f.dataset.kind === 'player') {
        var r = parseAcc(v);
        if (!r.ok) { home.err = r.msg; renderForm(); return; }
        home.err = ''; location.hash = '#/profile/' + r.acc;
      } else {
        v = String(v).trim();
        if (!/^\d{6,13}$/.test(v)) { home.merr = 'Match ID состоит из 6–13 цифр.'; renderForm(); return; }
        home.merr = ''; location.hash = '#/match/' + v;
      }
    }
  });

  /* ================= СТРАНИЦА: МАТЧ ================= */
  var M = { id: '', phase: 'idle', d: null, err: '', hist: {}, comm: null, token: 0 };
  function teamOf(p) { return p.isRadiant != null ? !!p.isRadiant : Number(p.player_slot) < 128; }
  function matchSignals(d) {
    var ps = d.players || [], out = {}, mins = Math.max(1, (d.duration || 0) / 60);
    ps.forEach(function (p, idx) {
      var sig = [], li = p.leaver_status != null ? R.leaverInfo(p.leaver_status) : null;
      if (li) sig.push({ kind: li.fact ? 'fact' : 'info', text: li.t + ' (leaver_status = ' + p.leaver_status + ')' });
      var others = ps.filter(function (q, j) { return j !== idx && q.deaths != null; });
      if (p.deaths != null && others.length >= 5 && d.duration >= 900) {
        var avg = others.reduce(function (s, q) { return s + q.deaths; }, 0) / others.length;
        if (p.deaths >= 10 && p.deaths >= avg * 2) sig.push({ kind: 'anomaly', text: p.deaths + ' ' + pl(p.deaths, 'смерть', 'смерти', 'смертей') + ' при среднем ' + avg.toFixed(1) + ' у остальных участников матча (' + (p.deaths / (mins / 10)).toFixed(1) + ' на 10 минут). Сравнение внутри одного матча, не с историей игрока.' });
      }
      out[idx] = sig;
    });
    return out;
  }
  function matchGo(id) {
    M.id = id; M.phase = 'loading'; M.d = null; M.err = ''; M.hist = {}; M.comm = null; var tok = ++M.token;
    if (!/^\d{6,13}$/.test(id)) { M.phase = 'error'; M.err = 'Match ID состоит из 6–13 цифр.'; return; }
    loadHeroes().then(function () { return api().getMatchDetail(id); }).then(function (d) {
      if (tok !== M.token) return;
      if (!d || !Array.isArray(d.players)) throw { code: 'bad_data' };
      M.d = d; M.phase = 'ready'; rememberMatch(id, { at: now() });
      renderRes();
      return communityOn().then(function (st) { if (st.available) return C.call('GET', '/match/' + id); }).then(function (r) { if (tok === M.token && r && r.ok) { M.comm = r.data; renderRes(); } });
    }).catch(function (x) { if (tok !== M.token) return; M.phase = 'error'; M.err = errText(x); renderRes(); });
  }
  function playerName(p) { return p.personaname || p.name || null; }
  function playerRow(p, idx, sigs) {
    var acc = p.account_id != null ? String(p.account_id) : null, nm = playerName(p);
    var hist = acc ? M.hist[acc] : null, histHtml = '';
    if (hist === 'loading') histHtml = '<div class="sm">Сверяю с историей игрока…</div>';
    else if (hist && hist.err) histHtml = '<div class="sm rp-err">' + e(hist.err) + '</div>';
    else if (hist) histHtml = '<div class="sm">' + (hist.items.length ? hist.items.map(function (i) { return '<div class="rp-sig ' + (i.group === 'anomaly' ? 'warn' : '') + '"><b>' + e(i.title) + '.</b> ' + e(i.facts.join('; ')) + '</div>'; }).join('') : 'По истории игрока (' + hist.baseline + ' матчей) этот матч не выделяется.') + '</div>';
    var s = (sigs[idx] || []).map(function (x) { return '<div class="rp-sig ' + (x.kind === 'anomaly' ? 'warn' : '') + '">' + (x.kind === 'fact' ? 'Факт игры: ' : x.kind === 'anomaly' ? 'Отклонение: ' : 'Отметка: ') + e(x.text) + '</div>'; }).join('');
    var marks = M.comm && acc ? M.comm.marks.filter(function (m) { return m.acc === acc; }) : [];
    var mk = marks.map(function (m) { return '<div class="rp-sig bad">' + (m.status === 'disputed' ? 'Оспариваемая отметка модератора: ' : 'Подтверждено модератором: ') + e(R.CATEGORIES[m.category] || m.category) + (m.reason ? '. ' + e(m.reason) : '') + '</div>'; }).join('');
    var gx = p.gold_per_min != null ? Math.round(p.gold_per_min) + ' / ' + Math.round(p.xp_per_min || 0) : '—';
    return '<tr><td><b>' + e(heroName(p.hero_id)) + '</b></td><td>' + (acc ? '<a href="#/profile/' + e(acc) + '" data-rp-link="1">' + e(nm || 'Игрок ' + acc) + '</a>' : '<span class="na">Скрытый профиль</span>') + '</td>' +
      '<td class="num">' + (p.kills != null ? p.kills + ' / ' + p.deaths + ' / ' + p.assists : '—') + '</td><td class="num">' + gx + '</td><td class="num">' + (p.last_hits != null ? p.last_hits : '—') + '</td>' +
      '<td class="rp-sigs">' + (s || mk || histHtml ? s + mk + histHtml : '<span class="sm">Сигналов нет</span>') + '</td>' +
      '<td>' + (acc ? '<button class="btn sm2" type="button" data-rp="hist" data-acc="' + e(acc) + '"' + (hist === 'loading' ? ' disabled' : '') + '>Сверить с историей</button> <button class="btn sm2 danger" type="button" data-rp="report-to" data-acc="' + e(acc) + '" data-mid="' + e(M.id) + '">Сообщить</button>' : '') + '</td></tr>';
  }
  register('match', {
    label: 'Матч', title: 'Исследование матча', desc: 'Участники, статистика и сигналы Dota Mate по каждому игроку. Показано только то, что есть в данных; намерение игрока по ним определить нельзя.',
    go: function (id) { if (id) matchGo(String(id).trim()); else { M.phase = 'idle'; M.id = ''; } },
    form: function () {
      return '<section class="card rp-search"><form data-rpform="match" novalidate><label for="rp-mid">Match ID</label><div class="me-row"><input id="rp-mid" type="text" inputmode="numeric" autocomplete="off" value="' + e(M.id) + '" placeholder="например 7712345678"><button class="btn primary" type="submit">' + ico('search') + 'Открыть матч</button></div></form></section>';
    },
    res: function () {
      if (M.phase === 'idle') return '<div class="empty">' + ico('search') + '<b>Введите Match ID</b><p>Откроется список участников с их статистикой и сигналами. Для проверки по истории игрока нажмите «Сверить с историей».</p></div>';
      if (M.phase === 'loading') return '<div class="sk-row" aria-busy="true" role="status"><span class="sm">Загружаю матч…</span><div class="skel h1"></div><div class="skel h2"></div></div>';
      if (M.phase === 'error') return '<div class="banner" role="alert">' + ico('alert') + '<div style="flex:1"><b>Матч не загружен</b><p class="sm">' + e(M.err) + '</p></div><button class="btn sm2" type="button" data-rp="retry">Повторить</button></div>';
      var d = M.d, sigs = matchSignals(d), rad = d.players.filter(teamOf), dire = d.players.filter(function (p) { return !teamOf(p); });
      var idx = function (p) { return d.players.indexOf(p); };
      var tbl = function (title, list, win) { return '<section class="card"><div class="sec-h"><h2>' + title + (win == null ? '' : ' <small>' + (win ? 'победа' : 'поражение') + '</small>') + '</h2></div><div class="tbl-scroll"><table class="rp-tbl rp-wide"><thead><tr><th>Герой</th><th>Игрок</th><th>K / D / A</th><th>GPM / XPM</th><th>Добито</th><th>Сигналы</th><th></th></tr></thead><tbody>' + list.map(function (p) { return playerRow(p, idx(p), sigs); }).join('') + '</tbody></table></div></section>'; };
      var parsed = d.players.some(function (p) { return p.lane_role != null; });
      return '<section class="card"><div class="sec-h"><h2>Матч ' + e(M.id) + '</h2><span><button class="btn sm2" type="button" data-rp="copy" data-t="' + e(shareUrl('match', M.id)) + '">' + ico('copy') + 'Скопировать ссылку</button> <a class="btn sm2" href="https://www.opendota.com/matches/' + e(M.id) + '" target="_blank" rel="noopener noreferrer">' + ico('ext') + 'OpenDota</a></span></div>' +
        '<p>' + e(dt(d.start_time)) + ' · длительность ' + (d.duration ? e(dur(d.duration)) : '—') + ' · победили ' + (d.radiant_win == null ? '<span class="na">—</span>' : d.radiant_win ? 'Силы Света' : 'Силы Тьмы') + '</p>' +
        (parsed ? '' : '<p class="sm">Матч не разобран OpenDota (нет данных о линиях). Это не мешает базовым сигналам, но точных позиций здесь нет.</p>') +
        '<p class="sm">Важно: OpenDota не отдаёт данные о намеренном кормлении, сломанных предметах или блокировке союзников, поэтому такие эпизоды система определить не может. Для них есть жалобы с проверкой модератором.</p></section>' +
        tbl('Силы Света', rad, d.radiant_win) + tbl('Силы Тьмы', dire, d.radiant_win == null ? null : !d.radiant_win);
    },
    submit: function (f) { var v = f.querySelector('input').value.trim(); location.hash = '#/match/' + v; if (v === M.id) matchGo(v); },
    act: function (name, t) {
      if (name === 'retry') { matchGo(M.id); renderRes(); return; }
      if (name === 'hist') {
        var acc = t.dataset.acc; M.hist[acc] = 'loading'; renderRes();
        var tok = M.token;
        loadPlayer(acc).then(function (pd) {
          if (tok !== M.token) return;
          M.hist[acc] = { baseline: pd.an.baselineN, items: pd.an.items.filter(function (i) { return i.matchId === M.id; }) };
          if (!pd.an.ready) M.hist[acc].err = 'У игрока меньше 15 подходящих матчей в истории: сравнивать не с чем.';
          renderRes();
        }).catch(function (x) { if (tok === M.token) { M.hist[acc] = { err: errText(x), items: [] }; renderRes(); } });
      }
    }
  });

  /* ================= СТРАНИЦЫ: ЭПИЗОДЫ и ХРОНОЛОГИЯ ================= */
  function playerPage(id, opts) {
    var st = { acc: '', phase: 'idle', d: null, err: '', input: '', ferr: '', f: opts.filters(), token: 0 };
    function go(param) {
      if (!param) { st.phase = 'idle'; st.acc = ''; return; }
      var r = parseAcc(param); if (!r.ok) { st.phase = 'error'; st.err = r.msg; return; }
      st.input = r.acc; load(r.acc, false);
    }
    function load(acc, force) {
      st.acc = acc; st.phase = 'loading'; st.err = ''; var tok = ++st.token;
      loadPlayer(acc, force).then(function (d) { if (tok !== st.token) return; st.d = d; st.phase = 'ready'; renderRes(); }, function (x) { if (tok !== st.token) return; st.phase = 'error'; st.err = errText(x); renderRes(); });
    }
    register(id, {
      label: opts.label, title: opts.title, desc: opts.desc, needsStatus: true,
      go: go,
      form: function () {
        return '<section class="card rp-search"><form data-rpform="' + id + '" novalidate><label for="rp-' + id + '">Steam ID, SteamID64 или ссылка на профиль</label><div class="me-row"><input id="rp-' + id + '" type="text" autocomplete="off" spellcheck="false" value="' + e(st.input) + '" placeholder="7656119…"' + (st.ferr ? ' aria-invalid="true"' : '') + '><button class="btn primary" type="submit">' + ico('search') + 'Показать</button></div>' + (st.ferr ? '<p class="rp-err" role="alert">' + e(st.ferr) + '</p>' : '') + '</form></section>';
      },
      input: function (k, v) { st.input = v; },
      res: function () {
        if (st.phase === 'idle') return '<div class="empty">' + ico('search') + '<b>Выберите игрока</b><p>' + e(opts.empty) + '</p></div>';
        if (st.phase === 'loading') return '<div class="sk-row" aria-busy="true" role="status"><span class="sm">Загружаю данные игрока…</span><div class="skel h1"></div><div class="skel h2"></div></div>';
        if (st.phase === 'error') return '<div class="banner" role="alert">' + ico('alert') + '<div style="flex:1"><b>Не удалось получить данные</b><p class="sm">' + e(st.err) + '</p></div>' + (st.acc ? '<button class="btn sm2" type="button" data-rp="reload">Повторить</button>' : '') + '</div>';
        var d = st.d;
        var head = '<section class="card"><div class="sec-h"><h2>' + e(who(d)) + '</h2><span>' + link('profile/' + d.acc, 'Профиль') + ' <button class="btn sm2" type="button" data-rp="recheck">' + ico('refresh') + 'Проверить заново</button> <button class="btn sm2" type="button" data-rp="copy" data-t="' + e(shareUrl(id, d.acc)) + '">' + ico('copy') + 'Ссылка</button></span></div>' +
          '<p>' + stateBadge(d.rep) + ' ' + confBadge(d.rep.confidence) + ' <span class="sm">Проверено: ' + e(dt(d.fetchedAt)) + ' · матчей в анализе: ' + d.matches.length + '</span></p>' + (d.communityAvailable ? '' : '<p class="sm">Данные сообщества недоступны (сайт открыт без сервера Dota Mate): подтверждённые эпизоды и жалобы не показываются.</p>') + '</section>';
        return head + opts.body(d, st);
      },
      set: function (k, v) { st.f[k] = v; renderRes(); },
      submit: function (f) {
        var r = parseAcc(f.querySelector('input').value);
        if (!r.ok) { st.ferr = r.msg; renderForm(); return; }
        st.ferr = ''; location.hash = pageLink(id, r.acc); if (r.acc === st.acc) load(r.acc, false);
      },
      act: function (name) { if (name === 'recheck') load(st.acc, true); if (name === 'reload') load(st.acc, false); },
      _st: st
    });
    return st;
  }
  function periodFilter(items, days) {
    if (days === 'all') return items;
    var from = now() - Number(days) * 86400;
    return items.filter(function (i) { return (i.start || i.decidedAt || 0) >= from; });
  }
  function selectHtml(key, label, val, opts) { return '<label>' + label + '<select class="sel" data-rpset="' + key + '">' + opts.map(function (o) { return '<option value="' + e(o[0]) + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + e(o[1]) + '</option>'; }).join('') + '</select></label>'; }
  var PERIODS = [['all', 'Всё время'], ['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней']];

  playerPage('episodes', {
    label: 'Эпизоды', title: 'Подозрительные эпизоды', desc: 'Эпизоды разделены по надёжности основания: факты игры, статистические аномалии, жалобы без решения и решения модераторов.',
    empty: 'Введите игрока, чтобы увидеть эпизоды, найденные по его матчам, и решения модераторов.',
    filters: function () { return { cat: 'all', period: 'all' }; },
    body: function (d, st) {
      var f = st.f, sum = d.sum || { confirmed: [], disputed: [], unconfirmed: { hidden: true } };
      var items = periodFilter(d.an.items, f.period);
      var facts = items.filter(function (i) { return i.group === 'fact'; }), anom = items.filter(function (i) { return i.group === 'anomaly'; }), info = items.filter(function (i) { return i.group === 'info'; });
      var conf = periodFilter(sum.confirmed.map(function (m) { return Object.assign({ start: m.decidedAt }, m); }), f.period), disp = periodFilter(sum.disputed.map(function (m) { return Object.assign({ start: m.decidedAt }, m); }), f.period);
      var filters = '<div class="filters me-f">' + selectHtml('cat', 'Категория', f.cat, [['all', 'Все'], ['fact', 'Факты игры'], ['anomaly', 'A · Статистические аномалии'], ['pending', 'B · Жалобы без решения'], ['confirmed', 'C · Подтверждённые'], ['info', 'Справочные отметки']]) + selectHtml('period', 'Период', f.period, PERIODS) + '</div>';
      var show = function (c) { return f.cat === 'all' || f.cat === c; };
      var sec = function (title, note, body) { return '<section class="card"><div class="sec-h"><h2>' + title + '</h2></div><p class="sm rp-note">' + note + '</p>' + body + '</section>'; };
      var empty = function (t) { return '<p class="sm">' + t + '</p>'; };
      var out = filters;
      if (show('confirmed')) out += sec('C · Подтверждено модератором', 'Решения людей с обоснованием. Хранятся отдельно от статистики. Любое решение можно оспорить.', (d.communityAvailable ? (conf.length ? conf.map(function (m) { return markCard(m, d, 'confirmed'); }).join('') : empty('Подтверждённых эпизодов нет.')) + disp.map(function (m) { return markCard(m, d, 'disputed'); }).join('') : empty('Нет данных сообщества.')));
      if (show('pending')) {
        var u = sum.unconfirmed;
        out += sec('B · Подозрения без решения', 'Жалобы сообщества, которые ещё не проверены. Жалоба не доказательство, поэтому здесь только обобщённый счётчик. Тексты жалоб и их авторы не публикуются.',
          !d.communityAvailable ? empty('Нет данных сообщества.') : u && !u.hidden ? '<p>Непроверенных жалоб: <b>' + u.reports + '</b> от ' + u.reporters + ' ' + pl(u.reporters, 'автора', 'авторов', 'авторов') + ' по ' + u.matches + ' ' + pl(u.matches, 'матчу', 'матчам', 'матчам') + '. Это не нарушение до решения модератора.</p>' : empty('Либо жалоб нет, либо их слишком мало для публичного счётчика (нужны два независимых автора и два матча).'));
      }
      if (show('fact')) out += sec('Факты игры', 'Отметки, записанные самой Dota 2. Причина (связь, вылет, решение игрока) в них не указана.', facts.length ? facts.map(function (i) { return episodeCard(i, d); }).join('') : empty('Нет.'));
      if (show('anomaly')) out += sec('A · Статистические аномалии', 'Отклонение от собственных обычных показателей игрока (и от его же показателей на этом герое). Не доказывают умысел: причиной может быть сложная игра, смена роли или сильный соперник.', !d.an.ready ? empty('Мало данных: нужно хотя бы 15 матчей с длительностью и числом смертей, сейчас ' + d.an.baselineN + '. Аномалии не ищутся, чтобы не делать выводов по случайным значениям.') : (anom.length ? anom.map(function (i) { return episodeCard(i, d); }).join('') : empty('Отклонений нет.')) + d.an.patterns.map(function (p) { return '<p class="rp-pattern">' + e(p.text) + '</p>'; }).join(''));
      if (show('info')) out += sec('Справочные отметки', 'Информация для контекста. В репутацию не входит.', info.length ? info.map(function (i) { return episodeCard(i, d); }).join('') : empty('Нет.'));
      return out;
    }
  });

  playerPage('timeline', {
    label: 'Хронология', title: 'Хронология поведения', desc: 'Все отметки игрока по порядку времени: факты, аномалии и решения модераторов. Каждое событие ведёт к матчу или решению.',
    empty: 'Введите игрока, чтобы увидеть хронологию его отметок.',
    filters: function () { return { cat: 'all', period: '90' }; },
    body: function (d, st) {
      var f = st.f, ev = [];
      d.an.items.forEach(function (i) { ev.push({ at: i.start || 0, cat: i.group === 'anomaly' ? 'anomaly' : i.group === 'fact' ? 'fact' : 'info', title: i.title, text: i.facts[0] || '', mid: i.matchId, tag: GROUP_LABEL[i.group] }); });
      var sum = d.sum;
      if (sum) {
        sum.confirmed.forEach(function (m) { ev.push({ at: m.decidedAt, cat: 'confirmed', title: 'Подтверждён модератором: ' + (R.CATEGORIES[m.category] || m.category), text: m.reason, mid: m.matchId, tag: 'C · Решение' }); });
        sum.disputed.forEach(function (m) { ev.push({ at: m.decidedAt, cat: 'confirmed', title: 'Отметка оспаривается: ' + (R.CATEGORIES[m.category] || m.category), text: m.reason, mid: m.matchId, tag: 'Оспаривается' }); });
        (sum.timeline || []).filter(function (t) { return t.type === 'revoked'; }).forEach(function (t) { ev.push({ at: t.at, cat: 'confirmed', title: 'Отметка снята после проверки', text: '', mid: null, tag: 'Исправление' }); });
      }
      var list = ev.filter(function (x) { return (f.cat === 'all' || f.cat === x.cat) && (f.period === 'all' || x.at >= now() - Number(f.period) * 86400); }).sort(function (a, b) { return b.at - a.at; });
      var filters = '<div class="filters me-f">' + selectHtml('cat', 'Категория', f.cat, [['all', 'Все'], ['fact', 'Факты игры'], ['anomaly', 'Аномалии'], ['confirmed', 'Решения модераторов'], ['info', 'Справочные']]) + selectHtml('period', 'Период', f.period, PERIODS) + '</div>';
      if (!list.length) return filters + '<div class="empty">' + ico('list') + '<b>Событий нет</b><p>' + (ev.length ? 'Под выбранные фильтры ничего не подходит.' : 'За загруженные матчи (' + d.matches.length + ') отметок не найдено. Это не гарантия отсутствия нарушений.') + '</p></div>';
      return filters + '<section class="card"><ol class="rp-tl">' + list.map(function (x) { return '<li class="c-' + x.cat + '"><time>' + e(dday(x.at)) + '</time><div><b>' + e(x.title) + '</b> ' + badge(x.cat === 'confirmed' ? 's-bad' : x.cat === 'anomaly' ? 's-warn' : 's-neutral', x.tag) + (x.text ? '<p class="sm">' + e(x.text) + '</p>' : '') + (x.mid ? '<p>' + link('match/' + x.mid, 'Матч ' + e(x.mid)) + '</p>' : '') + '</div></li>'; }).join('') + '</ol></section>';
    }
  });

  /* ================= СТРАНИЦА: PARTY SAFETY ================= */
  var PS = { input: '', err: '', rows: [], phase: 'idle', token: 0 };
  register('party', {
    label: 'Party Safety', title: 'Проверка группы', desc: 'До пяти Steam ID: сводка по каждому игроку. Общего вердикта по группе нет, а частая совместная игра не считается риском.', needsStatus: true,
    form: function () {
      return '<section class="card rp-search"><form data-rpform="party" novalidate><label for="rp-party">Steam ID, SteamID64 или ссылки, до 5 штук (через пробел, запятую или с новой строки)</label><textarea id="rp-party" rows="3" spellcheck="false" placeholder="76561198…, 123456789, …">' + e(PS.input) + '</textarea>' + (PS.err ? '<p class="rp-err" role="alert">' + e(PS.err) + '</p>' : '') + '<div style="margin-top:10px"><button class="btn primary" type="submit"' + (PS.phase === 'loading' ? ' disabled' : '') + '>' + ico('shield') + 'Проверить группу</button></div></form></section>';
    },
    input: function (k, v) { PS.input = v; },
    res: function () {
      if (PS.phase === 'idle') return '<div class="empty">' + ico('users') + '<b>Добавьте игроков группы</b><p>Для каждого будет показан статус репутации, достоверность данных и найденные сигналы. Если данных мало, так и будет написано.</p></div>';
      var done = PS.rows.filter(function (r) { return r.d; }), ins = done.filter(function (r) { return r.d.rep.state === 'insufficient'; }).length;
      var shared = {};
      done.forEach(function (r) { r.d.matches.forEach(function (m) { (shared[m.id] = shared[m.id] || {})[r.acc] = 1; }); });
      var together = Object.keys(shared).filter(function (id) { return Object.keys(shared[id]).length >= 2; }).length;
      var rows = PS.rows.map(function (r) {
        if (r.loading) return '<tr><td class="mono">' + e(r.acc) + '</td><td colspan="5"><span class="sm">Загружаю…</span></td></tr>';
        if (r.err) return '<tr><td class="mono">' + e(r.acc) + '</td><td colspan="4" class="rp-err">' + e(r.err) + '</td><td>' + link('profile/' + r.acc, 'Профиль') + '</td></tr>';
        var d = r.d, rep = d.rep;
        return '<tr><td><b>' + e(who(d)) + '</b><div class="mono sm">' + e(r.acc) + '</div></td><td>' + stateBadge(rep) + '</td><td>' + e(rep.confidence.label) + '</td><td class="num">' + rep.uniqueSignalMatches + '</td><td class="num">' + (d.communityAvailable ? rep.confirmedCount : '<span class="na">—</span>') + '</td><td>' + link('profile/' + r.acc, 'Профиль') + ' <button class="btn sm2 danger" type="button" data-rp="report-to" data-acc="' + e(r.acc) + '">Сообщить</button></td></tr>';
      }).join('');
      var s = '<section class="card"><div class="sec-h"><h2>Игроки группы</h2></div><div class="tbl-scroll"><table class="rp-tbl rp-wide"><thead><tr><th>Игрок</th><th>Статус</th><th>Достоверность</th><th>Матчей с сигналами</th><th>Подтверждено</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
      if (PS.phase === 'ready') {
        s += '<section class="card"><div class="sec-h"><h2>Сводка по группе</h2></div><ul class="rp-notes">' +
          '<li>' + (ins ? 'Недостаточно данных по ' + ins + ' из ' + done.length + ' игроков: по ним оценок нет, и это не значит, что всё хорошо.' : 'Данных достаточно по всем проверенным игрокам.') + '</li>' +
          '<li>Общих матчей среди загруженных историй (минимум у двух участников группы): ' + together + '. Совместная игра друзей это нормально, риском она не считается.</li>' +
          '<li>Dota Mate не выносит вердикт «опасная группа» и не утверждает, что разные аккаунты принадлежат одному человеку.</li>' +
          '<li>Сообщить об игроке можно по каждому отдельно кнопкой в строке; жалоба проверяется модератором так же, как любая другая.</li></ul></section>';
      }
      return s;
    },
    submit: function (f) {
      var raw = f.querySelector('textarea').value; PS.input = raw;
      var parts = raw.split(/[\s,;]+/).filter(Boolean), accs = [], bad = [];
      parts.forEach(function (p) { var r = parseAcc(p); if (!r.ok) bad.push(p); else if (accs.indexOf(r.acc) < 0) accs.push(r.acc); });
      if (!accs.length && !bad.length) { PS.err = 'Введите хотя бы один Steam ID.'; renderForm(); return; }
      if (bad.length) { PS.err = 'Не удалось распознать: ' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? '…' : '') + '.'; renderForm(); return; }
      if (accs.length > 5) { PS.err = 'Можно проверить не больше пяти игроков, указано ' + accs.length + '.'; renderForm(); return; }
      PS.err = ''; PS.phase = 'loading'; PS.rows = accs.map(function (a) { return { acc: a, loading: true }; }); var tok = ++PS.token;
      renderForm(); renderRes();
      (async function () {
        for (var i = 0; i < PS.rows.length; i++) {
          if (tok !== PS.token) return;
          try { PS.rows[i].d = await loadPlayer(PS.rows[i].acc); } catch (x) { PS.rows[i].err = errText(x); }
          PS.rows[i].loading = false; renderRes();
        }
        if (tok === PS.token) { PS.phase = 'ready'; renderForm(); renderRes(); }
      })();
    }
  });

  /* ================= СТРАНИЦА: СЕТЬ СОВМЕСТНОЙ ИГРЫ ================= */
  var N = { acc: '', phase: 'idle', peers: [], err: '', f: { days: '0', min: '3', top: '20' }, input: '', ferr: '', sel: null, shared: {}, token: 0, name: '' };
  function netGo(param) {
    if (!param) { N.phase = 'idle'; N.acc = ''; return; }
    var r = parseAcc(param); if (!r.ok) { N.phase = 'error'; N.err = r.msg; return; }
    N.input = r.acc; netLoad(r.acc);
  }
  function netLoad(acc) {
    N.acc = acc; N.phase = 'loading'; N.sel = null; N.shared = {}; var tok = ++N.token;
    api().getPeers(acc, Number(N.f.days)).then(function (l) { if (tok !== N.token) return; N.peers = l.filter(function (p) { return p && p.account_id != null; }); N.phase = 'ready'; renderRes(); }, function (x) { if (tok !== N.token) return; N.phase = 'error'; N.err = errText(x); renderRes(); });
    api().getPlayer(acc).then(function (p) { if (tok === N.token) { N.name = (p && p.profile && p.profile.personaname) || ''; renderRes(); } }).catch(function () { });
  }
  function graphSvg(list, center) {
    var W = 560, Hh = 420, cx = W / 2, cy = Hh / 2, rad = 160, max = Math.max.apply(null, list.map(function (p) { return p.with_games; }));
    var edges = '', nodes = '';
    list.forEach(function (p, i) {
      var ang = -Math.PI / 2 + 2 * Math.PI * i / list.length, x = cx + rad * Math.cos(ang), y = cy + rad * Math.sin(ang);
      var w = 1 + 5 * p.with_games / max, r = 7 + 11 * Math.sqrt(p.with_games / max);
      var tip = (p.personaname || 'Игрок ' + p.account_id) + ': ' + p.with_games + ' ' + pl(p.with_games, 'матч', 'матча', 'матчей') + ' вместе';
      edges += '<line x1="' + cx + '" y1="' + cy + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#5a6372" stroke-width="' + w.toFixed(1) + '" opacity=".7"/>';
      var lx = x + (Math.cos(ang) >= 0 ? r + 4 : -r - 4), anchor = Math.cos(ang) >= 0 ? 'start' : 'end';
      nodes += '<g class="rp-node" data-rp="peer" data-acc="' + e(p.account_id) + '" tabindex="0" role="button" aria-label="' + e(tip) + '"><title>' + e(tip) + '</title><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + (N.sel === String(p.account_id) ? '#d95c63' : '#4a93c6') + '" stroke="#13151a" stroke-width="2"/>' +
        '<text x="' + lx.toFixed(1) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="' + anchor + '" font-size="11" fill="#aeb4bf">' + e(String(p.personaname || p.account_id).slice(0, 14)) + '</text></g>';
    });
    return '<svg class="rp-graph" viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="Граф совместной игры: центр — выбранный игрок, вокруг — партнёры по числу общих матчей">' + edges +
      '<circle cx="' + cx + '" cy="' + cy + '" r="24" fill="#d95c63" stroke="#13151a" stroke-width="2"/><text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="11" fill="#fff">' + e(String(center).slice(0, 8)) + '</text>' + nodes + '</svg>';
  }
  register('network', {
    label: 'Сеть', title: 'Сеть совместной игры', desc: 'С кем игрок чаще всего играет вместе. Это справочная карта связей; частая совместная игра обычна для друзей и постоянных групп и сама ничего не доказывает.',
    go: netGo,
    form: function () {
      return '<section class="card rp-search"><form data-rpform="network" novalidate><label for="rp-net">Steam ID, SteamID64 или ссылка на профиль</label><div class="me-row"><input id="rp-net" type="text" autocomplete="off" spellcheck="false" value="' + e(N.input) + '" placeholder="7656119…"' + (N.ferr ? ' aria-invalid="true"' : '') + '><button class="btn primary" type="submit">' + ico('search') + 'Построить</button></div>' + (N.ferr ? '<p class="rp-err" role="alert">' + e(N.ferr) + '</p>' : '') + '</form></section>';
    },
    input: function (k, v) { N.input = v; },
    set: function (k, v) { N.f[k] = v; if (k === 'days' && N.acc) netLoad(N.acc); else renderRes(); },
    res: function () {
      if (N.phase === 'idle') return '<div class="empty">' + ico('users') + '<b>Введите игрока</b><p>Покажем партнёров, с которыми он сыграл больше всего матчей, и дадим ссылки на общие матчи.</p></div>';
      if (N.phase === 'loading') return '<div class="sk-row" aria-busy="true" role="status"><span class="sm">Загружаю партнёров…</span><div class="skel h1"></div></div>';
      if (N.phase === 'error') return '<div class="banner" role="alert">' + ico('alert') + '<div style="flex:1"><b>Не удалось получить данные</b><p class="sm">' + e(N.err) + '</p></div></div>';
      var min = Number(N.f.min), top = Number(N.f.top);
      var list = N.peers.filter(function (p) { return p.with_games >= min && String(p.account_id) !== N.acc; }).sort(function (a, b) { return b.with_games - a.with_games; }).slice(0, top);
      var filters = '<div class="filters me-f">' + selectHtml('days', 'Период', N.f.days, [['0', 'Всё время'], ['30', '30 дней'], ['90', '90 дней'], ['180', '180 дней'], ['365', 'Год']]) + selectHtml('min', 'Минимум общих матчей', N.f.min, [['1', '1'], ['2', '2'], ['3', '3'], ['5', '5'], ['10', '10'], ['20', '20']]) + selectHtml('top', 'Показать', N.f.top, [['10', '10'], ['20', '20'], ['30', '30']]) + '</div>';
      var head = '<section class="card"><div class="sec-h"><h2>' + e(N.name || ('Игрок ' + N.acc)) + '</h2><span>' + link('profile/' + N.acc, 'Профиль') + ' <button class="btn sm2" type="button" data-rp="copy" data-t="' + e(shareUrl('network', N.acc)) + '">' + ico('copy') + 'Ссылка</button></span></div><p class="sm">Источник: OpenDota (партнёры по матчам). Связи между другими игроками не запрашиваются, поэтому граф показывает только связи выбранного игрока. Период ограничивает матчи по давности.</p></section>';
      if (!list.length) return filters + head + '<div class="empty">' + ico('users') + '<b>Связей не найдено</b><p>' + (N.peers.length ? 'Под выбранные фильтры (минимум ' + min + ' общих матчей) партнёров нет. Уменьшите порог или расширьте период.' : 'OpenDota не вернул партнёров. Возможно, история игрока закрыта или игрок почти не играл в группе.') + '</p></div>';
      var sel = N.sel && list.filter(function (p) { return String(p.account_id) === N.sel; })[0], sh = sel && N.shared[N.sel];
      var detail = sel ? '<section class="card"><div class="sec-h"><h2>' + e(sel.personaname || 'Игрок ' + sel.account_id) + '</h2><span>' + link('profile/' + sel.account_id, 'Профиль') + ' ' + link('episodes/' + sel.account_id, 'Эпизоды') + '</span></div><p>Вместе в одной команде: <b>' + sel.with_games + '</b> ' + pl(sel.with_games, 'матч', 'матча', 'матчей') + (sel.with_games ? ', побед ' + Math.round(100 * sel.with_win / sel.with_games) + '%' : '') + '. Друг против друга: ' + (sel.against_games || 0) + '. Последний общий матч: ' + e(dday(sel.last_played)) + '.</p>' +
        '<div style="margin:8px 0"><button class="btn sm2" type="button" data-rp="shared" data-acc="' + e(sel.account_id) + '">Показать общие матчи</button></div>' +
        (sh === 'loading' ? '<p class="sm">Загружаю…</p>' : sh && sh.err ? '<p class="rp-err">' + e(sh.err) + '</p>' : sh ? '<div class="rp-list">' + sh.list.map(function (m) { return '<a class="chip" href="#/match/' + e(m.match_id) + '" data-rp-link="1">' + e(dday(m.start_time)) + ' · матч ' + e(m.match_id) + '</a>'; }).join('') + '</div>' : '') +
        '<p class="sm">Связь показывает только факт совместной игры. Выводов о сговоре или о том, что аккаунты принадлежат одному человеку, система не делает.</p></section>' : '';
      var table = '<section class="card"><div class="sec-h"><h2>Партнёры <small>' + list.length + '</small></h2></div><div class="tbl-scroll"><table class="rp-tbl rp-wide"><thead><tr><th>Игрок</th><th>Вместе</th><th>Побед вместе</th><th>Против</th><th>Последний раз</th></tr></thead><tbody>' + list.map(function (p) {
        return '<tr><td><button class="rp-lnk" type="button" data-rp="peer" data-acc="' + e(p.account_id) + '">' + e(p.personaname || 'Игрок ' + p.account_id) + '</button></td><td class="num">' + p.with_games + '</td><td class="num">' + (p.with_games ? Math.round(100 * p.with_win / p.with_games) + '%' : '—') + '</td><td class="num">' + (p.against_games || 0) + '</td><td>' + e(dday(p.last_played)) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
      return filters + head + '<section class="card">' + graphSvg(list, N.acc) + '</section>' + detail + table;
    },
    submit: function (f) {
      var r = parseAcc(f.querySelector('input').value);
      if (!r.ok) { N.ferr = r.msg; renderForm(); return; }
      N.ferr = ''; location.hash = pageLink('network', r.acc); if (r.acc === N.acc) netLoad(r.acc);
    },
    act: function (name, t) {
      if (name === 'peer') { N.sel = t.dataset.acc; renderRes(); }
      if (name === 'shared') {
        var other = t.dataset.acc, tok = N.token; N.shared[other] = 'loading'; renderRes();
        api().getSharedMatches(N.acc, other, 20).then(function (l) { if (tok !== N.token) return; N.shared[other] = { list: l.filter(function (m) { return m && m.match_id; }) }; renderRes(); }, function (x) { if (tok !== N.token) return; N.shared[other] = { err: errText(x), list: [] }; renderRes(); });
      }
    }
  });
  document.addEventListener('keydown', function (ev) { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList && ev.target.classList.contains('rp-node')) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); } });

  /* ================= СТРАНИЦА: ПУБЛИЧНЫЙ ОТЧЁТ ================= */
  var PR = { acc: '', phase: 'idle', d: null, err: '', token: 0 };
  register('report', {
    label: 'Отчёт', title: 'Публичный отчёт об игроке', desc: 'Страница, которой можно поделиться по ссылке. Каждый раз строится заново из актуальных данных, поэтому снятые отметки сразу пропадают.', needsStatus: true,
    go: function (param) {
      if (!param) { PR.phase = 'idle'; return; }
      var r = parseAcc(param); if (!r.ok) { PR.phase = 'error'; PR.err = r.msg; return; }
      PR.acc = r.acc; PR.phase = 'loading'; var tok = ++PR.token;
      loadPlayer(r.acc).then(function (d) { if (tok === PR.token) { PR.d = d; PR.phase = 'ready'; renderRes(); } }, function (x) { if (tok === PR.token) { PR.phase = 'error'; PR.err = errText(x); renderRes(); } });
    },
    res: function () {
      if (PR.phase === 'idle') return '<div class="empty">' + ico('ext') + '<b>Откройте профиль игрока</b><p>На странице профиля есть ссылка «Публичный отчёт».</p></div>';
      if (PR.phase === 'loading') return '<div class="sk-row" aria-busy="true"><span class="sm">Формирую отчёт…</span><div class="skel h1"></div></div>';
      if (PR.phase === 'error') return '<div class="banner" role="alert">' + ico('alert') + '<div style="flex:1"><b>Отчёт не сформирован</b><p class="sm">' + e(PR.err) + '</p></div></div>';
      var d = PR.d, rep = d.rep, sum = d.sum;
      var marks = sum ? sum.confirmed.map(function (m) { return markCard(m, d, 'confirmed'); }).join('') + sum.disputed.map(function (m) { return markCard(m, d, 'disputed'); }).join('') : '';
      return '<article class="card rp-report"><div class="sec-h"><h2>' + e(who(d)) + ' <small>Steam ID ' + e(d.acc) + '</small></h2><span><button class="btn sm2" type="button" data-rp="copy" data-t="' + e(shareUrl('report', d.acc)) + '">' + ico('copy') + 'Скопировать ссылку</button> <button class="btn sm2" type="button" data-rp="print">Печать</button></span></div>' +
        '<p class="sm">Отчёт сформирован: <b>' + e(dt(d.fetchedAt)) + '</b>. Проанализировано матчей: ' + d.matches.length + '.</p>' +
        '<p>' + stateBadge(rep) + ' ' + confBadge(rep.confidence) + '</p><p class="rp-hint">' + e(STATE_HINT[rep.state]) + '</p>' +
        '<div class="rp-grid">' + kv('Матчей с сигналами', String(rep.uniqueSignalMatches)) + kv('Подтверждено модератором', d.communityAvailable ? String(rep.confirmedCount) : '<span class="na">нет данных</span>') + kv('Уровень риска', rep.risk ? e(rep.risk) : '<span class="na">не оценивается</span>') + '</div>' +
        '<h3 style="margin-top:14px">Подтверждённые решения</h3>' + (marks || '<p class="sm">' + (d.communityAvailable ? 'Нет.' : 'Данные сообщества недоступны.') + '</p>') +
        '<h3 style="margin-top:14px">Источники</h3><ul class="rp-notes"><li>Статистика матчей: OpenDota (публичные данные игрока, Steam ID ' + e(d.acc) + ').</li><li>Решения: модераторы Dota Mate, только подтверждённые эпизоды с обоснованием; тексты и авторы жалоб не публикуются.</li></ul>' +
        '<h3 style="margin-top:14px">Методика</h3><p class="sm">Сигналы делятся на факты игры, отклонения от собственных показателей игрока и решения модераторов. Поражения, низкий K/D/A и число жалоб от одного автора баллов не дают. Оценка недоступна при выборке меньше 20 матчей. Подробности: на странице профиля, блок «Почему сформирована эта оценка?».</p>' +
        '<h3 style="margin-top:14px">Ограничения</h3><ul class="rp-notes"><li>OpenDota не отдаёт данные о предметах, сломанных союзникам, блокировках и кормлении как действии, поэтому система не может определять такие нарушения сама.</li><li>Отсутствие сигналов не гарантирует отсутствие нарушений.</li><li>Скрытые профили и закрытые матчи в анализ не попадают.</li><li>Отметку можно оспорить; исправленные отметки исчезают из отчёта при следующем открытии.</li></ul></article>';
    },
    act: function (name) { if (name === 'print') window.print(); }
  });

  window.DMRepUI = {
    init: function (host) { H = host; C.init({ server: host.server }); },
    view: function () { return '<div id="rp-root" class="pf"></div>'; },
    mount: mount, nav: nav, register: register, ctx: ctx,
    profileCard: profileCard,
    /** {matchId: 'confirmed'|'disputed'} по публичным решениям модераторов для игрока (из кэша карточки репутации). */
    marks: function (acc) {
      var c = S.cache['pc:' + acc], out = {};
      if (c && c.sum) { (c.sum.confirmed || []).forEach(function (m) { out[m.matchId] = 'confirmed'; }); (c.sum.disputed || []).forEach(function (m) { out[m.matchId] = 'disputed'; }); }
      return out;
    },
    hash: function () { return pageLink(S.tab, S.param); },
    resetStatus: function () { S.srv = null; S.user = null; S.mod = false; },
    isTab: function (t) { return !!S.pages[t]; },
    _state: S
  };
})();
