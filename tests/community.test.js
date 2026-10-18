'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DB = require('../server/db.js');
const C = require('../server/community.js');

const T0 = 1_800_000_000;
const REP = '1001', TGT = '2002', MOD = '9009', OTHER = '3003';
const MID = '7000000001';

function setup(over) {
  let t = T0;
  const db = DB.open(':memory:');
  const detail = (id) => ({ start_time: T0 - 3600, duration: 2400, game_mode: 22, players: [
    { account_id: 1001, hero_id: 1, player_slot: 0, kills: 3, deaths: 5, assists: 7 },
    { account_id: 2002, hero_id: 2, player_slot: 1, kills: 1, deaths: 20, assists: 2, personaname: 'Target' },
    { account_id: 3003, hero_id: 3, player_slot: 2, kills: 1, deaths: 1, assists: 1 },
    { account_id: 4004, hero_id: 4, player_slot: 128, kills: 1, deaths: 1, assists: 1 },
    { account_id: 5005, hero_id: 5, player_slot: 129, kills: 1, deaths: 1, assists: 1 }] });
  const svc = C.create(Object.assign({ db, now: () => t, moderators: new Set([MOD, '9010']),
    fetchMatch: async (id) => { if (id === '7999999999') throw Object.assign(new Error('x'), { code: 'not_found' }); return detail(id); } }, over || {}));
  return { db, svc, tick: (s) => { t += s; }, get now() { return t; } };
}
const body = (o) => Object.assign({ target: TGT, matchId: MID, category: 'feeding', description: 'Умышленно умирал в течение всей игры подряд', evidence: ['https://example.com/clip'], consent: true }, o || {});
const U = (acc) => ({ acc });
const post = (s, user, p, b) => s.svc.route('POST', p, { user, body: b });
const get = (s, user, p, q) => s.svc.route('GET', p, { user, query: q });

test('миграции применяются один раз и идемпотентны', () => {
  const db = DB.open(':memory:');
  DB.migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, DB.MIGRATIONS.length);
});

test('жалоба без входа отклоняется (401)', async () => {
  const s = setup();
  assert.equal((await post(s, null, '/reports', body())).status, 401);
});

test('жалоба создаётся, дубль по тому же матчу → 409, жалоба на себя → 400', async () => {
  const s = setup();
  const r = await post(s, U(REP), '/reports', body());
  assert.equal(r.status, 201); assert.equal(r.body.status, 'new');
  assert.equal((await post(s, U(REP), '/reports', body())).status, 409);
  assert.equal((await post(s, U(REP), '/reports', body({ target: REP }))).status, 400);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reports').get().n, 1);
});

test('валидация: короткое описание, плохая ссылка, неверный матч', async () => {
  const s = setup();
  assert.equal((await post(s, U(REP), '/reports', body({ description: 'мало' }))).status, 400);
  assert.equal((await post(s, U(REP), '/reports', body({ evidence: ['http://127.0.0.1/x'] }))).status, 400);
  assert.equal((await post(s, U(REP), '/reports', body({ evidence: ['https://x.com/a.exe'] }))).status, 400);
  assert.equal((await post(s, U(REP), '/reports', body({ matchId: 'abc' }))).status, 400);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reports').get().n, 0);
});

test('участие в матче проверяется на сервере', async () => {
  const s = setup();
  assert.equal((await post(s, U('7777'), '/reports', body())).body.error, 'not_participant');
  assert.equal((await post(s, U(REP), '/reports', body({ target: '8888' }))).body.error, 'target_not_in_match');
  assert.equal((await post(s, U(REP), '/reports', body({ matchId: '7999999999' }))).status, 404);
});

test('матч старше 60 дней не принимается', async () => {
  const s = setup({ fetchMatch: async () => ({ start_time: T0 - 61 * 86400, players: [{ account_id: 1001, player_slot: 0 }, { account_id: 2002, player_slot: 1 }] }) });
  assert.equal((await post(s, U(REP), '/reports', body())).body.error, 'match_too_old');
});

