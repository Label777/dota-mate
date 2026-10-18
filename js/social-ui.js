/* Dota Mate: интерфейс личных тегов, рекомендаций для пати, быстрой оценки матча, напоминаний и файлового экспорта.
   Логика лежит в js/social.js (DMSocial). Здесь только разметка и обработчики с префиксом data-a="s-…". */
(function () {
  'use strict';
  const X = { tab: 'all', f: { tag: '', rated: 'all', rmin: '', rmax: '' }, role: 'all', qr: null, imp: null, hits: Object.create(null) };
  let H = null;
  const D = () => window.DMSocial;
  const S = () => H.S();
  const esc = (s) => H.esc(s);
  const ico = (n) => H.ico(n);
  const now = () => Math.floor(Date.now() / 1000);
  const pct = (r) => (r == null ? '—' : Math.round(r * 100) + '%');
  const sc = (t) => (t.n ? t.w + '–' + t.l : '—');
  const $ = (s) => document.querySelector(s);

  function init(h) { H = h; }

  /* ---------- теги ---------- */
  const tagChip = (id) => `<span class="sx-tag ${D().tagTone(id)}">${esc(D().tagLabel(id))}</span>`;
  function chips(sid) {
    const t = D().tagsOf(S(), sid);
    return t.length ? `<span class="sx-chips">${t.map(tagChip).join('')}</span>` : '';
  }
  /* Дополнение к строке игрока: теги и, при поиске, где найден текст. */
  function rowExtra(e) {
    let h = chips(e.sid);
    const hits = H.V.page === 'players' && X.tab === 'all' ? X.hits[e.sid] : null;
    if (hits && hits.length) {
      const k = { review: 'заметка к матчу', player: 'заметка об игроке', hero: 'заметка о герое', tag: 'тег' };
      h += `<span class="sx-hit">${esc(k[hits[0].kind])}: ${esc(hits[0].text)}</span>`;
    }
    return h;
  }
  function recTxt(e, role) {
    const t = D().recordOf(e)[role === 'ally' ? 'with' : 'vs'];
    return t.n ? ` (${t.w}–${t.l})` : '';
  }
  function rowBadges(p) {
    if (!p.sid) return '';
    let h = chips(p.sid);
    const n = D().getHeroNote(S(), p.sid, p.hero);
    if (n) h += `<div class="sx-hnline">${ico('edit')}<span><b>${esc(p.hero)}:</b> ${esc(n)}</span></div>`;
    return h;
  }

  /* ---------- фильтры и поиск в списке игроков ---------- */
  function search(q) {
    X.hits = D().searchNotes(S(), q);
    return X.hits;
  }
  const filterActive = () => !!(X.f.tag || X.f.rated !== 'all' || X.f.rmin || X.f.rmax);
  function filter(list) { return D().applyFilters(S(), list, X.f); }
  function filterBar() {
    const f = X.f, d = D();
    const tagOpts = [['', 'Любой тег'], ['none', 'Без тегов']].concat(d.PRESETS.map((p) => [p.id, p.label]), d.customTags(S()).map((id) => [id, d.tagLabel(id)]));
    const st = [['', 'любая']].concat([1, 2, 3, 4, 5].map((n) => [String(n), String(n)]));
    const sel = (id, label, opts, val) => `<div class="field"><label for="${id}">${label}</label><select id="${id}">${opts.map((o) => `<option value="${esc(o[0])}" ${String(val) === String(o[0]) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></div>`;
    return `<div class="sx-filters">${sel('sx-tag', 'Тег', tagOpts, f.tag)}${sel('sx-rated', 'Оценки', [['all', 'Все игроки'], ['yes', 'Только с оценкой'], ['no', 'Без оценки']], f.rated)}${sel('sx-rmin', 'Средняя оценка от', st, f.rmin)}${sel('sx-rmax', 'до', st, f.rmax)}${filterActive() ? `<button class="btn ghost sm2" data-a="s-fclear">Сбросить</button>` : ''}</div>`;
  }

  /* ---------- вкладки страницы «Игроки» ---------- */
  const TABS = [['all', 'Все'], ['rec', 'Для пати'], ['unrated', 'Без оценки'], ['avoid', 'Избегать'], ['stats', 'Статистика']];
  function tabs() {
    const n = { unrated: D().unrated(S()).length, avoid: D().playersWithTag(S(), 'avoid').length };
    return `<div class="sx-tabs" role="tablist" aria-label="Списки игроков">${TABS.map((t) => `<button class="sx-tab" role="tab" aria-selected="${X.tab === t[0]}" data-a="s-tab" data-t="${t[0]}">${t[1]}${n[t[0]] ? `<span class="sx-n">${n[t[0]]}</span>` : ''}</button>`).join('')}</div>`;
  }
  const isAll = () => X.tab === 'all';

  const empty = (icon, title, text) => `<div class="empty">${ico(icon)}<b>${title}</b><p>${text}</p></div>`;
  function playerRow(e, sub, right) {
    return `<div class="sx-row"><button class="sx-rm" data-a="openPlayer" data-id="${esc(e.sid)}">${H.av(e.name, 'md', e.sid)}<span class="sx-rt"><span class="pname">${esc(e.name)}</span><small>${sub}</small>${chips(e.sid)}</span></button>${right || ''}</div>`;
  }

  function recBody() {
    const r = D().recommend(S(), { min: 2, limit: 5 });
    const head = `<p class="sx-lead">Союзники, с которыми вы играли минимум дважды: учитываются ваш винрейт с ними и ваша средняя оценка. Игроков с тегами «Токсик» и «Избегать» здесь нет.</p>`;
    if (!r.length) return head + empty('users', 'Пока некого рекомендовать', 'Нужны игроки, с которыми вы сыграли в одной команде минимум два матча. Оценки сделают рекомендации точнее.');
    const rows = r.map((x) => {
      const e = { sid: x.sid, name: x.name };
      const sub = `с ним ${x.w}–${x.l} (${pct(x.rate)}), матчей: ${x.n}` + (x.avg != null ? `, ваша оценка ${x.avg.toFixed(1)} (${x.rated})` : ', оценки нет');
      return playerRow(e, sub, `<span class="sx-sc" title="Индекс для пати"><span class="sx-bar"><i style="width:${Math.round(x.score * 100)}%"></i></span><b>${Math.round(x.score * 100)}</b></span>`);
    }).join('');
    return head + `<div class="sx-list">${rows}</div>
      <div class="actions"><button class="btn sm2" data-a="s-copynames">${ico('copy')}Скопировать ники</button></div>
      <details class="sx-how"><summary>Как считается индекс</summary><p>Половина индекса: сглаженный винрейт (победы + 1) / (матчи + 2), чтобы пара удачных игр не давала максимум. Вторая половина: ваша средняя оценка игрока, пересчитанная в долю от 0 до 1. Без оценки берётся нейтральное значение 0,5, так что неоценённые игроки преимущества не получают. Индекс относится только к вашим матчам и нигде не публикуется.</p></details>`;
  }

  function unratedBody() {
    const l = D().unrated(S(), { role: X.role });
    const last = H.sorted().find((m) => D().unratedInMatch(S(), m).length);
    const sel = `<div class="actions" style="align-items:center"><select id="sx-role" aria-label="Роль"><option value="all">Все</option><option value="ally" ${X.role === 'ally' ? 'selected' : ''}>Союзники</option><option value="enemy" ${X.role === 'enemy' ? 'selected' : ''}>Соперники</option></select>${last ? `<button class="btn primary sm2" data-a="s-rateall" data-mid="${esc(last.id)}">${ico('star')}Оценить игроков последнего матча</button>` : ''}</div>`;
    const head = `<p class="sx-lead">Игроки, которым вы ещё не ставили оценку. Заметка без звёзд оценкой не считается.</p>`;
    if (!l.length) return head + sel + empty('check', 'Все оценены', 'Новые игроки появятся здесь после следующей синхронизации.');
    const shown = l.slice(0, 40);
    const rows = shown.map((e) => playerRow(e, `встреч: ${e.count}${recTxt(e, 'ally') ? ', с ним' + recTxt(e, 'ally') : ''}, последний раз: ${esc(H.ago(e.last))}`,
      `<button class="btn sm2" data-a="s-rateall" data-mid="${esc(e.list[0].m.id)}" data-sid="${esc(e.sid)}">${ico('star')}Оценить</button>`)).join('');
    return head + sel + `<div class="sx-list">${rows}</div>${l.length > shown.length ? `<p class="sm">Показано ${shown.length} из ${l.length}. Остальные видны после оценки этих.</p>` : ''}`;
  }

  function avoidBody() {
    const ids = D().playersWithTag(S(), 'avoid'), idx = D().index(S());
    const head = `<p class="sx-lead">Ваш личный список. Игроки отсюда не попадают в рекомендации для пати, а в матче с ними появится предупреждение. Список виден только вам и не влияет на репутацию.</p>`;
    if (!ids.length) return head + empty('shield', 'Список пуст', 'Откройте игрока и отметьте тег «Избегать» в его карточке.');
    const rows = ids.map((sid) => {
      const e = idx[sid];
      const off = `<button class="btn sm2" data-a="s-tagoff" data-sid="${esc(sid)}" data-id="avoid">Убрать</button>`;
      if (!e) return `<div class="sx-row"><span class="sx-rm"><span class="sx-rt"><span class="pname">Игрок ${esc(sid)}</span><small>Матчей с ним в истории нет</small></span></span>${off}</div>`;
      const r = D().recordOf(e);
      return playerRow(e, `с ним ${sc(r.with)}, против ${sc(r.vs)}, последний раз: ${esc(H.ago(e.last))}`, off);
    }).join('');
    return head + `<div class="sx-list">${rows}</div>`;
  }

  function statsBody() {
    const st = D().stats(S());
    if (!st.players) return empty('list', 'Статистики пока нет', 'Она появится после первых матчей.');
    const li = (e, right) => `<li><button class="linkbtn" data-a="openPlayer" data-id="${esc(e.sid)}">${esc(e.name)}</button><span>${right}</span></li>`;
    const blk = (title, arr, fn, none) => `<section class="card stack"><h3>${title}</h3>${arr.length ? `<ul class="sx-stat">${arr.map((e) => li(e, fn(e))).join('')}</ul>` : `<p class="sm">${none}</p>`}</section>`;
    const w = st.winByRating, wr = (b) => (b.n ? `${Math.round(b.w / b.n * 100)}% (${b.w}–${b.l}, матчей: ${b.n})` : 'нет таких матчей');
    return `<div class="sx-grid">
      ${blk('С кем играю чаще всего', st.mostWith, (e) => `${e.withN} ${H.pl(e.withN, 'матч', 'матча', 'матчей')}`, 'Пока нет общих матчей в одной команде.')}
      ${blk('Против кого чаще всего', st.mostVs, (e) => `${e.vsN} ${H.pl(e.vsN, 'матч', 'матча', 'матчей')}`, 'Пока нет матчей против знакомых.')}
      ${blk('Оцениваю выше всего', st.high, (e) => `${e.avg.toFixed(1)}, оценок: ${e.rated}`, 'Нет игроков со средней оценкой от 4.')}
      ${blk('Оцениваю ниже всего', st.low, (e) => `${e.avg.toFixed(1)}, оценок: ${e.rated}`, 'Нет игроков со средней оценкой до 2.5.')}
    </div>
    <section class="card stack"><h3>Винрейт и ваши оценки</h3>
      <ul class="sx-stat"><li><span>Только высоко оценённые союзники (4–5)</span><span>${wr(w.high)}</span></li><li><span>Только низко оценённые союзники (1–2)</span><span>${wr(w.low)}</span></li></ul>
      <p class="sm">Считаются матчи, где у вас есть оценки союзников. Выборка обычно небольшая, поэтому это ориентир, а не вывод. Оценка сама зависит от исхода матча.</p></section>`;
  }

  function body() {
    switch (X.tab) { case 'rec': return recBody(); case 'unrated': return unratedBody(); case 'avoid': return avoidBody(); case 'stats': return statsBody(); }
    return '';
  }
  function view() { return tabs() + (isAll() ? '' : `<div class="sx-body" id="sx-body">${body()}</div>`); }

  /* ---------- карточка игрока: винрейт, теги, заметки по героям ---------- */
  function tagEditor(sid) {
    const d = D(), have = d.tagsOf(S(), sid);
    const uniq = d.PRESETS.map((p) => p.id).concat(d.customTags(S()));
    return `<div class="sx-te" role="group" aria-label="Теги игрока">${uniq.map((id) => `<button type="button" class="sx-pill ${d.tagTone(id)}" data-a="s-tag" data-sid="${esc(sid)}" data-id="${esc(id)}" aria-pressed="${have.includes(id)}">${esc(d.tagLabel(id))}</button>`).join('')}</div>
      <div class="sx-add"><input id="sx-ctag" type="text" maxlength="${d.MAX_CUSTOM}" placeholder="Свой тег" aria-label="Свой тег" autocomplete="off"><button class="btn sm2" data-a="s-tagadd" data-sid="${esc(sid)}">${ico('plus')}Добавить</button></div><p class="sm" id="sx-tmsg" role="status"></p>`;
  }
  function heroNotes(e) {
    const list = D().heroNotesOf(S(), e.sid);
    const used = [...new Set(e.list.map((x) => x.p.hero).filter((h) => h && h !== '—'))];
    const opts = [...new Set(used.concat(H.heroNames()))];
    return `${list.length ? `<ul class="sx-hn">${list.map((n) => `<li><span><b>${esc(n.hero)}</b> ${esc(n.text)}</span><span class="actions"><button class="iconbtn" data-a="s-heroedit" data-sid="${esc(e.sid)}" data-hero="${esc(n.hero)}" aria-label="Изменить заметку о герое ${esc(n.hero)}">${ico('edit')}</button><button class="iconbtn" data-a="s-herodel" data-sid="${esc(e.sid)}" data-hero="${esc(n.hero)}" aria-label="Удалить заметку о герое ${esc(n.hero)}">${ico('trash')}</button></span></li>`).join('')}</ul>` : '<p class="sm">Заметок о героях пока нет.</p>'}
      <div class="sx-hform"><div class="field"><label for="sx-hero">Герой</label><input id="sx-hero" type="text" list="sx-heroes" autocomplete="off" placeholder="Например: Pudge"></div>
      <div class="field"><label for="sx-hnote">Заметка</label><input id="sx-hnote" type="text" maxlength="${D().MAX_NOTE}" autocomplete="off" placeholder="На этом герое часто фидит"></div>
      <button class="btn sm2" data-a="s-herosave" data-sid="${esc(e.sid)}">${ico('check')}Сохранить</button></div>
      <datalist id="sx-heroes">${opts.map((h) => `<option value="${esc(h)}">`).join('')}</datalist><p class="sm" id="sx-hmsg" role="status"></p>`;
  }
  function playerBlocks(e) {
    const r = D().recordOf(e);
    const kv = (title, t) => `<div class="sx-kv"><div class="k">${title}</div><div class="v">${sc(t)}</div><div class="h">${t.n ? `${pct(t.rate)} побед, матчей: ${t.n}` : 'встреч не было'}</div></div>`;
    return `<section class="card stack"><h3>Ваш счёт с игроком</h3><div class="sx-kvs">${kv('Вместе', r.with)}${kv('Против него', r.vs)}</div><p class="sm">Ваши победы и поражения в матчах, где этот игрок был в вашей команде или у соперника.</p></section>
      <section class="card stack"><h3>Теги</h3><p class="sm">Видны только вам, на репутацию игрока не влияют.</p><div id="sx-tags">${tagEditor(e.sid)}</div></section>
      <section class="card stack"><h3>Заметки по героям</h3><div id="sx-hn">${heroNotes(e)}</div></section>`;
  }

  /* ---------- матч: «Оценить всех» и предупреждения ---------- */
  function matchTop(m) {
    const un = D().unratedInMatch(S(), m);
    const avoid = m.players.filter((p) => !p.me && p.sid && D().hasTag(S(), p.sid, 'avoid'));
    let h = '';
    if (avoid.length) h += `<div class="banner soft" role="note">${ico('alert')}<p>В матче были игроки из вашего списка «Избегать»: <b>${avoid.map((p) => esc(p.name)).join(', ')}</b>.</p></div>`;
    const total = m.players.filter((p) => !p.me && p.sid).length;
    if (total) h += `<div class="sx-qbar"><span class="sm">${un.length ? `Без оценки: ${un.length} из ${total}` : 'Все игроки оценены'}</span><button class="btn ${un.length ? 'primary' : ''} sm2" data-a="s-rateall" data-mid="${esc(m.id)}">${ico('star')}Оценить всех</button></div>`;
    return h;
  }
  const QT = ['party', 'toxic', 'avoid'];
  function openRateAll(mid, focusSid) {
    const m = H.mById(mid); if (!m) return;
    const rows = {};
    for (const p of m.players) {
      if (p.me || !p.sid) continue;
      const r = S().reviews[H.rkey(mid, p.sid)];
      rows[p.sid] = { rating: r ? r.rating || 0 : 0, note: r ? r.note || '' : '', tags: QT.filter((t) => D().hasTag(S(), p.sid, t)), orig: { rating: r ? r.rating || 0 : 0, note: r ? r.note || '' : '' } };
    }
    X.qr = { mid, rows, from: H.V.modal };
    H.openModal('rateall', { mid });
    if (focusSid) { const el = [...document.querySelectorAll('.sx-q')].find((x) => x.dataset.sid === focusSid); if (el) el.scrollIntoView({ block: 'center' }); }
  }
  function qRow(p) {
    const row = X.qr.rows[p.sid];
    return `<div class="sx-q" data-sid="${esc(p.sid)}"><div class="sx-qh">${H.av(p.name, 'md', p.sid)}<span class="sx-qn"><b>${esc(p.name)}</b><small>${esc(p.hero)}${D().hasTag(S(), p.sid, 'avoid') ? ' · в списке «Избегать»' : ''}</small></span></div>
      <div class="sx-qs" role="group" aria-label="Оценка: ${esc(p.name)}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="sx-star ${n <= row.rating ? 'on' : ''}" data-a="s-qstar" data-sid="${esc(p.sid)}" data-n="${n}" aria-label="${n} из 5" aria-pressed="${n === row.rating}">${ico('star')}</button>`).join('')}</div>
      <input class="sx-qnote" type="text" data-sid="${esc(p.sid)}" maxlength="${D().MAX_NOTE}" placeholder="Короткая заметка" aria-label="Заметка об игроке ${esc(p.name)}" value="${esc(row.note)}" autocomplete="off">
      <div class="sx-qt" role="group" aria-label="Быстрые теги: ${esc(p.name)}">${QT.map((t) => `<button type="button" class="sx-pill ${D().tagTone(t)}" data-a="s-qtag" data-sid="${esc(p.sid)}" data-id="${t}" aria-pressed="${row.tags.includes(t)}">${esc(D().tagLabel(t))}</button>`).join('')}</div></div>`;
  }
  function rateAllModal() {
    const q = X.qr, m = q && H.mById(q.mid); if (!m) return '';
    const al = m.players.filter((p) => p.ally && !p.me && p.sid), en = m.players.filter((p) => !p.ally && p.sid);
    const hidden = m.players.filter((p) => !p.me && !p.sid).length;
    return `<div class="panel-h"><div style="min-width:0"><h3 id="mt">Оценить всех</h3><small>${esc(m.hero)} · ${H.fd(m.start)} · ${m.win ? 'победа' : 'поражение'}</small></div>${H.closeBtn()}</div>
      <div class="panel-b"><div class="banner">${ico('lock')}<p class="sm" style="color:var(--fg-2)">Оценки, заметки и теги видны только вам. Игроки, которых вы не тронули, остаются как были.</p></div>
      ${al.length ? `<div><div class="lbl" style="margin-bottom:6px">Союзники</div>${al.map(qRow).join('')}</div>` : ''}
      ${en.length ? `<div><div class="lbl" style="margin-bottom:6px">Соперники</div>${en.map(qRow).join('')}</div>` : ''}
      ${hidden ? `<p class="sm">Скрыли профиль и не показаны: ${hidden}.</p>` : ''}
      ${!al.length && !en.length ? '<p class="sm">В этом матче нет игроков, которых можно оценить.</p>' : ''}
      <div class="actions"><button class="btn primary" data-a="s-qsave">${ico('check')}Сохранить</button><button class="btn" data-a="close">Отмена</button></div></div>`;
  }
  function captureNotes() {
    document.querySelectorAll('.sx-qnote').forEach((i) => { if (X.qr && X.qr.rows[i.dataset.sid]) X.qr.rows[i.dataset.sid].note = i.value; });
  }
  function saveRateAll() {
    captureNotes();
    const q = X.qr; if (!q) return;
    let changed = 0;
    for (const [sid, row] of Object.entries(q.rows)) {
      const k = H.rkey(q.mid, sid), old = S().reviews[k];
      const note = row.note.trim();
      if (row.rating !== row.orig.rating || note !== row.orig.note.trim()) {
        const cats = old && old.cats ? old.cats : {};
        if (!row.rating && !note && !Object.keys(cats).length) delete S().reviews[k];
        else S().reviews[k] = { rating: row.rating, cats, note, ts: now() };
        changed++;
      }
      for (const t of QT) { const on = row.tags.includes(t); if (on !== D().hasTag(S(), sid, t)) { D().setTag(S(), sid, t, on); changed++; } }
    }
    H.save();
    const back = q.from === 'match' ? q.mid : '';
    X.qr = null;
    if (back) { H.openModal('match', { mid: back }); H.paintMain(); } else H.closeModal();
    H.toast(changed ? 'Сохранено: ' + changed : 'Изменений нет.');
  }

  /* ---------- главная: напоминания и «ещё не оценены» ---------- */
  function dashBlock() {
    const rem = D().reminders(S(), { now: now() });
    const all = D().unrated(S()).length;
    const last = H.sorted().find((m) => D().unratedInMatch(S(), m).length);
    const un = last ? D().unratedInMatch(S(), last).length : 0;
    const show = last && !S().demo;
    if (!rem.length && !show) return '';
    let h = '';
    if (show) h += `<div class="sx-nudge">${ico('star')}<div><b>Матч на ${esc(last.hero)}: без оценки ${un} ${H.pl(un, 'игрок', 'игрока', 'игроков')}</b><p class="sm">${esc(H.ago(last.start))}. Оцените игроков одним экраном.</p></div><div class="actions"><button class="btn primary sm2" data-a="s-rateall" data-mid="${esc(last.id)}">Оценить всех</button><button class="btn sm2" data-a="s-tab" data-t="unrated" data-go="1">Все без оценки: ${all}</button></div></div>`;
    for (const r of rem) h += `<div class="sx-nudge">${ico('users')}<div><b>Давно не играли с ${esc(r.name)}</b><p class="sm">Вместе: ${r.withN} ${H.pl(r.withN, 'матч', 'матча', 'матчей')}${r.avg != null ? ', ваша оценка ' + r.avg.toFixed(1) : ''}. Последний раз: ${esc(H.ago(r.last))}</p></div><div class="actions"><button class="btn sm2" data-a="openPlayer" data-id="${esc(r.sid)}">Открыть</button><button class="btn ghost sm2" data-a="s-snooze" data-sid="${esc(r.sid)}">Напомнить позже</button></div></div>`;
    return `<section class="stack" aria-label="Напоминания" id="sx-dash">${h}</section>`;
  }

  /* ---------- настройки: напоминания, экспорт и импорт ---------- */
  function impBlock() {
    const im = X.imp;
    if (!im) return '';
    const s = im.sum;
    return `<div class="banner soft" role="status">${ico('info')}<div style="flex:1"><b>Файл «${esc(im.name)}»</b>
      <p class="sm" style="margin-top:2px">Матчей: ${s.matches}, оценок: ${s.reviews}, заметок об игроках: ${s.pnotes}, игроков с тегами: ${s.tagged}, заметок о героях: ${s.heroNotes}.</p>
      <div class="actions" style="margin-top:10px">${im.confirm ? `<button class="btn danger sm2" data-a="s-impreplace">Да, заменить мои данные</button><button class="btn sm2" data-a="s-impcancel">Отмена</button>` : `<button class="btn primary sm2" data-a="s-impmerge">Добавить к моим данным</button><button class="btn sm2" data-a="s-impask">Заменить мои данные</button><button class="btn ghost sm2" data-a="s-impcancel">Отмена</button>`}</div>
      ${im.confirm ? '<p class="sm" style="margin-top:8px">Текущие матчи, оценки и заметки на этом устройстве будут заменены содержимым файла. Ваш Steam ID останется.</p>' : '<p class="sm" style="margin-top:8px">«Добавить»: ваши данные не удаляются, новые матчи, заметки и теги добавляются, более новая оценка из файла побеждает.</p>'}</div></div>`;
  }
  function settingsBlock() {
    const remind = !(S().settings && S().settings.remind === false);
    return `<section class="card stack"><h3>Экспорт и импорт</h3>
      <p class="sm">Файл содержит все ваши матчи, оценки, заметки и теги. Он нигде не шифруется, храните его как личные данные.</p>
      <div class="actions"><button class="btn" data-a="s-export">${ico('copy')}Скачать файл (.json)</button><button class="btn" data-a="s-pick">${ico('plus')}Загрузить файл</button></div>
      <input id="sx-file" type="file" accept="application/json,.json" tabindex="-1" aria-label="Файл резервной копии" style="position:absolute;left:-9999px;width:1px;height:1px">
      <p class="sm" id="sx-fmsg" role="status"></p><div id="sx-imp">${impBlock()}</div>
      <hr class="hr"><label class="optin" for="sx-remind"><input type="checkbox" id="sx-remind" ${remind ? 'checked' : ''}><span>Напоминать о давно не игравших хороших тиммейтах<br><small>Показывается на главной: игроки с оценкой от 4 или тегом «Хороший тиммейт», «Хороший саппорт», «Можно в пати», с которыми вы не играли две недели и дольше.</small></span></label></section>`;
  }

  /* ---------- события ---------- */
  function refresh(sel, html) { const el = $(sel); if (el) el.innerHTML = html; }
  function refocus(sel) { const el = $(sel); if (el) el.focus(); }
  function download(name, text) {
    const b = new Blob([text], { type: 'application/json' }), u = URL.createObjectURL(b);
    const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }
  const setMsg = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  const att = (a, sid, extra) => `[data-a="${a}"]` + (sid != null ? `[data-sid="${CSS.escape(sid)}"]` : '') + (extra || '');

  document.addEventListener('click', (ev) => {
    if (!H) return;
    const t = ev.target.closest('[data-a^="s-"]'); if (!t) return;
    const a = t.dataset.a, d = t.dataset, s = S();
    switch (a) {
      case 's-tab': X.tab = d.t; if (d.go && H.V.page !== 'players') H.go('players'); else H.paintMain(); break;
      case 's-fclear': X.f = { tag: '', rated: 'all', rmin: '', rmax: '' }; H.paintMain(); break;
      case 's-tag': D().toggleTag(s, d.sid, d.id); H.save(); refresh('#sx-tags', tagEditor(d.sid)); refocus(att('s-tag', d.sid, `[data-id="${CSS.escape(d.id)}"]`)); break;
      case 's-tagadd': {
        const id = D().canonTag(s, D().tagKey($('#sx-ctag').value));
        if (!id) { setMsg('sx-tmsg', 'Введите название тега.'); break; }
        if (!D().setTag(s, d.sid, id, true)) { setMsg('sx-tmsg', D().hasTag(s, d.sid, id) ? 'Такой тег уже есть.' : 'У игрока может быть не больше ' + D().MAX_TAGS + ' тегов.'); break; }
        H.save(); refresh('#sx-tags', tagEditor(d.sid)); refocus('#sx-ctag'); break;
      }
      case 's-tagoff': D().setTag(s, d.sid, d.id, false); H.save(); H.paintMain(); break;
      case 's-herosave': {
        const hero = $('#sx-hero').value, text = $('#sx-hnote').value;
        if (!hero.trim()) { setMsg('sx-hmsg', 'Укажите героя.'); break; }
        if (!text.trim()) { setMsg('sx-hmsg', 'Напишите заметку. Чтобы удалить, нажмите на корзину у существующей.'); break; }
        if (!D().setHeroNote(s, d.sid, hero, text)) { setMsg('sx-hmsg', 'Не удалось сохранить: слишком много заметок о героях.'); break; }
        H.save(); H.paintMain(); break;
      }
      case 's-heroedit': $('#sx-hero').value = d.hero; $('#sx-hnote').value = D().getHeroNote(s, d.sid, d.hero); $('#sx-hnote').focus(); break;
      case 's-herodel': D().setHeroNote(s, d.sid, d.hero, ''); H.save(); refresh('#sx-hn', heroNotes(H.pIndex()[d.sid])); break;
      case 's-copynames': {
        const names = D().recommend(s, { min: 2, limit: 5 }).map((x) => x.name).join(', ');
        navigator.clipboard.writeText(names).then(() => H.toast('Ники скопированы.'), () => H.toast('Не удалось скопировать. Выделите ники вручную.')); break;
      }
      case 's-rateall': openRateAll(d.mid, d.sid); break;
      case 's-qstar': {
        captureNotes();
        const row = X.qr.rows[d.sid], n = Number(d.n);
        row.rating = row.rating === n ? 0 : n;
        const g = t.closest('.sx-qs');
        g.querySelectorAll('.sx-star').forEach((b) => { const k = Number(b.dataset.n); b.classList.toggle('on', k <= row.rating); b.setAttribute('aria-pressed', String(k === row.rating)); });
        break;
      }
      case 's-qtag': {
        const row = X.qr.rows[d.sid], on = !row.tags.includes(d.id);
        row.tags = on ? row.tags.concat(d.id) : row.tags.filter((x) => x !== d.id);
        /* «Токсик» и «Избегать» вместе не нужны подряд, а «Можно в пати» им противоречит */
        if (on && d.id !== 'party') row.tags = row.tags.filter((x) => x !== 'party');
        if (on && d.id === 'party') row.tags = row.tags.filter((x) => x === 'party');
        t.closest('.sx-qt').querySelectorAll('.sx-pill').forEach((b) => b.setAttribute('aria-pressed', String(row.tags.includes(b.dataset.id))));
        break;
      }
      case 's-qsave': saveRateAll(); break;
      case 's-snooze': D().snooze(s, d.sid, now(), 14); H.save(); H.toast('Напомню через две недели.'); H.paintMain(); break;
      case 's-export': {
        const j = JSON.stringify(D().exportData(s), null, 1);
        download('dota-mate-' + new Date().toISOString().slice(0, 10) + '.json', j);
        setMsg('sx-fmsg', 'Файл скачан.'); break;
      }
      case 's-pick': $('#sx-file').click(); break;
      case 's-impask': X.imp.confirm = true; refresh('#sx-imp', impBlock()); break;
      case 's-impcancel': X.imp = null; refresh('#sx-imp', ''); setMsg('sx-fmsg', ''); break;
      case 's-impmerge': {
        try {
          const r = D().mergeImport(s, X.imp.data); H.setS(H.migrate(r.state)); H.save(); X.imp = null; H.paint();
          const p = r.report;
          H.toast(`Добавлено: матчей ${p.matches}, оценок ${p.reviews}, заметок ${p.pnotes}, тегов ${p.tags}.`);
        } catch (e) { setMsg('sx-fmsg', e.message); }
        break;
      }
      case 's-impreplace': {
        try { H.setS(H.migrate(D().replaceWith(s, X.imp.data))); H.save(); X.imp = null; H.paint(); H.toast('Данные заменены содержимым файла.'); }
        catch (e) { setMsg('sx-fmsg', e.message); }
        break;
      }
    }
  });
  document.addEventListener('change', async (ev) => {
    if (!H) return;
    const t = ev.target;
    if (t.id === 'sx-file') {
      const f = t.files && t.files[0]; t.value = '';
      if (!f) return;
      X.imp = null; refresh('#sx-imp', '');
      if (f.size > 8 * 1024 * 1024) { setMsg('sx-fmsg', 'Файл слишком большой для импорта (больше 8 МБ).'); return; }
      try {
        const data = D().parseImport(await f.text());
        X.imp = { data, sum: D().summary(data), name: f.name.slice(0, 80), confirm: false };
        setMsg('sx-fmsg', ''); refresh('#sx-imp', impBlock());
      } catch (e) { setMsg('sx-fmsg', e.message); }
      return;
    }
    if (t.id === 'sx-remind') { const s = S(); s.settings = s.settings || {}; s.settings.remind = t.checked; H.save(); return; }
    if (t.id === 'sx-role') { X.role = t.value; refresh('#sx-body', body()); return; }
    const map = { 'sx-tag': 'tag', 'sx-rated': 'rated', 'sx-rmin': 'rmin', 'sx-rmax': 'rmax' };
    if (map[t.id]) { X.f[map[t.id]] = t.value; H.refreshList(); const fb = $('.sx-filters'); if (fb) fb.outerHTML = filterBar(); const el = document.getElementById(t.id); if (el) el.focus(); }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.classList && t.classList.contains('sx-qnote') && X.qr && X.qr.rows[t.dataset.sid]) X.qr.rows[t.dataset.sid].note = t.value;
  });

  window.DMSocialUI = { init, view, body, tabs, filterBar, filter, search, rowExtra, rowBadges, recTxt, playerBlocks, matchTop, rateAllModal, dashBlock, settingsBlock, isAll, state: X };
})();
