'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../js/impact.js');
const P = require('../js/perf.js');
const { BENCH, match, clone } = require('./helpers/impact-match.js');

const ev = (over, extra, opts) => I.evaluate(match(over, extra), Object.assign({ bench: BENCH }, opts || {}));

/* ---------- 1. MVP при доступных метриках ---------- */
test('MVP: игрок с сильными показателями по всем метрикам получает статус, оценка окончательная', () => {
  const r = ev({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30 } });
  assert.equal(r.status, 'ok');
  assert.equal(r.mvp.state, 'assigned');
  assert.equal(r.mvp.i, 0);
  assert.equal(r.final, true);
  assert.deepEqual(r.prelim, []);
  assert.ok(r.mvp.score >= I.MIN_MVP && r.mvp.margin >= I.MARGIN);
  assert.ok(r.mvp.why.length >= 2, 'объяснение строится из реальных цифр');
  assert.match(r.mvp.text, /14\/2\/8/);
  assert.ok(r.mvp.used.includes('урон по героям'));
  assert.equal(r.algo, I.ALGO);
});

/* ---------- 2. Худший игрок ---------- */
test('Худший игрок: много смертей, нет вклада и слабые цифры героя', () => {
  const r = ev({ 9: { k: 0, d: 14, s: 1, g: 250, x: 300, hd: 150 * 30, hh: 0, lh: 20 } });
  assert.equal(r.worst.state, 'assigned');
  assert.equal(r.worst.i, 9);
  assert.match(r.worst.text, /14 смертей/);
  assert.ok(r.worst.score >= I.MIN_WEAK);
});

test('В матче не больше одного MVP и одного худшего, и это разные игроки', () => {
  const r = ev({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30 }, 9: { k: 0, d: 14, s: 1, g: 250, x: 300, hd: 150 * 30, hh: 0, lh: 20 } });
  assert.equal(r.mvp.state, 'assigned'); assert.equal(r.worst.state, 'assigned');
  assert.notEqual(r.mvp.i, r.worst.i);
  const mvps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((i) => I.statusOf(r, { i }) === 'mvp');
  const worst = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((i) => I.statusOf(r, { i }) === 'worst');
  assert.deepEqual(mvps, [0]); assert.deepEqual(worst, [9]);
});

/* ---------- 3. Саппорт с малым числом убийств ---------- */
test('Саппорт с 1 убийством, но с лечением, контролем и вардами, не проигрывает керри автоматически', () => {
  const sup = { k: 1, d: 2, s: 24, g: 340, x: 540, hd: 380 * 30, hh: 260 * 30, lh: 30, td: 200, st: 90, ob: 12, se: 10 };
  const carry = { k: 9, d: 8, s: 4, g: 480, x: 560, hd: 650 * 30, lh: 260 };
  const withExt = ev({ 4: sup, 0: carry }, null, {});
  const noExt = ev({ 4: Object.assign({}, sup, { st: null, ob: null, se: null }), 0: carry });
  assert.ok(withExt.players[4].mvp > withExt.players[0].mvp, 'саппорт выше керри, который много умер');
  assert.ok(withExt.players[4].mvp >= noExt.players[4].mvp, 'данные разбора могут только поднять оценку');
  assert.equal(withExt.mvp.i, 4);
  assert.match(withExt.mvp.text, /поддержки|участие/);
  assert.notEqual(withExt.worst.i, 4, 'саппорт не худший');
});

test('Бонус поддержки только вверх: керри без вардов и станов не штрафуется за их отсутствие', () => {
  const a = ev({ 0: { st: null, ob: null, se: null } });
  const b = ev({ 0: { st: 0, ob: 0, se: 0 } }, null, {});
  assert.equal(a.players[0].mvp, b.players[0].mvp);
  assert.equal(a.players[0].weak, b.players[0].weak);
});

/* ---------- 4. Керри с высоким KDA, но низким вкладом ---------- */
test('Керри с высоким KDA, но слабой фармом, уроном и участием, не становится MVP', () => {
  const r = ev({ 0: { k: 3, d: 0, s: 2, g: 360, x: 410, hd: 420 * 30, lh: 90, td: 100 } }, { rw: 0 },
    {});
  // команда набрала много убийств: у остальных Radiant обычные цифры
  assert.ok(r.players[0].mvp < 50, 'оценка ' + r.players[0].mvp);
  assert.notEqual(r.mvp.i, 0);
  const kda = 5;   // (3+2)/max(1,0)
  assert.ok(kda > 3);
});

