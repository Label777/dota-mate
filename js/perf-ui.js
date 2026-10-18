/* Dota Mate: автоматическая оценка игроков по игре и карточки игроков (в том числе скрытых) внутри матча.
   Расчёт в js/perf.js (DMPerf). Здесь: сбор статистики матчей в фоне (OpenDota), локальный кэш, значки, блоки в карточках и настройки.
   Кэш лежит только в этом браузере (dotamate.perf.v1), на сервер Dota Mate не отправляется: его можно пересобрать из OpenDota. */
(function () {
  'use strict';
  const LS = 'dotamate.perf.v1';
  const MAX_MATCHES = 300, RUN_MATCHES = 30, RUN_BENCH = 40, BENCH_TTL = 3 * 864e5;
  let H = null, api = null, apiBase = '';
  const C = { v: 1, auto: true, m: {}, b: {} };   // m: записи матчей, b: бенчмарки героев {t, d}
  const E = { st: 'idle', done: 0, total: 0, msg: '', running: false, ver: 0, retryAfter: 0 };
  const memo = {};
  let saveT = null;

  const esc = (s) => H.esc(s);
  const P = () => window.DMPerf;

  /* ---------- кэш ---------- */
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(LS) || 'null');
      if (j && j.v === 1) { C.auto = j.auto !== false; C.m = j.m && typeof j.m === 'object' ? j.m : {}; C.b = j.b && typeof j.b === 'object' ? j.b : {}; }
    } catch (e) { /* пустой кэш */ }
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try {
        const ids = Object.keys(C.m);
        if (ids.length > MAX_MATCHES) for (const id of ids.slice(0, ids.length - MAX_MATCHES)) delete C.m[id];
        localStorage.setItem(LS, JSON.stringify(C));
      } catch (e) { /* не критично: останется в памяти */ }
    }, 300);
  }
  function API() {
    const base = H.base();
    if (!api || apiBase !== base) {
      let st = null; try { st = window.localStorage; } catch (e) { st = null; }
      api = window.DMApi.create({ base, storage: st, minInterval: H.server() ? 250 : 1100 }); apiBase = base;
    }
    return api;
  }
  const benchMap = () => { const o = {}; const now = Date.now(); for (const k of Object.keys(C.b)) if (C.b[k] && C.b[k].d && now - C.b[k].t < BENCH_TTL * 3) o[k] = C.b[k].d; return o; };

  /* ---------- данные ---------- */
  /** Вызывается при добавлении матча из OpenDota: статистика уже в ответе, лишний запрос не нужен. */
  function ingest(j) {
    try {
      const rec = P().fromDetail(j, H.meAcc());
      if (!rec) return;
      C.m[rec.id] = rec; E.ver++; save();
    } catch (e) { /* не мешаем добавлению матча */ }
  }
  function scores(m) {
    const rec = C.m[m.id];
    if (!rec) return null;
    const c = memo[m.id];
    if (c && c.ver === E.ver) return c;
    const out = { ver: E.ver, rec, arr: P().scoreMatch(rec, benchMap(), m.dur || rec.dur) };
    memo[m.id] = out; return out;
  }
  /** Оценка одного игрока в матче: {s, r, i} или null, если по матчу нет статистики или игрока не нашли. */
  function forPlayer(m, p) {
    const sc = scores(m); if (!sc) return null;
    const i = P().findRecord(sc.rec, p, H.heroId);
    return i < 0 ? null : { s: sc.arr[i], r: sc.rec.p[i], i };
  }
  /** Итог по игроку из списка знакомых (запись pIndex: e.list = [{m, p, role}]). */
  function aggFor(e) {
    const items = [];
    for (const x of e.list) { const f = forPlayer(x.m, x.p); if (f) items.push(Object.assign({}, f.s, { ts: x.m.start })); }
    const a = P().aggregate(items); a.total = e.list.length; a.items = items.length; return a;
  }

  /** Для модуля MVP: запись матча, бенчмарки героев и загрузка недостающих бенчмарков (не больше limit за раз). */
  const recOf = (id) => C.m[id] || null;
  async function fetchBench(ids, limit) {
    const now = Date.now(); let n = 0;
    for (const h of ids) {
      if (n >= (limit || 30)) break;
      if (C.b[h] && now - C.b[h].t < BENCH_TTL) continue;
      const j = await API().getBenchmarks(h);   // ошибка (лимит запросов) уходит вызывающему
      C.b[h] = { t: Date.now(), d: P().benchFrom(j) || null }; E.ver++; n++;
    }
    save();
    return n;
  }

  /* ---------- фоновый сбор ---------- */
  const need = () => H.matches().filter((m) => /^\d{6,13}$/.test(String(m.id)) && !C.m[m.id]);
  function heroesNeeded() {
    const cnt = {}, now = Date.now();
    for (const rec of Object.values(C.m)) for (const p of rec.p) cnt[p.h] = (cnt[p.h] || 0) + 1;
    return Object.keys(cnt).filter((h) => !(C.b[h] && now - C.b[h].t < BENCH_TTL)).sort((a, b) => cnt[b] - cnt[a]);
  }
  const pending = () => ({ matches: need().length, heroes: heroesNeeded().length });
  function setState(patch) { Object.assign(E, patch); paintStatus(); }
  async function scan(manual) {
    if (E.running) return;
    if (!manual && !C.auto) return;
    if (!manual && E.retryAfter > Date.now()) return;
    const todo = need().slice(0, manual ? 60 : RUN_MATCHES), pend = pending();
    if (!todo.length && !pend.heroes) { if (manual) setState({ st: 'done', msg: 'Всё уже проанализировано.' }); return; }
    E.running = true; E.retryAfter = 0;
    const heroes = heroesNeeded().length;   // уточним после матчей
    let done = 0; const total = todo.length;
    setState({ st: 'run', done: 0, total: total + Math.min(heroes, RUN_BENCH), msg: '' });
    try {
      for (const m of todo) {
        try {
          const j = await API().getMatchDetail(m.id);
          const rec = P().fromDetail(j, H.meAcc());
          if (rec) { C.m[rec.id] = rec; E.ver++; }
          else C.m[m.id] = { v: 1, id: String(m.id), dur: m.dur || 0, mr: null, p: [] };   // чтобы не запрашивать снова
        } catch (e) {
          if (e && (e.code === 'rate_limit')) throw e;
          if (e && e.code === 'not_found') C.m[m.id] = { v: 1, id: String(m.id), dur: m.dur || 0, mr: null, p: [] };
        }
        done++; E.done = done; save(); paintStatus();
      }
      const hs = heroesNeeded().slice(0, RUN_BENCH);
      E.total = done + hs.length;
      for (const h of hs) {
        try {
          const j = await API().getBenchmarks(h);
          const d = P().benchFrom(j);
          C.b[h] = { t: Date.now(), d: d || null }; E.ver++;
        } catch (e) { if (e && e.code === 'rate_limit') throw e; }
        done++; E.done = done; save(); paintStatus();
      }
      const left = pending();
      setState({ st: 'done', msg: left.matches ? `Проанализировано, осталось матчей: ${left.matches}.` : 'Готово.' });
    } catch (e) {
      E.retryAfter = Date.now() + 5 * 60000;
      setState({ st: 'err', msg: e && e.code === 'rate_limit' ? 'Лимит запросов OpenDota. Анализ продолжится позже.' : 'Не удалось получить данные OpenDota. Анализ продолжится позже.' });
    }
    E.running = false;
    for (const k of Object.keys(memo)) delete memo[k];
    save(); H.refresh();
  }

  /* ---------- разметка ---------- */
  const band = (st) => (st == null ? '' : st >= 3.5 ? 'pos' : st >= 2.7 ? '' : st >= 2 ? 'warn' : 'neg');
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const kda = (r) => `${r.k}/${r.d}/${r.s}`;
  const NOTE = 'Оценка по цифрам матча, а не по поведению: она не видит общение, тильт и решения.';

  function statusHtml() {
    const p = pending();
    let txt = '', btn = '';
    if (E.st === 'run') txt = `Анализирую игры: ${E.done} из ${E.total}…`;
    else if (E.st === 'err' || E.st === 'done') txt = E.msg;
    else if (!Object.keys(C.m).length && !p.matches) txt = 'Автооценка появится, когда в матчах будут игроки с данными OpenDota.';
    else if (p.matches) txt = `Матчей без анализа: ${p.matches}.`;
    else txt = 'Все матчи проанализированы.';
    if (E.st !== 'run' && (p.matches || p.heroes)) btn = `<button class="btn sm2" data-a="pf-scan" data-tip="Загрузить статистику матчей из OpenDota и посчитать оценки">${H.ico('refresh')}Проанализировать</button>`;
    return `<span class="pill ${E.st === 'err' ? 'err' : E.st === 'done' ? 'ok' : ''}" role="status">${E.st === 'run' ? '<span class="spin"></span>' : H.ico('star')}${esc(txt)}</span>${btn}`;
  }
  function paintStatus() { document.querySelectorAll('.pf-stat').forEach((el) => { el.innerHTML = statusHtml(); }); }
  const statusBox = () => `<div class="pf-stat" aria-live="polite">${statusHtml()}</div>`;

  /** Значок итоговой оценки игрока в списках. */
  function badge(e) {
    const a = e.auto || (e.auto = aggFor(e));
    if (!a.n) return '';
    const tip = `Оценка по игре: ${f1(a.stars)} из 5 (${P().verdict(a.stars)}). Матчей со статистикой: ${a.n}, ${P().CONF[a.conf]}. ${NOTE}`;
    return `<span class="pf-chip ${band(a.stars)}" data-tip="${esc(tip)}">${H.ico('star')}${f1(a.stars)}<small>${a.n}</small></span>`;
  }
  /** Значок оценки игрока в одном матче. */
  function matchChip(m, p) {
    const f = forPlayer(m, p);
    if (!f || f.s.score == null) return '';
    const s = f.s, r = f.r;
    const tip = `Оценка по игре: ${f1(s.stars)} из 5. ${r.k}/${r.d}/${r.s}, ${Math.round(r.g)} золота в минуту. ${P().explain(s)}`;
    return `<span class="pf-chip ${band(s.stars)}" data-tip="${esc(tip)}">${H.ico('star')}${f1(s.stars)}<small>${kda(r)}</small></span>`;
  }

  const POS = { 1: '1-й по золоту в команде', 2: '2-й по золоту в команде', 3: '3-й по золоту в команде', 4: '4-й по золоту в команде', 5: '5-й по золоту в команде' };
  function bar(v) { return `<span class="pf-bar" aria-hidden="true"><i style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></i></span>`; }
  function method() {
    return `<details class="pf-how"><summary>Как считается эта оценка</summary>
      <p>Для каждого матча берутся цифры игрока: золото и опыт в минуту, урон по героям, убийства, лечение, смерти, помощь. Они сравниваются с тем, как на <b>этом же герое</b> играют в публичных матчах OpenDota (процентили), поэтому у саппорта планка ниже, чем у кора. Если данных по герою нет, сравнение идёт с остальными участниками матча.</p>
      <p>Итог от 0 до 100: 60% вклад по меркам героя, 20% участие в убийствах команды, 20% смерти против среднего по матчу. Звёзды: 1 + 4 × итог / 100. Матчи короче 10 минут не считаются, выход из матча сильно снижает оценку.</p>
      <p><b>Чего оценка не знает.</b> Общение, тильт, троллинг, рискованные, но полезные решения, роль внутри драфта. Это ориентир по цифрам, ваша личная оценка остаётся отдельно и главнее.</p></details>`;
  }

  /** Блок в карточке игрока (страница игрока). */
  function playerBlock(e) {
    const a = aggFor(e);
    const head = `<div class="sec-h" style="margin:0"><h3>Оценка по игре (автоматическая)</h3>${statusBox()}</div>`;
    if (!a.n) {
      const manual = !/^\d+$/.test(String(e.sid));
      return `<section class="card stack pf-card">${head}<p class="sm">${e.list.length ? 'Для матчей с этим игроком пока нет статистики. Нажмите «Проанализировать»: сайт запросит подробности матчей у OpenDota (нужны матчи с открытыми данными).' : ''}${manual ? ' Игроки, добавленные вручную, находятся по герою и стороне, если матч есть в OpenDota.' : ''}</p>${method()}</section>`;
    }
    const rows = e.list.map((x) => { const f = forPlayer(x.m, x.p); return f ? { x, f } : null; }).filter(Boolean).slice(0, 12);
    const missing = e.list.length - a.items;
    const trend = a.trend ? `<span class="sm">${esc(P().TREND[a.trend])}</span>` : '';
    return `<section class="card stack pf-card">${head}
      <div class="pf-sum"><div class="pf-big ${band(a.stars)}" data-tip="${esc(NOTE)}"><b>${f1(a.stars)}</b><span>из 5</span></div>
        <div style="min-width:0"><div class="avg">${H.stars(a.stars)}<b>${esc(P().verdict(a.stars))}</b></div>
          <div class="sm">Матчей со статистикой: ${a.n}${missing > 0 ? ` из ${e.list.length}` : ''}. ${esc(P().CONF[a.conf][0].toUpperCase() + P().CONF[a.conf].slice(1))}. ${trend}</div>
          ${a.leavers ? `<div class="sm" style="color:#f0a0a4">Выходов из матча: ${a.leavers}</div>` : ''}
          ${a.hero < a.n ? `<div class="sm">В ${a.n - a.hero} из ${a.n} сравнение шло внутри матча: нет данных по герою.</div>` : ''}</div></div>
      <div class="pf-list">${rows.map(({ x, f }) => {
        const s = f.s, r = f.r;
        return `<div class="pf-row"><span class="pf-d"><b>${esc(x.p.hero)}</b><small>${esc(H.fd(x.m.start))} · ${x.role === 'ally' ? 'союзник' : 'соперник'}${s.pos ? ' · ' + POS[s.pos] : ''}</small></span>
          <span class="pf-k" data-tip="Убийства / смерти / помощь">${kda(r)}</span><span class="pf-k" data-tip="Золото в минуту">${Math.round(r.g)} <small>gpm</small></span>
          ${s.score == null ? `<span class="pf-chip" data-tip="${esc(P().explain(s))}">без оценки</span>` : `<span class="pf-chip ${band(s.stars)}" data-tip="${esc(P().explain(s))}">${H.ico('star')}${f1(s.stars)}</span>`}</div>`;
      }).join('')}</div>
      ${missing > 0 ? `<p class="sm">По ${missing} ${H.pl(missing, 'матчу', 'матчам', 'матчам')} статистики нет (нет данных OpenDota или матч добавлен вручную).</p>` : ''}
      ${method()}</section>`;
  }

  /** Карточка игрока в матче (в том числе со скрытым профилем): модальное окно. */
  function cardModal() {
    const c = H.V().pcard || {}, m = H.matchById(c.mid), p = m && m.players[c.i];
    if (!m || !p) return '';
    const f = forPlayer(m, p), known = p.sid && !p.me;
    const back = `<button class="btn ghost sm2" data-a="openMatch" data-id="${esc(m.id)}">${H.ico('back')}К матчу</button>`;
    const sideTxt = p.me ? 'это вы' : p.ally ? 'союзник' : 'соперник';
    let body = '';
    if (!f) body = `<p class="sm">Статистики этого игрока в матче нет. ${/^\d{6,13}$/.test(String(m.id)) ? 'Нажмите «Проанализировать» на странице «Игроки», чтобы загрузить подробности матча из OpenDota.' : 'Матч добавлен вручную или это демо-данные.'}</p>`;
    else {
      const s = f.s, r = f.r;
      const cell = (k, v, tip) => `<div class="sx-kv" ${tip ? `data-tip="${esc(tip)}"` : ''}><div class="k">${k}</div><div class="v">${v}</div></div>`;
      body = `<div class="pf-sum"><div class="pf-big ${band(s.stars)}"><b>${s.stars == null ? '—' : f1(s.stars)}</b><span>из 5</span></div>
        <div style="min-width:0"><div class="avg">${s.stars == null ? '' : H.stars(s.stars)}<b>${esc(P().verdict(s.stars))}</b></div><div class="sm">${esc(P().explain(s))}</div></div></div>
        ${s.score == null ? '' : `<div class="pf-parts"><div>Вклад по меркам героя ${bar(s.imp)}<small>${Math.round(s.imp * 100)}%</small></div><div>Участие в убийствах ${bar(s.part)}<small>${Math.round(s.part * 100)}%</small></div><div>Живучесть ${bar(s.surv)}<small>${Math.round(s.surv * 100)}%</small></div></div>`}
        <div class="sx-kvs pf-kvs">${cell('К / С / П', kda(r), 'Убийства / смерти / помощь')}${cell('Золото в минуту', Math.round(r.g))}${cell('Опыт в минуту', Math.round(r.x))}${cell('Урон по героям', r.hd == null ? '—' : r.hd.toLocaleString('ru-RU'))}${cell('Добито', r.lh, 'Добитые вражеские и нейтральные крипы')}${cell('Урон по зданиям', r.td == null ? '—' : r.td.toLocaleString('ru-RU'))}</div>
        ${s.pos ? `<p class="sm">По золоту в своей команде: ${POS[s.pos]}.</p>` : ''}`;
    }
    const who = known
      ? `<p class="sm">Профиль в Dota 2 открыт: можно посмотреть все матчи игрока.</p><div class="actions"><button class="btn primary sm2" data-a="openPlayer" data-id="${esc(p.sid)}">${H.ico('user')}Профиль игрока</button>${/^\d+$/.test(String(p.sid)) ? `<button class="btn sm2" data-a="openProfile" data-id="${esc(p.sid)}">Статистика на OpenDota</button>` : ''}</div>`
      : p.me ? '' : `<div class="banner soft" role="note">${H.ico('lock')}<p class="sm">Игрок скрыл профиль, поэтому его нельзя связать с другими матчами и оценка относится только к этой игре.</p></div>`;
    return `<div class="panel-h"><div style="display:flex;gap:12px;align-items:center;min-width:0">${H.av(p.name, 'md', p.sid)}<div style="min-width:0"><h3 id="mt" style="overflow-wrap:anywhere">${esc(p.name)}</h3>${window.DMRepChip ? DMRepChip.badges(p.sid) : ''}<small>${esc(p.hero)} · ${sideTxt} · ${esc(H.fd(m.start))}</small></div></div><button class="iconbtn" data-a="close" aria-label="Закрыть">${H.ico('x')}</button></div>
      <div class="panel-b">${body}${who}${method()}<div class="actions">${back}</div></div>`;
  }

  /** Строка игрока в матче: значок оценки и кнопка карточки. */
  function matchRowExtra(m, i) {
    const p = m.players[i];
    return `${matchChip(m, p)}<button class="btn ghost sm2" data-a="pf-card" data-mid="${esc(m.id)}" data-i="${i}" data-tip="Карточка игрока в этом матче: цифры игры и оценка">${H.ico('user')}Карточка</button>`;
  }

  function settingsBlock() {
    const n = Object.keys(C.m).length;
    return `<section class="card stack"><h3>Автооценка игроков</h3>
      <p class="sm">Сайт сам загружает подробности ваших матчей из OpenDota и оценивает игру каждого участника по цифрам. Оценка автоматическая и отдельная от ваших личных оценок: она ничего в них не меняет. Загружается до ${RUN_MATCHES} матчей за раз.</p>
      <label class="optin" for="pf-auto"><input type="checkbox" id="pf-auto" ${C.auto ? 'checked' : ''}><span>Анализировать матчи автоматически<br><small>Если выключить, анализ запускается только кнопкой «Проанализировать».</small></span></label>
      ${statusBox()}
      <p class="sm">Сохранено статистики матчей: ${n}. Хранится только в этом браузере, на сервер Dota Mate не отправляется.</p>
      <div class="actions"><button class="btn danger sm2" data-a="pf-clear" data-tip="Удалить сохранённую статистику матчей. Её можно загрузить снова">${H.ico('trash')}Очистить кэш статистики</button></div></section>`;
  }

  /* ---------- события ---------- */
  function onClick(ev) {
    if (!H) return;
    const t = ev.target.closest('[data-a^="pf-"]'); if (!t) return;
    const a = t.dataset.a;
    if (a === 'pf-scan') scan(true);
    else if (a === 'pf-card') H.openCard(t.dataset.mid, Number(t.dataset.i));
    else if (a === 'pf-clear') { C.m = {}; C.b = {}; E.ver++; E.st = 'idle'; for (const k of Object.keys(memo)) delete memo[k]; try { localStorage.removeItem(LS); } catch (e) { /* не критично */ } H.toast('Кэш статистики очищен.'); H.refresh(true); }
  }
  function onChange(ev) {
    if (ev.target && ev.target.id === 'pf-auto') { C.auto = !!ev.target.checked; save(); if (C.auto) setTimeout(() => scan(false), 200); H.toast(C.auto ? 'Автоматический анализ включён.' : 'Автоматический анализ выключен.'); }
  }
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);

  function init(h) {
    H = h; load();
    setTimeout(() => scan(false), 2500);
  }
  window.DMPerfUI = { init, ingest, bench: benchMap, rec: recOf, fetchBench, api: API, ver: () => E.ver, scan, forPlayer, aggFor, badge, matchChip, playerBlock, cardModal, matchRowExtra, settingsBlock, statusBox, pending, state: () => E, cache: () => C };
})();
