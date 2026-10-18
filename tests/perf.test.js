'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../js/perf.js');

/* таблица с медианой ровно на значении med: процентили 0.1..0.9 */
const table = (med) => [[0.1, med * 0.5], [0.3, med * 0.8], [0.5, med], [0.7, med * 1.2], [0.9, med * 1.6]];
const benchAt = (med) => ({ gold_per_min: table(med.g), xp_per_min: table(med.x), hero_damage_per_min: table(med.hd), kills_per_min: table(med.k) });
const rec = (players, extra) => Object.assign({ v: 1, id: '1', dur: 1800, mr: 0, p: players }, extra);
const pl = (o) => Object.assign({ h: 1, r: 0, a: null, k: 0, d: 0, s: 0, g: 400, x: 500, hd: 0, hh: null, lh: 0, td: null, lv: 0 }, o);

test('fromDetail: компактная запись, сторона игрока и очистка чисел', () => {
  const j = { match_id: 77001, duration: 2100, players: [
    { account_id: 111, hero_id: 2, player_slot: 0, kills: 5, deaths: 3, assists: 9, gold_per_min: 500.5, xp_per_min: 600, last_hits: 200, hero_damage: 20000, hero_healing: 0, tower_damage: 1000, leaver_status: 0, extra: 'x' },
    { account_id: null, hero_id: 14, player_slot: 130, isRadiant: false, kills: -4, deaths: NaN, assists: 'abc', gold_per_min: 300 }] };
  const r = P.fromDetail(j, '111');
  assert.strictEqual(r.id, '77001'); assert.strictEqual(r.dur, 2100); assert.strictEqual(r.mr, 1);
  assert.deepStrictEqual(r.p[0], { h: 2, r: 1, a: '111', k: 5, d: 3, s: 9, g: 500.5, x: 600, hd: 20000, hh: 0, lh: 200, td: 1000, lv: 0, st: null, ob: null, se: null });
  assert.deepStrictEqual([r.p[1].a, r.p[1].r, r.p[1].k, r.p[1].d, r.p[1].s, r.p[1].hd], [null, 0, 0, 0, 0, null]);
  assert.ok(!('extra' in r.p[0]));
  assert.strictEqual(P.fromDetail(j, '999').mr, null, 'вас нет в матче: сторона неизвестна');
  assert.strictEqual(P.fromDetail({ match_id: 1, players: [{ hero_id: 0 }, { hero_id: 1 }] }, '1'), null, 'герой без номера: запись отвергается');
  assert.strictEqual(P.fromDetail(null, '1'), null);
  assert.strictEqual(P.fromDetail({ match_id: 1, players: [] }, '1'), null);
});

test('percentile: интерполяция, края и мусор', () => {
  const t = [[0.1, 100], [0.5, 300], [0.9, 500]], near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  near(P.percentile(t, 200), 0.3);
  near(P.percentile(t, 300), 0.5);
  near(P.percentile(t, 50), 0.05);
  near(P.percentile(t, 500), 0.9);
  near(P.percentile(t, 1000), 1);
  assert.strictEqual(P.percentile(t, NaN), null);
  assert.strictEqual(P.percentile([], 5), null);
  assert.strictEqual(P.percentile(t, 0), 0);
});

test('benchFrom: оставляет нужные метрики по возрастанию, отбрасывает лишнее', () => {
  const rows = [0.5, 0.1, 0.9, 0.3].map((q) => ({ percentile: q, value: q * 1000 }));
  const b = P.benchFrom({ hero_id: 1, result: { gold_per_min: rows, secret: rows, xp_per_min: rows.slice(0, 2), kills_per_min: [{ percentile: 'x', value: 1 }, ...rows] } });
  assert.deepStrictEqual(Object.keys(b).sort(), ['gold_per_min', 'kills_per_min']);
  assert.deepStrictEqual(b.gold_per_min, [[0.1, 100], [0.3, 300], [0.5, 500], [0.9, 900]]);
  assert.strictEqual(b.kills_per_min.length, 4, 'строка с нечисловым процентилем отброшена');
  assert.strictEqual(P.benchFrom({ result: {} }), null);
  assert.strictEqual(P.benchFrom(null), null);
});