test('суточный лимит жалоб и лимит на одну цель', async () => {
  const s = setup({ limits: { reportsPerDay: 2, perTargetPerWeek: 2 } });
  assert.equal((await post(s, U(REP), '/reports', body({ matchId: '7000000001' }))).status, 201);
  assert.equal((await post(s, U(REP), '/reports', body({ matchId: '7000000002' }))).status, 201);
  assert.equal((await post(s, U(REP), '/reports', body({ matchId: '7000000003' }))).status, 429);
  s.tick(86400 + 10);
  assert.equal((await post(s, U(REP), '/reports', body({ matchId: '7000000003' }))).body.error, 'target_limit');
});

test('одна жалоба не попадает в публичный счётчик; две разных автора по двум матчам — попадают', async () => {
  const s = setup();
  await post(s, U(REP), '/reports', body({ matchId: '7000000001' }));
  let sum = (await get(s, null, '/player/' + TGT)).body;
  assert.equal(sum.unconfirmed.hidden, true); assert.deepEqual(sum.confirmed, []);
  await post(s, U(OTHER), '/reports', body({ matchId: '7000000001' }));
  sum = (await get(s, null, '/player/' + TGT)).body;
  assert.equal(sum.unconfirmed.hidden, true, 'два автора, но один матч');
  await post(s, U(OTHER), '/reports', body({ matchId: '7000000002' }));
  sum = (await get(s, null, '/player/' + TGT)).body;
  assert.equal(sum.unconfirmed.hidden, false); assert.equal(sum.unconfirmed.reporters, 2); assert.equal(sum.unconfirmed.matches, 2);
  assert.ok(!JSON.stringify(sum).includes(REP), 'автор жалобы не раскрывается');
});

test('права: не-модератор не видит и не меняет модерацию', async () => {
  const s = setup();
  const r = await post(s, U(REP), '/reports', body());
  assert.equal((await get(s, U(REP), '/mod/reports')).status, 403);
  assert.equal((await get(s, null, '/mod/reports')).status, 401);
  assert.equal((await post(s, U(REP), '/mod/reports/' + r.body.id + '/status', { to: 'confirmed', reason: 'я сам себе модератор' })).status, 403);
});

test('переходы статусов: требуется обоснование и допустимый переход', async () => {
  const s = setup();
  const id = (await post(s, U(REP), '/reports', body())).body.id;
  const set = (to, reason) => post(s, U(MOD), '/mod/reports/' + id + '/status', { to, reason });
  assert.equal((await set('confirmed', 'коротко')).status, 400);
  assert.equal((await set('disputed', 'Проверка переходов статусов')).body.error, 'bad_transition');
  assert.equal((await set('pending', 'Взято в работу, проверяю повтор')).status, 200);
  assert.equal((await set('confirmed', 'Повтор виден в реплее, подтверждаю')).status, 200);
  assert.equal((await set('new', 'Назад в новые нельзя')).status, 409);
  const log = (await get(s, U(MOD), '/mod/log')).body.log;
  assert.ok(log.filter((l) => l.action === 'status').length === 2);
  assert.ok(log.every((l) => l.actor));
});

test('модератор не может модерировать жалобу, где он автор или цель', async () => {
  const s = setup({ fetchMatch: async () => ({ start_time: T0 - 100, players: [{ account_id: 9009, player_slot: 0 }, { account_id: 2002, player_slot: 1 }, { account_id: 1001, player_slot: 2 }] }) });
  const id = (await post(s, U(MOD), '/reports', body())).body.id;
  assert.equal((await post(s, U(MOD), '/mod/reports/' + id + '/status', { to: 'pending', reason: 'Беру свою же жалобу' })).status, 403);
  assert.equal((await post(s, U('9010'), '/mod/reports/' + id + '/status', { to: 'pending', reason: 'Другой модератор берёт' })).status, 200);
});

