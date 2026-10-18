'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/social.js');

const DAY = 86400, NOW = 1_800_000_000;
function fixture() {
  /* Три союзника и два соперника в шести матчах. */
  const S = { v: 1, me: { acc: '111', name: 'Я' }, matches: [], reviews: {}, pnotes: {}, avatars: {}, settings: {}, demo: false, lastSync: null };
  const mk = (id, daysAgo, win, allies, enemies) => S.matches.push({
    id, start: NOW - daysAgo * DAY, mode: 'All Pick', ranked: false, win, dur: 2000, hero: 'Axe',
    players: [{ sid: '111', name: 'Я', hero: 'Axe', ally: true, me: true }]
      .concat(allies.map((a) => ({ sid: a, name: 'N' + a, hero: 'Pudge', ally: true, me: false })))
      .concat(enemies.map((a) => ({ sid: a, name: 'N' + a, hero: 'Lina', ally: false, me: false })))
  });
  mk('m1', 40, true, ['1', '2'], ['9']);
  mk('m2', 30, true, ['1', '2'], ['9']);
  mk('m3', 20, false, ['1', '3'], ['9']);
  mk('m4', 10, true, ['1'], ['8']);
  mk('m5', 5, false, ['3'], ['9']);
  mk('m6', 2, false, ['2'], ['8', '9']);
  return S;
}
const rate = (S, mid, sid, r, note) => { S.reviews[mid + '|' + sid] = { rating: r, cats: {}, note: note || '', ts: NOW }; };

test('теги: готовые и свои, без дублей, лимиты', () => {
  assert.equal(D.tagKey('good'), 'good');
  assert.equal(D.tagKey('  Токсик '), 'toxic', 'название готового тега приводится к идентификатору');
  assert.equal(D.tagKey('мой   тег'), 'c:мой тег');
  assert.equal(D.tagKey('   '), null);
  assert.equal(D.tagKey('x'.repeat(100)).length, 2 + D.MAX_CUSTOM);
  assert.equal(D.tagLabel('avoid'), 'Избегать');
  assert.equal(D.tagLabel('c:Бегун'), 'Бегун');
  const S = fixture(); D.ensure(S);
  assert.equal(D.setTag(S, '1', 'party', true), true);
  assert.equal(D.setTag(S, '1', 'party', true), false, 'повтор ничего не меняет');
  assert.deepEqual(D.tagsOf(S, '1'), ['party']);
  assert.equal(D.toggleTag(S, '1', 'party'), true);
  assert.equal('1' in S.tags, false, 'пустой список удаляется');
  assert.equal(D.setTag(S, '1', 'нет-такого', true), false, 'неизвестный идентификатор отвергается');
  for (let i = 0; i < 20; i++) D.setTag(S, '2', 'c:t' + i, true);
  assert.equal(D.tagsOf(S, '2').length, D.MAX_TAGS);
  assert.equal(D.setTag(S, '__proto__', 'good', true), false, 'опасные ключи отвергаются');
  assert.equal(Object.prototype.good, undefined);
});

test('свои теги не различаются по регистру и сохраняют первое написание', () => {
  const S = fixture(); D.ensure(S);
  assert.equal(D.setTag(S, '1', 'c:Любит мид', true), true);
  assert.equal(D.setTag(S, '1', 'c:любит МИД', true), false, 'тот же тег другим регистром не добавляется');
  assert.equal(D.setTag(S, '2', 'c:ЛЮБИТ мид', true), true);
  assert.deepEqual(D.tagsOf(S, '2'), ['c:Любит мид'], 'у второго игрока то же написание, что у первого');
  assert.deepEqual(D.customTags(S), ['c:Любит мид']);
  assert.equal(D.setTag(S, '1', 'c:ЛЮБИТ МИД', false), true, 'снять можно любым регистром');
  assert.deepEqual(D.tagsOf(S, '1'), []);
});

