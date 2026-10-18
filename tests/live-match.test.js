'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/live-match.js');
const Draft = require('../js/draft.js');

const OFF = 76561197960265728n;
const sid = (acc) => String(OFF + BigInt(acc));
const HERO = 'DOTA_GAMERULES_STATE_HERO_SELECTION';
const DRAFT = { activeteam: 2, pick: true, activeteam_time_remaining: 20, team2: { home_team: true, pick0_id: 1, ban0_id: 13 }, team3: { pick0_id: 14 } };
const pkt = (o) => Draft.pickGSI(Object.assign({ map: { matchid: '5001', game_state: HERO }, draft: DRAFT }, o));
const spectator = (ids) => {
  const p = { team2: {}, team3: {} };
  for (const [k, acc, name] of ids) { const [t, i] = k.split(':'); p[t === 'r' ? 'team2' : 'team3']['player' + i] = { steamid: sid(acc), name }; }
  return p;
};
const clock = (t0) => { let t = t0 || 1000; const f = () => t; f.set = (v) => { t = v; }; f.add = (v) => { t += v; }; return f; };

test('Steam ID: проверка диапазона и перевод в accountId и обратно', () => {
  assert.equal(L.steamToAccount(sid(39734273)), '39734273');
  assert.equal(L.accountToSteam('39734273'), sid(39734273));
  assert.equal(L.steamToAccount('76561197960265728'), null);          // accountId 0
  assert.equal(L.steamToAccount('7656119800000'), null);               // не 17 цифр
  assert.equal(L.steamToAccount('abc'), null);
  assert.equal(L.steamToAccount(String(OFF + 4294967296n)), null);     // больше 32 бит
  assert.equal(L.parseAccountInput('https://www.opendota.com/players/123'), '123');
  assert.equal(L.parseAccountInput('Просто Ник'), null);
  assert.equal(L.parseAccountInput(''), null);
});

test('1. Bridge сообщает о начале драфта: сессия переходит в draft_detected, дубли пакетов не создают новую сессию', () => {
  const s = L.createSession({ now: clock() });
  assert.equal(s.snapshot().phase, 'idle');
  const r1 = s.push(pkt({}), 1000);
  assert.equal(r1.newMatch, true); assert.equal(r1.epoch, 1);
  assert.equal(s.snapshot().phase, 'draft_detected');
  for (let i = 0; i < 5; i++) assert.equal(s.push(pkt({}), 1100 + i).newMatch, false);
  assert.equal(s.snapshot().epoch, 1);
  assert.notEqual(s.snapshot().phase, 'draft_detected');
  assert.deepEqual(s.snapshot().draft.picks.radiant, [1]);
  assert.deepEqual(s.snapshot().draft.picks.dire, [14]);
});

test('2. Все десять ID доступны (режим наблюдателя): десять identified, у каждого свой accountId', () => {
  const s = L.createSession({ now: clock() });
  const ids = []; for (let i = 0; i < 5; i++) { ids.push(['r:' + i, 100 + i, 'R' + i]); ids.push(['d:' + i, 200 + i, 'D' + i]); }
  const r = s.push(pkt({ player: spectator(ids) }), 1000);
  const sn = s.snapshot();
  assert.equal(sn.counts.identified, 10); assert.equal(r.newIds.length, 10);
  assert.equal(new Set(sn.slots.map((x) => x.identity.accountId)).size, 10);
  assert.ok(sn.slots.every((x) => x.identity.source === 'spectator'));
  assert.equal(sn.slots.filter((x) => x.side === 'radiant').length, 5);
});

test('3. Доступны ID только части игроков: остальные pending, чужие данные не подставляются', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: spectator([['r:0', 100, 'A'], ['d:2', 202, 'B']]) }), 1000);
  const sn = s.snapshot();
  assert.equal(sn.counts.identified, 2); assert.equal(sn.counts.pending, 8);
  assert.equal(sn.slots.filter((x) => x.identity.accountId).length, 2);
  assert.ok(sn.slots.filter((x) => !x.identity.accountId).every((x) => x.identity.steamId === null));
});

test('4. ID приходят с задержкой: обновляется только нужная карточка, загруженная статистика не сбрасывается', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: spectator([['r:0', 100, 'A']]) }), 1000);
  s.setStats('100', 'ready');
  const r = s.push(pkt({ player: spectator([['r:0', 100, 'A'], ['d:1', 201, 'B']]) }), 2000);
  assert.deepEqual(r.newIds, ['201']);                         // только новый
  assert.equal(s.snapshot().counts.identified, 2);
  assert.equal(s.snapshot().phase, 'loading_stats');           // у нового статистики ещё нет
  s.setStats('201', 'ready');
  assert.equal(s.snapshot().phase, 'resolving_players');       // остальные ещё ждут
  assert.equal(s.snapshot().slots.find((x) => x.identity.accountId === '100').identity.state, 'identified');
});

