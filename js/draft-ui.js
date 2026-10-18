/* Dota Mate: страница «Драфт». Доска выбора и банов, подсказки по контрпикам, ручной ввод, подключение к локальному мосту GSI,
   демонстрация, лента событий и история драфтов. Логика в js/draft.js (DMDraft), данные героев и матчапов из OpenDota через DMApi. */
(function () {
  'use strict';
  const D = () => window.DMDraft;
  const LS_BRIDGE = 'dotamate.bridge.v1', LS_HIST = 'dotamate.drafts.v1';
  const HOST_RE = /^(127\.0\.0\.1|localhost):\d{4,5}$/, TOKEN_RE = /^[A-Za-z0-9._-]{8,128}$/;
  const SIDE_LABEL = { radiant: 'Radiant', dire: 'Dire' };
  const ATTRS = { str: 'Сила', agi: 'Ловкость', int: 'Интеллект', all: 'Универсал' };
  const IMG = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/';
  let H = null;
  const P = {
    state: null, undo: [], log: [], mode: 'manual', conn: { status: 'off', host: '', token: '', note: '', lastAt: 0, hasDraft: false, gameState: '', packets: 0 },
    target: { kind: 'picks', side: 'radiant' }, side: 'radiant', pick: { q: '', attr: '', role: '' }, sugg: { sort: 'counter', attr: '', role: '' },
    meta: null, metaState: 'idle', mu: {}, muState: {}, personal: null, persState: 'idle', hist: [], saved: false,
    demoMs: 1300, es: null, retry: 0, retryT: null, demoT: null, tick: null, mounted: false, connOpen: false, live: ''
  };
  const esc = (s) => H.esc(s);
  const ico = (n) => H.ico(n);
  const st = () => (P.state || (P.state = D().empty()));

  /* ---------- хранилище ---------- */
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* без хранилища работаем в памяти */ } }
  function loadHist() { P.hist = D().sanitizeHistory(lsGet(LS_HIST) || []); }
  function saveHist() { lsSet(LS_HIST, P.hist); }
  const bridgeCfg = () => { const c = lsGet(LS_BRIDGE); return c && HOST_RE.test(c.host || '') && TOKEN_RE.test(c.token || '') ? c : null; };

  /* ---------- данные героев и матчапов ---------- */
  let api = null, apiBase = '';
  function API() {
    const base = H.base();
    if (!api || apiBase !== base) {
      let store = null; try { store = window.localStorage; } catch (e) { store = null; }
      api = window.DMApi.create({ base, storage: store, minInterval: H.server() ? 250 : 1000 }); apiBase = base;
    }
    return api;
  }
  function loadMeta() {
    if (P.metaState !== 'idle') return;
    P.metaState = 'loading';
    API().getHeroes().then((list) => {
      const m = {};
      for (const h of list) {
        const id = Number(h.id); if (!(id > 0) || !h.name) continue;
        const slug = String(h.name).replace(/^npc_dota_hero_/, '');
        m[id] = { name: h.localized_name || H.heroName(id) || slug, slug: /^[a-z0-9_]+$/.test(slug) ? slug : '', attr: ['str', 'agi', 'int', 'all'].includes(h.primary_attr) ? h.primary_attr : '', roles: Array.isArray(h.roles) ? h.roles.filter((r) => typeof r === 'string').slice(0, 10) : [] };
      }
      P.meta = m; P.metaState = 'ok'; renderAll();
    }, () => { P.metaState = 'err'; renderAll(); });
  }
  function loadPersonal() {
    const acc = H.myAcc();
    if (!acc || P.persState !== 'idle') return;
    P.persState = 'loading';
    API().getPlayerHeroes(acc).then((rows) => {
      const m = {}; for (const r of rows) if (r && Number(r.hero_id) > 0) m[Number(r.hero_id)] = { games: r.games | 0, win: r.win | 0 };
      P.personal = m; P.persState = 'ok'; renderSugg();
    }, () => { P.persState = 'err'; renderSugg(); });
  }
  function loadMatchups() {
    const s = st(), enemies = s.picks[D().other(mySide())];
    for (const id of enemies) {
      if (P.mu[id] || P.muState[id] === 'loading') continue;
      P.muState[id] = 'loading';
      API().getMatchups(id).then((rows) => { P.mu[id] = rows; P.muState[id] = 'ok'; renderSugg(); }, () => { P.muState[id] = 'err'; renderSugg(); });
    }
    renderSugg();
  }
  const mySide = () => (st().mySide && D().SIDES.includes(st().mySide) ? st().mySide : P.side);
  const heroName = (id) => (P.meta && P.meta[id] && P.meta[id].name) || H.heroName(id) || ('Герой #' + id);
  const heroSlug = (id) => (P.meta && P.meta[id] && P.meta[id].slug) || (st().slugs && st().slugs[id]) || '';
  const initials = (id) => heroName(id).replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  function portrait(id, cls) {
    const slug = heroSlug(id);
    return `<span class="dr-img ${cls || ''}" aria-hidden="true"><span class="dr-ph">${esc(initials(id))}</span>${slug ? `<img src="${IMG}${esc(slug)}.png" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</span>`;
  }

  /* ---------- лента событий ---------- */
  const hhmmss = (t) => new Date(t).toLocaleTimeString('ru-RU');
  function note(text) {
    P.log.unshift({ t: Date.now(), text }); if (P.log.length > 100) P.log.length = 100;
    P.live = text;
  }
  function evText(e) {
    if (e.type === 'pick') return `${SIDE_LABEL[e.side]}: выбор ${heroName(e.hero)}`;
    if (e.type === 'ban') return `${SIDE_LABEL[e.side]}: бан ${heroName(e.hero)}`;
    if (e.type === 'turn') return `Ход: ${SIDE_LABEL[e.side]}`;
    if (e.type === 'done') return 'Драфт завершён';
    return 'Новый драфт';
  }

  /* ---------- применение нового состояния (из игры или демо) ---------- */
  function applyState(next) {
    const prev = P.state;
    if (prev && (prev.source === 'gsi' || prev.source === 'demo') && D().isComplete(prev) && !P.saved && prev.source === 'gsi' && D().diff(prev, next).some((e) => e.type === 'reset')) saveCurrent(true);
    const ev = D().diff(prev, next);
    if (ev.some((e) => e.type === 'reset')) { P.saved = false; P.mu = {}; P.muState = {}; }
    for (const e of ev) note(evText(e));
    P.state = next;
    if (ev.some((e) => e.type === 'done') && next.source === 'gsi') saveCurrent(true);
    loadMatchups(); renderBoard(); renderHead(); renderPick(); renderLog();
  }
  function saveCurrent(auto) {
    const s = st();
    if (D().isEmpty(s)) return;
    P.hist = D().pushHistory(P.hist, s, Date.now()); saveHist(); P.saved = true;
    renderHist(); if (!auto) H.toast('Драфт сохранён в историю.'); else note('Драфт сохранён в историю');
  }

  /* ---------- подключение к мосту ---------- */
  function disconnect(forget) {
    if (P.es) { P.es.close(); P.es = null; }
    clearTimeout(P.retryT); P.retryT = null;
    if (forget) lsSet(LS_BRIDGE, null);
    P.conn.status = 'off'; if (P.mode === 'bridge') P.mode = 'manual';
  }
  function connect(host, token) {
    if (!HOST_RE.test(host) || !TOKEN_RE.test(token)) { P.conn.note = 'Адрес должен быть вида 127.0.0.1:7777, токен: от 8 символов (буквы, цифры, . _ -).'; renderHead(); return false; }
    stopDemo();
    if (P.es) P.es.close();
    clearTimeout(P.retryT);
    lsSet(LS_BRIDGE, { host, token });
    P.conn = { status: 'connecting', host, token, note: '', lastAt: 0, hasDraft: false, gameState: '', packets: 0 };
    P.mode = 'bridge';
    let es;
    try { es = new EventSource(`http://${host}/stream?t=${encodeURIComponent(token)}`); } catch (e) { P.conn.status = 'off'; P.conn.note = 'Браузер не позволил открыть соединение с мостом.'; renderHead(); return false; }
    P.es = es;
    es.addEventListener('hello', (ev) => {
      let j = {}; try { j = JSON.parse(ev.data); } catch (e) { /* оставим пустым */ }
      P.retry = 0; P.conn.status = 'wait'; P.conn.packets = j.packets | 0; P.conn.note = '';
      note('Мост подключён'); renderHead();
    });
    es.addEventListener('gsi', (ev) => {
      let j; try { j = JSON.parse(ev.data); } catch (e) { return; }
      onGsi(j && j.gsi);
    });
    es.onerror = () => {
      /* EventSource сам переподключается, но при неверном токене или закрытом мосте это бесконечные ошибки: управляем сами */
      if (P.es !== es) return;
      es.close(); P.es = null; P.conn.status = 'off';
      P.conn.note = P.retry === 0 ? 'Нет связи с мостом. Проверьте, что он запущен, адрес и токен верны.' : P.conn.note;
      renderHead();
      if (P.mounted) { P.retry = Math.min(P.retry + 1, 6); P.retryT = setTimeout(() => { const c = bridgeCfg(); if (c && P.mounted && P.mode === 'bridge') connect(c.host, c.token); }, Math.min(30000, 2000 * P.retry)); }
    };
    renderHead();
    return true;
  }
  function onGsi(g) {
    const r = D().fromGSI(g);
    P.conn.lastAt = Date.now(); P.conn.packets++; P.conn.gameState = r.gameState || P.conn.gameState;
    if (r.hasDraft) {
      P.conn.hasDraft = true; P.conn.status = 'live';
      const keepSide = r.state.mySide || (P.state && P.state.mySide) || null;
      r.state.mySide = keepSide;
      applyState(r.state);
    } else {
      P.conn.status = 'wait';
      if (r.mySide && P.state) P.state.mySide = r.mySide;
      renderHead();
    }
  }

  /* ---------- демо ---------- */
  function stopDemo() { clearInterval(P.demoT); P.demoT = null; if (P.mode === 'demo') P.mode = 'manual'; }
  function startDemo() {
    disconnect(false); stopDemo();
    const frames = D().demoFrames(); let i = 0;
    P.mode = 'demo'; P.state = null; P.log = []; P.saved = false; P.mu = {}; P.muState = {};
    note('Демонстрация: записанный драфт, это не реальный матч');
    const step = () => {
      applyState(frames[i]);
      i++;
      if (i >= frames.length) { clearInterval(P.demoT); P.demoT = null; }
    };
    step(); P.demoT = setInterval(step, P.demoMs);
    renderAll();
  }

  /* ---------- ручной ввод ---------- */
  function pushUndo() { P.undo.push(D().clone(st())); if (P.undo.length > 30) P.undo.shift(); }
  function manualAdd(id) {
    if (P.mode !== 'manual') return;
    const s = st(), t = P.target;
    const n = t.kind === 'picks' ? D().addPick(s, t.side, id) : D().addBan(s, t.side, id);
    if (!n) { H.toast(D().isTaken(s, id) ? 'Этот герой уже выбран или забанен.' : 'В этой группе нет свободных мест.'); return; }
    pushUndo(); n.source = 'manual'; n.mySide = s.mySide;
    P.state = n; P.saved = false;
    note(evText({ type: t.kind === 'picks' ? 'pick' : 'ban', side: t.side, hero: id }));
    loadMatchups(); renderBoard(); renderPick(); renderLog(); renderHead();
  }
  function manualRemove(id) {
    if (P.mode !== 'manual') return;
    const n = D().removeHero(st(), id); if (!n) return;
    pushUndo(); P.state = n; P.saved = false; note(`Убран герой ${heroName(id)}`);
    renderBoard(); renderPick(); renderSugg(); renderLog(); renderHead();
  }
  function undo() {
    if (P.mode !== 'manual' || !P.undo.length) return;
    P.state = P.undo.pop(); P.saved = false; note('Отменено последнее действие'); renderAll();
  }
  function resetAll() {
    if (P.state && D().isComplete(P.state) && !P.saved && P.mode !== 'demo') saveCurrent(true);
    stopDemo();
    const keep = P.mode === 'bridge';
    P.state = D().empty(); P.undo = []; P.saved = false; P.mu = {}; P.muState = {}; P.log = [];
    if (!keep) P.mode = 'manual';
    renderAll();
  }

  /* ---------- разметка ---------- */
  function fmtT(sec) { if (sec == null || !Number.isFinite(sec)) return '—'; sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
  const live = () => P.mode === 'bridge' && (P.conn.status === 'live');
  const modeLabel = () => P.mode === 'demo' ? 'Демонстрация' : P.mode === 'bridge' ? (P.conn.status === 'live' ? 'Данные из Dota 2' : P.conn.status === 'wait' ? 'Мост подключён' : P.conn.status === 'connecting' ? 'Подключаюсь к мосту' : 'Мост не отвечает') : 'Ручной ввод';
  const modeCls = () => P.mode === 'bridge' && P.conn.status === 'live' ? 'ok' : P.mode === 'bridge' && P.conn.status === 'off' ? 'err' : P.mode === 'manual' ? '' : 'warn';

  function headHtml() {
    const s = st(), a = s.active;
    let status = '';
    if (P.mode === 'bridge') {
      if (P.conn.status === 'live') status = `Игра: ${esc(gameStateName(P.conn.gameState))}. Данные идут в реальном времени.`;
      else if (P.conn.status === 'wait') status = P.conn.packets ? `Игра на связи (${esc(gameStateName(P.conn.gameState))}), но блока драфта пока нет. Он появляется в фазе выбора героев.` : 'Жду данные от Dota 2. Запустите игру и начните поиск матча.';
      else if (P.conn.status === 'connecting') status = 'Подключаюсь…';
      else status = esc(P.conn.note || 'Нет связи с мостом.');
    } else if (P.mode === 'demo') status = 'Проигрывается записанный драфт.';
    else status = 'Нажимайте героев ниже, чтобы вести драфт вручную, или подключите Dota 2.';
    const turn = a && !D().isComplete(s) ? `<span class="dr-turn ${a}">Ход: ${SIDE_LABEL[a]} <b id="dr-timer">${fmtT(remaining())}</b></span>` : D().isComplete(s) ? '<span class="dr-turn done">Драфт завершён</span>' : '';
    const bonus = (s.bonus.radiant != null || s.bonus.dire != null) && a ? `<span class="sm">Запас времени: Radiant ${fmtT(s.bonus.radiant)}, Dire ${fmtT(s.bonus.dire)}</span>` : '';
    return `<div class="dr-head-in"><div class="dr-st"><span class="pill ${modeCls()}">${esc(modeLabel())}</span><p class="sm">${status}</p></div><div class="dr-turnbox">${turn}${bonus}</div>
      <div class="actions"><button class="btn sm2 dr-popbtn" data-a="d-pop" title="Откроется компактное окно, его можно поставить рядом с игрой">Отдельное окно</button><button class="btn sm2" data-a="d-overlay" title="Оверлей с игроками матча: статистика, любимые герои и сигналы для проверки. Использует то же подключение к мосту">Оверлей игроков</button><button class="btn sm2" data-a="d-conn" aria-expanded="${P.connOpen}">${ico('lock')}Подключить Dota 2</button>${P.mode === 'demo' ? `<button class="btn sm2" data-a="d-demostop">Остановить демо</button>` : `<button class="btn sm2" data-a="d-demo">Демо</button>`}
      ${P.mode === 'manual' ? `<button class="btn sm2" data-a="d-undo" ${P.undo.length ? '' : 'disabled'}>Отменить</button>` : ''}
      <button class="btn sm2" data-a="d-save" ${D().isEmpty(s) ? 'disabled' : ''}>${ico('check')}Сохранить</button><button class="btn danger sm2" data-a="d-reset" ${D().isEmpty(s) && !P.log.length ? 'disabled' : ''}>Новый драфт</button></div></div>
      ${P.connOpen ? connHtml() : ''}`;
  }
  function gameStateName(g) {
    const m = { DOTA_GAMERULES_STATE_HERO_SELECTION: 'выбор героев', DOTA_GAMERULES_STATE_STRATEGY_TIME: 'стратегическое время', DOTA_GAMERULES_STATE_PRE_GAME: 'подготовка', DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 'матч идёт', DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD: 'загрузка', DOTA_GAMERULES_STATE_POST_GAME: 'матч закончен', DOTA_GAMERULES_STATE_DISCONNECT: 'отключение' };
    return m[g] || (g ? String(g).replace(/^DOTA_GAMERULES_STATE_/, '').toLowerCase() : 'неизвестно');
  }
  function connHtml() {
    const c = bridgeCfg() || { host: '127.0.0.1:7777', token: '' };
    return `<div class="dr-conn" id="dr-conn"><h3>Подключение к Dota 2</h3>
      <p class="sm">Сайт не может принять данные от игры сам: Dota 2 отправляет их только на адрес вашего компьютера. Поэтому нужен маленький мост, который запускается у вас и передаёт странице только драфт. Ничего не уходит в интернет.</p>
      <ol class="dr-steps"><li>Скачайте <a href="bridge/dota-mate-bridge.js" download>dota-mate-bridge.js</a> и запустите: <code>node dota-mate-bridge.js</code> (нужен Node.js 18 или новее).</li>
        <li>Положите файл cfg, который покажет мост, в папку <code>steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/</code> (или выполните <code>node dota-mate-bridge.js --install "&lt;папка игры&gt;"</code>).</li>
        <li>В Steam: Dota 2, Свойства, Параметры запуска: <code>-gamestateintegration</code>. Перезапустите игру.</li>
        <li>Откройте ссылку, которую напечатал мост, или введите адрес и токен ниже.</li></ol>
      <div class="dr-connform"><div class="field"><label for="dr-host">Адрес моста</label><input id="dr-host" type="text" value="${esc(c.host)}" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label for="dr-token">Токен</label><input id="dr-token" type="password" value="${esc(c.token)}" autocomplete="off" spellcheck="false"></div>
        <button class="btn primary sm2" data-a="d-connect">Подключиться</button>${P.mode === 'bridge' ? `<button class="btn sm2" data-a="d-disconnect">Отключить</button>` : ''}${bridgeCfg() ? `<button class="btn ghost sm2" data-a="d-forget">Забыть мост</button>` : ''}</div>
      ${P.conn.note ? `<p class="sm" role="status" style="color:#f0a0a4">${esc(P.conn.note)}</p>` : ''}
      <p class="sm">Что известно точно, а что нет: формат данных драфта взят из описаний открытых библиотек. Присылает ли ваш режим игры блок драфта, зависит от клиента Dota 2. Если он не приходит, мост сообщит об этом в консоли, а драфт можно вести вручную. Игроков лобби игра не раскрывает, поэтому ваши заметки о них здесь не показываются. Браузер Safari может не разрешить подключение страницы к 127.0.0.1.</p></div>`;
  }

  function slotHtml(side, i) {
    const id = st().picks[side][i], isMine = false;
    if (!id) return `<div class="dr-slot empty ${P.mode === 'manual' && P.target.kind === 'picks' && P.target.side === side && i === st().picks[side].length ? 'next' : ''}" aria-label="Свободное место"><span class="dr-ph">${i + 1}</span></div>`;
    return `<div class="dr-slot" title="${esc(heroName(id))}">${portrait(id, 'big')}<span class="dr-nm">${esc(heroName(id))}</span>${P.mode === 'manual' ? `<button class="dr-x" data-a="d-remove" data-id="${id}" aria-label="Убрать героя ${esc(heroName(id))}">${ico('x')}</button>` : ''}</div>`;
  }
  function teamHtml(side) {
    const s = st(), active = s.active === side && !D().isComplete(s), me = mySide() === side;
    const bans = s.bans[side];
    const comp = P.meta ? D().composition(s, side, P.meta) : null;
    const compHtml = comp && comp.n ? `<div class="dr-comp"><span>${['str', 'agi', 'int', 'all'].filter((k) => comp.attr[k]).map((k) => `${ATTRS[k]} ${comp.attr[k]}`).join(' · ') || ''}</span>${Object.keys(comp.roles).sort((a, b) => comp.roles[b] - comp.roles[a] || a.localeCompare(b)).slice(0, 6).map((r) => `<span class="dr-role">${esc(r)} ${comp.roles[r]}</span>`).join('')}</div>` : '';
    return `<section class="card dr-team ${side} ${active ? 'active' : ''}" aria-label="${SIDE_LABEL[side]}"><div class="dr-th"><h2>${SIDE_LABEL[side]}</h2>${me ? '<span class="dr-me">ваша сторона</span>' : ''}${active ? '<span class="dr-act">выбирает</span>' : ''}</div>
      <div class="dr-bans" aria-label="Баны ${SIDE_LABEL[side]}"><span class="sm">Баны</span>${bans.length ? bans.map((id) => `<span class="dr-ban" title="${esc(heroName(id))}">${portrait(id, 'sm')}${P.mode === 'manual' ? `<button class="dr-x" data-a="d-remove" data-id="${id}" aria-label="Убрать бан ${esc(heroName(id))}">${ico('x')}</button>` : ''}</span>`).join('') : '<span class="sm">нет</span>'}</div>
      <div class="dr-slots">${[0, 1, 2, 3, 4].map((i) => slotHtml(side, i)).join('')}</div>${compHtml}</section>`;
  }
  const boardHtml = () => teamHtml('radiant') + teamHtml('dire');

  /* подсказки */
  function suggHtml() {
    const s = st(), side = mySide(), enemy = s.picks[D().other(side)];
    const f = P.sugg;
    const meta = P.meta || {};
    const pool = P.meta ? null : H.heroIds();
    const metaFor = P.meta ? meta : Object.fromEntries((pool || []).map((id) => [id, {}]));
    const list = D().suggest({ state: s, side, meta: metaFor, pool: pool, matchups: P.mu, personal: P.personal || {}, filter: { attr: f.attr, role: f.role }, sort: f.sort, limit: 12 });
    const loading = enemy.filter((e) => P.muState[e] === 'loading').length, failed = enemy.filter((e) => P.muState[e] === 'err');
    const roles = P.meta ? [...new Set(Object.values(P.meta).flatMap((m) => m.roles))].sort() : [];
    let msg = '';
    if (!enemy.length) msg = `<p class="sm">Врагов ещё не выбрали. Как только появится первый вражеский герой, список отсортируется по тому, кто против него выигрывает чаще.${P.personal ? ' Пока он показывает ваших самых игранных героев.' : ''}</p>`;
    else if (loading) msg = `<p class="sm" role="status">${ico('refresh')} Загружаю данные матчапов: ${loading} из ${enemy.length}…</p>`;
    if (failed.length) msg += `<p class="sm" style="color:#f0a0a4">Не удалось загрузить матчапы: ${failed.map((e) => esc(heroName(e))).join(', ')}. <button class="linkbtn" data-a="d-retry">Повторить</button></p>`;
    if (P.metaState === 'err') msg += '<p class="sm" style="color:#f0a0a4">Не удалось загрузить список героев с OpenDota: показаны только имена, без фильтров.</p>';
    const rows = list.map((r) => {
      const pers = r.personal ? `<span class="dr-pers" title="Ваши матчи на этом герое">у вас ${r.personal.games} ${H.pl(r.personal.games, 'игра', 'игры', 'игр')}, ${Math.round(r.personal.rate * 100)}%</span>` : '';
      const vs = r.vs.map((x) => `<span class="dr-vs ${x.raw >= 0.52 ? 'up' : x.raw <= 0.48 ? 'dn' : ''}" title="Против ${esc(heroName(x.enemy))}: ${x.games} игр">${esc(heroName(x.enemy))} ${Math.round(x.raw * 100)}%</span>`).join('');
      const sc = r.score != null ? `<b class="dr-sc ${r.score >= 0.52 ? 'up' : r.score <= 0.48 ? 'dn' : ''}" title="Сглаженный винрейт против выбранных врагов">${Math.round(r.score * 100)}%</b>` : '<span class="dr-sc na">—</span>';
      const clickable = P.mode === 'manual';
      return `<li class="dr-row"><${clickable ? 'button class="dr-rm" data-a="d-suggpick"' : 'div class="dr-rm"'} data-id="${r.id}" ${clickable ? `title="Добавить в выбор ${SIDE_LABEL[side]}"` : ''}>${portrait(r.id, 'md')}<span class="dr-rt"><span class="pname">${esc(heroName(r.id))}</span><span class="dr-chips">${vs}${pers}${r.total && r.covered < r.total ? `<span class="dr-vs na">данных: ${r.covered} из ${r.total}</span>` : ''}</span></span>${sc}</${clickable ? 'button' : 'div'}></li>`;
    }).join('');
    return `<div class="dr-sh"><h2>Подсказки для ${SIDE_LABEL[side]}</h2>${P.mode === 'manual' && !s.mySide ? `<div class="dr-seg" role="group" aria-label="Ваша сторона">${D().SIDES.map((x) => `<button class="dr-segb" data-a="d-side" data-side="${x}" aria-pressed="${side === x}">${SIDE_LABEL[x]}</button>`).join('')}</div>` : ''}</div>
      <div class="dr-ctl"><div class="dr-seg" role="group" aria-label="Сортировка"><button class="dr-segb" data-a="d-sort" data-s="counter" aria-pressed="${f.sort === 'counter'}">Против врагов</button><button class="dr-segb" data-a="d-sort" data-s="mine" aria-pressed="${f.sort === 'mine'}">Мои герои</button></div>
      ${P.meta ? `<select id="dr-sattr" aria-label="Атрибут"><option value="">Любой атрибут</option>${Object.entries(ATTRS).map(([k, v]) => `<option value="${k}" ${f.attr === k ? 'selected' : ''}>${v}</option>`).join('')}</select><select id="dr-srole" aria-label="Роль"><option value="">Любая роль</option>${roles.map((r) => `<option ${f.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>` : ''}</div>
      ${msg}${rows ? `<ul class="dr-list">${rows}</ul>` : '<p class="sm">Подходящих героев нет.</p>'}
      <p class="sm dr-foot">Проценты: как часто герой выигрывает против выбранных врагов в публичных матчах OpenDota, сглаженно (малые выборки тянутся к 50%). Период и рейтинг не фильтруются. Сочетания с союзниками не считаются: у OpenDota нет таких данных. Это ориентир, а не приказ.${H.myAcc() ? '' : ' Укажите Steam ID в настройках, чтобы видеть свои игры на героях.'}</p>`;
  }

  /* выбор героя вручную */
  function pickHtml() {
    const s = st(), t = P.target, f = P.pick;
    const cnt = (k, side) => `${s[k][side].length}/${k === 'picks' ? D().MAX_PICKS : D().MAX_BANS}`;
    const seg = [['picks', 'radiant'], ['bans', 'radiant'], ['picks', 'dire'], ['bans', 'dire']].map(([k, side]) => `<button class="dr-segb ${side}" data-a="d-target" data-k="${k}" data-side="${side}" aria-pressed="${t.kind === k && t.side === side}">${SIDE_LABEL[side]}: ${k === 'picks' ? 'выбор' : 'бан'} <span class="sm">${cnt(k, side)}</span></button>`).join('');
    const roles = P.meta ? [...new Set(Object.values(P.meta).flatMap((m) => m.roles))].sort() : [];
    return `<div class="dr-sh"><h2>Выбор героя</h2></div><p class="sm">Куда добавлять:</p><div class="dr-seg wrap" role="group" aria-label="Куда добавлять героя">${seg}</div>
      <div class="dr-ctl"><div class="searchbox">${ico('search')}<label class="sm" for="dr-q" style="position:absolute;left:-9999px">Поиск героя</label><input id="dr-q" type="text" placeholder="Найти героя" value="${esc(f.q)}" autocomplete="off"></div>
      ${P.meta ? `<select id="dr-pattr" aria-label="Атрибут"><option value="">Любой атрибут</option>${Object.entries(ATTRS).map(([k, v]) => `<option value="${k}" ${f.attr === k ? 'selected' : ''}>${v}</option>`).join('')}</select><select id="dr-prole" aria-label="Роль"><option value="">Любая роль</option>${roles.map((r) => `<option ${f.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>` : ''}</div>
      <div class="dr-grid" id="dr-grid">${gridHtml()}</div>`;
  }
  function gridHtml() {
    const s = st(), f = P.pick, q = f.q.trim().toLowerCase(), used = D().taken(s);
    const ids = (P.meta ? Object.keys(P.meta).map(Number) : H.heroIds()).filter((id) => {
      const m = P.meta && P.meta[id];
      if (f.attr && !(m && m.attr === f.attr)) return false;
      if (f.role && !(m && m.roles.includes(f.role))) return false;
      return !q || heroName(id).toLowerCase().includes(q);
    }).sort((a, b) => heroName(a).localeCompare(heroName(b), 'ru'));
    if (!ids.length) return '<p class="sm">Никого не найдено.</p>';
    return ids.map((id) => `<button class="dr-h ${used.has(id) ? 'used' : ''}" data-a="d-hero" data-id="${id}" ${used.has(id) ? 'disabled' : ''} aria-label="${esc(heroName(id))}${used.has(id) ? ', уже занят' : ''}" title="${esc(heroName(id))}">${portrait(id, 'tile')}<span class="dr-hn">${esc(heroName(id))}</span></button>`).join('');
  }

  function logHtml() {
    return `<div class="dr-sh"><h2>Лента драфта</h2></div>${P.log.length ? `<ol class="dr-log">${P.log.slice(0, 40).map((l) => `<li><time>${hhmmss(l.t)}</time> ${esc(l.text)}</li>`).join('')}</ol>` : '<p class="sm">Здесь появятся выборы и баны по мере драфта.</p>'}`;
  }
  function histHtml() {
    if (!P.hist.length) return '<p class="sm">Сохранённых драфтов пока нет. Драфт из игры сохраняется сам, когда он закончился; ручной и демо сохраняются кнопкой.</p>';
    const row = (h) => {
      const part = (side) => h.picks[side].map((id) => { const sl = (h.slugs && h.slugs[id]) || (P.meta && P.meta[id] && P.meta[id].slug) || ''; return `<span class="dr-img xs" title="${esc(heroName(id))}"><span class="dr-ph">${esc(initials(id))}</span>${sl ? `<img src="${IMG}${esc(sl)}.png" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>`; }).join('');
      return `<li class="dr-hist"><div><b>${new Date(h.ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b> <span class="sm">${h.source === 'gsi' ? 'из игры' : h.source === 'demo' ? 'демо' : 'вручную'}${h.mySide ? ', вы: ' + SIDE_LABEL[h.mySide] : ''}${h.matchId ? ', матч ' + esc(h.matchId) : ''}</span></div>
        <div class="dr-hp"><span class="dr-hs radiant">${part('radiant')}</span><span class="sm">против</span><span class="dr-hs dire">${part('dire')}</span></div>
        <div class="actions"><button class="btn sm2" data-a="d-open" data-id="${esc(h.id)}">Открыть</button><button class="iconbtn" data-a="d-hdel" data-id="${esc(h.id)}" aria-label="Удалить запись">${ico('trash')}</button></div></li>`;
    };
    return `<ul class="dr-hlist">${P.hist.map(row).join('')}</ul><div class="actions"><button class="btn danger sm2" data-a="d-hclear">Очистить историю</button></div>`;
  }

  /* ---------- отрисовка по частям ---------- */
  const $ = (s) => document.querySelector(s);
  function setHtml(sel, html) { const el = $(sel); if (el) el.innerHTML = html; }
  const renderHead = () => { setHtml('#dr-head', headHtml()); };
  const renderBoard = () => setHtml('#dr-board', boardHtml());
  const renderSugg = () => { if (P.mounted) setHtml('#dr-sugg', suggHtml()); };
  const renderPick = () => { const el = $('#dr-side'); if (!el) return; const manual = P.mode === 'manual'; el.className = 'card dr-panel'; el.innerHTML = manual ? pickHtml() : logHtml(); renderSugg(); };
  const renderLog = () => { if (P.mode !== 'manual') { const el = $('#dr-side'); if (el) el.innerHTML = logHtml(); } const lv = $('#dr-live'); if (lv) lv.textContent = P.live; };
  const renderHist = () => setHtml('#dr-hist', histHtml());
  function renderAll() { if (!P.mounted) return; renderHead(); renderBoard(); renderPick(); renderLog(); renderHist(); }
  function remaining() {
    const s = st(); if (s.timeLeft == null) return null;
    if (P.mode === 'demo') return s.timeLeft;
    return s.timeLeft - (Date.now() - (P.conn.lastAt || Date.now())) / 1000;
  }

  /* ---------- жизненный цикл страницы ---------- */
  function view() {
    return `<div class="pagehead"><div><h1>Драфт</h1><p>Выбор и баны героев в реальном времени: из Dota 2 через локальный мост, вручную или в демонстрации.</p></div></div>
      <div id="dr-root" class="dr">
        <section class="card dr-headc" id="dr-head" aria-label="Состояние драфта"></section>
        <div class="dr-board" id="dr-board"></div>
        <div class="dr-work"><section class="card dr-panel" id="dr-sugg" aria-label="Подсказки"></section><section class="card dr-panel" id="dr-side" aria-label="Герои и лента"></section></div>
        <section class="card dr-panel dr-histcard" aria-label="История драфтов"><div class="dr-sh"><h2>История драфтов</h2></div><div id="dr-hist"></div></section>
        <div id="dr-live" class="sr" aria-live="polite"></div></div>`;
  }
  function mount() {
    P.mounted = true; st(); loadHist(); renderAll(); loadMeta(); loadPersonal(); loadMatchups();
    clearInterval(P.tick);
    P.tick = setInterval(() => { const t = $('#dr-timer'); if (t) t.textContent = fmtT(remaining()); }, 500);
    const c = bridgeCfg();
    if (P.mode === 'manual' && c && !P.es && !P.manualChosen) connect(c.host, c.token);
    else if (P.mode === 'bridge' && !P.es && c) connect(c.host, c.token);
  }
  function leave() {
    if (!P.mounted) return;
    if (P.compact) setCompact(false);
    P.mounted = false; clearInterval(P.tick); clearTimeout(P.retryT); P.retryT = null;
    if (P.es) { P.es.close(); P.es = null; if (P.mode === 'bridge') P.conn.status = 'off'; }
    clearInterval(P.demoT); P.demoT = null; if (P.mode === 'demo') P.mode = 'manual';
  }
  /* Компактное окно: то же состояние и то же подключение к мосту, но без шапки сайта, навигации и истории. */
  function setCompact(on) { P.compact = !!on; try { document.body.classList.toggle('dr-compact', !!on); } catch (e) { /* не критично */ } }
  function popout() {
    const u = new URL(location.href); u.hash = '#/draft?w=1';
    let w = null;
    try { w = window.open(u.toString(), 'dotamate-draft', 'popup=yes,width=440,height=780,left=40,top=40'); } catch (e) { w = null; }
    if (!w) H.toast('Браузер заблокировал новое окно. Разрешите всплывающие окна для этого сайта.');
    else { try { w.focus(); } catch (e) { /* не критично */ } }
  }
  /* Ссылка от моста: #/draft?b=127.0.0.1:7777&t=токен. Токен сохраняем и убираем из адресной строки. */
  function applyLink(query) {
    const q = new URLSearchParams(query || '');
    const b = q.get('b') || '', t = q.get('t') || '', w = q.get('w') === '1';
    if (w) setCompact(true);
    if (!b && !t) return w;
    if (HOST_RE.test(b) && TOKEN_RE.test(t)) { lsSet(LS_BRIDGE, { host: b, token: t }); P.connOpen = false; H.toast('Мост запомнен. Подключаюсь.'); P.manualChosen = false; }
    else H.toast('Ссылка на мост некорректна: адрес должен быть 127.0.0.1 или localhost, токен от 8 символов.');
    try { history.replaceState(null, '', w ? '#/draft?w=1' : '#/draft'); } catch (e) { /* не критично */ }
    return true;
  }

  /* ---------- события ---------- */
  document.addEventListener('click', (ev) => {
    if (!H) return;
    const t = ev.target.closest('[data-a^="d-"]'); if (!t) return;
    const a = t.dataset.a, d = t.dataset;
    switch (a) {
      case 'd-pop': popout(); break;
      case 'd-overlay': { let w = null; try { w = window.open(new URL('overlay.html', location.href).toString(), 'dotamate-overlay', 'popup=yes,width=860,height=720,left=40,top=40'); } catch (e) { w = null; } if (!w) H.toast('Браузер заблокировал новое окно. Разрешите всплывающие окна для этого сайта.'); break; }
      case 'd-conn': P.connOpen = !P.connOpen; renderHead(); break;
      case 'd-connect': { const ok = connect(($('#dr-host') || {}).value.trim(), ($('#dr-token') || {}).value.trim()); if (ok) P.connOpen = false; renderHead(); break; }
      case 'd-disconnect': disconnect(false); P.manualChosen = true; renderAll(); break;
      case 'd-forget': disconnect(true); P.manualChosen = true; P.conn.note = ''; renderAll(); break;
      case 'd-demo': startDemo(); break;
      case 'd-demostop': stopDemo(); renderAll(); break;
      case 'd-undo': undo(); break;
      case 'd-save': saveCurrent(false); break;
      case 'd-reset': resetAll(); break;
      case 'd-remove': manualRemove(Number(d.id)); break;
      case 'd-target': P.target = { kind: d.k, side: d.side }; renderPick(); break;
      case 'd-hero': manualAdd(Number(d.id)); break;
      case 'd-suggpick': { const side = mySide(); P.target = { kind: 'picks', side }; manualAdd(Number(d.id)); break; }
      case 'd-side': P.side = d.side; loadMatchups(); renderSugg(); break;
      case 'd-sort': P.sugg.sort = d.s; renderSugg(); break;
      case 'd-retry': for (const k of Object.keys(P.muState)) if (P.muState[k] === 'err') delete P.muState[k]; loadMatchups(); break;
      case 'd-open': {
        const h = P.hist.find((x) => x.id === d.id); if (!h) break;
        disconnect(false); stopDemo(); P.manualChosen = true;
        const s = D().empty(); s.picks = D().clone(h.picks); s.bans = D().clone(h.bans); s.mySide = h.mySide; s.matchId = h.matchId; s.slugs = Object.assign({}, h.slugs); s.source = 'manual';
        P.state = s; P.undo = []; P.saved = true; P.mu = {}; P.muState = {}; P.log = []; note('Открыт сохранённый драфт'); loadMatchups(); renderAll(); window.scrollTo(0, 0); break;
      }
      case 'd-hdel': P.hist = P.hist.filter((x) => x.id !== d.id); saveHist(); renderHist(); break;
      case 'd-hclear': P.hist = []; saveHist(); renderHist(); break;
    }
  });
  document.addEventListener('input', (ev) => {
    if (!H) return;
    if (ev.target.id === 'dr-q') { P.pick.q = ev.target.value; setHtml('#dr-grid', gridHtml()); }
  });
  document.addEventListener('change', (ev) => {
    if (!H) return;
    const t = ev.target;
    if (t.id === 'dr-pattr') { P.pick.attr = t.value; setHtml('#dr-grid', gridHtml()); }
    else if (t.id === 'dr-prole') { P.pick.role = t.value; setHtml('#dr-grid', gridHtml()); }
    else if (t.id === 'dr-sattr') { P.sugg.attr = t.value; renderSugg(); }
    else if (t.id === 'dr-srole') { P.sugg.role = t.value; renderSugg(); }
  });
  /* Нет картинки героя: остаются инициалы. */
  document.addEventListener('error', (ev) => { const t = ev.target; if (t && t.tagName === 'IMG' && t.closest && t.closest('.dr-img')) t.remove(); }, true);

  function init(h) { H = h; }
  window.DMDraftUI = { init, setCompact, view, mount, leave, applyLink, state: P, bridgeConfig: bridgeCfg };
})();
