'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/live-stats.js');

/* Подставные часы и таймеры: тест управляет временем сам. */
function world(over) {
  const w = { t: 1_800_000_000_000, timers: [], calls: [], updates: [] };
  w.now = () => w.t;
  w.setTimer = (fn, ms) => { const h = { fn, at: w.t + ms, dead: false }; w.timers.push(h); return h; };
  w.clearTimer = (h) => { h.dead = true; };
  w.advance = async (ms) => {
    const end = w.t + ms;
    for (;;) {
      await settle();
      const due = w.timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      w.t = Math.max(w.t, due.at); due.dead = true; due.fn();
    }
    w.t = end; await settle();
  };
  return Object.assign(w, over || {});
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

const NOWS = 1_800_000_000;
function rows(n, o) {
  o = o || {};
  return Array.from({ length: n }, (_, i) => ({ match_id: 9000 + i, player_slot: 1, radiant_win: o.win ? o.win(i) : i % 2 === 0, start_time: NOWS - i * 7200, duration: 2100 + (i % 5) * 60, hero_id: 1 + (i % 3),
    kills: o.k != null ? o.k : 5, deaths: o.d ? o.d(i) : 5, assists: 8, leaver_status: 0 }));
}
function fakeApi(w, behaviour) {
  const b = Object.assign({ player: () => ({ profile: { personaname: 'Nick', avatarmedium: '' }, rank_tier: 55 }), wl: () => ({ win: 30, lose: 20 }), heroes: () => [{ hero_id: '1', games: 20, win: 12 }, { hero_id: '2', games: 9, win: 3 }, { hero_id: '3', games: 5, win: 5 }, { hero_id: '4', games: 1, win: 0 }], matches: () => rows(40) }, behaviour || {});
  const call = (name, acc) => { w.calls.push(name + ':' + acc); return Promise.resolve(b[name](acc)).then((x) => { if (x instanceof Error) throw x; return x; }); };
  return { getPlayer: (a) => call('player', a), getWinLoss: (a) => call('wl', a), getPlayerHeroes: (a) => call('heroes', a), getMatches: (a) => call('matches', a) };
}
const apiErr = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
function svc(w, behaviour, extra) {
  const api = fakeApi(w, behaviour);
  return S.create(Object.assign({ api, now: w.now, setTimer: w.setTimer, clearTimer: w.clearTimer, heroName: (id) => 'hero' + id, onUpdate: (acc, e, ep) => w.updates.push([acc, e.status, ep]) }, extra || {}));
}

test('Сводка: винрейт, K/D/A, три героя, форма считаются из ответов', async () => {
  const w = world(), s = svc(w);
  const r = await s.request('100');
  assert.equal(r.status, 'ready');
  const d = r.data;
  assert.equal(d.winrate, 0.6); assert.equal(d.wl.games, 50); assert.equal(d.sample, 40);
  assert.deepEqual(d.topHeroes.map((x) => x.heroId), [1, 2, 3]);          // три самых частых, четвёртый не попал
  assert.equal(d.topHeroes[0].games, 20); assert.equal(d.topHeroes[0].winrate, 0.6);
  assert.deepEqual([d.kda.k, d.kda.d, d.kda.a], [5, 5, 8]);
  assert.equal(d.form.length, 20); assert.equal(d.rank.label, 'Legend 5');
});

test('14. Отсутствующая статистика не превращается в нули', async () => {
  const w = world();
  const s = svc(w, { wl: () => apiErr('api'), heroes: () => apiErr('api'), matches: () => rows(3).map((r) => { delete r.kills; return r; }) });
  const d = (await s.request('100')).data;
  assert.equal(d.wl, null); assert.equal(d.winrate, null);                 // не 0%
  assert.deepEqual(d.topHeroes, []);
  assert.equal(d.kda, null);                                               // мало матчей или нет kills: не 0/0/0
  assert.equal(d.form.length, 3);
  const e = S.summarize('1', { player: {}, wl: {}, heroes: null, matches: [] });
  assert.equal(e.winrate, null); assert.equal(e.kda, null); assert.equal(e.lastMatchAt, null); assert.equal(e.signals, null); assert.equal(e.rank, null);
});

test('7. API вернул пустой профиль (нет матчей): состояние private с пояснением, без цифр', async () => {
  const w = world(), s = svc(w, { matches: () => [], wl: () => ({ win: 0, lose: 0 }), heroes: () => [] });
  const r = await s.request('100');
  assert.equal(r.status, 'private');
  assert.match(r.error.message, /Нет публичных матчей/);
  assert.equal(r.data.winrate, null); assert.equal(r.data.sample, 0);
});

test('8. Приватный или неполный профиль: 404 -> private; профиль без wl и героев не ломает расчёт', async () => {
  const w = world(), s = svc(w, { player: () => apiErr('not_found') });
  assert.equal((await s.request('100')).status, 'private');
  const w2 = world(), s2 = svc(w2, { player: () => ({}), wl: () => null, heroes: () => 'не список' });
  const r = await s2.request('100');
  assert.equal(r.status, 'ready'); assert.equal(r.data.name, null); assert.equal(r.data.winrate, null);
});

test('9. HTTP 429: пауза очереди, статус rate_limited, автоповтор после Retry-After и ограниченное число попыток', async () => {
  const w = world(); let fail = 2;
  const s = svc(w, { player: (a) => (a === '100' && fail-- > 0 ? apiErr('rate_limit', { retryAfter: 40 }) : { profile: { personaname: 'N' } }) });
  const p = s.request('100'); await settle();
  let e = s.get('100');
  assert.equal(e.status, 'rate_limited'); assert.match(e.error.message, /429/); assert.ok(e.nextTryAt >= w.t + 40000 - 1);
  s.request('200'); await settle();
  assert.equal(w.calls.filter((c) => c === 'player:200').length, 0, 'во время паузы другие игроки не запрашиваются');
  await w.advance(41000);
  assert.equal(s.get('100').status, 'rate_limited');                         // вторая 429
  await w.advance(100000);
  assert.equal(s.get('100').status, 'ready');
  assert.ok(w.calls.filter((c) => c === 'player:100').length <= 3);
  await p;
});

test('10. API временно недоступен: ошибка, backoff, не больше maxAttempts, бесконечного цикла нет', async () => {
  const w = world(), s = svc(w, { player: () => apiErr('network') });
  await s.request('100');
  assert.equal(s.get('100').status, 'error');
  await w.advance(24 * 3600 * 1000);
  const n = w.calls.filter((c) => c === 'player:100').length;
  assert.equal(n, S.CONFIG.maxAttempts);
  assert.match(s.get('100').error.message, /Автоповторы закончились/);
  await w.advance(24 * 3600 * 1000);
  assert.equal(w.calls.filter((c) => c === 'player:100').length, n);
  assert.equal(s.stats().queued, 0);
});

test('API недоступен, но кэш есть: данные остаются на экране, ошибка видна рядом', async () => {
  const w = world(); let down = false;
  const s = svc(w, { player: () => (down ? apiErr('timeout') : { profile: { personaname: 'N' } }) });
  await s.request('100');
  down = true; w.t += S.CONFIG.ttlMs + 1000;
  await s.request('100');
  const e = s.get('100');
  assert.equal(e.status, 'error'); assert.ok(e.data && e.data.sample === 40); assert.equal(e.stale, true);
});

test('11. Один профиль запрашивается один раз: повторные вызовы в пределах кэша и параллельные вызовы', async () => {
  const w = world(), s = svc(w);
  const [a, b] = await Promise.all([s.request('100'), s.request('100')]);
  assert.equal(a.status, 'ready'); assert.equal(b.status, 'ready');
  for (let i = 0; i < 10; i++) await s.request('100');
  assert.equal(w.calls.filter((c) => c === 'player:100').length, 1);
  assert.equal(w.calls.filter((c) => c === 'matches:100').length, 1);
  assert.ok(s.stats().cacheHits >= 10);
});

test('Кэш показывается сразу, обновление идёт в фоне (устаревшие данные помечены)', async () => {
  const w = world(), s = svc(w);
  await s.request('100');
  w.t += S.CONFIG.ttlMs + 5000;
  const g = s.get('100');
  assert.equal(g.status, 'ready'); assert.equal(g.stale, true); assert.ok(g.data);
  const p = s.request('100');
  assert.equal(s.get('100').refreshing, true); assert.ok(s.get('100').data, 'пока идёт обновление, старые данные на месте');
  await p;
  assert.equal(s.get('100').stale, false); assert.equal(w.calls.filter((c) => c === 'player:100').length, 2);
});

test('Ручное обновление не чаще раза в минуту', async () => {
  const w = world(), s = svc(w);
  await s.request('100');
  const r = await s.request('100', { force: true });
  assert.equal(r.tooSoon, true); assert.equal(w.calls.filter((c) => c === 'player:100').length, 1);
  w.t += S.CONFIG.minRefreshMs + 10;
  const r2 = await s.request('100', { force: true });
  assert.ok(!r2.tooSoon); assert.equal(w.calls.filter((c) => c === 'player:100').length, 2);
});

test('Кэш переживает перезапуск (хранилище), старше staleMs не показывается, объём ограничен', async () => {
  const mem = {}; const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; } };
  const w = world(), s = svc(w, null, { storage });
  await s.request('100');
  const w2 = world(); w2.t = w.t + 1000;
  const s2 = svc(w2, null, { storage });
  assert.ok(s2.get('100').data); assert.equal(w2.calls.length, 0);
  await s2.request('100'); assert.equal(w2.calls.length, 0, 'свежий кэш: сеть не трогаем');
  w2.t += S.CONFIG.staleMs + 1000;
  assert.equal(s2.get('100').data, null);
  const w3 = world(), s3 = svc(w3, null, { storage, config: { maxCached: 2 } });
  for (const a of ['1', '2', '3']) { await s3.request(a); w3.t += 10; }
  assert.equal(Object.keys(JSON.parse(mem['dotamate.live.v1']).items).length, 2);
});