/* ---------- 5. Много смертей, но недостаточно данных ---------- */
test('Игрок с 15 смертями, но без экономики и урона, не становится худшим принудительно', () => {
  const r = ev({ 3: { k: 0, d: 15, s: 0, g: 0, x: 0, lh: 0, hd: null, hh: null, td: null } });
  assert.equal(r.status, 'ok');
  assert.notEqual(r.worst.i, 3);
  assert.equal(r.players[3].e, 0, 'игрок исключён из сравнения');
  assert.equal(r.final, false);
  assert.ok(r.prelim.includes('not_all'));
});

test('Если без данных несколько игроков, честного сравнения нет: статусы не назначаются', () => {
  const dead = { g: 0, x: 0, lh: 0, hd: null, hh: null, td: null };
  const r = ev({ 1: dead, 3: dead, 6: dead });
  assert.equal(r.status, 'insufficient');
  assert.equal(r.reason, 'few_eligible');
  assert.equal(r.mvp.state, 'nodata'); assert.equal(r.worst.state, 'nodata');
  assert.equal(r.mvp.text, 'Недостаточно данных для определения MVP');
  assert.equal(r.worst.text, 'Недостаточно данных');
});

/* ---------- 6. Неполные данные ---------- */
test('Нет урона по героям у одного игрока: оценка считается, но помечена предварительной', () => {
  const r = ev({ 5: { hd: null } });
  assert.equal(r.status, 'ok');
  assert.equal(r.final, false);
  assert.ok(r.prelim.includes('no_damage'));
  assert.ok(r.players[5].c < 1);
  assert.equal(r.players[5].e, 1);
});

test('Нет бенчмарков героев: упрощённая оценка без экономики, помечена предварительной', () => {
  const r = I.evaluate(match({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30 } }), { bench: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.final, false);
  assert.ok(r.prelim.includes('no_bench'));
  assert.equal(r.mvp.comps && r.mvp.comps.econ, undefined, 'экономика без бенчмарка не используется');
  assert.equal(r.mvp.i, 0);
});

test('Игрок, вышедший из матча, исключён из статусов и не получает худшего', () => {
  const r = ev({ 6: { k: 0, d: 9, s: 0, g: 100, x: 150, lh: 5, hd: 100, lv: 3 } });
  assert.equal(r.players[6].lv, 1); assert.equal(r.players[6].e, 0);
  assert.notEqual(r.worst.i, 6);
  assert.ok(r.prelim.includes('not_all'));
});

test('Короткий матч (меньше 10 минут) не оценивается', () => {
  const r = ev({}, { dur: 540 });
  assert.equal(r.status, 'insufficient'); assert.equal(r.reason, 'short');
  assert.equal(r.mvp.state, 'nodata');
});

/* ---------- 7. Равные оценки ---------- */
test('Равные оценки двух лидеров: «Нет однозначного лидера», выбор не случаен', () => {
  const same = { k: 12, d: 2, s: 8, g: 700, x: 780, hd: 1200 * 30 };
  const r = ev({ 0: same, 1: Object.assign({}, same, { h: 1 }) });
  assert.equal(r.mvp.state, 'tie');
  assert.equal(r.mvp.text, 'Нет однозначного лидера');
  assert.deepEqual(r.mvp.contenders, [0, 1]);
  assert.equal(I.statusOf(r, { i: 0 }), null); assert.equal(I.statusOf(r, { i: 1 }), null);
});

test('Разрыв меньше порога MARGIN считается ничьей, больше — нет', () => {
  const a = { k: 12, d: 2, s: 8, g: 700, x: 780, hd: 1200 * 30 };
  const near = ev({ 0: a, 1: Object.assign({}, a, { h: 1, g: 703 }) });
  assert.ok(Math.abs(near.players[0].mvp - near.players[1].mvp) < I.MARGIN);
  assert.equal(near.mvp.state, 'tie');
  const far = ev({ 0: a, 1: Object.assign({}, a, { h: 1, k: 6, d: 6, s: 5, hd: 800 * 30, g: 560, x: 620 }) });
  assert.equal(far.mvp.state, 'assigned'); assert.equal(far.mvp.i, 0);
});

