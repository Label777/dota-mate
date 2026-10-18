/* Dota Mate: MVP и худший игрок матча, интерфейс.
   Расчёт в js/impact.js (DMImpact). Здесь: сохранение результатов, отметки в списке матчей и в матче, блок в профиле игрока,
   фильтры, настройки и блок для раздела «Найти профиль» (любой игрок OpenDota).
   Данные берутся из кэша статистики матчей (js/perf-ui.js, dotamate.perf.v1). Результаты хранятся только в этом браузере
   (dotamate.impact.v1) по номеру матча и версии алгоритма и не выдаются за серверные: ничего никуда не отправляется. */
(function () {
  'use strict';
  const LS = 'dotamate.impact.v1', MAX = 300;
  let H = null, saveT = null;
  const C = { v: 1, m: {} };
  const memo = {};
  const J = { run: false, stop: false, done: 0, total: 0, stage: '', msg: '', render: null };
  const I = () => window.DMImpact, PF = () => window.DMPerfUI, PM = () => window.DMPerf;
  const esc = (s) => H.esc(s);
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const pc = (v) => Math.round(v * 100) + '%';

  /* ---------- хранение ---------- */
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(LS) || 'null');
      if (j && j.v === 1 && j.m && typeof j.m === 'object') C.m = j.m;
    } catch (e) { /* пустой кэш */ }
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try {
        const ids = Object.keys(C.m);
        if (ids.length > MAX) for (const id of ids.slice(0, ids.length - MAX)) delete C.m[id];
        localStorage.setItem(LS, JSON.stringify(C));
      } catch (e) { /* не критично: останется в памяти */ }
    }, 300);
  }

  /* ---------- расчёт с сохранением ---------- */
  function winnerOf(rec, m) {
    if (rec.rw === 0 || rec.rw === 1) return rec.rw;
    if (m && m.win != null && rec.mr != null) return m.win ? rec.mr : 1 - rec.mr;
    return null;
  }
  /** Результат для записи матча: берётся из сохранённых, если версия алгоритма и входные данные те же, иначе считается заново. */
  function resultForRec(rec, m) {
    const opts = { bench: PF().bench(), dur: (m && m.dur) || rec.dur, winner: winnerOf(rec, m) };
    const sig = I().signature(rec, opts), e = C.m[rec.id];
    if (I().reusable(e, sig)) return e;
    const res = I().evaluate(rec, opts);
    res.sig = sig; res.id = String(rec.id);
    C.m[rec.id] = res; save();
    return res;
  }
  /** Матч сайта: {rec, res} или null, если статистики матча ещё нет. */
  function forMatch(m) {
    if (!H || !m) return null;
    const rec = PF().rec(m.id);
    if (!rec || !rec.p || !rec.p.length) return null;
    const ver = PF().ver(), c = memo[m.id];
    if (c && c.ver === ver && c.rec === rec) return c.f;
    const f = { rec, res: resultForRec(rec, m) };
    memo[m.id] = { ver, rec, f };
    return f;
  }
  const playerIdx = (f, p) => PM().findRecord(f.rec, p, H.heroId);
  function statusFor(m, p) {
    const f = forMatch(m); if (!f || !p) return null;
    const i = playerIdx(f, p);
    return i < 0 ? null : I().statusOf(f.res, { i });
  }
  const siteAt = (m, f, i) => m.players.find((p) => playerIdx(f, p) === i) || null;
  function who(m, f, i) {
    const p = siteAt(m, f, i), h = f.rec.p[i] ? H.heroName(f.rec.p[i].h) : '';
    return { p, me: !!(p && p.me), name: p ? (p.me ? 'Вы' : p.name) : 'Игрок со скрытым ником', hero: p ? p.hero : h };
  }

  /* ---------- общие кусочки разметки ---------- */
  const KIND = { mvp: ['MVP', 'MVP матча'], worst: ['Худший', 'Худший результат матча'] };
  function preText(res) { return res.prelim && res.prelim.length ? res.prelim.map((c) => I().REASONS[c]).filter(Boolean).join(' ') : ''; }
  function tipFor(kind, st, w, res) {
    const base = `${KIND[kind][1]}: ${w.name}${w.hero ? ' (' + w.hero + ')' : ''}. Оценка ${f1(st.score)} из 100. ${st.text}`;
    const pre = res.final ? 'Оценка окончательная.' : 'Оценка предварительная. ' + preText(res);
    const tail = kind === 'worst' ? ' Это худший статистический результат в матче, а не доказательство саботажа.' : '';
    return base + ' ' + pre + tail;
  }
  const chip = (kind, label, tip, pre) => `<span class="im-chip ${kind}${pre ? ' pre' : ''}" data-tip="${esc(tip)}">${H.ico(kind === 'mvp' ? 'star' : 'alert')}${esc(label)}</span>`;

  /** Отметки в строке матча (список матчей): кто MVP и кто худший. */
  function rowChips(m) {
    const f = forMatch(m);
    if (!f || f.res.status !== 'ok') return '';
    const out = [];
    for (const k of ['mvp', 'worst']) {
      const st = f.res[k];
      if (st.state !== 'assigned') continue;
      const w = who(m, f, st.i);
      out.push(chip(k, `${KIND[k][0]}: ${w.me ? 'вы' : w.hero}`, tipFor(k, st, w, f.res), !f.res.final));
    }
    return out.length ? `<span class="im-line">${out.join('')}</span>` : '';
  }
  /** Небольшая отметка рядом с ником игрока в матче. */
  function nameBadge(m, p) {
    const f = forMatch(m), s = statusFor(m, p);
    if (!s) return '';
    const st = f.res[s], w = who(m, f, st.i);
    return chip(s, KIND[s][0], tipFor(s, st, w, f.res), !f.res.final);
  }

  /* ---------- блок на странице матча ---------- */
  function cell(kind, m, f) {
    const st = f.res[kind], title = KIND[kind][0];
    if (st.state === 'assigned') {
      const w = who(m, f, st.i);
      return `<div class="im-cell ${kind}"><div class="im-lab">${chip(kind, title, tipFor(kind, st, w, f.res), !f.res.final)}${f.res.final ? '' : '<span class="im-pre" data-tip="' + esc(preText(f.res)) + '">предварительно</span>'}</div>
        <div class="im-who"><b>${esc(w.name)}</b><small>${esc(w.hero)}</small></div>
        <div class="im-score" data-tip="${kind === 'mvp' ? 'Оценка вклада от 0 до 100. Выше — лучше.' : 'Индекс слабого результата от 0 до 100. Выше — хуже.'}"><b>${f1(st.score)}</b><span>из 100</span></div>
        <p class="sm">${esc(st.text)}</p></div>`;
    }
    if (st.state === 'tie') {
      const names = (st.contenders || []).map((i) => who(m, f, i).name).join(', ');
      return `<div class="im-cell ${kind} none"><div class="im-lab"><span class="im-chip">${title}</span></div><div class="im-who"><b>Нет однозначного лидера</b></div>
        <p class="sm">Оценки почти равны (разрыв меньше ${I().MARGIN} балла): ${esc(names)}. Случайно статус не назначаем.</p></div>`;
    }
    return `<div class="im-cell ${kind} none"><div class="im-lab"><span class="im-chip">${title}</span></div><div class="im-who"><b>${esc(st.text)}</b></div>
      ${st.state === 'none' ? `<p class="sm">${kind === 'mvp' ? 'Никто не показал результат заметно выше обычного.' : 'Ни у кого результат не оказался заметно слабым.'}</p>` : ''}</div>`;
  }
  function detailRows(m, f) {
    const r = f.res;
    const rows = r.players.map((q) => ({ q, rp: f.rec.p[q.i] })).filter((x) => x.rp);
    rows.sort((a, b) => (b.q.mvp == null ? -1 : b.q.mvp) - (a.q.mvp == null ? -1 : a.q.mvp) || a.q.i - b.q.i);
    return rows.map(({ q, rp }) => {
      const w = who(m, f, q.i), mark = r.mvp.i === q.i && r.mvp.state === 'assigned' ? 'mvp' : r.worst.i === q.i && r.worst.state === 'assigned' ? 'worst' : '';
      return `<tr class="${mark}"><td>${esc(w.name)}<small>${esc(w.hero)}</small></td><td>${rp.k}/${rp.d}/${rp.s}</td><td>${q.mvp == null ? '—' : f1(q.mvp)}</td><td>${q.weak == null ? '—' : f1(q.weak)}</td>
        <td>${pc(q.c)}${q.lv ? ' · вышел' : !q.e ? ' · не сравнивался' : ''}</td></tr>`;
    }).join('');
  }
  function howBlock(m, f) {
    const r = f.res, used = (k) => (r[k].used || []);
    return `<details class="pf-how"><summary>Как посчитано и на каких данных</summary>
      <p><b>Оценка:</b> ${r.final ? 'окончательная' : 'предварительная'}. Версия алгоритма: <span class="mono">${esc(r.algo)}</span>. Полнота данных: ${pc(r.completeness)}, сравнивались игроков: ${r.eligible} из ${r.players.length}${r.extended ? '. Есть данные разбора реплея (оглушения, варды)' : '. Матч не разобран OpenDota: оглушений и вардов нет, это учтено'}.</p>
      ${r.final ? '' : `<p>${esc(preText(r))}</p>`}
      ${r.mvp.state === 'assigned' ? `<p><b>Для MVP использованы:</b> ${esc(used('mvp').join(', '))}.</p>` : ''}
      ${r.worst.state === 'assigned' ? `<p><b>Для худшего результата использованы:</b> ${esc(used('worst').join(', '))}.</p>` : ''}
      <p>Участие в убийствах, KDA и смерти (относительно среднего по матчу и по команде) сравниваются между игроками. Урон, золото и опыт сравниваются с типичными цифрами <b>того же героя</b> в публичных матчах OpenDota, поэтому саппорт не проигрывает керри автоматически. Лечение, оглушения, варды и урон по строениям дают только бонус и никого не штрафуют. Победа команды добавляет не больше ${I().BONUS.win} баллов.</p>
      <p>Статус не назначается, если лидеров несколько (разрыв меньше ${I().MARGIN} балла), если результат не дотягивает до порога (MVP от ${I().MIN_MVP}, худший от ${I().MIN_WEAK}) или если данных мало. Вышедшие из матча в сравнении не участвуют.</p>
      <div class="im-tw"><table class="im-t"><thead><tr><th>Игрок</th><th>К/С/П</th><th>MVP</th><th>Слабость</th><th>Данные</th></tr></thead><tbody>${detailRows(m, f)}</tbody></table></div>
      <p class="sm"><b>Худший игрок</b> означает худший статистический результат в этом матче. Это не доказательство саботажа или намеренного руина: оценка не видит общение, тильт, решения и роль в драфте.</p></details>`;
  }
  function matchBlock(m) {
    if (!H) return '';
    const f = forMatch(m), head = (right) => `<div class="im-h"><h4>MVP и худший игрок матча</h4>${right || ''}</div>`;
    if (!f) {
      const num = /^\d{6,13}$/.test(String(m.id));
      return `<section class="im-box" aria-label="MVP и худший игрок матча">${head()}<p class="sm">${num ? 'Статистики матча пока нет: подробности подгружаются из OpenDota в фоне. Если этого не произошло, откройте раздел «Игроки» и нажмите «Проанализировать».' : 'Для демо-матчей и матчей без номера OpenDota статусы не определяются: нет цифр игры.'}</p></section>`;
    }
    if (f.res.status !== 'ok') {
      return `<section class="im-box" aria-label="MVP и худший игрок матча">${head()}<div class="im-grid"><div class="im-cell mvp none"><div class="im-lab"><span class="im-chip">MVP</span></div><div class="im-who"><b>${esc(f.res.mvp.text)}</b></div></div>
        <div class="im-cell worst none"><div class="im-lab"><span class="im-chip">Худший</span></div><div class="im-who"><b>${esc(f.res.worst.text)}</b></div></div></div>
        <p class="sm">${esc(I().REASONS[f.res.reason] || '')}</p></section>`;
    }
    return `<section class="im-box" aria-label="MVP и худший игрок матча">${head(`<span class="im-ver" data-tip="Версия алгоритма оценки. Результаты разных версий не смешиваются.">${esc(f.res.algo)}</span>`)}
      <div class="im-grid">${cell('mvp', m, f)}${cell('worst', m, f)}</div>${howBlock(m, f)}</section>`;
  }

  /* ---------- сводки ---------- */
  function siteItems(list) {
    const out = [];
    for (const x of list) {
      const m = x.m || x, p = x.p || (m.players || []).find((q) => q.me);
      const f = forMatch(m);
      if (!f || !p) continue;
      const i = playerIdx(f, p);
      if (i >= 0) out.push({ res: f.res, ref: { i }, m });
    }
    return out;
  }
  function shareText(s, kind) {
    const n = s[kind], share = s[kind + 'Share'];
    return s.enough ? `${n} из ${s.judged} (${pc(share)})` : `${n}`;
  }
  const enoughNote = (s) => (s.enough ? '' : `Доля появится, когда будет не меньше ${I().MIN_SHARE} матчей с определёнными статусами (сейчас ${s.judged}).`);

  /** Блок в профиле игрока из списка знакомых. */
  function playerBlock(e) {
    if (!H) return '';
    const items = siteItems(e.list), s = I().summarize(items);
    const head = '<div class="sec-h" style="margin:0"><h3>MVP и худший игрок матча</h3></div>';
    if (!items.length) {
      return `<section class="card stack im-card">${head}<p class="sm">Статусы пока нельзя определить: для матчей с этим игроком нет статистики. Нажмите «Проанализировать» в блоке выше.</p></section>`;
    }
    const marked = items.map((it) => ({ it, st: I().statusOf(it.res, it.ref) })).filter((x) => x.st).slice(0, 8);
    return `<section class="card stack im-card">${head}
      <div class="im-sum"><div class="im-n mvp" data-tip="Сколько раз этот игрок был MVP в общих с вами матчах"><b>${s.mvp}</b><span>MVP</span></div><div class="im-n worst" data-tip="Сколько раз у этого игрока был худший результат в матче"><b>${s.worst}</b><span>худший</span></div>
        <div class="im-txt"><div>Матчей с определёнными статусами: <b>${s.judged}</b> из ${e.list.length}${s.prelim ? `, предварительных: ${s.prelim}` : ''}</div>
          ${s.enough ? `<div>MVP в ${pc(s.mvpShare)} матчей, худший результат в ${pc(s.worstShare)}</div>` : `<div class="sm">${enoughNote(s)}</div>`}</div></div>
      ${marked.length ? `<div class="pf-list">${marked.map(({ it, st }) => {
        const f = forMatch(it.m), res = it.res, w = who(it.m, f, it.ref.i), x = res[st];
        return `<div class="pf-row"><span class="pf-d"><b>${esc(w.hero)}</b><small>${esc(H.fd(it.m.start))}</small></span>${chip(st, KIND[st][0], tipFor(st, x, w, res), !res.final)}<span class="sm im-why">${esc(x.text)}</span></div>`;
      }).join('')}</div>` : '<p class="sm">В сыгранных вместе матчах этот игрок не получал статусов.</p>'}
      <p class="sm">Статус «худший» означает худший статистический результат в матче, а не доказательство саботажа.</p></section>`;
  }

  /** Сводка по вашим матчам: над списком матчей. */
  function mySummary() {
    if (!H) return '';
    const s = I().summarize(siteItems(H.matches().map((m) => ({ m, p: m.players.find((q) => q.me) }))));
    if (!s.judged) return '';
    return `<div class="im-my" role="status"><span class="im-chip mvp">${H.ico('star')}MVP: ${shareText(s, 'mvp')}</span><span class="im-chip worst">${H.ico('alert')}Худший: ${shareText(s, 'worst')}</span>
      <span class="sm">по ${s.judged} ${H.pl(s.judged, 'матчу', 'матчам', 'матчам')} с определёнными статусами${s.prelim ? `, из них предварительных ${s.prelim}` : ''}. ${esc(enoughNote(s))}</span></div>`;
  }
  /** Фильтр списка матчей: 'mvp' — я был MVP, 'worst' — я сыграл хуже всех. */
  function matchHasMine(m, kind) {
    const me = m.players.find((q) => q.me);
    return !!me && statusFor(m, me) === kind;
  }

  /* ---------- настройки ---------- */
  function settingsBlock() {
    if (!H) return '';
    const all = Object.values(C.m), cur = all.filter((e) => e.algo === I().ALGO).length, old = all.length - cur;
    return `<section class="card stack"><h3>MVP и худший игрок матча</h3>
      <p class="sm">Сайт сам определяет двух игроков в каждом матче со статистикой: с лучшим и с худшим результатом. Расчёт идёт в этом браузере по цифрам OpenDota, на сервер ничего не уходит. Версия алгоритма: <span class="mono">${esc(I().ALGO)}</span>.</p>
      <p class="sm">Сохранено результатов: ${cur}${old ? `, от прошлых версий: ${old} (при открытии матча они пересчитываются и не смешиваются с новыми)` : ''}.</p>
      <div class="actions"><button class="btn sm2" data-a="im-recalc" data-tip="Удалить сохранённые результаты и посчитать заново по текущей версии алгоритма">${H.ico('refresh')}Пересчитать все матчи</button></div></section>`;
  }

  /* ---------- раздел «Найти профиль» (любой игрок OpenDota) ---------- */
  function resForRow(r) {
    const rec = PF() && PF().rec(r.id);
    if (rec && rec.p && rec.p.length) return resultForRec(rec, null);
    const e = C.m[r.id];
    return e && e.algo === I().ALGO ? e : null;
  }
  const refFor = (acc, r) => ({ a: acc, h: r.hero, r: r.side });
  function profileStatus(acc, r) {
    const res = resForRow(r);
    return res ? I().statusOf(res, refFor(acc, r)) : null;
  }
  function profileChip(acc, r) {
    const res = resForRow(r), s = res ? I().statusOf(res, refFor(acc, r)) : null;
    if (!s) return '';
    const st = res[s];
    return chip(s, KIND[s][0], `${KIND[s][1]}. Оценка ${f1(st.score)} из 100. ${st.text} ${res.final ? 'Оценка окончательная.' : 'Оценка предварительная. ' + preText(res)}`, !res.final);
  }
  function profileFilter(rows, acc, mode) {
    if (mode === 'all') return rows;
    return rows.filter((r) => profileStatus(acc, r) === mode);
  }
  function draw() { if (J.render) try { J.render(); } catch (e) { /* страница могла смениться */ } }

  function profileSection(acc, rows, hooks) {
    if (!H) return '';
    J.render = hooks && hooks.render;
    const items = rows.map((r) => ({ res: resForRow(r), ref: refFor(acc, r), r })).filter((x) => x.res);
    const s = I().summarize(items), left = rows.filter((r) => !resForRow(r)).length;
    const marked = items.map((x) => ({ x, st: I().statusOf(x.res, x.ref) })).filter((y) => y.st).slice(0, 8);
    const job = J.run
      ? `<div class="jobline"><div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="${J.total}" aria-valuenow="${J.done}"><i style="width:${J.total ? Math.round(100 * J.done / J.total) : 0}%"></i></div><span class="sm">${esc(J.stage)} ${J.done} из ${J.total}</span><button class="btn sm2" type="button" data-a="im-stop" data-tip="Остановить загрузку. Уже обработанные матчи сохранятся">Остановить</button></div>`
      : `<div class="jobline"><button class="btn" type="button" data-a="im-job" data-tip="Загрузить подробности свежих матчей из OpenDota и определить MVP и худшего игрока в каждом" data-acc="${esc(acc)}" ${left ? '' : 'disabled'}>${H.ico('search')}Определить MVP и худшего</button><span class="sm">${left ? `Матчей без статусов: ${left}. За один запуск обрабатывается до 20 свежих.` : 'Для всех загруженных матчей статусы определены.'}</span></div>`;
    return `<section class="card im-card"><div class="sec-h"><h2>MVP и худший игрок матча</h2></div>
      <p class="me-note" style="margin-bottom:12px">Для каждого матча сайт сравнивает всех десять игроков по цифрам OpenDota: KDA, участие в убийствах, урон, золото и опыт по меркам героя. Статус «худший» — это худший статистический результат, а не доказательство саботажа.</p>
      <div class="im-sum"><div class="im-n mvp"><b>${s.mvp}</b><span>MVP</span></div><div class="im-n worst"><b>${s.worst}</b><span>худший</span></div>
        <div class="im-txt"><div>Матчей с определёнными статусами: <b>${s.judged}</b> из ${rows.length}${s.prelim ? `, предварительных: ${s.prelim}` : ''}</div>
          ${s.enough ? `<div>MVP в ${pc(s.mvpShare)} матчей, худший результат в ${pc(s.worstShare)}</div>` : `<div class="sm">${enoughNote(s)}</div>`}</div></div>
      ${job}${J.msg ? `<div class="banner soft" style="margin-top:12px" role="status">${H.ico('info')}<p>${esc(J.msg)}</p></div>` : ''}
      ${marked.length ? `<div class="pf-list" style="margin-top:12px">${marked.map(({ x, st }) => `<div class="pf-row"><span class="pf-d"><b>${esc(hooks.heroName(x.r.hero))}</b><small>${esc(hooks.date(x.r.start))}</small></span>${chip(st, KIND[st][0], x.res[st].text, !x.res.final)}<span class="sm im-why">${esc(x.res[st].text)}</span></div>`).join('')}</div>` : ''}
      </section>`;
  }

  async function runJob(acc, rows) {
    if (J.run) return;
    const todo = rows.filter((r) => !resForRow(r)).slice(0, 20);
    if (!todo.length) { J.msg = 'Для всех загруженных матчей статусы уже определены.'; draw(); return; }
    J.run = true; J.stop = false; J.done = 0; J.total = todo.length; J.stage = 'Загружаю подробности матчей:'; J.msg = ''; draw();
    const api = PF().api();
    try {
      for (const r of todo) {
        if (J.stop) break;
        try { PF().ingest(await api.getMatchDetail(r.id)); }
        catch (e) { if (e && e.code === 'rate_limit') throw e; }
        J.done++; draw();
      }
      const cnt = {};
      for (const r of todo) { const rec = PF().rec(r.id); if (rec) for (const q of rec.p) cnt[q.h] = (cnt[q.h] || 0) + 1; }
      const need = Object.keys(cnt).filter((h) => !PF().bench()[h]).sort((a, b) => cnt[b] - cnt[a]).slice(0, 25);
      J.stage = 'Загружаю нормы героев:'; J.done = 0; J.total = need.length; draw();
      for (const h of need) {
        if (J.stop) break;
        await PF().fetchBench([h], 1);
        J.done++; draw();
      }
      J.msg = J.stop ? 'Остановлено. Что успели, сохранено.' : 'Готово. Оценки без норм героя помечены как предварительные.';
    } catch (e) {
      J.msg = e && e.code === 'rate_limit' ? 'Лимит запросов OpenDota. Продолжите чуть позже: уже обработанное сохранено.' : 'Не удалось получить часть данных OpenDota. Попробуйте ещё раз.';
    }
    J.run = false; for (const k of Object.keys(memo)) delete memo[k];
    draw();
  }

  /* ---------- события ---------- */
  let rowsFn = null;
  function onClick(ev) {
    if (!H) return;
    const t = ev.target.closest && ev.target.closest('[data-a^="im-"]'); if (!t) return;
    const a = t.dataset.a;
    if (a === 'im-recalc') { C.m = {}; for (const k of Object.keys(memo)) delete memo[k]; try { localStorage.removeItem(LS); } catch (e) { /* не критично */ } H.toast('Результаты будут посчитаны заново.'); H.refresh(true); }
    else if (a === 'im-job' && rowsFn) runJob(t.dataset.acc, rowsFn());
    else if (a === 'im-stop') J.stop = true;
  }
  document.addEventListener('click', onClick);

  /** h: {esc, ico, pl, fd, toast, refresh, matches, heroId, heroName}. */
  function init(h) { H = h; load(); }
  /** Раздел «Найти профиль» сообщает, какие матчи сейчас загружены: нужно для кнопки «Определить». */
  function bindRows(fn) { rowsFn = fn; }

  window.DMImpactUI = { init, bindRows, rowChips, nameBadge, matchBlock, playerBlock, mySummary, matchHasMine, settingsBlock, profileSection, profileChip, profileFilter,
    statusFor, forMatch, state: () => C, job: () => J };
})();