test('12. Старые ответы не попадают в новый матч: ожидающие задания отменяются, готовый ответ старого не доставляется', async () => {
  const w = world(); const gate = {}; let release;
  const slow = new Promise((r) => { release = r; });
  const s = svc(w, { player: (acc) => (acc === '100' ? slow.then(() => ({ profile: { personaname: 'old' } })) : { profile: { personaname: acc } }) }, { config: { concurrency: 1 } });
  s.setEpoch(1);
  const p1 = s.request('100', { epoch: 1 });      // выполняется
  const p2 = s.request('200', { epoch: 1 });      // ждёт в очереди
  await settle();
  s.setEpoch(2);                                   // начался новый матч
  release(); await p1; const r2 = await p2;
  assert.equal(w.calls.filter((c) => c === 'player:200').length, 0, 'задание старого матча не стартовало');
  assert.equal(r2.status, 'none');
  assert.equal(w.updates.filter((u) => u[0] === '100' && u[1] === 'ready').length, 0, 'готовый ответ старого матча в новый не доставлен');
  assert.equal(s.stats().cancelled >= 1, true);
  const r3 = await s.request('300', { epoch: 2 });
  assert.equal(r3.status, 'ready');
  assert.equal((await s.request('400', { epoch: 1 })).status, 'none', 'запрос с устаревшим epoch игнорируется');
  assert.equal(w.calls.filter((c) => c === 'player:400').length, 0);
});

