'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../js/analytics.js');

const NOW = 1_800_000_000;
const DAY = 86400;
let seq = 0;
function mk(o) {
  seq++;
  return Object.assign({ id: String(1000 + seq), start: NOW - DAY, dur: 2000, win: true, hero: 1, k: 5, d: 5, a: 5, gpm: 500, xpm: 600, lh: 200, dn: 10, laneRole: null, roam: null, mode: 22, lobby: 7, party: 1, leaver: 0, pos: null }, o);
}
const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b);

test('parsePlayerInput: разные форматы дают один и тот же аккаунт', () => {
  const want = { ok: true, acc: '86745912', steam64: '76561198047011640' };
  const cases = ['86745912', '76561198047011640', 'https://steamcommunity.com/profiles/76561198047011640/',
    'steamcommunity.com/profiles/76561198047011640', 'https://www.dotabuff.com/players/86745912', 'https://www.opendota.com/players/86745912/matches',
    'STEAM_0:0:43372956', '[U:1:86745912]', '  86745912  '];
  for (const c of cases) {
    const r = A.parsePlayerInput(c);
    assert.equal(r.ok, true, c);
    assert.equal(r.acc, want.acc, c);
    assert.equal(r.steam64, want.steam64, c);
  }
  assert.equal(A.parsePlayerInput('STEAM_0:1:43372956').acc, '86745913');
});

test('parsePlayerInput: ошибки и ссылки с именем', () => {
  assert.deepEqual(A.parsePlayerInput('   '), { ok: false, code: 'empty' });
  assert.equal(A.parsePlayerInput('https://steamcommunity.com/id/some_name/').code, 'vanity');
  assert.equal(A.parsePlayerInput('https://steamcommunity.com/id/some_name/').vanity, 'some_name');
  for (const bad of ['abc', '0', '99999999999999999999999', 'https://example.com/players/5', 'https://steamcommunity.com/groups/x', 'STEAM_9:0:1']) {
    assert.equal(A.parsePlayerInput(bad).ok, false, bad);
  }
});

test('normalizeMatch: победа считается по стороне и radiant_win', () => {
  const base = { match_id: 1, duration: 100, start_time: 5 };
  assert.equal(A.normalizeMatch({ ...base, player_slot: 0, radiant_win: true }).win, true);
  assert.equal(A.normalizeMatch({ ...base, player_slot: 4, radiant_win: false }).win, false);
  assert.equal(A.normalizeMatch({ ...base, player_slot: 129, radiant_win: false }).win, true);
  assert.equal(A.normalizeMatch({ ...base, player_slot: 132, radiant_win: true }).win, false);
});

test('normalizeMatch: нет данных остаётся null, а не нулём', () => {
  const m = A.normalizeMatch({ match_id: 7, player_slot: 0, radiant_win: true, start_time: 10, hero_id: 3, kills: 0 });
  assert.equal(m.k, 0);
  assert.equal(m.d, null);
  assert.equal(m.gpm, null);
  assert.equal(m.laneRole, null);
  assert.equal(A.normalizeMatch({ match_id: 7, player_slot: 0 }), null);
  assert.equal(A.normalizeMatch(null), null);
});

test('filterMatches: период, герой, результат, позиция', () => {
  const list = [
    mk({ start: NOW - 1 * DAY, hero: 1, win: true, pos: 1 }),
    mk({ start: NOW - 6 * DAY, hero: 2, win: false, pos: 2 }),
    mk({ start: NOW - 8 * DAY, hero: 1, win: false }),
    mk({ start: NOW - 40 * DAY, hero: 1, win: true, pos: 1 }),
    mk({ start: null, hero: 1, win: true })
  ];
  assert.equal(A.filterMatches(list, { periodDays: 7, now: NOW }).length, 2);
  assert.equal(A.filterMatches(list, { periodDays: 30, now: NOW }).length, 3);
  assert.equal(A.filterMatches(list, { now: NOW }).length, 5);
  assert.equal(A.filterMatches(list, { hero: 1 }).length, 4);
  assert.equal(A.filterMatches(list, { hero: '2' }).length, 1);
  assert.equal(A.filterMatches(list, { result: 'win' }).length, 3);
  assert.equal(A.filterMatches(list, { result: 'loss' }).length, 2);
  assert.equal(A.filterMatches(list, { pos: 1 }).length, 2);
  assert.equal(A.filterMatches(list, { pos: 0 }).length, 2, 'позиция 0 = не определена (два матча без позиции)');
  const r = A.filterMatches(list, { periodDays: 30, now: NOW });
  assert.ok(r[0].start >= r[1].start, 'сначала новые');
});

