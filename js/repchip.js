/*
 * Dota Mate: теги и репутация возле ника.
 * Теги берутся из личных отметок (DMSocialUI). Репутация: короткий значок состояния из того же расчёта,
 * что и раздел «Репутация» (факты игры, аномалии, решения модераторов). Считается в фоне для игроков на экране,
 * кэшируется в браузере на 12 часов (dotamate.repq.v1), на сервер не отправляется.
 * Значок не говорит о нарушении: «Нет сигналов» не гарантия, «Проверить» не приговор.
 */
(function () {
  'use strict';
  const LS = 'dotamate.repq.v1', TTL = 12 * 3600e3, RETRY = 3600e3;
  const Q = { v: 1, auto: true, m: {} };
  let H = null, running = false, timer = 0, fails = 0;
  const flight = {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (s) => /^\d{3,12}$/.test(String(s));

  function load() {
    try { const j = JSON.parse(localStorage.getItem(LS) || 'null'); if (j && j.v === 1) { Q.auto = j.auto !== false; Q.m = j.m && typeof j.m === 'object' ? j.m : {}; } } catch (x) { /* нет доступа к хранилищу */ }
  }
  function save() {
    const ks = Object.keys(Q.m);
    if (ks.length > 400) ks.sort((a, b) => Q.m[a].t - Q.m[b].t).slice(0, ks.length - 400).forEach((k) => delete Q.m[k]);
    try { localStorage.setItem(LS, JSON.stringify(Q)); } catch (x) { /* ignore */ }
  }

  const LAB = {
    confirmed: ['bad', 'Подтверждено', 'Есть эпизоды, подтверждённые модератором Dota Mate, с обоснованием. Подробности в разделе «Репутация».'],
    needs_review: ['warn', 'Проверить', 'Есть повод посмотреть матчи самому: повторяющиеся отклонения или много выходов из игры. Это не вывод о нарушении.'],
    no_signals: ['ok', 'Нет сигналов', 'Статистических сигналов не найдено. Это не гарантия хорошего поведения: анализ видит только публичные цифры матчей.'],
    insufficient: ['neutral', 'Мало данных', 'Открытых матчей меньше 20, оценки нет. Это не плохая и не хорошая репутация.'],
    stale: ['neutral', 'Давно не играл', 'Последний открытый матч старше 90 дней, сигналы могут быть устаревшими.']
  };
  const ICON = '<svg class="ic" aria-hidden="true"><use href="#i-shield"/></svg>';

  function fresh(r) { return r && Date.now() - r.t < (r.e ? RETRY : TTL); }

  /** Значок репутации. Без Steam ID связать игрока с другими матчами нельзя, поэтому там честная заглушка. */
  function chip(sid) {
    if (!sid || !isNum(sid)) return `<span class="rq rq-neutral" data-tip="Игрок скрыл профиль: у него нет Steam ID, поэтому репутацию по другим матчам посчитать нельзя.">${ICON}Профиль скрыт</span>`;
    return `<span class="rq ${cls(Q.m[sid])}" data-rq="${esc(sid)}"${tipAttr(Q.m[sid])}>${ICON}${txt(Q.m[sid], sid)}</span>`;
  }
  function cls(r) { return !r ? 'rq-wait' : r.e ? 'rq-neutral' : 'rq-' + LAB[r.s][0]; }
  function txt(r, sid) {
    if (!r) return flight[sid] || Q.auto ? 'Репутация…' : 'Не проверена';
    if (r.e) return 'Нет данных';
    return LAB[r.s][1];
  }
  function tipText(r) {
    if (!r) return Q.auto ? 'Репутация считается в фоне по открытым матчам игрока (OpenDota) и решениям модераторов.' : 'Репутация не проверена: автоматическая проверка выключена в настройках.';
    if (r.e) return 'Не удалось получить матчи игрока: профиль закрыт или OpenDota недоступен. Повторю позже.';
    return LAB[r.s][2] + ' Матчей в расчёте: ' + r.n + (r.k ? ', подтверждено модератором: ' + r.k : '') + '.';
  }
  function tipAttr(r) { return ` data-tip="${esc(tipText(r))}"`; }

  /** Теги и репутация одной строкой для вставки справа от ника. */
  function badges(sid) {
    const tags = window.DMSocialUI && DMSocialUI.tagChips && sid ? DMSocialUI.tagChips(sid) : '';
    return `<span class="nb">${tags}${chip(sid)}</span>`;
  }

  function paintChip(el, sid) {
    const r = Q.m[sid];
    el.className = 'rq ' + cls(r);
    el.innerHTML = ICON + txt(r, sid);
    el.setAttribute('data-tip', tipText(r));
  }
  function paintAll(sid) { document.querySelectorAll('.rq[data-rq="' + sid + '"]').forEach((el) => paintChip(el, sid)); }

  function nextSid() {
    const els = document.querySelectorAll('.rq[data-rq]');
    const lim = (window.innerHeight || 800) * 2;
    for (const el of els) {
      const sid = el.getAttribute('data-rq');
      if (fresh(Q.m[sid]) || flight[sid]) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.top < lim && r.bottom > -lim) return sid;
    }
    return null;
  }
  async function pump() {
    if (running || !Q.auto) return;
    const ui = window.DMRepUI && DMRepUI.ctx;
    if (!ui || !ui.loadPlayer) return;
    running = true;
    try {
      for (let i = 0; i < 60; i++) {
        const sid = nextSid();
        if (!sid) break;
        flight[sid] = 1; paintAll(sid);
        try {
          const d = await ui.loadPlayer(sid, false);
          const rep = d.rep;
          Q.m[sid] = { s: rep.state, r: rep.risk || null, n: d.matches.length, k: rep.confirmedCount || 0, t: Date.now() };
          fails = 0;
        } catch (x) { Q.m[sid] = { e: 1, t: Date.now() }; if (++fails >= 5) { delete flight[sid]; paintAll(sid); break; } }
        delete flight[sid]; save(); paintAll(sid);
      }
    } finally { running = false; }
    if (fails < 5 && nextSid()) setTimeout(pump, 300);
  }
  function soon() { clearTimeout(timer); timer = setTimeout(pump, 350); }

  function settingsBlock() {
    const n = Object.keys(Q.m).length;
    return `<section class="card stack"><h3>Репутация возле ников</h3>
      <p class="sm">Рядом с ником показывается короткий значок репутации. Он считается по открытой истории игрока (OpenDota) теми же правилами, что и раздел «Репутация», и не заменяет проверку матчей. Результат хранится только в этом браузере, значок обновляется раз в 12 часов.</p>
      <label class="optin" for="rq-auto"><input type="checkbox" id="rq-auto" ${Q.auto ? 'checked' : ''}><span>Считать репутацию игроков автоматически<br><small>Для каждого игрока на экране делается 1–2 запроса к OpenDota. Если выключить, значки покажут «Не проверена».</small></span></label>
      <p class="sm">Сохранено оценок: ${n}.</p>
      <div class="actions"><button class="btn danger sm2" data-a="rq-clear" data-tip="Удалить сохранённые значки репутации. Они посчитаются заново">${H && H.ico ? H.ico('trash') : ''}Очистить кэш репутации</button></div></section>`;
  }

  function init(h) {
    H = h; load();
    document.addEventListener('change', (ev) => {
      if (ev.target && ev.target.id === 'rq-auto') {
        Q.auto = !!ev.target.checked; save();
        document.querySelectorAll('.rq[data-rq]').forEach((el) => paintChip(el, el.getAttribute('data-rq')));
        if (Q.auto) soon();
        if (H.toast) H.toast(Q.auto ? 'Репутация считается автоматически' : 'Автоматический расчёт репутации выключен');
      }
    });
    document.addEventListener('click', (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest('[data-a="rq-clear"]');
      if (!b) return;
      Q.m = {}; save(); if (H.toast) H.toast('Кэш репутации очищен');
      document.querySelectorAll('.rq[data-rq]').forEach((el) => paintChip(el, el.getAttribute('data-rq')));
      if (H.refresh) H.refresh(true);
      soon();
    });
    new MutationObserver((list) => {
      if (list.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches('.rq[data-rq]') || n.querySelector('.rq[data-rq]'))))) soon();
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', soon, { passive: true });
    soon();
  }

  window.DMRepChip = { init, chip, badges, settingsBlock, state: () => Q, pump };
})();