test('17. Завершение матча останавливает ненужные запросы и повторы', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const w = world(), s = svc(w, { player: () => gate.then(() => apiErr('network')) }, { config: { concurrency: 1 } });
  s.setEpoch(1);
  const p = s.request('100', { epoch: 1 }); s.request('200', { epoch: 1 });
  await settle();
  s.stop();
  release(); await p; await w.advance(3600 * 1000);
  const before = w.calls.length;
  await w.advance(24 * 3600 * 1000);
  assert.equal(w.calls.length, before, 'после завершения матча новых запросов нет');
  assert.equal(w.calls.filter((c) => c === 'player:200').length, 0);
  assert.equal(s.stats().queued, 0);
});

test('Параллельность ограничена настройкой', async () => {
  const w = world(); let running = 0, maxRun = 0;
  const api = { getPlayer: async () => { running++; maxRun = Math.max(maxRun, running); await new Promise((r) => setImmediate(r)); running--; return {}; }, getWinLoss: async () => ({ win: 1, lose: 1 }), getPlayerHeroes: async () => [], getMatches: async () => rows(3) };
  const s = S.create({ api, now: w.now, setTimer: w.setTimer, clearTimer: w.clearTimer, config: { concurrency: 2 } });
  await Promise.all(['1', '2', '3', '4', '5', '6'].map((a) => s.request(a)));
  assert.ok(maxRun <= 2 && maxRun >= 1, 'одновременно не больше двух: ' + maxRun);
});