test('scoreMatch: игрок на медиане героя даёт точно 52.5 (3.1 звезды)', () => {
  // 30 минут. Медиана: 450 золота, 500 опыта, 600 урона/мин (18000 за матч), 0.2 убийства/мин (6 за матч)
  const bench = { 1: benchAt({ g: 450, x: 500, hd: 600, k: 0.2 }) };
  const me = pl({ h: 1, r: 0, g: 450, x: 500, hd: 18000, k: 6, s: 9, d: 5 });
  // сумма убийств команды = 6 + 19 = 25; участие (6+9)/25 = 0.6 -> (0.6-0.3)/0.6 = 0.5
  const mates = [pl({ h: 2, r: 0, k: 19, d: 5 }), pl({ h: 3, r: 0, d: 5 }), pl({ h: 4, r: 0, d: 5 }), pl({ h: 5, r: 0, d: 5 })];
  const enemies = [6, 7, 8, 9, 10].map((h) => pl({ h, r: 1, d: 5 }));
  const out = P.scoreMatch(rec([me, ...mates, ...enemies]), bench, 1800)[0];
  assert.strictEqual(out.src, 'hero');
  assert.ok(Math.abs(out.imp - 0.5) < 1e-9, 'вклад: ' + out.imp);
  assert.ok(Math.abs(out.part - 0.5) < 1e-9, 'участие: ' + out.part);
  assert.ok(Math.abs(out.surv - 0.625) < 1e-9, 'живучесть: ' + out.surv);
  assert.strictEqual(out.score, 52.5);
  assert.strictEqual(out.stars, 3.1);
  assert.strictEqual(out.pos, 1, 'самый высокий GPM в своей команде');
});

test('scoreMatch: лучшая игра даёт больше худшей, а выход из матча ограничивает оценку', () => {
  const bench = { 1: benchAt({ g: 450, x: 500, hd: 600, k: 0.2 }) };
  const base = (o) => rec([pl(Object.assign({ h: 1, r: 0, d: 5 }, o)), ...[2, 3, 4, 5].map((h) => pl({ h, r: 0, k: 4, d: 5 })), ...[6, 7, 8, 9, 10].map((h) => pl({ h, r: 1, d: 5 }))]);
  const great = P.scoreMatch(base({ g: 900, x: 1000, hd: 50000, k: 15, s: 12, d: 1 }), bench, 1800)[0];
  const poor = P.scoreMatch(base({ g: 180, x: 220, hd: 3000, k: 0, s: 1, d: 14 }), bench, 1800)[0];
  assert.ok(great.score > 85, 'сильная игра: ' + great.score);
  assert.ok(poor.score < 20, 'слабая игра: ' + poor.score);
  const left = P.scoreMatch(base({ g: 900, x: 1000, hd: 50000, k: 15, s: 12, d: 1, lv: 2 }), bench, 1800)[0];
  assert.strictEqual(left.score, 15); assert.strictEqual(left.leaver, true);
  const dc = P.scoreMatch(base({ g: 900, x: 1000, hd: 50000, k: 15, s: 12, d: 1, lv: 1 }), bench, 1800)[0];
  assert.strictEqual(dc.leaver, false, 'кратковременный дисконнект (1) не наказываем');
  assert.ok(dc.score > 85);
});

test('scoreMatch: короткий матч не оценивается, без бенчмарка сравнение внутри матча', () => {
  const players = [pl({ h: 1, r: 0, g: 800, x: 900, hd: 40000, k: 10, s: 5, d: 2 }), pl({ h: 2, r: 0, g: 200, x: 250, hd: 2000, k: 0, s: 3, d: 9 }), ...[3, 4, 5].map((h) => pl({ h, r: 0, g: 400, x: 500, hd: 15000, k: 3, d: 5 })), ...[6, 7, 8, 9, 10].map((h) => pl({ h, r: 1, g: 400, x: 500, hd: 15000, k: 3, d: 5 }))];
  const short = P.scoreMatch(rec(players, { dur: 500 }), {}, 500);
  assert.ok(short.every((x) => x.score === null && x.short === true));
  const rel = P.scoreMatch(rec(players), {}, 1800);
  assert.strictEqual(rel[0].src, 'match');
  assert.ok(rel[0].score > rel[1].score + 30, `${rel[0].score} против ${rel[1].score}`);
  assert.strictEqual(rel[0].pos, 1); assert.strictEqual(rel[1].pos, 5);
});

