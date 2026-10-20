/*
 * Dota Mate: страницы сообщества раздела «Репутация»: жалобы, обжалования, наблюдение и уведомления, панель модератора.
 * Все права, лимиты и переходы статусов проверяет сервер (server/community.js). Здесь только формы и показ ответов:
 * если сервер ответил отказом, пользователь видит его причину, а не «успех».
 * Без сервера Dota Mate (например, на GitHub Pages) отправка жалоб и модерация недоступны, и страница об этом прямо говорит.
 * Исключение: личный список наблюдения хранится в браузере (локально) и так и подписан.
 */
(function () {
  'use strict';
  var UI = window.DMRepUI, X = UI.ctx, R = window.DMRep, C = window.DMComm;
  var e = X.e, ico = X.ico, S = X.state;

  function needLogin() {
    var st = S.srv;
    if (!st) return '<div class="sk-row"><span class="sm">Проверяю доступность сервера…</span></div>';
    if (!st.available) return '<div class="banner warn" role="status">' + ico('lock') + '<div style="flex:1"><b>Сообщество недоступно</b><p class="sm">' + e(st.reason || 'Сервер не отвечает.') + ' Жалобы, обжалования и модерация работают только на сервере Dota Mate с базой данных: данные в браузере не могут быть общими для всех, поэтому хранить их локально было бы подделкой. Статистика и репутация по данным OpenDota остаются доступными.</p></div></div>';
    if (!st.user) return '<div class="banner warn" role="status">' + ico('lock') + '<div style="flex:1"><b>Нужен вход</b><p class="sm">Жалобы и обращения привязаны к аккаунту Steam: так работает защита от массовых и повторных жалоб.</p></div><a class="btn primary sm2" href="/auth/steam">Войти через Steam</a></div>';
    return '';
  }
  function ready() { return !!(S.srv && S.srv.available && S.srv.user); }
  function fieldErr(m, k) { return m && m[k] ? '<p class="rp-err" id="err-' + k + '" role="alert">' + e(m[k]) + '</p>' : ''; }
  function statusBadge(code, label) {
    var cls = code === 'confirmed' || code === 'upheld' ? 's-bad' : code === 'disputed' || code === 'pending' || code === 'needs_data' || code === 'open' ? 's-warn' : 's-neutral';
    return X.badge(cls, label);
  }
  function histList(h) {
    if (!h || !h.length) return '';
    return '<ol class="rp-hist">' + h.map(function (x) {
      var what = x.action === 'create' ? 'Жалоба подана' : x.action === 'status' ? ((R.STATUS_LABEL[x.from] || '—') + ' → ' + (R.STATUS_LABEL[x.to] || '—')) : x.action === 'flag_false' ? 'Сообщение о ложной жалобе' : x.action === 'appeal_open' ? 'Обращение открыто' : String(x.action).indexOf('appeal_') === 0 ? 'Решение по обращению' : x.action;
      return '<li><time>' + e(X.dt(x.at || x.created_at)) + '</time> <b>' + e(what) + '</b> <span class="sm">' + e(x.by || x.actor || '') + '</span>' + (x.reason ? '<div class="sm">' + e(x.reason) + '</div>' : '') + '</li>';
    }).join('') + '</ol>';
  }
  function load(fn) { return X.communityOn().then(fn); }

  /* ================= ЖАЛОБЫ ================= */
  var RP = { f: { target: '', matchId: '', category: '', description: '', evidence: '', more: '', consent: false }, errs: null, msg: null, busy: false, mine: null, mineErr: '' };
  function reportsReload() {
    if (!ready()) return;
    C.call('GET', '/my/reports').then(function (r) { if (r.ok) { RP.mine = r.data.reports; RP.mineErr = ''; } else RP.mineErr = r.message; X.renderRes(); });
  }
  function reportForm() {
    var f = RP.f, er = RP.errs, off = !ready();
    return '<section class="card"><div class="sec-h"><h2>Сообщить о подозрительном эпизоде</h2></div>' + needLogin() +
      '<p class="sm">Жалоба проверяется модератором и не является доказательством. До решения она не публикуется как нарушение. Укажите конкретный матч и что именно произошло. Нельзя жаловаться на игрока только за поражение или плохую статистику.</p>' +
      '<form data-rpform="reports" novalidate class="rp-form"><fieldset class="rp-fs"' + (off ? ' disabled' : '') + '>' +
      '<div class="field"><label for="rf-target">Игрок (Steam ID, SteamID64 или ссылка)</label><input id="rf-target" type="text" data-rpin="target" value="' + e(f.target) + '" autocomplete="off"' + (er && er.target ? ' aria-invalid="true" aria-describedby="err-target"' : '') + '>' + fieldErr(er, 'target') + '</div>' +
      '<div class="field"><label for="rf-match">Match ID</label><input id="rf-match" type="text" inputmode="numeric" data-rpin="matchId" value="' + e(f.matchId) + '" autocomplete="off"' + (er && er.matchId ? ' aria-invalid="true" aria-describedby="err-matchId"' : '') + '>' + fieldErr(er, 'matchId') + '<p class="sm">Вы и обвиняемый должны быть участниками этого матча (проверяется по данным OpenDota), матч не старше 60 дней.</p></div>' +
      '<div class="field"><label for="rf-cat">Категория</label><select id="rf-cat" data-rpset="category"' + (er && er.category ? ' aria-invalid="true"' : '') + '><option value="">Выберите…</option>' + Object.keys(R.CATEGORIES).map(function (k) { return '<option value="' + k + '"' + (f.category === k ? ' selected' : '') + '>' + e(R.CATEGORIES[k]) + '</option>'; }).join('') + '</select>' + fieldErr(er, 'category') + '</div>' +
      '<div class="field"><label for="rf-desc">Что произошло (с указанием минуты матча)</label><textarea id="rf-desc" data-rpin="description" rows="4" maxlength="1000"' + (er && er.description ? ' aria-invalid="true" aria-describedby="err-description"' : '') + '>' + e(f.description) + '</textarea>' + fieldErr(er, 'description') + '</div>' +
      '<div class="field"><label for="rf-ev">Ссылки на доказательства (по одной в строке, до 3, только https)</label><textarea id="rf-ev" data-rpin="evidence" rows="2"' + (er && er.evidence ? ' aria-invalid="true" aria-describedby="err-evidence"' : '') + ' placeholder="https://…">' + e(f.evidence) + '</textarea>' + fieldErr(er, 'evidence') + '<p class="sm">Файлы не загружаются. Ссылки на программы, архивы и HTML-страницы не принимаются.</p></div>' +
      '<details class="rp-more"' + (f.more ? ' open' : '') + '><summary>Групповая жалоба: ещё игроки из этого матча</summary><div class="field"><textarea data-rpin="more" rows="2" aria-label="Дополнительные игроки" placeholder="Steam ID через пробел, до 4 дополнительных">' + e(f.more) + '</textarea><p class="sm">На каждого игрока создаётся отдельная жалоба с тем же описанием; каждая проверяется отдельно. Суточный лимит жалоб действует на все.</p></div></details>' +
      '<label class="rp-check"><input type="checkbox" data-rpset="consent"' + (f.consent ? ' checked' : '') + (er && er.consent ? ' aria-invalid="true"' : '') + '> Я подтверждаю, что описал(а) события честно, понимаю, что ложные и массовые жалобы блокируются, а моё имя игроку не раскрывается.</label>' + fieldErr(er, 'consent') +
      (RP.msg ? '<div class="banner ' + (RP.msg.ok ? '' : 'soft') + '" role="status">' + ico(RP.msg.ok ? 'check' : 'alert') + '<div style="flex:1">' + RP.msg.html + '</div></div>' : '') +
      '<div><button class="btn primary" type="submit"' + (off || RP.busy ? ' disabled' : '') + '>' + (RP.busy ? 'Отправляю…' : 'Отправить жалобу') + '</button></div></fieldset></form></section>';
  }
  function mineHtml() {
    if (!ready()) return '';
    if (RP.mineErr) return '<div class="banner soft" role="alert">' + ico('alert') + '<p>' + e(RP.mineErr) + '</p></div>';
    if (!RP.mine) return '<div class="sk-row"><span class="sm">Загружаю ваши жалобы…</span></div>';
    if (!RP.mine.length) return '<section class="card"><div class="sec-h"><h2>Мои жалобы</h2></div><p class="sm">Вы пока не подавали жалоб.</p></section>';
    return '<section class="card"><div class="sec-h"><h2>Мои жалобы <small>' + RP.mine.length + '</small></h2></div><div class="rp-cards">' + RP.mine.map(function (r) {
      return '<article class="rp-ep e-info"><header><span>' + statusBadge(r.status, r.statusLabel) + ' <b>' + e(r.categoryLabel) + '</b></span><span class="sm">' + e(X.dt(r.createdAt)) + '</span></header>' +
        '<p>Игрок <a href="#/profile/' + e(r.target) + '" data-rp-link="1">' + e(r.target) + '</a> · матч <a href="#/match/' + e(r.matchId) + '" data-rp-link="1">' + e(r.matchId) + '</a></p><p class="sm">' + e(r.description) + '</p>' + histList(r.history) + '</article>'; }).join('') + '</div></section>';
  }
  UI.register('reports', {
    label: 'Жалобы', title: 'Жалобы сообщества', desc: 'Сообщите о конкретном эпизоде. Жалоба попадёт к модератору, а не станет публичным обвинением.', needsStatus: true,
    go: function () { RP.msg = null; RP.errs = null; load(function () { reportsReload(); X.renderForm(); X.renderRes(); }); },
    form: function () { return reportForm(); },
    res: function () { return mineHtml(); },
    input: function (k, v) { RP.f[k] = v; },
    set: function (k, v) { RP.f[k] = v; },
    prefill: function (acc, mid) { RP.f.target = acc || RP.f.target; if (mid) RP.f.matchId = mid; RP.msg = null; RP.errs = null; },
    submit: async function () {
      if (RP.busy) return;
      var f = RP.f, evid = f.evidence.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      var extra = f.more.split(/[\s,;]+/).filter(Boolean);
      var targets = [f.target].concat(extra);
      var local = R.validateReport({ target: f.target, matchId: f.matchId, category: f.category, description: f.description, evidence: evid, consent: f.consent });
      var errs = local.ok ? {} : local.errors;
      var accs = [];
      if (local.ok) {
        targets.forEach(function (t, i) { var n = R.normAcc(t); if (!n) errs[i ? 'more' : 'target'] = 'Не удалось распознать идентификатор: ' + t; else if (accs.indexOf(n.acc) < 0) accs.push(n.acc); });
        if (accs.length > 5) errs.more = 'Не больше пяти игроков в одной групповой жалобе.';
      }
      if (Object.keys(errs).length) { RP.errs = errs; RP.msg = null; X.renderForm(); return; }
      RP.errs = null; RP.busy = true; RP.msg = null; X.renderForm();
      var okN = [], bad = [];
      for (var i = 0; i < accs.length; i++) {
        var r = await C.call('POST', '/reports', { target: accs[i], matchId: local.value.matchId, category: local.value.category, description: local.value.description, evidence: local.value.evidence, consent: true });
        if (r.ok) okN.push(accs[i]); else { bad.push({ acc: accs[i], r: r }); if (r.status === 401 || r.status === 429 || r.status === 0) break; }
      }
      RP.busy = false;
      var html = '';
      if (okN.length) html += '<b>Жалоб принято: ' + okN.length + '.</b> Статус «Новый»; решение придёт после проверки модератором. Следить можно ниже в «Мои жалобы».';
      bad.forEach(function (b) { html += '<p>' + e(b.acc) + ': ' + e(b.r.message) + '</p>'; });
      RP.msg = { ok: okN.length > 0 && !bad.length, html: html };
      if (bad.length && bad[0].r.fields) RP.errs = bad[0].r.fields;
      if (okN.length && !bad.length) { RP.f.description = ''; RP.f.evidence = ''; RP.f.more = ''; RP.f.consent = false; }
      X.renderForm(); reportsReload();
    }
  });

  /* ================= ОБЖАЛОВАНИЯ ================= */
  var AP = { marks: null, mine: null, err: '', msg: null, f: { reportId: '', text: '', evidence: '' }, errs: null, busy: false };
  function appealsReload() {
    if (!ready()) return;
    Promise.all([C.call('GET', '/against-me'), C.call('GET', '/my/appeals')]).then(function (rs) {
      AP.err = '';
      if (rs[0].ok) AP.marks = rs[0].data; else AP.err = rs[0].message;
      if (rs[1].ok) AP.mine = rs[1].data.appeals; else AP.err = AP.err || rs[1].message;
      X.renderForm(); X.renderRes();
    });
  }
  UI.register('appeals', {
    label: 'Обжалования', title: 'Обжалование отметок', desc: 'Если подтверждённая отметка ошибочна, её можно оспорить: приложить материалы и следить за решением. Пока рассматривается, отметка помечена как оспариваемая и в оценку не входит.', needsStatus: true,
    go: function () { AP.msg = null; load(function () { appealsReload(); X.renderForm(); X.renderRes(); }); },
    prefill: function (id) { AP.f.reportId = String(id); AP.msg = null; AP.errs = null; },
    form: function () {
      var f = AP.f, er = AP.errs;
      var opts = (AP.marks && AP.marks.marks || []).map(function (m) { return '<option value="' + m.id + '"' + (String(f.reportId) === String(m.id) ? ' selected' : '') + '>' + e(m.categoryLabel) + ', матч ' + e(m.matchId) + ' (' + e(m.statusLabel) + ')</option>'; }).join('');
      return '<section class="card"><div class="sec-h"><h2>Оспорить отметку</h2></div>' + needLogin() +
        '<form data-rpform="appeals" novalidate class="rp-form"><fieldset class="rp-fs"' + (!ready() ? ' disabled' : '') + '><div class="field"><label for="ap-id">Номер отметки</label><div class="field-inline"><input id="ap-id" type="text" inputmode="numeric" data-rpin="reportId" value="' + e(f.reportId) + '" placeholder="номер из карточки отметки" style="max-width:220px">' +
        (opts ? '<select class="sel" data-rpset="reportId" aria-label="Мои отметки"><option value="">Мои отметки…</option>' + opts + '</select>' : '') + '</div>' + fieldErr(er, 'reportId') + '</div>' +
        '<div class="field"><label for="ap-text">Что в отметке неверно</label><textarea id="ap-text" data-rpin="text" rows="4" maxlength="1000"' + (er && er.text ? ' aria-invalid="true"' : '') + '>' + e(f.text) + '</textarea>' + fieldErr(er, 'text') + '</div>' +
        '<div class="field"><label for="ap-ev">Материалы (ссылки https, по одной в строке)</label><textarea id="ap-ev" data-rpin="evidence" rows="2">' + e(f.evidence) + '</textarea>' + fieldErr(er, 'evidence') + '</div>' +
        (AP.msg ? '<div class="banner ' + (AP.msg.ok ? '' : 'soft') + '" role="status">' + ico(AP.msg.ok ? 'check' : 'alert') + '<p>' + e(AP.msg.text) + '</p></div>' : '') +
        '<div><button class="btn primary" type="submit"' + (!ready() || AP.busy ? ' disabled' : '') + '>' + (AP.busy ? 'Отправляю…' : 'Отправить обращение') + '</button></div></fieldset></form></section>';
    },
    input: function (k, v) { AP.f[k] = v; },
    set: function (k, v) { AP.f[k] = v; if (k === 'reportId') X.renderForm(); },
    res: function () {
      if (!ready()) return '';
      if (AP.err) return '<div class="banner soft" role="alert">' + ico('alert') + '<p>' + e(AP.err) + '</p></div>';
      if (!AP.marks) return '<div class="sk-row"><span class="sm">Загружаю…</span></div>';
      var marks = AP.marks.marks, out = '';
      out += '<section class="card"><div class="sec-h"><h2>Отметки против вас <small>' + marks.length + '</small></h2></div>' +
        (marks.length ? marks.map(function (m) { return '<article class="rp-ep ' + (m.status === 'disputed' ? 'e-info' : 'e-bad') + '"><header><span>' + statusBadge(m.status, m.statusLabel) + ' <b>' + e(m.categoryLabel) + '</b> <span class="sm">№' + m.id + '</span></span><span class="sm">' + e(X.dday(m.decidedAt)) + '</span></header>' +
          '<p><b>Основание:</b> ' + e(m.reason || 'Модератор не добавил публичного пояснения.') + '</p><footer><span>' + X.link('match/' + m.matchId, 'Матч ' + e(m.matchId)) + '</span><span>' + (m.myAppeal ? statusBadge('open', 'Ваше обращение №' + m.myAppeal.id + ': ' + (R.APPEAL_STATUS[m.myAppeal.status] || m.myAppeal.status)) : '<button class="btn sm2" type="button" data-rp="pick" data-id="' + m.id + '">Оспорить</button>') + '</span></footer></article>'; }).join('') : '<p class="sm">Против вас нет публичных отметок.' + (AP.marks.pendingCount ? ' Нерассмотренных жалоб: ' + AP.marks.pendingCount + ' (их содержание и авторы не раскрываются, пока нет решения).' : '') + '</p>') + '</section>';
      out += '<section class="card"><div class="sec-h"><h2>Мои обращения <small>' + (AP.mine ? AP.mine.length : 0) + '</small></h2></div>' +
        (AP.mine && AP.mine.length ? AP.mine.map(function (a) { return '<article class="rp-ep e-info"><header><span>' + statusBadge(a.status, a.statusLabel) + ' <b>' + e(a.categoryLabel || '') + '</b> <span class="sm">отметка №' + a.reportId + '</span></span><span class="sm">' + e(X.dt(a.createdAt)) + '</span></header><p class="sm">' + e(a.text) + '</p>' +
          (a.evidence.length ? '<p class="sm">Материалы: ' + a.evidence.map(function (u) { var s = X.safeUrl(u); return s ? '<a href="' + e(s) + '" target="_blank" rel="noopener noreferrer nofollow">' + e(s) + '</a>' : e(u); }).join(', ') + '</p>' : '') +
          (a.decisionReason ? '<p><b>Решение модератора:</b> ' + e(a.decisionReason) + '</p>' : '') + histList(a.history) + '</article>'; }).join('') : '<p class="sm">Обращений нет.</p>') + '</section>';
      return out;
    },
    act: function (name, t) { if (name === 'pick') { AP.f.reportId = t.dataset.id; X.renderForm(); var el = document.getElementById('ap-text'); if (el) el.focus(); } },
    submit: async function () {
      if (AP.busy) return;
      var f = AP.f, errs = {};
      if (!/^\d+$/.test(String(f.reportId).trim())) errs.reportId = 'Укажите номер отметки.';
      if (String(f.text).trim().length < 10) errs.text = 'Опишите, в чём ошибка (от 10 символов).';
      var ev = f.evidence.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (ev.length > R.LIMITS.evidenceMax || ev.some(function (u) { return !R.evidenceUrlOk(u); })) errs.evidence = 'Ссылки должны начинаться с https:// (не больше ' + R.LIMITS.evidenceMax + ').';
      if (Object.keys(errs).length) { AP.errs = errs; AP.msg = null; X.renderForm(); return; }
      AP.errs = null; AP.busy = true; X.renderForm();
      var r = await C.call('POST', '/appeals', { reportId: Number(f.reportId), text: f.text, evidence: ev });
      AP.busy = false;
      if (r.ok) { AP.msg = { ok: true, text: 'Обращение №' + r.data.id + ' принято. Модератор рассмотрит его и укажет обоснование решения.' }; AP.f.text = ''; AP.f.evidence = ''; AP.f.reportId = ''; }
      else { AP.msg = { ok: false, text: r.message }; AP.errs = r.fields || null; }
      X.renderForm(); appealsReload();
    }
  });

  /* ================= НАБЛЮДЕНИЕ ================= */
  var WL = { server: [], local: [], notes: [], unread: 0, busy: {}, input: '', err: '', mode: 'local', loaded: false, msg: '' };
  var KIND = { message: 'Новое сообщение', anomaly: 'Статистическая аномалия', decision: 'Решение модератора' };
  function localWl() { return (X.store().watch || []).slice(); }
  function saveLocalWl(l) { var s = X.store(); s.watch = l.slice(0, 50); X.store(s); }
  function localNotes() { return (X.store().notes || []).slice(); }
  function pushLocalNote(n) { var s = X.store(); s.notes = [n].concat(s.notes || []).slice(0, 50); X.store(s); }
  function wlReload() {
    return load(function () {
      WL.mode = ready() ? 'server' : 'local';
      WL.local = localWl(); WL.notes = localNotes();
      if (WL.mode !== 'server') { WL.loaded = true; X.renderForm(); X.renderRes(); return; }
      return Promise.all([C.call('GET', '/watchlist'), C.call('GET', '/notifications')]).then(function (rs) {
        if (rs[0].ok) WL.server = rs[0].data.entries; else WL.err = rs[0].message;
        if (rs[1].ok) { WL.notes = rs[1].data.notifications; WL.unread = rs[1].data.unread; }
        WL.loaded = true; X.renderForm(); X.renderRes();
      });
    });
  }
  function entries() { return WL.mode === 'server' ? WL.server.map(function (x) { return { acc: x.acc, note: x.note, lastCheckedAt: x.lastCheckedAt, lastState: x.lastState, lastAnomalies: x.lastAnomalies }; }) : WL.local; }
  function addEntry(acc, note) {
    if (WL.mode === 'server') return C.call('POST', '/watchlist', { target: acc, note: note || '' }).then(function (r) { if (!r.ok) { WL.err = r.message; WL.msg = ''; } else { WL.err = ''; WL.msg = 'Игрок добавлен.'; } return wlReload(); });
    var l = localWl();
    if (l.some(function (x) { return x.acc === acc; })) { WL.err = 'Игрок уже в списке.'; return Promise.resolve(); }
    if (l.length >= 50) { WL.err = 'В списке не больше 50 игроков.'; return Promise.resolve(); }
    l.unshift({ acc: acc, note: note || '', addedAt: X.now() }); saveLocalWl(l); WL.err = ''; WL.msg = 'Игрок добавлен.'; return wlReload();
  }
  async function checkEntry(acc) {
    WL.busy[acc] = true; X.renderRes();
    try {
      var d = await X.loadPlayer(acc, true), an = d.an.items.filter(function (i) { return i.group === 'anomaly' || i.group === 'fact'; }).length;
      if (WL.mode === 'server') {
        var r = await C.call('POST', '/watchlist/' + acc + '/check', { state: d.rep.state, anomalies: an, score: d.rep.score, confidence: d.rep.confidence.level });
        if (!r.ok) WL.err = r.message; else WL.err = '';
      } else {
        var l = localWl(), it = l.filter(function (x) { return x.acc === acc; })[0];
        if (it) {
          if (it.lastAnomalies != null && an > it.lastAnomalies) pushLocalNote({ id: Date.now(), kind: 'anomaly', target: acc, text: 'Появились новые статистические аномалии (+' + (an - it.lastAnomalies) + '). Это повод посмотреть матчи, а не вывод о нарушении.', createdAt: X.now(), readAt: null });
          var prevConfirmed = it.lastConfirmed || 0;
          if (d.communityAvailable && d.rep.confirmedCount > prevConfirmed) pushLocalNote({ id: Date.now() + 1, kind: 'decision', target: acc, text: 'Модератор подтвердил эпизод. Это проверенное решение.', createdAt: X.now(), readAt: null });
          it.lastCheckedAt = X.now(); it.lastState = d.rep.state; it.lastAnomalies = an; it.lastConfirmed = d.rep.confirmedCount; saveLocalWl(l);
        }
      }
    } catch (x) { WL.err = X.errText(x); }
    WL.busy[acc] = false; await wlReload();
  }
  UI.register('watchlist', {
    label: 'Наблюдение', title: 'Список наблюдения', desc: 'Игроки, за которыми вы следите. Проверка запускается вами: сайт сравнивает свежие данные с прошлой проверкой и сообщает о новых отметках.', needsStatus: true,
    go: function () { WL.err = ''; WL.msg = ''; wlReload(); },
    form: function () {
      var mode = WL.mode === 'server' ? 'Список хранится на сервере Dota Mate и доступен с любого устройства.' : 'Список хранится только в этом браузере (локально). Войдите через Steam на сервере Dota Mate, чтобы он хранился в аккаунте.';
      return '<section class="card rp-search"><form data-rpform="watchlist" novalidate><label for="wl-in">Добавить игрока: Steam ID, SteamID64 или ссылка</label><div class="me-row"><input id="wl-in" type="text" autocomplete="off" spellcheck="false" value="' + e(WL.input) + '" data-rpin="w"' + (WL.err ? ' aria-invalid="true"' : '') + '><button class="btn primary" type="submit">' + ico('plus') + 'Добавить</button></div>' +
        (WL.err ? '<p class="rp-err" role="alert">' + e(WL.err) + '</p>' : WL.msg ? '<p class="sm" role="status">' + e(WL.msg) + '</p>' : '') + '<p class="sm">' + e(mode) + '</p></form></section>';
    },
    input: function (k, v) { WL.input = v; },
    res: function () {
      if (!WL.loaded) return '<div class="sk-row"><span class="sm">Загружаю список…</span></div>';
      var l = entries(), out = '';
      if (!l.length) out += '<div class="empty">' + ico('star') + '<b>Список пуст</b><p>Добавьте игрока по Steam ID или нажмите «В наблюдение» на странице профиля.</p></div>';
      else out += '<section class="card"><div class="sec-h"><h2>Игроки <small>' + l.length + '</small></h2><button class="btn sm2" type="button" data-rp="check-all">' + ico('refresh') + 'Проверить всех</button></div><div class="tbl-scroll"><table class="rp-tbl rp-wide"><thead><tr><th>Игрок</th><th>Статус при последней проверке</th><th>Аномалии</th><th>Проверено</th><th></th></tr></thead><tbody>' + l.map(function (it) {
        return '<tr><td><a href="#/profile/' + e(it.acc) + '" data-rp-link="1">' + e(it.acc) + '</a>' + (it.note ? '<div class="sm">' + e(it.note) + '</div>' : '') + '</td><td>' + (it.lastState ? X.badge(X.STATE_CLS[it.lastState] || 's-neutral', R.STATE_LABEL[it.lastState] || it.lastState) : '<span class="na">не проверялся</span>') + '</td><td class="num">' + (it.lastAnomalies != null ? it.lastAnomalies : '—') + '</td><td>' + (it.lastCheckedAt ? e(X.dt(it.lastCheckedAt)) : '—') + '</td>' +
          '<td><button class="btn sm2" type="button" data-rp="check" data-acc="' + e(it.acc) + '"' + (WL.busy[it.acc] ? ' disabled' : '') + '>' + (WL.busy[it.acc] ? 'Проверяю…' : 'Проверить') + '</button> <button class="btn sm2 ghost" type="button" data-rp="remove" data-acc="' + e(it.acc) + '" aria-label="Убрать из списка">' + ico('trash') + '</button></td></tr>'; }).join('') + '</tbody></table></div></section>';
      out += '<section class="card"><div class="sec-h"><h2>Уведомления' + (WL.unread ? ' <small>' + WL.unread + ' новых</small>' : '') + '</h2>' + (WL.notes.length ? '<button class="btn sm2" type="button" data-rp="read-all">Отметить прочитанными</button>' : '') + '</div>' +
        (WL.notes.length ? '<ul class="rp-notes2">' + WL.notes.map(function (n) { return '<li class="k-' + e(n.kind) + (n.readAt ? '' : ' new') + '">' + X.badge(n.kind === 'decision' ? 's-bad' : n.kind === 'anomaly' ? 's-warn' : 's-neutral', KIND[n.kind] || n.kind) + ' <span>' + e(n.text) + '</span> <span class="sm">' + (n.target ? '<a href="#/profile/' + e(n.target) + '" data-rp-link="1">' + e(n.target) + '</a> · ' : '') + e(X.dt(n.createdAt)) + '</span></li>'; }).join('') + '</ul>' : '<p class="sm">Уведомлений нет. Они появляются, когда у наблюдаемого игрока растёт число отметок или модератор принимает решение.</p>') +
        '<p class="sm">Три типа: новые сообщения (непроверенные жалобы), статистические аномалии и решения модераторов. Первые два не означают нарушения.</p></section>';
      return out;
    },
    quickAdd: function (acc) { load(function () { WL.mode = ready() ? 'server' : 'local'; return addEntry(acc, ''); }).then(function () { X.toast(WL.err || 'Игрок добавлен в список наблюдения.'); }); },
    submit: function (f) {
      var r = X.parseAcc(f.querySelector('input').value);
      if (!r.ok) { WL.err = r.msg; WL.msg = ''; X.renderForm(); return; }
      WL.input = ''; addEntry(r.acc, '');
    },
    act: async function (name, t) {
      if (name === 'check') checkEntry(t.dataset.acc);
      else if (name === 'check-all') { var l = entries(); for (var i = 0; i < l.length; i++) await checkEntry(l[i].acc); }
      else if (name === 'remove') {
        if (WL.mode === 'server') await C.call('DELETE', '/watchlist/' + t.dataset.acc); else saveLocalWl(localWl().filter(function (x) { return x.acc !== t.dataset.acc; }));
        wlReload();
      } else if (name === 'read-all') {
        if (WL.mode === 'server') await C.call('POST', '/notifications/read', {}); else { var s = X.store(); (s.notes || []).forEach(function (n) { n.readAt = X.now(); }); X.store(s); }
        wlReload();
      }
    }
  });

  /* ================= МОДЕРАЦИЯ ================= */
  var MD = { tab: 'reports', status: '', list: null, appeals: null, log: null, sel: null, detail: null, err: '', msg: '', busy: false };
  function modLoad() {
    if (!S.mod) return;
    var p = MD.tab === 'reports' ? C.call('GET', '/mod/reports' + (MD.status ? '?status=' + MD.status : '')) : MD.tab === 'appeals' ? C.call('GET', '/mod/appeals') : C.call('GET', '/mod/log?limit=100');
    p.then(function (r) {
      if (!r.ok) { MD.err = r.message; } else { MD.err = ''; if (MD.tab === 'reports') MD.list = r.data; else if (MD.tab === 'appeals') MD.appeals = r.data.appeals; else MD.log = r.data.log; }
      X.renderRes();
    });
  }
  function modDetail(id) {
    MD.sel = id; MD.detail = null; X.renderRes();
    C.call('GET', '/mod/reports/' + id).then(function (r) { if (r.ok) MD.detail = r.data; else MD.err = r.message; X.renderRes(); });
  }
  UI.register('mod', {
    label: 'Модерация', title: 'Панель модератора', desc: 'Рассмотрение жалоб и обращений. Каждое решение требует обоснования и записывается в журнал. Модератор не может рассматривать дела, где он автор или обвиняемый.', needsStatus: true,
    visible: function () { return !!S.mod; },
    go: function () { load(function () { X.renderForm(); modLoad(); X.renderRes(); }); },
    form: function () { return ''; },
    res: function () {
      if (!S.srv) return '<div class="sk-row"><span class="sm">Проверяю доступ…</span></div>';
      if (!S.mod) return needLogin() || '<div class="banner soft" role="alert">' + ico('lock') + '<div style="flex:1"><b>Нет доступа</b><p class="sm">Раздел только для модераторов. Список модераторов задаётся администратором сервера.</p></div></div>';
      var tabs = '<div class="rp-subtabs" role="tablist">' + [['reports', 'Жалобы'], ['appeals', 'Обращения'], ['log', 'Журнал действий']].map(function (t) { return '<button class="btn sm2 ' + (MD.tab === t[0] ? 'primary' : '') + '" type="button" role="tab" aria-selected="' + (MD.tab === t[0]) + '" data-rp="mdtab" data-t="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>';
      var err = MD.err ? '<div class="banner soft" role="alert">' + ico('alert') + '<p>' + e(MD.err) + '</p></div>' : '';
      var msg = MD.msg ? '<div class="banner" role="status">' + ico('check') + '<p>' + e(MD.msg) + '</p></div>' : '';
      var body = '';
      if (MD.tab === 'reports') {
        if (!MD.list) body = '<div class="sk-row"><span class="sm">Загружаю…</span></div>';
        else {
          var counts = MD.list.counts, opts = [['', 'Требуют внимания']].concat(Object.keys(R.STATUS_LABEL).map(function (k) { return [k, R.STATUS_LABEL[k] + (counts[k] ? ' (' + counts[k] + ')' : '')]; }));
          body = '<div class="filters me-f"><label>Статус<select class="sel" data-rpset="mdstatus">' + opts.map(function (o) { return '<option value="' + e(o[0]) + '"' + (MD.status === o[0] ? ' selected' : '') + '>' + e(o[1]) + '</option>'; }).join('') + '</select></label></div>' +
            (MD.list.reports.length ? '<div class="tbl-scroll"><table class="rp-tbl rp-wide"><thead><tr><th>№</th><th>Статус</th><th>Категория</th><th>Игрок</th><th>Матч</th><th>Флаги</th><th></th></tr></thead><tbody>' + MD.list.reports.map(function (r) {
              return '<tr' + (MD.sel === r.id ? ' class="sel-row"' : '') + '><td>' + r.id + '</td><td>' + statusBadge(r.status, r.statusLabel) + '</td><td>' + e(r.categoryLabel) + '</td><td class="mono">' + e(r.target) + '</td><td class="mono">' + e(r.matchId) + '</td><td>' + (r.volumeFlag ? X.badge('s-warn', 'всплеск жалоб') + ' ' : '') + (r.flags ? X.badge('s-low', 'ложная? ×' + r.flags) : '') + '</td><td><button class="btn sm2" type="button" data-rp="mdopen" data-id="' + r.id + '">Открыть</button></td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">' + ico('check') + '<b>Очередь пуста</b><p>Жалоб с таким статусом нет.</p></div>');
          if (MD.sel) body += detailHtml();
        }
      } else if (MD.tab === 'appeals') {
        if (!MD.appeals) body = '<div class="sk-row"><span class="sm">Загружаю…</span></div>';
        else body = MD.appeals.length ? MD.appeals.map(appealHtml).join('') : '<div class="empty">' + ico('check') + '<b>Открытых обращений нет</b></div>';
      } else {
        body = !MD.log ? '<div class="sk-row"><span class="sm">Загружаю…</span></div>' : '<div class="tbl-scroll"><table class="rp-tbl rp-wide"><thead><tr><th>Время</th><th>Кто</th><th>Действие</th><th>Жалоба</th><th>Обращение</th><th>Обоснование</th></tr></thead><tbody>' + MD.log.map(function (l) { return '<tr><td>' + e(X.dt(l.created_at)) + '</td><td class="mono">' + e(l.actor) + '</td><td>' + e(l.action) + (l.from_status || l.to_status ? ' <span class="sm">' + e((R.STATUS_LABEL[l.from_status] || l.from_status || '') + ' → ' + (R.STATUS_LABEL[l.to_status] || l.to_status || '')) + '</span>' : '') + '</td><td>' + (l.report_id || '') + '</td><td>' + (l.appeal_id || '') + '</td><td class="sm">' + e(l.reason || '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
      }
      return '<section class="card">' + tabs + err + msg + body + '</section>';
    },
    set: function (k, v) { if (k === 'mdstatus') { MD.status = v; MD.sel = null; MD.list = null; modLoad(); X.renderRes(); } },
    act: async function (name, t) {
      if (name === 'mdtab') { MD.tab = t.dataset.t; MD.msg = ''; MD.sel = null; modLoad(); X.renderRes(); }
      else if (name === 'mdopen') modDetail(Number(t.dataset.id));
      else if (name === 'mdsave') {
        if (MD.busy) return;
        var box = t.closest('.rp-md'), to = box.querySelector('[name=to]').value, reason = box.querySelector('[name=reason]').value, pub = box.querySelector('[name=pub]').value;
        MD.busy = true; t.disabled = true;
        var r = await C.call('POST', '/mod/reports/' + MD.sel + '/status', { to: to, reason: reason, publicReason: pub });
        MD.busy = false;
        if (!r.ok) { var me = box.querySelector('.rp-md-msg'); if (me) me.textContent = r.message; t.disabled = false; return; }   // форма остаётся как была
        MD.msg = 'Статус изменён: ' + r.data.statusLabel + '. Запись добавлена в журнал.'; MD.err = '';
        modDetail(MD.sel); modLoad();
      } else if (name === 'mdappeal') {
        if (MD.busy) return;
        var b2 = t.closest('.rp-md'), dec = b2.querySelector('[name=decision]').value, rs = b2.querySelector('[name=reason]').value;
        MD.busy = true; t.disabled = true;
        var r2 = await C.call('POST', '/mod/appeals/' + t.dataset.id, { decision: dec, reason: rs });
        MD.busy = false;
        if (!r2.ok) { var me2 = b2.querySelector('.rp-md-msg'); if (me2) me2.textContent = r2.message; t.disabled = false; return; }
        MD.msg = 'Решение по обращению сохранено: ' + r2.data.statusLabel + '.';
        modLoad(); X.renderRes();
      }
    }
  });
  function detailHtml() {
    var d = MD.detail;
    if (!d) return '<div class="sk-row"><span class="sm">Загружаю жалобу…</span></div>';
    var r = d.report;
    return '<div class="rp-md"><h3>Жалоба №' + r.id + '</h3><p>' + statusBadge(r.status, r.statusLabel) + ' <b>' + e(r.categoryLabel) + '</b> · автор <span class="mono">' + e(r.reporter) + '</span> → игрок <a href="#/profile/' + e(r.target) + '" data-rp-link="1">' + e(r.target) + '</a> · ' + X.link('match/' + r.matchId, 'матч ' + e(r.matchId)) + '</p>' +
      '<blockquote class="rp-quote">' + e(r.description) + '</blockquote>' +
      (r.evidence && r.evidence.length ? '<p class="sm">Материалы: ' + r.evidence.map(function (u) { var s = X.safeUrl(u); return s ? '<a href="' + e(s) + '" target="_blank" rel="noopener noreferrer nofollow">' + e(s) + '</a>' : e(u); }).join(', ') + '</p>' : '<p class="sm">Материалов нет.</p>') +
      (r.volumeFlag ? '<div class="banner warn">' + ico('alert') + '<p>Много разных авторов подали жалобы на этого игрока за сутки. Проверьте, нет ли организованной травли: опирайтесь на реплей, а не на число жалоб.</p></div>' : '') +
      (d.flagReasons.length ? '<p class="sm"><b>Сообщения о ложной жалобе (' + d.flagReasons.length + '):</b> ' + d.flagReasons.map(function (f) { return e(f.reason); }).join('; ') + '</p>' : '') +
      (d.otherReportsOnTarget.length ? '<p class="sm">Другие жалобы на игрока: ' + d.otherReportsOnTarget.map(function (o) { return '№' + o.id + ' (' + e(R.STATUS_LABEL[o.status]) + ')'; }).join(', ') + '</p>' : '') +
      '<h4>История</h4>' + histList(d.history.map(function (h) { return { at: h.created_at, action: h.action, from: h.from_status, to: h.to_status, actor: h.actor, reason: h.reason }; })) +
      (r.allowed.length ? '<div class="rp-form"><div class="field"><label>Новый статус</label><select name="to" class="sel">' + r.allowed.map(function (s) { return '<option value="' + s + '">' + e(R.STATUS_LABEL[s]) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>Обоснование решения (для журнала и автора, обязательно)</label><textarea name="reason" rows="2" maxlength="500"></textarea></div>' +
        '<div class="field"><label>Публичное пояснение к подтверждению (видно всем, до 300 символов)</label><textarea name="pub" rows="2" maxlength="300">' + e(r.publicReason || '') + '</textarea></div>' +
        '<p class="rp-err rp-md-msg" role="alert"></p><button class="btn primary" type="button" data-rp="mdsave">Сохранить решение</button></div>' : '<p class="sm">Из этого статуса переходов нет.</p>') + '</div>';
  }
  function appealHtml(a) {
    return '<div class="rp-md"><h3>Обращение №' + a.id + ' по отметке №' + a.reportId + '</h3><p>' + statusBadge(a.status, a.statusLabel) + ' ' + (a.byTarget ? X.badge('s-warn', 'от владельца аккаунта') : X.badge('s-neutral', 'от третьего лица')) + ' <b>' + e(a.categoryLabel || '') + '</b> · ' + X.link('match/' + a.matchId, 'матч ' + e(a.matchId)) + ' · автор <span class="mono">' + e(a.author) + '</span> · игрок <span class="mono">' + e(a.target) + '</span></p>' +
      '<blockquote class="rp-quote">' + e(a.text) + '</blockquote>' + (a.evidence.length ? '<p class="sm">Материалы: ' + a.evidence.map(function (u) { var s = X.safeUrl(u); return s ? '<a href="' + e(s) + '" target="_blank" rel="noopener noreferrer nofollow">' + e(s) + '</a>' : e(u); }).join(', ') + '</p>' : '') +
      '<div class="rp-form"><div class="field"><label>Решение</label><select name="decision" class="sel"><option value="uphold">Оставить отметку</option><option value="revoke">Снять отметку (ошибочна)</option><option value="need_data">Запросить данные</option><option value="close">Закрыть без изменений</option></select></div>' +
      '<div class="field"><label>Обоснование (обязательно)</label><textarea name="reason" rows="2" maxlength="500"></textarea></div><p class="rp-err rp-md-msg" role="alert"></p><button class="btn primary" type="button" data-rp="mdappeal" data-id="' + a.id + '">Сохранить решение</button></div></div>';
  }

  /* ================= БЛОК В НАСТРОЙКАХ ================= */
  UI.settingsBlock = function () {
    var st = S.srv;
    if (!st) { X.communityOn().then(function () { var el = document.getElementById('rp-settings'); if (el) el.innerHTML = UI.settingsBlock(true); }); }
    var s = st ? (st.available ? 'Серверная часть сообщества работает.' + (st.user ? ' Вы вошли как ' + (st.user.moderator ? 'модератор' : 'пользователь') + '.' : ' Вы не вошли.') : 'Сообщество недоступно: ' + String(st.reason || 'сервер не отвечает').replace(/\.$/, '') + '.') : 'Проверяю…';
    var inner = '<h3>Репутация и сообщество</h3><p class="sm">' + e(s) + '</p><p class="sm">Локально в браузере хранятся: последние поиски, личный список наблюдения (если вы не вошли) и кэш данных OpenDota.</p>' +
      '<div class="actions"><button class="btn" type="button" data-a="repClear">Очистить локальные данные репутации</button></div>';
    return arguments[0] === true ? inner : '<section class="card" id="rp-settings">' + inner + '</section>';
  };
})();
