/* Dota Mate: быстрый поиск и переходы (Ctrl+K, Cmd+K или «/»). Разделы, действия, знакомые игроки, матчи, открыть профиль по Steam ID.
   Только интерфейс: данные и действия приходят из index.html через DMQuick.init. */
(function () {
  'use strict';
  let H = null, root = null, items = [], act = 0, lastFocus = null;
  const esc = (s) => H.esc(s);
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

  function build(q) {
    const nq = norm(q).trim(), toks = nq.split(/\s+/).filter(Boolean), out = [];
    const match = (label, extra) => {
      if (!toks.length) return 1;
      const hay = norm(label + ' ' + (extra || ''));
      if (!toks.every((t) => hay.includes(t))) return 0;
      return norm(label).startsWith(toks[0]) ? 3 : 2;
    };
    const group = (title, list) => { if (list.length) out.push({ head: title }); list.forEach((x) => out.push(x)); };
    const acc = q.trim() ? H.parse(q.trim()) : null;
    if (acc) out.push({ head: 'Игрок по ссылке или ID' }, { kind: 'profile', id: acc, label: 'Открыть профиль игрока ' + acc, hint: 'Статистика из OpenDota', icon: 'user' });
    const pages = H.pages().map((n) => ({ kind: 'page', id: n[0], label: n[2], hint: 'Раздел', icon: n[1], r: match(n[2]) })).filter((x) => x.r);
    const actions = [
      { kind: 'act', id: 'sync', label: 'Синхронизировать матчи', hint: 'Загрузить новые матчи из OpenDota', icon: 'refresh', kw: 'обновить загрузить opendota' },
      { kind: 'act', id: 'add', label: 'Добавить матч', hint: 'По ссылке или вручную', icon: 'plus', kw: 'новый ссылка' },
      { kind: 'act', id: 'rateall', label: 'Оценить игроков последнего матча', hint: 'Быстрая оценка всего состава', icon: 'star', kw: 'оценка звезды' },
      { kind: 'act', id: 'settings', label: 'Резервная копия и импорт', hint: 'Настройки', icon: 'sliders', kw: 'экспорт импорт бэкап файл json' }
    ].map((x) => Object.assign(x, { r: match(x.label, x.kw) })).filter((x) => x.r);
    const players = H.players().map((e) => ({ kind: 'player', id: e.sid, label: e.name, hint: `${e.withN ? 'вместе: ' + e.withN : ''}${e.withN && e.vsN ? ', ' : ''}${e.vsN ? 'против: ' + e.vsN : ''}${e.auto && e.auto.stars != null ? ' · по игре ' + e.auto.stars.toFixed(1) : ''}`, icon: 'user', r: match(e.name, e.sid), last: e.last }))
      .filter((x) => x.r).sort((a, b) => b.r - a.r || b.last - a.last).slice(0, toks.length ? 6 : 4);
    const matches = H.matches().map((m) => ({ kind: 'match', id: m.id, label: `${m.win ? 'Победа' : 'Поражение'} на ${m.hero}`, hint: `${H.fd(m.start)} · ${m.mode}`, icon: 'list', r: match(`${m.win ? 'победа' : 'поражение'} ${m.hero} ${m.mode} ${m.id}`) }))
      .filter((x) => x.r && toks.length).slice(0, 5);
    group('Разделы', pages); group('Действия', actions); group(toks.length ? 'Игроки' : 'Недавние игроки', players); group('Матчи', matches);
    return out;
  }

  function render() {
    const list = root.querySelector('.qk-list'); let n = 0;
    list.innerHTML = items.length ? items.map((x) => {
      if (x.head) return `<div class="qk-head" role="presentation">${esc(x.head)}</div>`;
      const i = n++;
      return `<button class="qk-i ${i === act ? 'on' : ''}" id="qk-${i}" role="option" aria-selected="${i === act}" data-i="${i}">${H.ico(x.icon)}<span class="qk-l"><b>${esc(x.label)}</b>${x.hint ? `<small>${esc(x.hint)}</small>` : ''}</span></button>`;
    }).join('') : '<p class="qk-none">Ничего не найдено. Можно вставить Steam ID или ссылку на профиль Steam.</p>';
    const inp = root.querySelector('input'); inp.setAttribute('aria-activedescendant', n ? 'qk-' + act : '');
    const el = list.querySelector('.qk-i.on'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  const selectable = () => items.filter((x) => !x.head);
  function refresh() { items = build(root.querySelector('input').value); act = 0; render(); }
  function open() {
    if (root) return;
    lastFocus = document.activeElement;
    root = document.createElement('div'); root.className = 'qk-ov'; root.setAttribute('data-qk', '1');
    root.innerHTML = `<div class="qk" role="dialog" aria-modal="true" aria-label="Быстрый поиск"><div class="qk-in">${H.ico('search')}<input type="text" role="combobox" aria-expanded="true" aria-controls="qk-list" aria-autocomplete="list" placeholder="Раздел, игрок, матч или Steam ID" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div><div class="qk-list" id="qk-list" role="listbox"></div><p class="qk-foot">Стрелки и Enter. Ctrl+K открывает это окно с любой страницы.</p></div>`;
    document.body.appendChild(root);
    const inp = root.querySelector('input'); inp.focus();
    inp.addEventListener('input', refresh);
    root.addEventListener('click', (ev) => {
      if (ev.target === root) { close(); return; }
      const b = ev.target.closest('.qk-i'); if (b) run(selectable()[Number(b.dataset.i)]);
    });
    root.addEventListener('mousemove', (ev) => { const b = ev.target.closest('.qk-i'); if (b && Number(b.dataset.i) !== act) { act = Number(b.dataset.i); root.querySelectorAll('.qk-i').forEach((e) => { const on = Number(e.dataset.i) === act; e.classList.toggle('on', on); e.setAttribute('aria-selected', on); }); inp.setAttribute('aria-activedescendant', 'qk-' + act); } });
    inp.addEventListener('keydown', (ev) => {
      const sel = selectable();
      if (ev.key === 'ArrowDown') { ev.preventDefault(); act = sel.length ? (act + 1) % sel.length : 0; render(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); act = sel.length ? (act - 1 + sel.length) % sel.length : 0; render(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (sel[act]) run(sel[act]); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      else if (ev.key === 'Tab') { ev.preventDefault(); }
    });
    refresh();
  }
  function close() {
    if (!root) return;
    root.remove(); root = null;
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) { /* не критично */ }
  }
  function run(x) { if (!x) return; close(); H.run(x); }

  document.addEventListener('keydown', (ev) => {
    if (!H) return;
    const k = (ev.key || '').toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === 'k') { ev.preventDefault(); root ? close() : open(); return; }
    if (k === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !root) {
      const t = ev.target, typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (!typing) { ev.preventDefault(); open(); }
    }
  });
  window.DMQuick = { init: (h) => { H = h; }, open, close, isOpen: () => !!root };
})();