test('Если все играют одинаково средне, статусы не назначаются принудительно', () => {
  const r = ev({});
  assert.equal(r.mvp.state, 'none'); assert.equal(r.mvp.text, 'Нет выраженного MVP');
  assert.equal(r.worst.state, 'none'); assert.equal(r.worst.text, 'Нет выраженного отстающего');
});

/* ---------- 8. Нет статистики ---------- */
test('Нет статистики: пустая запись, пустой список, нули у всех', () => {
  for (const rec of [null, undefined, {}, { p: [] }, { dur: 1800, p: [] }]) {
    const r = I.evaluate(rec, { bench: BENCH });
    assert.equal(r.status, 'insufficient'); assert.equal(r.reason, 'no_stats');
    assert.equal(r.mvp.state, 'nodata');
  }
  const zeros = match({}); zeros.p.forEach((p) => Object.assign(p, { k: 0, d: 0, s: 0, g: 0, x: 0, lh: 0, hd: null, hh: null, td: null }));
  const r = I.evaluate(zeros, { bench: BENCH });
  assert.equal(r.status, 'insufficient'); assert.equal(r.reason, 'no_stats');
  const nine = match({}); nine.p.pop();
  assert.equal(I.evaluate(nine, { bench: BENCH }).reason, 'players');
});

/* ---------- 9. Повторный расчёт ---------- */
test('Повторный расчёт даёт идентичный результат и не меняет входные данные', () => {
  const rec = match({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30 }, 9: { k: 0, d: 14, s: 1, g: 250, x: 300, hd: 150 * 30, lh: 20 } });
  const before = clone(rec), bench = clone(BENCH);
  const a = I.evaluate(rec, { bench }), b = I.evaluate(clone(rec), { bench: clone(bench) });
  assert.deepEqual(a, b);
  assert.deepEqual(rec, before); assert.deepEqual(bench, BENCH);
  assert.equal(I.signature(rec, { bench }), I.signature(clone(rec), { bench: clone(bench) }));
});

test('Порядок игроков в записи не влияет на то, кто получит статус', () => {
  const rec = match({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30 }, 9: { k: 0, d: 14, s: 1, g: 250, x: 300, hd: 150 * 30, lh: 20 } });
  const rev = clone(rec); rev.p.reverse();
  const a = I.evaluate(rec, { bench: BENCH }), b = I.evaluate(rev, { bench: BENCH });
  assert.equal(a.mvp.a, b.mvp.a); assert.equal(a.worst.a, b.worst.a);
  assert.equal(a.mvp.score, b.mvp.score);
});

/* ---------- 10. Версия алгоритма ---------- */
test('Версия алгоритма: сохранённый результат другой версии или с другими входами не используется', () => {
  const rec = match({}), sig = I.signature(rec, { bench: BENCH });
  const r = I.evaluate(rec, { bench: BENCH });
  assert.equal(r.algo, I.ALGO);
  assert.ok(sig.startsWith(I.ALGO + '|'));
  assert.equal(I.reusable({ algo: I.ALGO, sig }, sig), true);
  assert.equal(I.reusable({ algo: 'impact-0', sig: sig.replace(I.ALGO, 'impact-0') }, sig), false, 'другая версия');
  assert.equal(I.reusable({ algo: I.ALGO, sig: sig + 'x' }, sig), false, 'другие входные данные');
  assert.equal(I.reusable(null, sig), false);
  assert.notEqual(I.signature(rec, { bench: null }), sig, 'появились бенчмарки: результат стоит пересчитать');
});

test('Сводка не смешивает версии: количество оценок по версиям считается отдельно', () => {
  const res = ev({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30 } });
  const old = Object.assign({}, res, { algo: 'impact-0' });
  const s = I.summarize([{ res, ref: { i: 0 } }, { res: old, ref: { i: 0 } }]);
  assert.deepEqual(s.algos, { [I.ALGO]: 1, 'impact-0': 1 });
});

