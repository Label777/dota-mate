/*
 * Dota Mate: главная-дашборд.
 * Только реальные данные: матчи и оценки из вашей истории, результаты расчётов репутации и автооценки, сохранённые в браузере.
 * Если данных нет, блок честно говорит об этом и предлагает действие. Ничего не рисуется «для красоты».
 * Хозяин (index.html) передаёт функции в init(H).
 */
(function () {
  'use strict';
  var H = null, K = window.DMKit;
  var X = { sort: 'risk', dir: -1, filter: 'all', page: 1, q: '', size: 8 };
  var PAGE_SIZES = 8;

  var esc = function (s) { return K.esc(s); };
  var ico = function (n) { return K.ico(n); };
  var S = function () { return H.S(); };

  /* ---------- данные ---------- */
  var WEIGHT = { confirmed: 5, needs_review: 4, stale: 2, insufficient: 1, no_signals: 0 };
  var STATE_LABEL = { confirmed: 'Подтверждено', needs_review: 'Проверить', no_signals: 'Нет сигналов', insufficient: 'Мало данных', stale: 'Давно не играл' };
  var STATE_TONE = { confirmed: 'bad', needs_review: 'warn', no_signals: 'ok', insufficient: 'neutral', stale: 'neutral' };

  function repOf(sid) { var q = window.DMRepChip && DMRepChip.state(); var r = q && q.m[sid]; return r && !r.e ? r : null; }
  function riskW(sid) { var r = repOf(sid); return r ? (WEIGHT[r.s] != null ? WEIGHT[r.s] : 0) : -1; }
  function flagged(sid) { var r = repOf(sid); return !!r && (r.s === 'needs_review' || r.s === 'confirmed'); }
  function avgStars(list) { var v = list.filter(function (x) { return x != null; }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; }

  /** Оценка по игре для вас самого по каждому матчу (от старых к новым). */
  function myForm(ms) {
    if (!window.DMPerfUI) return [];
    return ms.slice(0, 40).reverse().map(function (m) {
      var p = m.players.find(function (x) { return x.me; });
      if (!p) return { m: m, v: null };
      var f = null; try { f = DMPerfUI.forPlayer(m, p); } catch (e) { f = null; }
      return { m: m, v: f && f.s && f.s.stars != null ? f.s.stars : null };
    });
  }

  function rolling(ms, win) {
    var asc = ms.slice(0, 60).reverse(), out = [];
    for (var i = 0; i < asc.length; i++) {
      if (i < win - 1) { out.push(null); continue; }
      var w = asc.slice(i - win + 1, i + 1).filter(function (m) { return m.win; }).length;
      out.push(Math.round(w / win * 100));
    }
    return { asc: asc, v: out };
  }

  /* ---------- блоки ---------- */
  function headerHtml(ms, total) {
    var loading = H.loading(), m = ms[0];
    var note = !m ? 'Добавьте первый матч или синхронизируйте историю: здесь появятся метрики, динамика и знакомые игроки.' :
      'Последний матч: ' + (m.win ? 'победа' : 'поражение') + ' на ' + m.hero + ', ' + H.ago(m.start) + (total ? '. Знакомых игроков: ' + total + '.' : '.');
    return '<div class="pagehead"><div><h1>Обзор</h1><p>' + esc(note) + '</p></div><div class="actions">' +
      '<button class="btn primary" data-a="sync"' + (loading ? ' disabled' : '') + '>' + ico('refresh') + 'Синхронизировать</button>' +
      '<button class="btn" data-a="add">' + ico('plus') + 'Добавить матч</button>' +
      (window.DMSocialUI && ms.length && !S().demo ? '<button class="btn" data-a="s-rateall" data-mid="' + esc(ms[0].id) + '">' + ico('star') + 'Оценить игроков</button>' : '') +
      '</div></div><div class="dh-status">' + H.syncStatus() + (window.DMPerfUI ? DMPerfUI.statusBox() : '') + '</div>';
  }

  function searchHtml() {
    var mine = H.myAcc(), chips = '';
    if (mine) chips += '<button type="button" class="chip" data-a="myProfile" data-tip="Открыть мой профиль: статистика, герои и динамика">' + ico('user') + ' Мой профиль</button>';
    var rec = window.DMProfile && DMProfile.recent ? DMProfile.recent() : [];
    rec.filter(function (x) { return x.acc !== mine; }).slice(0, 4).forEach(function (x) {
      chips += '<button type="button" class="chip" data-a="openProfile" data-id="' + esc(x.acc) + '" data-tip="Открыть профиль: Steam ID ' + esc(x.acc) + '">' + esc(x.name || x.acc) + '</button>';
    });
    return '<section class="kp dsr" aria-label="Поиск игрока"><form id="d-search" class="dsr-f" role="search" novalidate>' +
      '<label class="sr-only" for="d-q">Поиск игрока</label>' +
      '<div class="dsr-in">' + ico('search') + '<input id="d-q" type="text" autocomplete="off" spellcheck="false" placeholder="Ник или Steam ID" data-tip="Введите ник (покажу варианты), Steam ID или ссылку на профиль" aria-describedby="d-hint" aria-controls="d-sug"><button class="btn primary" type="submit">Найти</button></div>' +
      '<div id="d-sug" class="dsr-sug" hidden></div>' +
      '<p id="d-hint" class="sm dsr-hint">Среди ваших знакомых ищется сразу. Ник, Steam ID и ссылка открывают профиль по данным OpenDota: ник даёт варианты, Steam ID точнее.</p>' +
      (chips ? '<div class="dsr-chips"><span class="sm">Быстро:</span>' + chips + '</div>' : '') + '</form></section>';
  }

  function metricsHtml(ms, list) {
    var recent = ms.slice(0, 20), w = recent.filter(function (m) { return m.win; }).length, wr = recent.length ? Math.round(w / recent.length * 100) : null;
    var total = list.length, unrated = list.filter(function (e) { return !e.rated; }).length;
    var form = myForm(ms), fv = avgStars(form.map(function (x) { return x.v; })), fn = form.filter(function (x) { return x.v != null; }).length;
    var q = window.DMRepChip ? DMRepChip.state() : null;
    var checked = 0, flag = 0, conf = 0;
    list.forEach(function (e) { var r = repOf(e.sid); if (r) { checked++; if (r.s === 'needs_review' || r.s === 'confirmed') flag++; if (r.s === 'confirmed') conf++; } });
    var repVal = checked ? String(flag) : '—';
    var repSub = checked ? 'из ' + checked + ' проверенных' + (conf ? ', подтверждено: ' + conf : '') : (q && q.auto ? 'проверка идёт в фоне' : 'проверка выключена');
    var repTone = conf ? 'bad' : flag ? 'warn' : checked ? 'ok' : 'neutral';
    var last = ms[0];
    return '<div class="kms" role="list" aria-label="Ключевые показатели">' + [
      K.metric({ label: 'Матчей в истории', value: String(ms.length), sub: ms.length ? 'с ' + H.fday(ms[ms.length - 1].start) : 'пока пусто', tip: 'Сколько матчей сохранено в вашей истории на этом сайте.' }),
      K.metric({ label: 'Винрейт, последние ' + (recent.length || 20), value: wr == null ? '—' : wr + '%', sub: recent.length ? w + ' побед, ' + (recent.length - w) + ' поражений' : 'нет матчей', tone: wr != null && wr >= 55 ? 'ok' : 'neutral', tip: 'Доля побед в последних 20 матчах вашей истории. Небольшая выборка: колебания в пределах нескольких матчей нормальны.' }),
      K.metric({ label: 'Знакомые игроки', value: String(total), sub: total ? unrated + ' без оценки' : 'появятся после матчей', tip: 'Игроки, с которыми вы играли вместе или друг против друга и чей Steam ID виден.' }),
      K.metric({ label: 'Моя оценка по игре', value: fv == null ? '—' : fv.toFixed(1) + ' / 5', sub: fv == null ? 'нужен анализ матчей' : 'по ' + fn + ' ' + H.pl(fn, 'матчу', 'матчам', 'матчам'), tone: 'accent', tip: 'Среднее по вашей автооценке: считается по цифрам матча (золото, опыт, убийства, урон, участие). Поведение и общение не оценивает.' }),
      K.metric({ label: 'Отмечено репутацией', value: repVal, sub: repSub, tone: repTone, tip: 'Сколько знакомых игроков получили метку «Проверить» или «Подтверждено» в расчёте репутации. Это повод посмотреть матчи, а не вывод о нарушении.' }),
      K.metric({ label: 'Свежесть данных', value: last ? H.ago(last.start) : '—', sub: S().lastSync ? 'синхронизация: ' + H.ago(S().lastSync) : 'синхронизации не было', tip: 'Когда сыгран последний сохранённый матч и когда вы последний раз синхронизировались с OpenDota.' })
    ].join('') + '</div>';
  }

  function trendHtml(ms) {
    if (!ms.length) return K.empty({ icon: 'list', title: 'Здесь появится динамика', text: 'Добавьте матч по ссылке или синхронизируйте историю с OpenDota.', actionHtml: '<button class="btn primary" data-a="sync">' + ico('refresh') + 'Синхронизировать</button><button class="btn" data-a="add">' + ico('plus') + 'Добавить матч</button>' });
    var strip = ms.slice(0, 30).reverse().map(function (m) { return { win: m.win, tip: (m.win ? 'Победа' : 'Поражение') + ' · ' + m.hero + ' · ' + H.fd(m.start) }; });
    var wins = strip.filter(function (x) { return x.win; }).length;
    var r = rolling(ms, 10), hasR = ms.length >= 12;
    var rChart = hasR ? K.spark(r.v, { min: 0, max: 100, ref: 50, fmt: function (v) { return Math.round(v) + '%'; }, aria: 'Винрейт по скользящему окну из 10 матчей', label: function (i, v) { var m = r.asc[i]; return 'Винрейт ' + v + '% за 10 матчей до ' + H.fd(m.start); } }) : '';
    var form = myForm(ms), fv = form.map(function (x) { return x.v; }), fn = fv.filter(function (v) { return v != null; }).length;
    var fChart = fn >= 3 ? K.spark(fv, { min: 1, max: 5, ref: 3, fmt: function (v) { return (Math.round(v * 10) / 10).toFixed(1); }, aria: 'Моя оценка по игре в каждом матче', label: function (i, v) { var x = form[i]; return 'Оценка по игре ' + v.toFixed(1) + ' / 5 · ' + x.m.hero + ' · ' + H.fd(x.m.start); } }) : '';
    var fEmpty = '<p class="sm dtr-none">' + (window.DMPerfUI ? 'Появится после анализа матчей: сайт загружает подробности из OpenDota и оценивает игру по цифрам.' : 'Недоступно.') + '</p>' +
      (window.DMPerfUI ? '<div class="actions"><button class="btn sm2" data-a="pf-scan">Проанализировать матчи</button></div>' : '');
    return '<div class="dtr">' +
      '<div class="kc"><div class="kc-h"><b>Результаты</b><span>последние ' + strip.length + ': ' + wins + ' побед</span></div>' + K.resultStrip(strip, 'Результаты последних ' + strip.length + ' матчей: ' + wins + ' побед, ' + (strip.length - wins) + ' поражений') +
      '<div class="kc-x"><span>старые</span><span>новые</span></div></div>' +
      '<div class="kc"><div class="kc-h"><b>Винрейт, окно 10 матчей</b><span>' + (hasR ? 'пунктир: 50%' : 'нужно хотя бы 12 матчей') + '</span></div>' + (rChart || '<p class="sm dtr-none">Динамика появится, когда в истории будет хотя бы 12 матчей.</p>') + '</div>' +
      '<div class="kc"><div class="kc-h"><b>Моя оценка по игре</b><span>' + (fChart ? '1–5, пунктир: 3' : 'пока нет данных') + '</span></div>' + (fChart || fEmpty) + '</div></div>';
  }

  function riskHtml(list) {
    var cnt = { confirmed: 0, needs_review: 0, no_signals: 0, insufficient: 0, stale: 0, none: 0 };
    list.forEach(function (e) { var r = repOf(e.sid); cnt[r ? r.s : 'none']++; });
    var items = [
      { label: 'Подтверждено модератором', n: cnt.confirmed, tone: 'bad', tip: 'Есть эпизоды, подтверждённые модератором Dota Mate с обоснованием (нужен сервер).' },
      { label: 'Проверить', n: cnt.needs_review, tone: 'warn', tip: 'Повторяющиеся отклонения или много выходов из игры. Повод посмотреть матчи, не вывод о нарушении.' },
      { label: 'Нет сигналов', n: cnt.no_signals, tone: 'ok', tip: 'Статистических сигналов не найдено. Это не гарантия.' },
      { label: 'Мало данных', n: cnt.insufficient, tone: 'neutral', tip: 'Открытых матчей меньше 20: оценки нет, это не плохо и не хорошо.' },
      { label: 'Давно не играл', n: cnt.stale, tone: 'neutral', tip: 'Последний открытый матч старше 90 дней.' },
      { label: 'Ещё не проверено', n: cnt.none, tone: 'neutral', tip: 'Значок репутации считается в фоне для игроков на экране.' }
    ];
    var body = K.distribution(items, { label: 'Распределение знакомых игроков по сводке репутации', emptyTitle: 'Знакомых игроков пока нет', emptyText: 'Сводка появится после первых матчей.' });
    if (list.length) body += '<p class="sm dr-note">Сводка по открытой статистике OpenDota и решениям модераторов. Метка не доказывает намерение и не заменяет проверку матчей.</p>';
    return K.panel({ title: 'Риск-сводка знакомых', meta: list.length ? list.length + ' ' + H.pl(list.length, 'игрок', 'игрока', 'игроков') : '', actionHtml: '<button class="btn ghost sm2" data-a="go" data-p="rep">Репутация</button>', bodyHtml: body, cls: 'dr-risk' });
  }

  /* ---------- таблица игроков ---------- */
  var COLS = [['name', 'Игрок'], ['risk', 'Репутация'], ['auto', 'Оценка по игре'], ['rating', 'Моя оценка'], ['count', 'Встречи'], ['recent', 'Последний раз']];
  var SORT_TIP = { name: 'по имени', risk: 'по степени риска: сначала подтверждённые и «Проверить»', auto: 'по автооценке игры', rating: 'по вашей оценке', count: 'по числу встреч', recent: 'по дате последней встречи' };
  var FILTERS = [['all', 'Все'], ['flag', 'Отмеченные'], ['unrated', 'Без оценки'], ['ally', 'Союзники'], ['enemy', 'Соперники']];

  function rows(list) {
    var q = X.q.trim().toLowerCase(), l = list.slice();
    if (q) l = l.filter(function (e) {
      var tags = window.DMSocialUI ? (DMSocialUI.tagNames ? DMSocialUI.tagNames(e.sid) : '') : '';
      return e.name.toLowerCase().indexOf(q) >= 0 || e.sid.indexOf(q) >= 0 || String(tags).toLowerCase().indexOf(q) >= 0;
    });
    if (X.filter === 'flag') l = l.filter(function (e) { return flagged(e.sid); });
    else if (X.filter === 'unrated') l = l.filter(function (e) { return !e.rated; });
    else if (X.filter === 'ally') l = l.filter(function (e) { return e.withN > 0; });
    else if (X.filter === 'enemy') l = l.filter(function (e) { return e.vsN > 0; });
    var d = X.dir, k = X.sort;
    l.sort(function (a, b) {
      var r;
      if (k === 'name') r = a.name.localeCompare(b.name, 'ru');
      else if (k === 'risk') r = riskW(a.sid) - riskW(b.sid);
      else if (k === 'auto') r = ((a.auto && a.auto.score) || -1) - ((b.auto && b.auto.score) || -1);
      else if (k === 'rating') r = (a.avg || 0) - (b.avg || 0);
      else if (k === 'count') r = a.count - b.count;
      else r = a.last - b.last;
      return (r || (b.last - a.last)) * (k === 'name' ? -d : d);
    });
    return l;
  }

  function tableHtml(list) {
    var all = list, l = rows(all);
    var pages = Math.max(1, Math.ceil(l.length / PAGE_SIZES));
    if (X.page > pages) X.page = pages;
    var slice = l.slice((X.page - 1) * PAGE_SIZES, X.page * PAGE_SIZES);
    if (!all.length) return K.empty({ icon: 'users', title: 'Здесь появятся игроки', text: 'После первого матча вы увидите, с кем играли, и сможете оценить их игру и репутацию.', actionHtml: '<button class="btn primary" data-a="add">' + ico('plus') + 'Добавить матч</button>' });
    var head = COLS.map(function (c) {
      var on = X.sort === c[0], dir = on ? (X.dir > 0 ? 'ascending' : 'descending') : 'none';
      var arrow = on ? (X.dir > 0 ? ' ↑' : ' ↓') : '';
      return '<th scope="col" aria-sort="' + dir + '" class="dt-' + c[0] + '"><button type="button" class="dt-sort' + (on ? ' on' : '') + '" data-a="d-sort" data-k="' + c[0] + '" data-tip="Сортировать ' + esc(SORT_TIP[c[0]]) + '">' + esc(c[1]) + arrow + '</button></th>';
    }).join('') + '<th scope="col" class="dt-act"><span class="sr-only">Действия</span></th>';
    var body = slice.length ? slice.map(rowHtml).join('') : '<tr><td colspan="7" class="dt-none">' + K.empty({ icon: 'search', title: 'Никого не найдено', text: 'Измените запрос или фильтр.', actionHtml: '<button class="btn sm2" data-a="d-reset">Сбросить</button>' }) + '</td></tr>';
    return '<div class="dt-wrap"><table class="dt"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      K.pager({ total: l.length, size: PAGE_SIZES, page: X.page, prev: 'd-prev', next: 'd-next' });
  }

  function rowHtml(e) {
    var tags = window.DMSocialUI && DMSocialUI.tagChips ? DMSocialUI.tagChips(e.sid) : '';
    var rep = window.DMRepChip ? DMRepChip.chip(e.sid) : '';
    var auto = window.DMPerfUI ? DMPerfUI.badge(e) : '';
    var meet = [e.withN ? 'вместе ' + e.withN + H.rec(e, 'ally') : '', e.vsN ? 'против ' + e.vsN + H.rec(e, 'enemy') : ''].filter(Boolean).join(' · ');
    return '<tr><td class="dt-name" data-l="Игрок"><div class="dt-who">' + H.av(e.name, 'md', e.sid) + '<div class="dt-nm"><button type="button" class="linkbtn" data-a="openPlayer" data-id="' + esc(e.sid) + '">' + esc(e.name) + '</button>' + tags + '</div></div></td>' +
      '<td data-l="Репутация">' + rep + '</td>' +
      '<td data-l="Оценка по игре">' + (auto || '<span class="sm">—</span>') + '</td>' +
      '<td data-l="Моя оценка">' + (e.avg != null ? '<span class="avg">' + H.stars(e.avg) + e.avg.toFixed(1) + '</span>' : '<span class="sm">без оценки</span>') + '</td>' +
      '<td data-l="Встречи"><span class="dt-meet">' + esc(meet) + '</span></td>' +
      '<td data-l="Последний раз">' + esc(H.ago(e.last)) + '</td>' +
      '<td class="dt-act">' + (/^\d+$/.test(e.sid) ? '<button class="btn sm2" data-a="openProfile" data-id="' + esc(e.sid) + '" data-tip="Полный профиль игрока: герои, динамика, позиции (данные OpenDota)" aria-label="Открыть профиль игрока ' + esc(e.name) + '">' + ico('user') + 'Профиль</button>' : '<span class="sm" data-tip="Без Steam ID профиль найти нельзя">нет ID</span>') + '</td></tr>';
  }

  function playersPanel(list) {
    var filt = '<div class="dt-filters" role="group" aria-label="Фильтр игроков">' + FILTERS.map(function (f) {
      return '<button type="button" class="dt-f' + (X.filter === f[0] ? ' on' : '') + '" data-a="d-filter" data-v="' + f[0] + '" data-tip="Показать в таблице: ' + esc(f[1].toLowerCase()) + '" aria-pressed="' + (X.filter === f[0]) + '">' + f[1] + '</button>';
    }).join('') + '</div>' +
      '<div class="searchbox dt-q">' + ico('search') + '<input id="d-tq" type="text" autocomplete="off" placeholder="Фильтр по нику, ID или тегу" data-tip="Фильтрует таблицу по нику, Steam ID или тегу" aria-label="Фильтр таблицы игроков" value="' + esc(X.q) + '"></div>';
    var body = H.loading() ? K.skeleton(4, 52) : '<div id="d-tbl">' + tableHtml(list) + '</div>';
    return K.panel({ title: 'Игроки', meta: list.length ? 'отмеченные и недавние' : '', actionHtml: '<button class="btn ghost sm2" data-a="go" data-p="players">Все игроки</button>', bodyHtml: (list.length ? '<div class="dt-bar">' + filt + '</div>' : '') + body, cls: 'dt-panel', });
  }

  /* ---------- активность и быстрый доступ ---------- */
  function activity(ms, list) {
    var ev = [];
    ms.slice(0, 8).forEach(function (m) { ev.push({ t: m.start, ic: 'list', html: (m.win ? 'Победа' : 'Поражение') + ' на ' + esc(m.hero) + ' · ' + esc(m.mode), a: '<button class="linkbtn" data-a="openMatch" data-id="' + esc(m.id) + '">Открыть</button>', tone: m.win ? 'ok' : 'bad' }); });
    var names = {}; list.forEach(function (e) { names[e.sid] = e.name; });
    Object.keys(S().reviews || {}).forEach(function (k) {
      var r = S().reviews[k]; if (!r || !r.ts) return;
      var sid = k.split('|')[1], nm = names[sid] || sid;
      ev.push({ t: r.ts, ic: 'star', html: 'Оценка игроку <b>' + esc(nm) + '</b>' + (r.rating ? ': ' + r.rating + ' из 5' : ''), tone: 'accent' });
    });
    var q = window.DMRepChip ? DMRepChip.state() : null;
    if (q) Object.keys(q.m).forEach(function (sid) {
      var r = q.m[sid]; if (!r || r.e || !names[sid]) return;
      ev.push({ t: Math.floor(r.t / 1000), ic: 'shield', html: 'Репутация <b>' + esc(names[sid]) + '</b>: ' + esc(STATE_LABEL[r.s] || r.s), tone: STATE_TONE[r.s] || 'neutral' });
    });
    ev.sort(function (a, b) { return b.t - a.t; });
    ev = ev.slice(0, 8);
    if (!ev.length) return K.empty({ icon: 'list', title: 'Пока нет событий', text: 'Матчи, оценки и проверки репутации будут появляться здесь.' });
    return '<ol class="da">' + ev.map(function (x) {
      return '<li class="da-' + x.tone + '"><span class="da-i">' + ico(x.ic) + '</span><span class="da-t">' + x.html + (x.a ? ' ' + x.a : '') + '</span><time class="da-d" datetime="' + new Date(x.t * 1000).toISOString() + '">' + esc(H.ago(x.t)) + '</time></li>';
    }).join('') + '</ol>';
  }

  function quick(ms) {
    var mine = H.myAcc(), items = [
      mine ? ['myProfile', 'user', 'Мой профиль', 'статистика и динамика'] : ['go', 'user', 'Указать мой Steam ID', 'чтобы открыть свой профиль', 'settings'],
      ['go', 'search', 'Найти профиль', 'по нику или Steam ID', 'me'],
      ['go', 'list', 'История матчей', ms.length + ' ' + H.pl(ms.length, 'матч', 'матча', 'матчей'), 'matches'],
      ['d-watch', 'shield', 'Список наблюдения', H.server() ? 'игроки под вашим наблюдением' : 'нужен сервер Dota Mate'],
      ['go', 'users', 'Игроки', 'теги, оценки, пати', 'players'],
      ['go', 'rune', 'Драфт', 'выбор героев в реальном времени', 'draft']
    ];
    return '<ul class="dq">' + items.map(function (i) {
      return '<li><button type="button" class="dq-i" data-a="' + i[0] + '"' + (i[4] ? ' data-p="' + i[4] + '"' : '') + ' data-tip="' + esc(i[2] + ': ' + i[3]) + '"><span class="dq-ic">' + ico(i[1]) + '</span><span class="dq-t"><b>' + esc(i[2]) + '</b><small>' + esc(i[3]) + '</small></span>' + ico('chev') + '</button></li>';
    }).join('') + '</ul>';
  }

  /* ---------- сборка ---------- */
  function view() {
    var ms = H.matches(), idx = H.pIndex(), list = Object.keys(idx).map(function (k) { return idx[k]; });
    var empty = !ms.length && !H.loading();
    var trendMeta = ms.length ? 'последние ' + Math.min(ms.length, 30) + ' матчей' : '';
    return headerHtml(ms, list.length) + H.demoBanner() + searchHtml() +
      (empty ? '' : metricsHtml(ms, list)) +
      (window.DMSocialUI ? DMSocialUI.dashBlock() : '') +
      '<div class="dg dg-main">' +
        K.panel({ title: 'Динамика матчей', meta: trendMeta, metaTip: 'Только ваши сохранённые матчи. Серии побед и поражений сами по себе ничего не доказывают.', bodyHtml: H.loading() ? K.skeleton(3, 70) : trendHtml(ms), cls: 'dg-trend' }) +
        riskHtml(list) +
      '</div>' +
      playersPanel(list) +
      '<div class="dg dg-foot">' +
        K.panel({ title: 'Недавняя активность', bodyHtml: activity(ms, list) }) +
        K.panel({ title: 'Быстрый доступ', bodyHtml: quick(ms) }) +
      '</div>';
  }

  function refreshTable() {
    var el = document.getElementById('d-tbl'); if (!el) return;
    var idx = H.pIndex(); el.innerHTML = tableHtml(Object.keys(idx).map(function (k) { return idx[k]; }));
  }

  /* ---------- подсказки поиска среди знакомых ---------- */
  function suggest(q) {
    var box = document.getElementById('d-sug'); if (!box) return;
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
    var idx = H.pIndex(), l = Object.keys(idx).map(function (k) { return idx[k]; }).filter(function (e) { return e.name.toLowerCase().indexOf(q) >= 0 || e.sid.indexOf(q) >= 0; }).slice(0, 5);
    if (!l.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = '<div class="sm dsr-lbl">Среди ваших знакомых</div>' + l.map(function (e) {
      return '<div class="dsr-r">' + H.av(e.name, 'md', e.sid) + '<span class="dsr-n"><b>' + esc(e.name) + '</b><small>встреч: ' + e.count + ' · ' + esc(H.ago(e.last)) + '</small></span>' +
        '<button type="button" class="btn sm2" data-a="openPlayer" data-id="' + esc(e.sid) + '">Карточка</button>' +
        (/^\d+$/.test(e.sid) ? '<button type="button" class="btn sm2" data-a="openProfile" data-id="' + esc(e.sid) + '">' + ico('user') + 'Профиль</button>' : '') + '</div>';
    }).join('');
    box.hidden = false;
  }

  function init(h) {
    H = h;
    document.addEventListener('submit', function (ev) {
      if (!ev.target || ev.target.id !== 'd-search') return;
      ev.preventDefault();
      var v = document.getElementById('d-q').value.trim();
      if (!v) { var i = document.getElementById('d-q'); if (i) i.focus(); H.toast('Введите ник, Steam ID или ссылку на профиль'); return; }
      H.searchProfile(v);
    });
    document.addEventListener('input', function (ev) {
      var t = ev.target; if (!t) return;
      if (t.id === 'd-q') suggest(t.value);
      else if (t.id === 'd-tq') { X.q = t.value; X.page = 1; refreshTable(); }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && ev.target && ev.target.id === 'd-q') { ev.target.value = ''; suggest(''); }
    });
    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest && ev.target.closest('[data-a^="d-"]'); if (!b) return;
      var a = b.getAttribute('data-a');
      if (a === 'd-sort') { var k = b.dataset.k; if (X.sort === k) X.dir = -X.dir; else { X.sort = k; X.dir = k === 'name' ? 1 : -1; } X.page = 1; refreshTable(); }
      else if (a === 'd-filter') { X.filter = b.dataset.v; X.page = 1; document.querySelectorAll('.dt-f').forEach(function (x) { var on = x.dataset.v === X.filter; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); refreshTable(); }
      else if (a === 'd-prev') { X.page = Math.max(1, X.page - 1); refreshTable(); }
      else if (a === 'd-next') { X.page += 1; refreshTable(); }
      else if (a === 'd-reset') { X.q = ''; X.filter = 'all'; X.page = 1; var q = document.getElementById('d-tq'); if (q) q.value = ''; H.paintMain(); }
      else if (a === 'd-watch') H.openWatchlist();
    });
  }

  window.DMDash = { init: init, view: view, state: function () { return X; } };
})();
