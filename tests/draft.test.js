'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/draft.js');

/* Тело GSI собрано по описанию полей из открытых библиотек (xzion/dota2-gsi, antonpup/Dota2GSI), это не запись реального матча. */
const gsi = (over) => Object.assign({
  provider: { name: 'Dota 2', appid: 570 },
  map: { matchid: '7900000001', game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION', game_time: 0 },
  player: { team_name: 'dire', steamid: '76561197960265729', gold: 0 },
  draft: {
    activeteam: 3, pick: true, activeteam_time_remaining: 24, radiant_bonus_time: 130, dire_bonus_time: 118,
    team2: { home_team: true, pick0_id: 2, pick0_class: 'npc_dota_hero_axe', pick1_id: 0, pick1_class: '', ban0_id: 14, ban0_class: 'npc_dota_hero_pudge', ban1_id: 0 },
    team3: { home_team: false, pick0_id: 74, pick0_class: 'npc_dota_hero_invoker', ban0_id: 1, ban0_class: 'npc_dota_hero_antimage', ban1_id: 5 }
  }
}, over || {});

test('GSI: разбор блока draft, сторона игрока, таймеры', () => {
  const r = D.fromGSI(gsi());
  assert.equal(r.hasDraft, true);
  const s = r.state;
  assert.deepEqual(s.picks, { radiant: [2], dire: [74] });
  assert.deepEqual(s.bans, { radiant: [14], dire: [1, 5] }, 'нулевые слоты пропускаются');
  assert.equal(s.active, 'dire');
  assert.equal(s.pickFlag, true);
  assert.equal(s.timeLeft, 24);
  assert.deepEqual(s.bonus, { radiant: 130, dire: 118 });
  assert.equal(s.mySide, 'dire');
  assert.equal(s.matchId, '7900000001');
  assert.equal(s.gameState, 'DOTA_GAMERULES_STATE_HERO_SELECTION');
  assert.equal(s.source, 'gsi');
  assert.deepEqual(s.slugs, { 2: 'axe', 14: 'pudge', 74: 'invoker', 1: 'antimage' });
});

test('GSI: терпим к отсутствию полей и к мусору', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { draft: null }, { draft: 'x' }, { draft: {} }, { map: { game_state: 'X' } }]) {
    const r = D.fromGSI(bad);
    assert.equal(r.hasDraft, false, JSON.stringify(bad));
    assert.equal(r.state, null);
  }
  const r = D.fromGSI({ map: { game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: '0' } });
  assert.equal(r.gameState, 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS');
  assert.equal(r.matchId, null, 'нулевой matchid не считается номером матча');
  /* только activeteam без команд: драфт идёт, но пока пустой */
  const e = D.fromGSI({ draft: { activeteam: 2, pick: false, activeteam_time_remaining: '30' } });
  assert.equal(e.hasDraft, true); assert.equal(e.state.active, 'radiant'); assert.equal(e.state.pickFlag, false); assert.equal(e.state.timeLeft, 30);
  assert.equal(D.isEmpty(e.state), true);
  /* ID как строки, дубликаты, лишние и огромные значения, класс-инъекция */
  const t = D.fromGSI({ draft: { team2: { pick0_id: '2', pick1_id: '2', pick2_id: 99999, pick3_id: -4, pick4_id: 1.5, pick0_class: 'npc_dota_hero_axe"><script>', ban0_id: '14', ban9_id: 7 } } }).state;
  assert.deepEqual(t.picks.radiant, [2]);
  assert.deepEqual(t.bans.radiant, [14, 7]);
  assert.deepEqual(t.slugs, {}, 'небезопасный класс не попадает в slug');
  /* больше пяти выборов не бывает */
  const many = { draft: { team3: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((i) => ['pick' + i + '_id', i + 1])) } };
  assert.equal(D.fromGSI(many).state.picks.dire.length, 5);
});