test('5. Steam ID нет весь драфт: pending сменяется на unavailable с понятной причиной, ID не выдумывается', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({}), 1000);
  assert.equal(s.snapshot().counts.pending, 10);
  s.push(pkt({}), 1000 + L.CONFIG.waitForIdsMs + 1);
  const sn = s.snapshot();
  assert.equal(sn.counts.unavailable, 10); assert.equal(sn.counts.identified, 0);
  assert.match(sn.slots[0].identity.reason, /не передала Steam ID|cfg/);
  assert.ok(sn.slots.every((x) => x.identity.accountId === null));
});

test('Клиент игрока: известен только свой ID, остальные девять unavailable сразу, а не угадываются', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: { steamid: sid(777), name: 'Я', team_name: 'dire', team_slot: 3 } }), 1000);
  const sn = s.snapshot();
  assert.equal(sn.counts.identified, 1); assert.equal(sn.counts.unavailable, 9);
  const me = sn.slots.find((x) => x.identity.accountId);
  assert.equal(me.side, 'dire'); assert.equal(me.self, true); assert.equal(me.index, 3); assert.equal(me.identity.source, 'local');
  assert.match(sn.slots.find((x) => !x.identity.accountId).identity.reason, /только вашего аккаунта/);
});

test('Свой ID без стороны команды не размещается: сторону не угадываем', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: { steamid: sid(777), name: 'Я' } }), 1000);
  assert.equal(s.snapshot().counts.identified, 0);
});

test('6. Одинаковые ники: идентичность определяется только по accountId, ник никого не склеивает', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: spectator([['r:0', 100, 'Same'], ['r:1', 101, 'Same'], ['d:0', 200, 'Same']]) }), 1000);
  const ids = s.snapshot().slots.filter((x) => x.identity.accountId);
  assert.equal(ids.length, 3); assert.equal(new Set(ids.map((x) => x.identity.accountId)).size, 3);
  // только ник, без Steam ID: личности не появляется
  const s2 = L.createSession({ now: clock() });
  s2.push(pkt({ player: { team2: { player0: { name: 'Same' }, player1: { name: 'Same' } } } }), 1000);
  assert.equal(s2.snapshot().counts.identified, 0);
});

test('Один и тот же accountId не занимает два слота', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: spectator([['r:0', 100, 'A'], ['r:1', 100, 'A again']]) }), 1000);
  assert.equal(s.snapshot().counts.identified, 1);
});

test('Мусор в steamid и имени отбрасывается', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: { team2: { player0: { steamid: '12345', name: 'x' }, player1: { steamid: '76561197960265728', name: 'нулевой' } } } }), 1000);
  assert.equal(s.snapshot().counts.identified, 0);
  const a = L.adapt(Draft.pickGSI({ player: { steamid: sid(5), name: 'A\u0000\u0007B'.repeat(50), team_name: 'radiant' } }));
  assert.ok(a.ids[0].name.length <= 64); assert.ok(!/[\u0000-\u001f]/.test(a.ids[0].name));
});

test('Герой игрока берётся только из блока hero с известным слотом (наблюдатель), не из порядка выбора', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: spectator([['r:0', 100, 'A']]), hero: { team2: { player0: { id: 74 } } } }), 1000);
  assert.equal(s.snapshot().slots.find((x) => x.identity.accountId === '100').heroId, 74);
  const s2 = L.createSession({ now: clock() });
  s2.push(pkt({ player: { steamid: sid(7), team_name: 'radiant' } }), 1000);
  assert.equal(s2.snapshot().slots.find((x) => x.identity.accountId === '7').heroId, null);   // пик команды ≠ игрок
});

test('Новый матч полностью изолирован от старого: личности, ручные записи, статусы статистики, epoch', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: spectator([['r:0', 100, 'A']]) }), 1000);
  s.setStats('100', 'ready');
  assert.equal(s.addManual('dire', '555').ok, true);
  const r = s.push(pkt({ map: { matchid: '5002', game_state: HERO }, player: spectator([['d:4', 300, 'N']]) }), 5000);
  assert.equal(r.newMatch, true); assert.equal(r.epoch, 2);
  const sn = s.snapshot();
  assert.deepEqual(sn.slots.filter((x) => x.identity.accountId).map((x) => x.identity.accountId), ['300']);
  assert.equal(sn.slots.some((x) => x.identity.source === 'manual'), false);
  assert.equal(sn.matchId, '5002');
  // статус статистики старого игрока не переходит в новый матч
  s.push(pkt({ map: { matchid: '5002', game_state: HERO }, player: spectator([['d:4', 300, 'N'], ['r:0', 100, 'A']]) }), 5100);
  assert.equal(s.snapshot().phase, 'loading_stats');
});