test('scoreMatch: лечение учитывается, только если оно было', () => {
  const bench = { 1: Object.assign(benchAt({ g: 300, x: 400, hd: 300, k: 0.1 }), { hero_healing_per_min: table(60) }) };
  const mk = (hh) => rec([pl({ h: 1, r: 0, g: 300, x: 400, hd: 9000, k: 3, s: 20, d: 5, hh }), ...[2, 3, 4, 5].map((h) => pl({ h, r: 0, k: 3, d: 5 })), ...[6, 7, 8, 9, 10].map((h) => pl({ h, r: 1, d: 5 }))]);
  const without = P.scoreMatch(mk(0), bench, 1800)[0], withHeal = P.scoreMatch(mk(60 * 30 * 1.6), bench, 1800)[0];
  assert.ok(withHeal.imp > without.imp, 'высокое лечение подняло вклад');
  assert.ok(Math.abs(without.imp - 0.5) < 1e-9, 'нулевое лечение не тянет вклад вниз: ' + without.imp);
});

test('findRecord: по Steam ID, по герою и стороне, неоднозначности', () => {
  const r = rec([pl({ h: 2, r: 0, a: '111' }), pl({ h: 14, r: 0 }), pl({ h: 14 + 1, r: 1, a: '222' }), pl({ h: 30, r: 1 })], { mr: 0 });
  const heroId = (n) => ({ Axe: 2, Pudge: 14, 'Witch Doctor': 30 })[n];
  assert.strictEqual(P.findRecord(r, { sid: '222', hero: 'x', ally: false }, heroId), 2);
  assert.strictEqual(P.findRecord(r, { sid: null, hero: 'Pudge', ally: true }, heroId), 1, 'скрытый союзник по герою и стороне');
  assert.strictEqual(P.findRecord(r, { sid: null, hero: 'Pudge', ally: false }, heroId), -1, 'Pudge на другой стороне не подходит');
  assert.strictEqual(P.findRecord(r, { sid: 'nick:вася', hero: 'Witch Doctor', ally: false }, heroId), 3, 'игрок с ником вместо ID');
  assert.strictEqual(P.findRecord(r, { sid: null, hero: 'Неизвестный', ally: true }, heroId), -1);
  assert.strictEqual(P.findRecord(Object.assign({}, r, { mr: null }), { sid: null, hero: 'Pudge', ally: true }, heroId), -1, 'сторона неизвестна: по герою не ищем');
  assert.strictEqual(P.findRecord(Object.assign({}, r, { mr: null }), { sid: '111', hero: 'Axe', ally: true }, heroId), 0, 'по ID находим и без стороны');
  assert.strictEqual(P.findRecord(null, { sid: '1' }, heroId), -1);
});

test('aggregate: среднее, надёжность, динамика, пустой ввод', () => {
  const it = (score, ts, o) => Object.assign({ score, ts, src: 'hero', leaver: false }, o);
  const a = P.aggregate([it(40, 1), it(50, 2), null, it(null, 3), it(70, 4), it(80, 5), it(60, 6)]);
  assert.strictEqual(a.n, 5); assert.strictEqual(a.score, 60); assert.strictEqual(a.stars, 3.4); assert.strictEqual(a.conf, 'good');
  assert.strictEqual(a.trend, 'up'); assert.strictEqual(a.hero, 5);
  const b = P.aggregate([it(50, 1), it(52, 2)]);
  assert.strictEqual(b.conf, 'low'); assert.strictEqual(b.trend, null);
  const c = P.aggregate([it(80, 1), it(80, 2), it(40, 3, { src: 'match', leaver: true }), it(40, 4)]);
  assert.strictEqual(c.trend, 'down'); assert.strictEqual(c.hero, 3); assert.strictEqual(c.leavers, 1); assert.strictEqual(c.conf, 'ok');
  assert.deepStrictEqual(P.aggregate([]), { n: 0, score: null, stars: null, conf: 'none', hero: 0, leavers: 0, trend: null });
});

test('verdict и explain: тексты не пустые и честные', () => {
  assert.strictEqual(P.verdict(4.5), 'очень сильная игра'); assert.strictEqual(P.verdict(3.0), 'ровная игра'); assert.strictEqual(P.verdict(1.2), 'очень слабая игра'); assert.strictEqual(P.verdict(null), '');
  assert.match(P.explain({ score: 50, imp: 0.5, part: 0.5, surv: 0.625, src: 'hero' }), /Вклад 50% \(по меркам героя\).*участие в убийствах 50%.*живучесть 63%/);
  assert.match(P.explain({ score: 10, imp: 0.1, part: 0, surv: 0, src: 'match', leaver: true }), /внутри матча.*Вышел из матча/);
  assert.match(P.explain({ score: null, short: true }), /короче 10 минут/);
});