test('GSI: pickGSI оставляет только нужное и не передаёт чужие данные игрока', () => {
  const p = D.pickGSI(Object.assign(gsi(), { items: { slot0: { name: 'item_blink' } }, hero: { xpos: 5 }, auth: { token: 'секрет' }, previously: { x: 1 } }));
  assert.deepEqual(Object.keys(p).sort(), ['draft', 'map', 'player']);
  assert.deepEqual(p.player, { team_name: 'dire', team: undefined });
  assert.equal(JSON.stringify(p).includes('секрет'), false);
  assert.equal(JSON.stringify(p).includes('76561197960265729'), false, 'Steam ID игрока наружу не уходит');
  assert.deepEqual(D.pickGSI(null), {});
});

test('ручной ввод: выбор, бан, лимиты, повтор героя, снятие', () => {
  let s = D.empty();
  s = D.addPick(s, 'radiant', 2); assert.deepEqual(s.picks.radiant, [2]);
  assert.equal(D.addPick(s, 'dire', 2), null, 'один герой не может быть выбран дважды');
  assert.equal(D.addBan(s, 'dire', 2), null, 'и забанен после выбора тоже');
  s = D.addBan(s, 'dire', 14); assert.deepEqual(s.bans.dire, [14]);
  for (const id of [3, 4, 5, 6]) s = D.addPick(s, 'radiant', id);
  assert.equal(D.addPick(s, 'radiant', 7), null, 'не больше пяти выборов за команду');
  for (let i = 0; i < 6; i++) s = D.addBan(s, 'dire', 100 + i);
  assert.equal(s.bans.dire.length, 7);
  assert.equal(D.addBan(s, 'dire', 200), null, 'не больше семи банов');
  assert.equal(D.addPick(s, 'nobody', 8), null);
  assert.equal(D.addPick(s, 'dire', 0), null);
  assert.equal(D.addPick(s, 'dire', 'abc'), null);
  assert.equal(D.isTaken(s, 14), true);
  const r = D.removeHero(s, 14); assert.equal(D.isTaken(r, 14), false);
  assert.equal(D.removeHero(s, 999), null);
  assert.equal(s.bans.dire.includes(14), true, 'исходное состояние не меняется');
});

test('события: выборы, баны, ход, завершение, сброс при новом матче', () => {
  const a = D.fromGSI(gsi()).state;
  assert.deepEqual(D.diff(null, a).map((e) => e.type + ':' + (e.side || '') + ':' + (e.hero || '')), ['ban:radiant:14', 'ban:dire:1', 'ban:dire:5', 'pick:radiant:2', 'pick:dire:74', 'turn:dire:']);
  const b = D.clone(a); b.picks.radiant.push(29); b.active = 'radiant';
  assert.deepEqual(D.diff(a, b), [{ type: 'pick', side: 'radiant', hero: 29 }, { type: 'turn', side: 'radiant' }]);
  assert.deepEqual(D.diff(b, b), [], 'без изменений событий нет');
  const c = D.clone(b); c.picks.radiant = [2, 29, 3, 4, 5]; c.picks.dire = [74, 6, 7, 8, 9]; c.active = null;
  const ev = D.diff(b, c).map((e) => e.type);
  assert.equal(ev.includes('done'), true);
  assert.equal(D.isComplete(c), true);
  assert.equal(D.diff(c, c).includes('done'), false, 'done приходит один раз');
  const n = D.clone(a); n.matchId = '7900000002'; n.picks = { radiant: [3], dire: [] }; n.bans = { radiant: [], dire: [] };
  const evn = D.diff(c, n);
  assert.equal(evn[0].type, 'reset');
  assert.deepEqual(evn.filter((e) => e.type === 'pick'), [{ type: 'pick', side: 'radiant', hero: 3 }]);
});