test('подтверждение появляется в публичной сводке, снятие отметки убирает её', async () => {
  const s = setup();
  const id = (await post(s, U(REP), '/reports', body())).body.id;
  const st = (to, reason, pr) => post(s, U(MOD), '/mod/reports/' + id + '/status', { to, reason, publicReason: pr });
  await st('pending', 'Беру в работу, проверяю реплей');
  assert.equal((await st('confirmed', 'Реплей подтверждает умышленные смерти', 'Умышленные смерти на 20–35 минутах')).status, 200);
  let sum = (await get(s, null, '/player/' + TGT)).body;
  assert.equal(sum.confirmed.length, 1); assert.equal(sum.confirmed[0].reason, 'Умышленные смерти на 20–35 минутах');
  assert.ok(sum.confirmed[0].decidedAt);
  // игрок оспаривает → отметка помечена, в «подтверждённые» не входит
  const ap = await post(s, U(TGT), '/appeals', { reportId: id, text: 'Это была смена стратегии, а не умышленные смерти', evidence: [] });
  assert.equal(ap.status, 201);
  sum = (await get(s, null, '/player/' + TGT)).body;
  assert.equal(sum.confirmed.length, 0); assert.equal(sum.disputed.length, 1); assert.equal(sum.openAppeals, 1);
  // модератор отменяет
  const dec = await post(s, U(MOD), '/mod/appeals/' + ap.body.id, { decision: 'revoke', reason: 'Повторный просмотр: умысла нет' });
  assert.equal(dec.status, 200); assert.equal(dec.body.reportStatus, 'not_confirmed');
  sum = (await get(s, null, '/player/' + TGT)).body;
  assert.equal(sum.confirmed.length, 0); assert.equal(sum.disputed.length, 0); assert.equal(sum.openAppeals, 0);
  // автор обращения получил уведомление о решении
  assert.equal((await get(s, U(TGT), '/notifications')).body.notifications.some((n) => n.kind === 'decision'), true);
});

test('обжалование: только публичная отметка, дубль → 409, чужое обращение статус не меняет', async () => {
  const s = setup();
  const id = (await post(s, U(REP), '/reports', body())).body.id;
  assert.equal((await post(s, U(TGT), '/appeals', { reportId: id, text: 'Эта жалоба пока непроверенная' })).status, 404, 'непубличную нельзя');
  await post(s, U(MOD), '/mod/reports/' + id + '/status', { to: 'confirmed', reason: 'Очевидно по статистике и реплею' });
  assert.equal((await post(s, U(OTHER), '/appeals', { reportId: id, text: 'Я игрок из команды и не согласен' })).status, 201);
  assert.equal(s.db.prepare('SELECT status FROM reports WHERE id = ?').get(id).status, 'confirmed', 'чужое обращение не снимает отметку');
  assert.equal((await post(s, U(OTHER), '/appeals', { reportId: id, text: 'Ещё раз то же самое обращение' })).status, 409);
  assert.equal((await post(s, U(TGT), '/appeals', { reportId: id, text: 'Прошу пересмотреть', evidence: ['ftp://x.com/a'] })).status, 400);
});

test('жалоба на жалобу: только цель или участник матча, дубль и причина', async () => {
  const s = setup();
  const id = (await post(s, U(REP), '/reports', body())).body.id;
  assert.equal((await post(s, U(REP), '/reports/' + id + '/flag', { reason: 'Это моя жалоба, хочу флаг' })).status, 400);
  assert.equal((await post(s, U('6006'), '/reports/' + id + '/flag', { reason: 'Посторонний человек пытается' })).status, 403);
  assert.equal((await post(s, U(TGT), '/reports/' + id + '/flag', { reason: 'ok' })).status, 400);
  assert.equal((await post(s, U(TGT), '/reports/' + id + '/flag', { reason: 'Жалоба ложная, в матче я играл иначе' })).status, 201);
  assert.equal((await post(s, U(TGT), '/reports/' + id + '/flag', { reason: 'Жалоба ложная, в матче я играл иначе' })).status, 409);
  assert.equal(s.db.prepare('SELECT flags FROM reports WHERE id = ?').get(id).flags, 1);
});