test('личный винрейт: «с ним» и «против него»', () => {
  const S = fixture();
  const r1 = D.record(S, '1');
  assert.deepEqual([r1.with.w, r1.with.l, r1.with.n], [3, 1, 4]);
  assert.equal(r1.vs.n, 0);
  assert.equal(r1.vs.rate, null);
  const r9 = D.record(S, '9');
  assert.deepEqual([r9.vs.w, r9.vs.l], [2, 3], 'против игрока 9: две победы и три поражения');
  assert.equal(r9.with.n, 0);
  assert.equal(D.record(S, 'нет'), null);
});

test('рекомендации для пати: винрейт плюс оценка, минимум игр, без токсиков', () => {
  const S = fixture();
  rate(S, 'm1', '1', 5); rate(S, 'm2', '1', 5);
  rate(S, 'm3', '3', 2);
  let r = D.recommend(S, { min: 2 });
  /* игрок 1: 3–1, оценка 5 → 0.833; игрок 2: 2–1, без оценки → 0.55; игрок 3: 0–2, оценка 2 → 0.25 */
  assert.deepEqual(r.map((x) => x.sid), ['1', '2', '3']);
  assert.deepEqual(r.map((x) => Math.round(x.score * 1000)), [833, 550, 250]);
  assert.equal(r.every((x) => x.n >= 2), true);
  D.setTag(S, '1', 'avoid', true);
  r = D.recommend(S, { min: 2 });
  assert.equal(r.some((x) => x.sid === '1'), false, 'игрок с тегом «Избегать» не рекомендуется');
  D.setTag(S, '2', 'toxic', true);
  assert.equal(D.recommend(S, { min: 2 }).some((x) => x.sid === '2'), false);
  assert.equal(D.recommend(S, { min: 5 }).length, 0, 'при малом числе игр рекомендаций нет');
  assert.equal(D.recommend(S, { min: 1, limit: 1 }).length, 1);
});

test('неоценённые игроки и состав матча', () => {
  const S = fixture();
  assert.equal(D.unrated(S).length, 5, 'без оценок все знакомые в списке');
  rate(S, 'm1', '1', 4);
  const u = D.unrated(S);
  assert.equal(u.some((e) => e.sid === '1'), false);
  assert.equal(u[0].last >= u[u.length - 1].last, true, 'сначала самые недавние');
  assert.deepEqual(D.unrated(S, { role: 'enemy' }).map((e) => e.sid).sort(), ['8', '9']);
  assert.equal(D.unrated(S, { role: 'ally' }).every((e) => e.withN > 0), true);
  S.reviews['m2|2'] = { rating: 0, cats: {}, note: 'только заметка', ts: NOW };
  assert.equal(D.unrated(S).some((e) => e.sid === '2'), true, 'заметка без звёзд не считается оценкой');
  const m1 = S.matches[0];
  assert.deepEqual(D.unratedInMatch(S, m1).map((p) => p.sid), ['2', '9']);
});

test('заметки по героям', () => {
  const S = fixture(); D.ensure(S);
  assert.equal(D.setHeroNote(S, '1', 'Pudge', '  часто фидит  '), true);
  assert.equal(D.getHeroNote(S, '1', 'Pudge'), 'часто фидит');
  assert.deepEqual(D.heroNotesOf(S, '1'), [{ hero: 'Pudge', text: 'часто фидит' }]);
  D.setHeroNote(S, '1', 'Pudge', '');
  assert.equal('1' in S.heroNotes, false, 'пустая заметка удаляет запись');
  assert.equal(D.setHeroNote(S, '1', '__proto__', 'x'), false);
  D.setHeroNote(S, '1', 'Axe', 'a'.repeat(5000));
  assert.equal(D.getHeroNote(S, '1', 'Axe').length, D.MAX_NOTE);
});