/* ---------- сводка и привязка ---------- */
test('Привязка статуса по герою и стороне, когда Steam ID скрыт', () => {
  const rec = match({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30, a: null } });
  const r = I.evaluate(rec, { bench: BENCH });
  assert.equal(r.mvp.a, null);
  assert.equal(I.statusOf(r, { h: 1, r: 1 }), 'mvp');
  assert.equal(I.statusOf(r, { h: 1, r: 0 }), null, 'такой же герой у соперников — не MVP');
});

test('Доля показывается только при достаточной истории', () => {
  const win = ev({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30 } });
  const few = I.summarize([1, 2, 3].map(() => ({ res: win, ref: { i: 0 } })));
  assert.equal(few.enough, false); assert.equal(few.mvpShare, null); assert.equal(few.mvp, 3);
  const items = [1, 2, 3, 4].map(() => ({ res: win, ref: { i: 0 } })).concat([{ res: win, ref: { i: 5 } }, { res: null, ref: { i: 0 } }]);
  const s = I.summarize(items);
  assert.equal(s.total, 6); assert.equal(s.judged, 5); assert.equal(s.enough, true);
  assert.equal(s.mvp, 4); assert.equal(s.mvpShare, 0.8);
});

test('Игрок, исключённый из сравнения, не попадает в знаменатель доли', () => {
  const res = ev({ 6: { lv: 3 } });
  const s = I.summarize([{ res, ref: { i: 6 } }, { res, ref: { i: 0 } }, { res, ref: { h: 99, r: 1 } }]);
  assert.equal(s.total, 3); assert.equal(s.judged, 1); assert.equal(s.excluded, 2);
});

test('Победа — только контекст: проигравший с лучшей игрой остаётся MVP', () => {
  const r = ev({ 5: { k: 16, d: 1, s: 9, g: 780, x: 850, hd: 1500 * 30 } });   // Dire проигрывает (rw=1)
  assert.equal(r.mvp.state, 'assigned'); assert.equal(r.mvp.i, 5);
  assert.equal(r.mvp.bonus.win, 0);
  const winner = ev({ 0: { k: 16, d: 1, s: 9, g: 780, x: 850, hd: 1500 * 30 } });
  assert.equal(winner.mvp.bonus.win, I.BONUS.win);
  assert.equal(I.BONUS.win < 8, true, 'бонус за победу малый');
});

/* ---------- совместимость записи матча ---------- */
test('DMPerf.fromDetail сохраняет прежние поля и добавляет победителя и данные разбора', () => {
  const det = { match_id: 8000000002, duration: 2000, radiant_win: false, players: [] };
  for (let i = 0; i < 10; i++) det.players.push({ account_id: 100 + i, hero_id: i + 1, player_slot: i < 5 ? i : 128 + i - 5, kills: 1, deaths: 2, assists: 3, gold_per_min: 400, xp_per_min: 500, hero_damage: 9000, hero_healing: 0, last_hits: 100, tower_damage: 300, leaver_status: 0, stuns: i === 0 ? 55.5 : undefined, obs_placed: i === 0 ? 4 : undefined });
  const rec = P.fromDetail(det, 100);
  assert.equal(rec.rw, 0); assert.equal(rec.mr, 1); assert.equal(rec.p.length, 10);
  assert.equal(rec.p[0].k, 1); assert.equal(rec.p[0].g, 400);
  assert.equal(rec.p[0].st, 55.5); assert.equal(rec.p[0].ob, 4); assert.equal(rec.p[0].se, null);
  assert.equal(rec.p[1].st, null, 'неразобранный матч: данных разбора нет, нулями не подменяем');
  assert.equal(P.fromDetail(Object.assign({}, det, { radiant_win: undefined }), 100).rw, null);
  const sc = P.scoreMatch(rec, null, 2000);
  assert.equal(sc.length, 10);
});

test('Объяснения не содержат NaN/undefined и заканчиваются точкой', () => {
  const r = ev({ 0: { k: 14, d: 2, s: 8, g: 720, x: 800, hd: 1300 * 30 }, 9: { k: 0, d: 14, s: 1, g: 250, x: 300, hd: 150 * 30, lh: 20 } });
  for (const t of [r.mvp.text, r.worst.text]) { assert.doesNotMatch(t, /NaN|undefined|null/); assert.match(t, /\.$/); }
  for (const p of r.players) for (const k of ['mvp', 'weak']) assert.ok(p[k] == null || (p[k] >= 0 && p[k] <= 100));
});