/* Матчапы OpenDota: строка описывает героя enemy против hero_id, wins = победы enemy. */
const META = { 1: { attr: 'agi', roles: ['Carry'] }, 2: { attr: 'str', roles: ['Initiator', 'Durable'] }, 3: { attr: 'int', roles: ['Support'] }, 4: { attr: 'str', roles: ['Support'] }, 5: { attr: 'agi', roles: ['Carry'] } };
test('подсказки: контрпик по матчапам, сглаживание, фильтры, занятые герои', () => {
  let s = D.empty(); s.mySide = 'radiant';
  s = D.addPick(s, 'dire', 5);
  /* враг 5 против героя 1: 400 игр, враг выиграл 180 (45%) → у героя 1 55% против него; против героя 3: 20 игр, враг выиграл 2 */
  const matchups = { 5: [{ hero_id: 1, games_played: 400, wins: 180 }, { hero_id: 2, games_played: 400, wins: 240 }, { hero_id: 3, games_played: 20, wins: 2 }] };
  const r = D.suggest({ state: s, side: 'radiant', meta: META, matchups });
  /* герой 3: (18+25)/70 = 0.614; герой 1: (220+25)/450 = 0.544; герой 2: (160+25)/450 = 0.411; у героя 4 данных нет */
  assert.deepEqual(r.map((x) => x.id), [3, 1, 2, 4]);
  const byId = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.ok(Math.abs(byId[1].vs[0].raw - 0.55) < 1e-9);
  assert.ok(byId[1].score > byId[2].score, 'герой 1 (55%) лучше героя 2 (40%)');
  assert.ok(byId[3].score < 0.9, 'малая выборка (20 игр, 90%) сглажена');
  assert.ok(byId[3].score > byId[2].score, 'но после сглаживания всё равно выше слабого контрпика');
  assert.ok(Math.abs(byId[3].score - 43 / 70) < 1e-9 && Math.abs(byId[1].score - 245 / 450) < 1e-9);
  assert.equal(r.some((x) => x.id === 5), false, 'уже выбранный герой не предлагается');
  assert.equal(byId[4].score, null, 'нет данных матчапа: оценки нет, но герой в списке');
  assert.equal(byId[4].covered, 0);
  assert.deepEqual(D.suggest({ state: s, side: 'radiant', meta: META, matchups, filter: { attr: 'str' } }).map((x) => x.id).sort(), [2, 4]);
  assert.deepEqual(D.suggest({ state: s, side: 'radiant', meta: META, matchups, filter: { role: 'Support' } }).map((x) => x.id).sort(), [3, 4]);
  s = D.addBan(s, 'radiant', 1);
  assert.equal(D.suggest({ state: s, side: 'radiant', meta: META, matchups }).some((x) => x.id === 1), false, 'забаненный не предлагается');
});

test('подсказки: среднее по нескольким врагам, покрытие, мои герои', () => {
  let s = D.empty(); s.mySide = 'dire';
  s = D.addPick(s, 'radiant', 1); s = D.addPick(s, 'radiant', 2);
  const matchups = { 1: [{ hero_id: 3, games_played: 1000, wins: 400 }], 2: [{ hero_id: 3, games_played: 1000, wins: 600 }, { hero_id: 4, games_played: 1000, wins: 450 }] };
  const personal = { 4: { games: 30, win: 20 }, 3: { games: 2, win: 0 } };
  const r = D.suggest({ state: s, side: 'dire', meta: META, matchups, personal });
  const c3 = r.find((x) => x.id === 3), c4 = r.find((x) => x.id === 4);
  assert.equal(c3.covered, 2); assert.equal(c3.total, 2);
  assert.ok(Math.abs(c3.score - ((0.6 * 1000 + 25) / 1050 + (0.4 * 1000 + 25) / 1050) / 2) < 1e-9);
  assert.equal(c4.covered, 1);
  assert.deepEqual(c4.personal, { games: 30, rate: 20 / 30 });
  const mine = D.suggest({ state: s, side: 'dire', meta: META, matchups, personal, sort: 'mine' });
  assert.equal(mine[0].id, 4, 'при сортировке «мои герои» первым идёт самый игранный');
  assert.equal(D.suggest({ state: s, side: 'dire', meta: META, matchups, limit: 2 }).length, 2);
  /* без вражеских пиков оценки нет ни у кого */
  assert.equal(D.suggest({ state: D.empty(), side: 'radiant', meta: META }).every((x) => x.score === null), true);
});