test('всплеск жалоб от многих авторов помечается для модератора', async () => {
  const accs = ['1001', '3003', '4004', '5005', '1111'];
  const s = setup({ limits: { volumeReporters: 4 }, fetchMatch: async () => ({ start_time: T0 - 100, players: [...accs, '2002'].map((a, i) => ({ account_id: Number(a), player_slot: i })) }) });
  let last;
  for (const a of accs.slice(0, 4)) last = await post(s, U(a), '/reports', body());
  assert.equal(last.body.flaggedForReview, true);
  const list = (await get(s, U(MOD), '/mod/reports')).body.reports;
  assert.ok(list[0].volumeFlag);
});

test('«Мои жалобы» не раскрывают причины чужих решений автору иначе как через обоснование модератора; модератор виден как роль', async () => {
  const s = setup();
  const id = (await post(s, U(REP), '/reports', body())).body.id;
  await post(s, U(MOD), '/mod/reports/' + id + '/status', { to: 'rejected', reason: 'Недостаточно оснований для проверки' });
  const mine = (await get(s, U(REP), '/my/reports')).body.reports[0];
  assert.equal(mine.status, 'rejected');
  assert.ok(mine.history.some((h) => h.by === 'модератор'));
  assert.ok(!JSON.stringify(mine).includes(MOD));
  assert.equal((await get(s, U(OTHER), '/my/reports')).body.reports.length, 0);
});

test('список наблюдения: лимит, дубль, уведомление только при росте аномалий', async () => {
  const s = setup({ limits: { watchlistMax: 2 } });
  assert.equal((await post(s, U(REP), '/watchlist', { target: '123456' })).status, 201);
  assert.equal((await post(s, U(REP), '/watchlist', { target: '123456' })).status, 409);
  assert.equal((await post(s, U(REP), '/watchlist', { target: 'abc' })).status, 400);
  assert.equal((await post(s, U(REP), '/watchlist', { target: '654321' })).status, 201);
  assert.equal((await post(s, U(REP), '/watchlist', { target: '777777' })).status, 409);
  const chk = (n) => post(s, U(REP), '/watchlist/123456/check', { state: 'no_signals', anomalies: n, score: 0, confidence: 'low' });
  assert.equal((await chk(0)).body.notified, false);
  assert.equal((await chk(0)).body.notified, false);
  assert.equal((await chk(2)).body.notified, true);
  assert.equal((await chk(2)).body.notified, false);
  const n = (await get(s, U(REP), '/notifications')).body;
  assert.equal(n.notifications.filter((x) => x.kind === 'anomaly').length, 1); assert.equal(n.unread, 1);
  await post(s, U(REP), '/notifications/read', {});
  assert.equal((await get(s, U(REP), '/notifications')).body.unread, 0);
  assert.equal((await post(s, U(OTHER), '/watchlist/123456/check', { state: 'no_signals', anomalies: 1 })).status, 404, 'чужой список недоступен');
  assert.equal((await post(s, U(REP), '/watchlist/123456/check', { state: 'ужас', anomalies: 1 })).status, 400);
});

test('наблюдатели получают разные типы уведомлений: новая жалоба — message, решение — decision', async () => {
  const s = setup();
  await post(s, U(OTHER), '/watchlist', { target: TGT });
  const id = (await post(s, U(REP), '/reports', body())).body.id;
  await post(s, U(MOD), '/mod/reports/' + id + '/status', { to: 'confirmed', reason: 'Подтверждено по реплею матча' });
  const kinds = (await get(s, U(OTHER), '/notifications')).body.notifications.map((n) => n.kind).sort();
  assert.deepEqual(kinds, ['decision', 'message']);
});

test('SQL-инъекция в Steam ID и в тексте не ломает базу', async () => {
  const s = setup();
  assert.equal((await get(s, null, "/player/1;DROP TABLE reports")).status, 404);
  assert.equal((await post(s, U(REP), '/reports', body({ description: "Robert'); DROP TABLE reports;-- умышленно умирал" }))).status, 201);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM reports').get().n, 1);
});

test('parseModerators принимает account id и SteamID64', () => {
  const m = C.parseModerators('123, 76561197960389184 ; bad');
  assert.ok(m.has('123')); assert.ok(m.has('123456')); assert.equal(m.size, 2);
});