test('Драфт «откатился» (меньше героев, чем было): это новый матч даже без matchid', () => {
  const s = L.createSession({ now: clock() });
  const big = { activeteam: 2, team2: { pick0_id: 1, pick1_id: 2, ban0_id: 3 }, team3: { pick0_id: 14, ban0_id: 5 } };
  s.push(Draft.pickGSI({ map: { game_state: HERO }, draft: big }), 1000);
  const r = s.push(Draft.pickGSI({ map: { game_state: HERO }, draft: { activeteam: 2, team2: { ban0_id: 7 } } }), 2000);
  assert.equal(r.newMatch, true);
});

test('Матч идёт, завершается, после завершения новая фаза выбора начинает новую сессию', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({}), 1000);
  s.push({ map: { matchid: '5001', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' } }, 2000);
  assert.equal(s.snapshot().phase, 'in_game');
  s.push({ map: { matchid: '5001', game_state: 'DOTA_GAMERULES_STATE_POST_GAME' } }, 3000);
  assert.equal(s.snapshot().phase, 'finished');
  const r = s.push(pkt({ map: { game_state: HERO } }), 4000);
  assert.equal(r.newMatch, true); assert.equal(s.snapshot().epoch, 2);
});

test('13. Потеря и возврат Bridge: phase disconnected, данные остаются, после возврата прежнее состояние', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: spectator([['r:0', 100, 'A']]) }), 1000); s.setStats('100', 'ready');
  const before = s.snapshot().phase;
  s.setTransport('lost');
  const lost = s.snapshot();
  assert.equal(lost.phase, 'disconnected'); assert.equal(lost.counts.identified, 1); assert.equal(lost.draft.picks.radiant[0], 1);
  s.setTransport('connected');
  assert.equal(s.snapshot().phase, before);
  assert.equal(L.createSession().snapshot().phase, 'idle');
  const fresh = L.createSession(); fresh.setTransport('lost'); assert.equal(fresh.snapshot().phase, 'disconnected');
});

test('Приватный профиль и ошибка статистики меняют состояние личности, но не превращают её в чужую', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({ player: spectator([['r:0', 100, 'A'], ['r:1', 101, 'B']]) }), 1000);
  s.setStats('100', 'private', 'скрыт'); s.setStats('101', 'error', 'сеть');
  const sn = s.snapshot();
  assert.equal(sn.slots.find((x) => x.identity.accountId === '100').identity.state, 'private');
  assert.equal(sn.slots.find((x) => x.identity.accountId === '101').identity.state, 'error');
  assert.equal(sn.counts.private, 1); assert.equal(sn.counts.error, 1);
  s.setStats('101', 'ready');
  assert.equal(s.snapshot().slots.find((x) => x.identity.accountId === '101').identity.state, 'identified');
});

test('Ручной ввод: только валидный ID, без дублей, максимум пять на сторону, источник «manual»', () => {
  const s = L.createSession({ now: clock() });
  assert.equal(s.addManual('radiant', '1').reason, 'no_match');
  s.push(pkt({ player: { steamid: sid(7), team_name: 'radiant', team_slot: 0 } }), 1000);
  assert.equal(s.addManual('radiant', 'Ник').reason, 'bad_id');
  assert.equal(s.addManual('left', '5').reason, 'bad_side');
  assert.equal(s.addManual('radiant', '7').reason, 'duplicate');
  for (let i = 1; i <= 4; i++) assert.equal(s.addManual('radiant', String(100 + i)).ok, true);
  assert.equal(s.addManual('radiant', '999').reason, 'side_full');
  const m = s.snapshot().slots.filter((x) => x.identity.source === 'manual');
  assert.equal(m.length, 4);
  assert.equal(s.removeManual('101'), true);
  // игра позже присылает тот же ID: остаётся один, источник из игры
  s.push(pkt({ player: spectator([['d:0', 102, 'X']]) }), 1100);
  assert.equal(s.snapshot().slots.filter((x) => x.identity.accountId === '102').length, 1);
  assert.equal(s.snapshot().slots.find((x) => x.identity.accountId === '102').identity.source, 'spectator');
});

test('Snapshot не раскрывает внутреннее состояние: изменение результата ничего не портит', () => {
  const s = L.createSession({ now: clock() });
  s.push(pkt({}), 1000);
  const a = s.snapshot(); a.draft.picks.radiant.push(99); a.slots.length = 0;
  const b = s.snapshot();
  assert.deepEqual(b.draft.picks.radiant, [1]); assert.equal(b.slots.length, 10);
});