test('Некорректный accountId не уходит в сеть', async () => {
  const w = world(), s = svc(w);
  for (const bad of ['', 'abc', '12345678901', '../x', '1;2']) assert.equal((await s.request(bad)).status, 'error');
  assert.equal(w.calls.length, 0);
});

test('15. Низкий KDA и поражения сами по себе не создают сигнал нарушения', async () => {
  const w = world();
  const bad = rows(60, { win: () => false, k: 0, d: (i) => 14 + (i % 3) });         // всегда проигрывает, всегда много смертей: это обычная манера игрока
  const s = svc(w, { matches: () => bad, wl: () => ({ win: 5, lose: 95 }) });
  const d = (await s.request('100')).data;
  assert.equal(d.winrate, 0.05); assert.ok(d.kda.ratio < 1);
  assert.equal(d.signals.count, 0, 'сигналов нет: отклонений от собственной нормы не было');
  assert.notEqual(d.signals.state, 'confirmed'); assert.notEqual(d.signals.state, 'needs_review');
  assert.ok(!/руин|саботаж/i.test(JSON.stringify(d.signals)));
});

test('Выраженное отклонение от собственной нормы даёт сигнал «требует проверки» с датой, фактами, основанием и ссылкой на матч, но не приговор', async () => {
  const w = world();
  const ms = rows(60, { d: (i) => (i === 3 || i === 20 || i === 41 ? 28 : 5) });
  const d = (await svc(w, { matches: () => ms }).request('100')).data;
  assert.ok(d.signals.ready); assert.ok(d.signals.count >= 1);
  const it = d.signals.items.find((x) => x.kind === 'deaths_outlier');
  assert.ok(it && it.matchId && it.start && it.facts.length && it.basis);
  assert.notEqual(d.signals.state, 'confirmed');                          // без решения модератора итог не «подтверждён»
});

test('16. Малая выборка: сигналов нет, готовность false, уверенность низкая / «мало данных»', async () => {
  const w = world();
  const d = (await svc(w, { matches: () => rows(6, { d: (i) => (i === 2 ? 30 : 4) }) }).request('100')).data;
  assert.equal(d.signals.ready, false); assert.equal(d.signals.count, 0);
  assert.equal(d.signals.state, 'insufficient');
  assert.equal(d.kda.n, 6);                                               // KDA по 6 матчам есть (порог 5), но помечен малой выборкой
  const d2 = (await svc(world(), { matches: () => rows(3) }).request('1')).data;
  assert.equal(d2.kda, null);                                             // меньше порога: не показываем вовсе
});

test('Сравнение на герое: меньше трёх матчей на герое -> «недостаточно данных», иначе сравнение с обычными показателями', async () => {
  const w = world();
  const d = (await svc(w).request('100')).data;
  assert.equal(S.heroCompare(d, 999).enough, false);
  const c = S.heroCompare(d, 1);
  assert.equal(c.enough, true); assert.ok(c.n >= 3 && c.nAll === 40); assert.ok(c.hero.kda && c.usual.kda);
  assert.equal(S.heroCompare(null, 1), null);
});