test('состав команды по атрибутам и ролям', () => {
  let s = D.empty();
  for (const id of [1, 2, 3, 99]) s = D.addPick(s, 'radiant', id);
  const c = D.composition(s, 'radiant', META);
  assert.deepEqual(c.attr, { str: 1, agi: 1, int: 1, all: 0 });
  assert.deepEqual(c.roles, { Carry: 1, Initiator: 1, Durable: 1, Support: 1 });
  assert.equal(c.unknown, 1, 'герой без данных считается отдельно');
  assert.equal(c.n, 4);
});

test('демо-последовательность корректна и заканчивается полным драфтом', () => {
  const f = D.demoFrames();
  assert.equal(f.length > 10, true);
  assert.equal(f[0].source, 'demo'); assert.equal(D.isEmpty(f[0]), true);
  for (let i = 1; i < f.length; i++) assert.ok(D.taken(f[i]).size >= D.taken(f[i - 1]).size, 'герои только добавляются');
  const last = f[f.length - 1];
  assert.equal(D.isComplete(last), true, 'в демо по пять героев у каждой команды');
  assert.equal(last.active, null);
});

test('история: ограничение, замена по matchId, очистка мусора', () => {
  let l = [];
  const s = D.addPick(D.empty(), 'radiant', 2); s.matchId = '123';
  l = D.pushHistory(l, s, 1000000);
  l = D.pushHistory(l, Object.assign(D.clone(s), { picks: { radiant: [2, 3], dire: [] } }), 2000000);
  assert.equal(l.length, 1, 'тот же матч заменяет прежнюю запись');
  assert.deepEqual(l[0].picks.radiant, [2, 3]);
  let big = [];
  for (let i = 0; i < 70; i++) { const t = D.addPick(D.empty(), 'dire', 1 + i); big = D.pushHistory(big, t, (i + 1) * 1000); }
  assert.equal(big.length, D.MAX_HISTORY);
  assert.equal(big[0].ts, 70, 'новые сверху');
  const dirty = D.sanitizeHistory([null, 5, { picks: {}, bans: {} }, { id: 'a', ts: 1, picks: { radiant: [2, 'x', 0, 99999], dire: [] }, bans: { radiant: [], dire: [] }, mySide: 'evil', matchId: '12ab', source: 'hack', slugs: { 2: 'axe', 3: '<b>' } }]);
  assert.equal(dirty.length, 1);
  assert.deepEqual(dirty[0].picks.radiant, [2]);
  assert.equal(dirty[0].mySide, null); assert.equal(dirty[0].matchId, null); assert.equal(dirty[0].source, 'manual');
  assert.deepEqual(dirty[0].slugs, { 2: 'axe' });
});

test('toGSI и fromGSI взаимно обратимы', () => {
  const s = D.fromGSI(gsi()).state;
  const back = D.fromGSI(D.toGSI(s)).state;
  assert.deepEqual(back.picks, s.picks); assert.deepEqual(back.bans, s.bans);
  assert.equal(back.active, s.active); assert.equal(back.mySide, s.mySide); assert.equal(back.timeLeft, s.timeLeft);
  assert.deepEqual(back.bonus, s.bonus); assert.equal(back.matchId, s.matchId);
  for (const f of D.demoFrames()) { const x = D.fromGSI(D.toGSI(f)); assert.deepEqual(x.state.picks, f.picks); assert.deepEqual(x.state.bans, f.bans); }
});