test('поиск по тексту заметок, героям и тегам', () => {
  const S = fixture(); D.ensure(S);
  rate(S, 'm1', '1', 5, 'Отлично ставит варды');
  S.pnotes['2'] = 'Любит играть на линии. ВАРДЫ тоже ставит';
  D.setHeroNote(S, '3', 'Pudge', 'на пудже часто фидит');
  D.setTag(S, '9', 'c:Бегун', true);
  const h = D.searchNotes(S, 'варды');
  assert.deepEqual(Object.keys(h).sort(), ['1', '2']);
  assert.equal(h['1'][0].kind, 'review');
  assert.equal(h['1'][0].mid, 'm1');
  assert.equal(h['2'][0].kind, 'player');
  assert.equal(D.searchNotes(S, 'ФИДИТ')['3'][0].kind, 'hero');
  assert.equal(D.searchNotes(S, 'бегун')['9'][0].kind, 'tag');
  assert.deepEqual(Object.keys(D.searchNotes(S, 'x')), [], 'короткий запрос игнорируется');
  assert.deepEqual(Object.keys(D.searchNotes(S, 'нет такого текста')), []);
});

test('фильтры по тегам и диапазону оценки', () => {
  const S = fixture(); D.ensure(S);
  rate(S, 'm1', '1', 5); rate(S, 'm1', '2', 3); rate(S, 'm3', '3', 1);
  D.setTag(S, '1', 'party', true); D.setTag(S, '3', 'avoid', true);
  const all = Object.values(D.index(S));
  const ids = (l) => l.map((e) => e.sid).sort();
  assert.deepEqual(ids(D.applyFilters(S, all, { tag: 'party' })), ['1']);
  assert.deepEqual(ids(D.applyFilters(S, all, { tag: 'none' })), ['2', '8', '9']);
  assert.deepEqual(ids(D.applyFilters(S, all, { rmin: '4' })), ['1']);
  assert.deepEqual(ids(D.applyFilters(S, all, { rmin: '2', rmax: '4' })), ['2']);
  assert.deepEqual(ids(D.applyFilters(S, all, { rmax: '2' })), ['3']);
  assert.deepEqual(ids(D.applyFilters(S, all, { rated: 'no' })), ['8', '9']);
  assert.deepEqual(ids(D.applyFilters(S, all, { rated: 'yes', tag: 'avoid' })), ['3']);
  assert.equal(D.applyFilters(S, all, {}).length, all.length);
});

test('статистика: с кем чаще играю, кого оцениваю выше и ниже, винрейт по оценкам', () => {
  const S = fixture();
  rate(S, 'm1', '1', 5); rate(S, 'm2', '1', 4); rate(S, 'm3', '3', 1); rate(S, 'm5', '3', 2); rate(S, 'm6', '2', 5);
  const st = D.stats(S);
  assert.equal(st.mostWith[0].sid, '1');
  assert.equal(st.mostVs[0].sid, '9');
  assert.equal(st.high[0].sid, '2');
  assert.equal(st.low[0].sid, '3');
  assert.equal(st.low.some((e) => e.sid === '1'), false);
  /* m1, m2 (высокие, победы), m4 (игрок 1 без оценки в m4: не считается) */
  assert.deepEqual(st.winByRating.high, { w: 2, l: 1, n: 3 }, 'm1, m2 победы и m6 поражение (игрок 2 оценён на 5)');
  assert.deepEqual(st.winByRating.low, { w: 0, l: 2, n: 2 }, 'm3 и m5: только низко оценённые союзники');
});