test('summarize: винрейт, средние, длительность', () => {
  const list = [mk({ win: true, k: 10, d: 2, a: 8, gpm: 600, dur: 2000 }), mk({ win: false, k: 2, d: 8, a: 4, gpm: 400, dur: 3000 }), mk({ win: true, k: 6, d: 2, a: 6, gpm: 500, dur: 2500 })];
  const s = A.summarize(list);
  assert.equal(s.n, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  close(s.winrate, 2 / 3);
  close(s.k, 6); close(s.d, 4); close(s.a, 6);
  close(s.kdaRatio, (18 + 18) / 12);
  close(s.gpm, 500); close(s.dur, 2500);
});

test('summarize: пустой список и пропуски не превращаются в нули', () => {
  const e = A.summarize([]);
  assert.equal(e.n, 0); assert.equal(e.winrate, null); assert.equal(e.gpm, null); assert.equal(e.kdaRatio, null);
  const s = A.summarize([mk({ gpm: 600 }), mk({ gpm: null }), mk({ gpm: 400 }), mk({ gpm: null, k: null })]);
  close(s.gpm, 500);
  assert.equal(s.gpmN, 2);
  assert.equal(s.kdaN, 3, 'матч без убийств не входит в K/D/A');
  const none = A.summarize([mk({ gpm: null }), mk({ gpm: null })]);
  assert.equal(none.gpm, null);
  assert.equal(none.gpmN, 0);
});

test('streaks: текущая и самые длинные серии', () => {
  const r = (win, i) => mk({ win, start: NOW - (20 - i) * DAY });
  const list = [true, true, false, true, true, true, true, false, false, false].map(r);
  const s = A.streaks(list);
  assert.deepEqual(s.current, { type: 'loss', len: 3 });
  assert.equal(s.longestWin, 4);
  assert.equal(s.longestLoss, 3);
  assert.deepEqual(A.streaks([]).current, { type: null, len: 0 });
  assert.deepEqual(A.streaks([mk({ win: true })]).current, { type: 'win', len: 1 });
});

test('wilson: известное значение и пустая выборка', () => {
  const w = A.wilson(10, 20);
  close(w.lower, 0.2993, 1e-3); close(w.upper, 0.7007, 1e-3);
  assert.equal(A.wilson(0, 0).lower, null);
  assert.ok(A.wilson(5, 5).lower < A.wilson(50, 50).lower, 'больше выборка, выше нижняя граница');
});

function many(hero, wins, losses, extra) {
  const out = [];
  for (let i = 0; i < wins + losses; i++) out.push(mk(Object.assign({ hero, win: i < wins, start: NOW - (i + 1) * 3600 * 5 }, extra)));
  return out;
}

test('герои: выборка важнее процента', () => {
  const list = [].concat(many(1, 17, 8), many(2, 2, 0), many(3, 6, 14), many(4, 7, 8), many(5, 4, 4), many(6, 16, 31));
  const overall = 0.5; // средний винрейт аккаунта задан явно, чтобы порог не зависел от состава тестовых героев
  const cl = A.classifyHeroes(A.heroStats(list), overall, { minMatches: 5 });
  const ids = (a) => a.map((h) => h.heroId);
  assert.deepEqual(ids(cl.best), [1], 'герой на 25 матчах, 68%, лучший');
  assert.ok(!ids(cl.best).includes(2), '2 из 2 побед не считаются лучшим героем');
  assert.deepEqual(ids(cl.lowSample), [2], 'герой с 2 матчами в «мало данных»');
  assert.ok(ids(cl.worst).includes(3) && ids(cl.worst).includes(6));
  assert.ok(ids(cl.develop).includes(4) || ids(cl.develop).includes(5));
  const all = [].concat(ids(cl.best), ids(cl.worst), ids(cl.develop));
  assert.equal(new Set(all).size, all.length, 'герой попадает только в одну категорию');
  assert.equal(cl.best[0].confident, true);
});

test('герои: порог минимальных матчей меняется', () => {
  const list = [].concat(many(1, 3, 0), many(2, 1, 4), many(3, 5, 5));
  const overall = A.summarize(list).winrate;
  const hs = A.heroStats(list);
  assert.equal(A.classifyHeroes(hs, overall, { minMatches: 5 }).best.length, 0);
  assert.deepEqual(A.classifyHeroes(hs, overall, { minMatches: 3 }).best.map((h) => h.heroId), [1]);
  assert.equal(A.classifyHeroes(hs, null, {}).best.length, 0);
});

test('explainHero: текст с процентом, матчами и пометкой о малой выборке', () => {
  const h = A.heroStats(many(7, 17, 8))[0];
  const t = A.explainHero(h, 0.51, 'best');
  assert.match(t, /68% побед за 25 матчей/);
  assert.match(t, /выше твоего среднего/);
  const small = A.heroStats(many(8, 4, 1))[0];
  assert.match(A.explainHero(small, 0.5, 'best'), /Выборка небольшая/);
});

// схема: игроки одной команды
function team(rows, rad = true) {
  return rows.map((r, i) => ({ account_id: r.id, player_slot: rad ? i : 128 + i, isRadiant: rad, lane_role: r.lane, net_worth: r.gold, is_roaming: false }));
}
test('inferPosition: стандартная расстановка', () => {
  const t = team([{ id: 1, lane: 1, gold: 30000 }, { id: 2, lane: 2, gold: 28000 }, { id: 3, lane: 3, gold: 22000 }, { id: 4, lane: 3, gold: 14000 }, { id: 5, lane: 1, gold: 11000 }]);
  assert.equal(A.inferPosition(t, 1).pos, 1);
  assert.equal(A.inferPosition(t, 2).pos, 2);
  assert.equal(A.inferPosition(t, 3).pos, 3);
  assert.equal(A.inferPosition(t, 4).pos, 4);
  assert.equal(A.inferPosition(t, 5).pos, 5);
});

test('inferPosition: саппорты на одной линии делятся по золоту, игроки второй команды не мешают', () => {
  const mine = team([{ id: 1, lane: 1, gold: 30000 }, { id: 2, lane: 2, gold: 28000 }, { id: 3, lane: 3, gold: 22000 }, { id: 4, lane: 1, gold: 14000 }, { id: 5, lane: 1, gold: 11000 }]);
  const enemy = team([{ id: 11, lane: 1, gold: 31000 }, { id: 12, lane: 2, gold: 20000 }, { id: 13, lane: 3, gold: 20000 }, { id: 14, lane: 3, gold: 9000 }, { id: 15, lane: 1, gold: 8000 }], false);
  const all = mine.concat(enemy);
  assert.equal(A.inferPosition(all, 4).pos, 4);
  assert.equal(A.inferPosition(all, 5).pos, 5);
  assert.equal(A.inferPosition(all, 11).pos, 1);
});

test('inferPosition: нет данных разбора или противоречие, тогда null', () => {
  const noParse = team([{ id: 1, lane: null, gold: 3 }, { id: 2, lane: 2, gold: 2 }, { id: 3, lane: 3, gold: 1 }, { id: 4, lane: 3, gold: 1 }, { id: 5, lane: 1, gold: 1 }]);
  assert.equal(A.inferPosition(noParse, 2).pos, null);
  assert.equal(A.inferPosition(noParse, 2).why, 'not_parsed');
  const dualSafe = team([{ id: 1, lane: 1, gold: 30000 }, { id: 2, lane: 1, gold: 28000 }, { id: 3, lane: 3, gold: 22000 }, { id: 4, lane: 3, gold: 14000 }, { id: 5, lane: 2, gold: 11000 }]);
  assert.equal(A.inferPosition(dualSafe, 1).pos, null);
  assert.equal(A.inferPosition(dualSafe, 1).why, 'core_lanes');
  assert.equal(A.inferPosition(dualSafe, 999).why, 'not_in_match');
  assert.equal(A.inferPosition(null, 1).pos, null);
  const nogold = team([{ id: 1, lane: 1, gold: null }, { id: 2, lane: 2, gold: 2 }, { id: 3, lane: 3, gold: 1 }, { id: 4, lane: 3, gold: 1 }, { id: 5, lane: 1, gold: 1 }]);
  assert.equal(A.inferPosition(nogold, 2).why, 'no_gold');
});

test('positionStats: «Не определена» не смешивается с известными позициями', () => {
  const list = [].concat(many(1, 6, 2, { pos: 1 }), many(2, 3, 5, { pos: 2 }), many(3, 4, 4, {}), many(4, 5, 0, { pos: 3 }));
  const ps = A.positionStats(list, { minMatches: 5 });
  assert.equal(ps.rows[1].n, 8); assert.equal(ps.rows[2].n, 8); assert.equal(ps.rows[0].n, 8);
  assert.equal(ps.known, 21);
  assert.equal(ps.total, 29);
  assert.equal(ps.best, 3, 'у позиции 3 лучшая нижняя граница при 5 из 5');
  assert.ok(!ps.qualifying.includes(0));
  const none = A.positionStats(many(1, 3, 3, {}), { minMatches: 5 });
  assert.equal(none.known, 0); assert.equal(none.best, null);
});

test('timeSeries: дни без матчей остаются пустыми, а винрейт нарастающий', () => {
  const today = Math.floor(NOW / DAY) * DAY + 12 * 3600; // полдень «сегодня» по UTC
  const list = [
    mk({ start: today - 2 * DAY, win: true }), mk({ start: today - 2 * DAY + 60, win: false }),
    mk({ start: today, win: true }), mk({ start: today - 30 * DAY, win: false })
  ];
  const ts = A.timeSeries(list, { periodDays: 7, now: today, offMin: 0 });
  assert.equal(ts.bucket, 'day');
  assert.equal(ts.points.length, 7);
  const last = ts.points[6], mid = ts.points[4], empty = ts.points[5];
  assert.equal(last.n, 1); assert.equal(mid.n, 2); assert.equal(empty.n, 0);
  assert.equal(empty.wr, null, 'нет матчей: винрейт не 0%, а пусто');
  assert.equal(ts.points[0].cumWr, null, 'до первого матча периода нет значения');
  close(mid.cumWr, 0.5); close(last.cumWr, 2 / 3);
  assert.equal(ts.points.reduce((a, p) => a + p.n, 0), 3, 'матч 30 дней назад в 7-дневный период не попал');
});

test('timeSeries: «всё время» делится по неделям, пустой список даёт пустой ряд', () => {
  const today = Math.floor(NOW / DAY) * DAY + 12 * 3600;
  const list = [mk({ start: today - 100 * DAY }), mk({ start: today })];
  const ts = A.timeSeries(list, { periodDays: null, now: today, offMin: 0 });
  assert.equal(ts.bucket, 'week');
  assert.ok(ts.points.length >= 14 && ts.points.length <= 16);
  assert.equal(ts.points.reduce((a, p) => a + p.n, 0), 2);
  assert.equal(A.timeSeries([], { periodDays: null, now: today }).points.length, 0);
});

test('kdaSeries: порядок по времени и скользящее среднее', () => {
  const list = [mk({ k: 10, d: 0, a: 10, start: NOW - 3 * DAY }), mk({ k: 1, d: 5, a: 4, start: NOW - 2 * DAY }), mk({ k: 5, d: 5, a: 5, start: NOW - 1 * DAY }), mk({ k: null, start: NOW })];
  const s = A.kdaSeries(list, { window: 3 });
  assert.equal(s.length, 3, 'матч без K/D/A пропущен');
  close(s[0].v, 20); close(s[1].v, 1); close(s[2].v, 2);
  close(s[2].ma, (20 + 1 + 2) / 3);
  assert.equal(s[0].ma, null, 'среднее не считается по одной точке');
});

test('compareWindows: последние 7 дней против предыдущих 7', () => {
  const list = [].concat(many(1, 2, 8, { start: NOW - 2 * DAY }), many(1, 6, 4, { start: NOW - 10 * DAY }));
  const c = A.compareWindows(list, { now: NOW, days: 7, min: 5 });
  assert.equal(c.enough, true);
  close(c.recent.winrate, 0.2); close(c.prev.winrate, 0.6);
  close(c.diffPP, -40, 1e-6);
  const few = A.compareWindows(many(1, 1, 1, { start: NOW - 2 * DAY }), { now: NOW, days: 7, min: 5 });
  assert.equal(few.enough, false);
});

test('coverage и coversPeriod: неполная история не выдаётся за полную', () => {
  const list = [mk({ start: NOW - 5 * DAY }), mk({ start: NOW - 2 * DAY })];
  const c = A.coverage(list, 120, true);
  assert.equal(c.loaded, 2); assert.equal(c.total, 120); assert.equal(c.complete, false);
  assert.equal(A.coverage(list, 2, false).complete, true);
  assert.equal(A.coversPeriod(list, 30, NOW, true), false, 'самый старый матч моложе 30 дней, а страниц ещё много');
  assert.equal(A.coversPeriod(list, 3, NOW, true), true, 'найден матч старше 3 дней');
  assert.equal(A.coversPeriod(list, 30, NOW, false), true, 'история закончилась');
  assert.equal(A.coversPeriod(list, null, NOW, true), false);
});

test('buildInsights: мало данных объясняется честно', () => {
  const out = A.buildInsights({ matches: many(1, 2, 1), now: NOW, minMatches: 5 });
  assert.equal(out.length, 1);
  assert.match(out[0].text, /нужно хотя бы 5 матчей, сейчас загружено 3/);
});

test('buildInsights: ухудшение за 7 дней, герой и позиции', () => {
  const list = [].concat(
    many(1, 2, 8, { start: NOW - 2 * DAY, pos: 1 }),
    many(1, 6, 4, { start: NOW - 10 * DAY, pos: 1 }),
    many(2, 9, 3, { start: NOW - 12 * DAY, pos: 2 }),
    many(3, 1, 3, { start: NOW - 12 * DAY, pos: 2 })
  );
  const out = A.buildInsights({ matches: list, now: NOW, minMatches: 5, heroName: (id) => 'Hero' + id });
  const by = Object.fromEntries(out.map((x) => [x.id, x]));
  assert.equal(by.trend.level, 'warn');
  assert.match(by.trend.text, /ухудшились: 20% \(10 матчей\) против 62% \(26 матчей\)/);
  assert.match(by.pos.text, /лучшая позиция за последние 30 дней/);
  assert.match(by.low.text, /Hero3 мало матчей \(4 из 5 нужных\)/);
});

test('buildInsights: нет позиций, подсказывает, что делать', () => {
  const out = A.buildInsights({ matches: many(1, 6, 6, { start: NOW - 3 * DAY }), now: NOW, minMatches: 5 });
  const pos = out.find((x) => x.id === 'pos');
  assert.match(pos.text, /Позиции за 30 дней пока не определены \(12 из 12 матчей\)/);
});

test('buildInsights: предупреждает о неполной истории', () => {
  const out = A.buildInsights({ matches: many(1, 6, 6), now: NOW, minMatches: 5, coverage: { loaded: 12, total: 400, complete: false } });
  assert.match(out.find((x) => x.id === 'cov').text, /12 из 400/);
});

test('recommendHeroes: порядок по надёжности и честные причины пустого результата', () => {
  const list = [].concat(many(1, 17, 8, { pos: 1 }), many(2, 5, 0, { pos: 1 }), many(3, 4, 16, { pos: 2 }));
  const r = A.recommendHeroes(list, { minMatches: 5, limit: 5 });
  assert.deepEqual(r.items.map((h) => h.heroId), [1, 2], '25 матчей на 68% надёжнее, чем 5 из 5');
  assert.deepEqual(A.recommendHeroes(list, { minMatches: 5, pos: 2 }).items.length, 0);
  assert.match(A.recommendHeroes(list, { minMatches: 5, pos: 2 }).reason, /нет результатов не ниже/i);
  assert.match(A.recommendHeroes(list, { minMatches: 5, pos: 4 }).reason, /Нет матчей с определённой позицией/);
  assert.match(A.recommendHeroes(many(1, 2, 1), { minMatches: 5 }).reason, /Нет героев как минимум с 5 матчей/);
  assert.equal(A.recommendHeroes([], {}).items.length, 0);
});

test('rankTier: названия рангов', () => {
  assert.equal(A.rankTier(80).label, 'Immortal');
  assert.equal(A.rankTier(54).label, 'Legend 4');
  assert.equal(A.rankTier(11).label, 'Herald 1');
  assert.equal(A.rankTier(null), null);
  assert.equal(A.rankTier(0), null);
});

test('inferRole: по золоту команды кор или саппорт, спорные границы не назначаются', () => {
  const { inferRole, filterMatches } = require('../js/analytics.js');
  const team = (golds, meIdx) => golds.map((g, i) => ({ account_id: i === meIdx ? 7 : 100 + i, isRadiant: true, net_worth: g })).concat(
    [1, 2, 3, 4, 5].map((i) => ({ account_id: 900 + i, isRadiant: false, net_worth: 1000 * i })));
  assert.equal(inferRole(team([30000, 20000, 15000, 8000, 6000], 0), 7).role, 'core');
  assert.equal(inferRole(team([30000, 20000, 15000, 8000, 6000], 4), 7).role, 'support');
  assert.equal(inferRole(team([30000, 20000, 10000, 9900, 6000], 2), 7).role, null, 'третий и четвёртый почти равны: не назначаем');
  assert.equal(inferRole(team([30000, 20000, 15000, 8000, 6000], 0), 8).role, null, 'игрока нет в матче');
  assert.equal(inferRole(null, 7).role, null);
  const list = [
    { id: '1', start: 3, win: true, pos: null, role: 'core' }, { id: '2', start: 2, win: true, pos: 2, role: null },
    { id: '3', start: 1, win: false, pos: null, role: 'support' }, { id: '4', start: 0, win: false, pos: null, role: null }];
  assert.deepEqual(filterMatches(list, { pos: 'core' }).map((m) => m.id), ['1']);
  assert.deepEqual(filterMatches(list, { pos: 'support' }).map((m) => m.id), ['3']);
  assert.deepEqual(filterMatches(list, { pos: 0 }).map((m) => m.id), ['1', '3', '4'], 'без точной позиции: 0 включает и оценки ролей');
});

test('matchScores: 0 это средняя игра, лучше — плюс, хуже — минус, без данных оценки нет', () => {
  const { matchScores } = require('../js/analytics.js');
  const mk = (i, k, d, a, gpm, xpm, hero) => ({ id: String(i), start: i, win: true, hero: hero || 1, k, d, a, gpm, xpm });
  const list = [];
  for (let i = 0; i < 10; i++) list.push(mk(i, 5 + (i % 3), 5, 10, 450 + (i % 4) * 20, 500 + (i % 3) * 20));
  list.push(mk(20, 15, 1, 20, 800, 900)); // выдающаяся
  list.push(mk(21, 0, 12, 1, 250, 300));  // провальная
  const r = matchScores(list);
  assert.equal(r.ready, true);
  assert.ok(r.scores['20'].v >= 2, 'выдающаяся игра сильно выше нуля: ' + r.scores['20'].v);
  assert.ok(r.scores['21'].v <= -1.5, 'провальная игра ниже нуля: ' + r.scores['21'].v);
  assert.ok(r.scores['20'].v <= 3 && r.scores['21'].v >= -3, 'оценка ограничена');
  const mid = list.slice(0, 10).map((m) => r.scores[m.id].v);
  assert.ok(Math.abs(mid.reduce((a, b) => a + b, 0) / mid.length) < 0.5, 'обычные игры около нуля');
  // мало данных: оценки нет
  assert.equal(matchScores(list.slice(0, 5)).ready, false);
  assert.deepEqual(matchScores(list.slice(0, 5)).scores, {});
  // у игры одного показателя нет: оценки у неё нет, а не 0
  const lack = list.concat([{ id: '99', start: 99, win: true, hero: 1, k: null, d: null, a: null, gpm: 500, xpm: null }]);
  assert.equal(matchScores(lack).scores['99'], undefined);
  // база по герою: 5+ матчей на герое сравниваются с его средним
  const heroList = list.concat(Array.from({ length: 6 }, (_, i) => mk(40 + i, 2, 6, 3, 300, 350, 7)));
  const hr = matchScores(heroList);
  assert.equal(hr.scores['40'].basis, 'hero');
  assert.ok(Math.abs(hr.scores['40'].v) < 0.7, 'обычная игра на «слабом» герое около нуля: ' + hr.scores['40'].v);
});