test('напоминания: давно не играли с хорошим, откладывание, выключение', () => {
  const S = fixture(); D.ensure(S);
  rate(S, 'm1', '1', 5); rate(S, 'm2', '1', 5);
  rate(S, 'm1', '2', 5); rate(S, 'm2', '2', 5);
  /* игрок 1 последний раз был 10 дней назад, игрок 2 — 2 дня назад */
  assert.deepEqual(D.reminders(S, { now: NOW, days: 14 }), [], 'недавно играли: напоминать рано');
  const r = D.reminders(S, { now: NOW + 30 * DAY, days: 14 });
  assert.deepEqual(r.map((x) => x.sid), ['1', '2'], 'сначала те, с кем не играли дольше всего');
  D.snooze(S, '1', NOW + 30 * DAY, 14);
  assert.deepEqual(D.reminders(S, { now: NOW + 30 * DAY, days: 14 }).map((x) => x.sid), ['2']);
  assert.deepEqual(D.reminders(S, { now: NOW + 50 * DAY, days: 14 }).map((x) => x.sid), ['1', '2'], 'после срока откладывания напоминание возвращается');
  D.setTag(S, '2', 'avoid', true);
  assert.deepEqual(D.reminders(S, { now: NOW + 50 * DAY, days: 14 }).map((x) => x.sid), ['1']);
  S.settings.remind = false;
  assert.deepEqual(D.reminders(S, { now: NOW + 50 * DAY }), []);
  const T = fixture(); D.setTag(T, '3', 'party', true);
  assert.equal(D.reminders(T, { now: NOW + 60 * DAY }).some((x) => x.sid === '3'), true, 'тег «Можно в пати» тоже считается');
  const U = fixture();
  assert.deepEqual(D.reminders(U, { now: NOW + 60 * DAY }), [], 'без оценок и тегов напоминаний нет');
});

test('экспорт и импорт: круг, слияние, замена', () => {
  const S = fixture(); D.ensure(S);
  rate(S, 'm1', '1', 5, 'варды'); S.pnotes['1'] = 'надёжный'; D.setTag(S, '1', 'party', true); D.setHeroNote(S, '1', 'Pudge', 'фидит');
  S.avatars = { 1: 'https://x' };
  const ex = D.exportData(S, NOW * 1000);
  assert.equal(ex.app, 'dota-mate');
  assert.equal('avatars' in ex.data, false, 'кэш аватарок в файл не попадает');
  const data = D.parseImport(JSON.stringify(ex));
  const sm = D.summary(data);
  assert.deepEqual(sm, { matches: 6, reviews: 1, pnotes: 1, tagged: 1, heroNotes: 1 });

  /* замена на пустом устройстве: свой Steam ID сохраняется */
  const empty = { v: 1, me: { acc: '777', name: 'Другой' }, matches: [], reviews: {}, pnotes: {}, settings: {} };
  const rep = D.replaceWith(empty, data);
  assert.equal(rep.me.acc, '777');
  assert.equal(rep.matches.length, 6);
  assert.deepEqual(D.tagsOf(rep, '1'), ['party']);

  /* слияние: свои данные не теряются, чужие добавляются, более новая оценка побеждает */
  const mine = fixture(); D.ensure(mine);
  mine.matches.push({ id: 'm7', start: NOW, mode: 'Turbo', ranked: false, win: true, dur: 1500, hero: 'Sven', players: [{ sid: '111', name: 'Я', hero: 'Sven', ally: true, me: true }, { sid: '5', name: 'N5', hero: 'Lion', ally: true, me: false }] });
  mine.reviews['m1|1'] = { rating: 2, cats: {}, note: 'старое', ts: NOW - 100 };
  mine.pnotes['1'] = 'моя заметка';
  D.setTag(mine, '1', 'core', true);
  const m = D.mergeImport(mine, data);
  assert.equal(m.state.matches.length, 7, 'м7 осталась, остальные совпали по id');
  assert.equal(m.report.matches, 0);
  assert.equal(m.state.reviews['m1|1'].rating, 5, 'более новая оценка из файла');
  assert.equal(m.report.updated, 1);
  assert.equal(m.state.pnotes['1'], 'моя заметка', 'своя заметка не перезаписывается');
  assert.deepEqual(D.tagsOf(m.state, '1').sort(), ['core', 'party']);
  assert.equal(D.getHeroNote(m.state, '1', 'Pudge'), 'фидит');
  assert.equal(m.state.me.acc, '111');
  assert.deepEqual(mine.reviews['m1|1'].note, 'старое', 'исходное состояние не мутируется');

  /* демо-данные при слиянии не смешиваются с чужими */
  const demo = Object.assign(fixture(), { demo: true });
  assert.equal(D.mergeImport(demo, data).state.matches.length, 6);
});

test('импорт отвергает мусор и чистит опасное', () => {
  assert.throws(() => D.parseImport(''), /пустой/);
  assert.throws(() => D.parseImport('не json'), /не JSON/);
  assert.throws(() => D.parseImport('{"a":1}'), /не резервная копия/);
  assert.throws(() => D.parseImport('{"v":1,"matches":[]}'), /нет ни матчей/);
  assert.throws(() => D.parseImport('x'.repeat(9 * 1024 * 1024)), /слишком большой/);
  const evil = JSON.stringify({
    v: 1, me: { acc: '12345abc', name: '<img onerror=x>' },
    matches: [{ id: 'a', start: 1, win: true, players: [{ sid: '1', name: 'A', hero: 'Axe', ally: true }] }, { id: '', players: [] }, 5, null],
    reviews: { 'a|1': { rating: 99, note: 'ok', cats: { team: 7, comm: 3, zzz: 1 } }, 'нет-разделителя': { rating: 3 }, 'PROTO': { rating: 5 } },
    pnotes: { '1': 'заметка\u0007', constructor: 'x', PROTO: 'z', '2': 5 },
    tags: { '1': ['good', 'good', 'bogus', 'c:', 'мой тег', 7], 'PROTO': ['good'] },
    heroNotes: { '1': { Pudge: 'x', PROTO: 'y' } },
    settings: { avatars: 'yes', remind: false, evil: true },
    avatars: { 1: 'https://x' }
  }).replace(/PROTO/g, '__proto__');
  assert.equal((evil.match(/__proto__/g) || []).length, 4, 'в JSON действительно есть собственные ключи __proto__');
  const d = D.parseImport(evil);
  assert.equal(d.me.acc, '', 'нечисловой Steam ID отбрасывается');
  assert.equal(d.matches.length, 1);
  assert.equal(d.reviews['a|1'].rating, 5, 'оценка ограничена пятью');
  assert.deepEqual(d.reviews['a|1'].cats, { comm: 3 }, 'категории вне 1–5 и неизвестные отбрасываются');
  assert.deepEqual([Object.keys(d.reviews), Object.keys(d.pnotes), Object.keys(d.tags), Object.keys(d.heroNotes), Object.keys(d.heroNotes['1'])], [['a|1'], ['1'], ['1'], ['1'], ['Pudge']], 'ключи __proto__ и constructor отброшены везде');
  assert.equal(d.pnotes['1'], 'заметка', 'управляющие символы убраны');
  assert.equal('2' in d.pnotes, false);
  assert.deepEqual(d.tags['1'], ['good', 'c:bogus', 'c:мой тег'], 'остались только корректные теги без повторов');
  assert.equal(Object.prototype.good, undefined);
  assert.equal(({}).polluted, undefined);
  assert.equal(d.settings.avatars, true);
  assert.equal(d.settings.remind, false);
  assert.equal('evil' in d.settings, false);
  assert.deepEqual(d.avatars, {});
  const sm = D.summary(d);
  assert.equal(sm.matches, 1);
});

test('старые данные без новых полей работают', () => {
  const S = fixture();
  assert.deepEqual(D.tagsOf(S, '1'), []);
  assert.equal(D.getHeroNote(S, '1', 'Pudge'), '');
  assert.deepEqual(D.reminders(S, { now: NOW }), []);
  assert.equal(D.recommend(S).length > 0, true);
  D.ensure(S);
  assert.deepEqual([S.tags, S.heroNotes, S.snooze], [{}, {}, {}]);
  D.setTag(S, '1', 'good', true); D.setHeroNote(S, '1', 'Axe', 'x'); S.pnotes['1'] = 'n'; rate(S, 'm1', '1', 4);
  D.removePlayerData(S, '1');
  assert.deepEqual([S.tags, S.heroNotes, S.pnotes, S.reviews], [{}, {}, {}, {}]);
});
