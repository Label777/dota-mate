'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, ApiError } = require('../js/dotaapi.js');

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i], get length() { return m.size; }, _m: m };
}
const resp = (status, body, headers) => ({ status, ok: status >= 200 && status < 300, headers: { get: (h) => (headers || {})[h.toLowerCase()] || null }, json: async () => body });
function api(handler, extra) {
  const calls = [];
  const fetch = async (url) => { calls.push(url); return handler(url, calls.length); };
  const a = create(Object.assign({ fetch, minInterval: 0, sleep: async () => { } }, extra));
  return { a, calls };
}

test('кэш: повторный запрос не уходит в сеть', async () => {
  const { a, calls } = api(() => resp(200, { win: 5, lose: 4 }));
  assert.deepEqual(await a.getWinLoss('123'), { win: 5, lose: 4 });
  assert.deepEqual(await a.getWinLoss('123'), { win: 5, lose: 4 });
  assert.equal(calls.length, 1);
  assert.equal(a.stats.cacheHits, 1);
});

test('кэш: одинаковые запросы, идущие одновременно, склеиваются', async () => {
  const { a, calls } = api(() => resp(200, []));
  await Promise.all([a.getMatches('123'), a.getMatches('123'), a.getMatches('123')]);
  assert.equal(calls.length, 1);
});

test('кэш переживает перезагрузку через storage и истекает по TTL', async () => {
  const storage = memStorage();
  let t = 1000;
  const mk = () => api(() => resp(200, [{ id: 1 }]), { storage, now: () => t });
  const first = mk(); await first.a.getHeroes();
  const second = mk(); await second.a.getHeroes();
  assert.equal(second.calls.length, 0, 'данные взяты из хранилища');
  t += 8 * 864e5;
  const third = mk(); await third.a.getHeroes();
  assert.equal(third.calls.length, 1, 'после TTL запрос повторяется');
  first.a.clearCache();
  assert.equal(storage.length, 0);
});

test('getMatches: основной запрос без project, параметры страницы', async () => {
  const { a, calls } = api(() => resp(200, []));
  await a.getMatches('86745912', { limit: 100, offset: 200 });
  assert.equal(calls.length, 1, 'пустая страница: дополнительных запросов нет');
  const u = new URL(calls[0]);
  assert.equal(u.pathname, '/api/players/86745912/matches');
  assert.equal(u.searchParams.get('limit'), '100');
  assert.equal(u.searchParams.get('offset'), '200');
  assert.equal(u.searchParams.getAll('project').length, 0);
});

// Имитация OpenDota: основной список, project с одним или несколькими полями.
const BASE_ROWS = [
  { match_id: 11, player_slot: 1, radiant_win: true, duration: 2000, hero_id: 4, start_time: 100, kills: 5, deaths: 2, assists: 9 },
  { match_id: 10, player_slot: 130, radiant_win: true, duration: 2500, hero_id: 9, start_time: 50, kills: 1, deaths: 7, assists: 3 }
];
const VALUES = { gold_per_min: [500, 400], xp_per_min: [600, 450], last_hits: [210, 90], denies: [8, 2], lane_role: [1, null] };
const DEFAULT_COLS = ['hero_id', 'start_time', 'kills', 'deaths', 'assists', 'version', 'average_rank', 'leaver_status', 'party_size', 'hero_variant'];
function openDota(mode) {
  return (url) => {
    const u = new URL(url), proj = u.searchParams.getAll('project');
    if (!proj.length) return resp(200, BASE_ROWS);
    // mode 'one': применяется первое поле, которого нет среди основных (как отвечает живой API)
    const use = mode === 'multi' ? proj : [proj.find((f) => !DEFAULT_COLS.includes(f)) || proj[0]];
    return resp(200, BASE_ROWS.map((r, i) => {
      const o = { match_id: r.match_id, player_slot: r.player_slot, radiant_win: r.radiant_win, duration: r.duration };
      use.forEach((f) => { if (VALUES[f] && VALUES[f][i] != null) o[f] = VALUES[f][i]; });
      return o;
    }));
  };
}

test('getMatches: сервер понимает несколько project: два запроса на страницу', async () => {
  const { a, calls } = api(openDota('multi'));
  const got = { base: 0, prog: [] };
  const rows = await a.getMatches('5', { limit: 100, onBase: (r) => { got.base = r.length; }, onProgress: (r, d, t) => got.prog.push([d, t]) });
  assert.equal(calls.length, 2);
  assert.deepEqual(new URL(calls[1]).searchParams.getAll('project'), ['gold_per_min', 'xp_per_min', 'last_hits', 'denies', 'lane_role']);
  assert.equal(rows[0].gold_per_min, 500); assert.equal(rows[0].lane_role, 1); assert.equal(rows[0].kills, 5);
  assert.equal(rows[1].last_hits, 90); assert.ok(!('lane_role' in rows[1]) || rows[1].lane_role == null);
  assert.equal(got.base, 2);
  assert.deepEqual(got.prog.at(-1), [5, 5]);
});

test('getMatches: сервер применяет один project: поля запрашиваются по одному и это запоминается', async () => {
  const storage = memStorage();
  const { a, calls } = api(openDota('one'), { storage });
  const rows = await a.getMatches('5', { limit: 100 });
  const projects = calls.map((c) => new URL(c).searchParams.getAll('project').join('+'));
  assert.deepEqual(projects, ['', 'gold_per_min+xp_per_min+last_hits+denies+lane_role', 'xp_per_min', 'last_hits', 'denies', 'lane_role'], 'основной, проба, затем недостающие поля');
  assert.equal(rows[0].gold_per_min, 500, 'gpm пришёл уже из пробы');
  assert.equal(rows[0].xp_per_min, 600); assert.equal(rows[0].last_hits, 210); assert.equal(rows[0].denies, 8);
  assert.equal(rows[1].xp_per_min, 450); assert.equal(rows[1].lane_role == null, true);
  assert.equal(rows[0].kills, 5, 'основные поля на месте');
  // следующая страница: пробы уже нет
  const again = api(openDota('one'), { storage });
  await again.a.getMatches('5', { limit: 100, offset: 100 });
  const p2 = again.calls.map((c) => new URL(c).searchParams.getAll('project').join('+'));
  assert.deepEqual(p2, ['', 'gold_per_min', 'xp_per_min', 'last_hits', 'denies', 'lane_role']);
});

test('getMatches: кэшированный основной список не портится при слиянии', async () => {
  const { a } = api(openDota('multi'));
  const base = await a.getMatches('5', { limit: 100, extra: false });
  assert.equal(base[0].gold_per_min, undefined);
  const full = await a.getMatches('5', { limit: 100 });
  assert.equal(full[0].gold_per_min, 500);
  const base2 = await a.getMatches('5', { limit: 100, extra: false });
  assert.equal(base2[0].gold_per_min, undefined, 'в кэше остались только основные поля');
});

test('ошибки: 404, 429 с Retry-After, 5xx, сеть, неверный ответ', async () => {
  let r = api(() => resp(404, {}));
  await assert.rejects(r.a.getPlayer('1'), (e) => e instanceof ApiError && e.code === 'not_found');
  r = api(() => resp(429, {}, { 'retry-after': '30' }));
  await assert.rejects(r.a.getPlayer('2'), (e) => e.code === 'rate_limit' && e.retryAfter === 30);
  assert.equal(r.calls.length, 1, 'после 429 повторов нет');
  r = api(() => resp(503, {}));
  await assert.rejects(r.a.getPlayer('3'), (e) => e.code === 'api' && e.status === 503);
  assert.equal(r.calls.length, 2, 'при 5xx один повтор');
  r = api(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(r.a.getPlayer('4'), (e) => e.code === 'network');
  r = api(() => resp(200, { not: 'a list' }));
  await assert.rejects(r.a.getMatches('5'), (e) => e.code === 'bad_data');
});

test('ошибка не попадает в кэш: следующий запрос пробует снова', async () => {
  let n = 0;
  const { a, calls } = api(() => (++n === 1 ? resp(429, {}) : resp(200, { win: 1, lose: 1 })));
  await assert.rejects(a.getWinLoss('9'));
  assert.deepEqual(await a.getWinLoss('9'), { win: 1, lose: 1 });
  assert.equal(calls.length, 2);
});

test('проверка идентификаторов', async () => {
  const { a, calls } = api(() => resp(200, {}));
  await assert.rejects(async () => a.getPlayer('12/../x'), (e) => e.code === 'invalid');
  await assert.rejects(async () => a.getMatchDetail('abc'), (e) => e.code === 'invalid');
  assert.equal(calls.length, 0);
});

test('очередь: запросы идут по одному с паузой', async () => {
  const starts = [];
  const a = create({ fetch: async () => { starts.push(Date.now()); return resp(200, []); }, minInterval: 60 });
  await Promise.all([a.getMatches('1'), a.getMatches('2'), a.getMatches('3')]);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 55, 'пауза между запросами 1 и 2');
  assert.ok(starts[2] - starts[1] >= 55, 'пауза между запросами 2 и 3');
});

test('подробности матча хранятся только в памяти', async () => {
  const storage = memStorage();
  const { a, calls } = api(() => resp(200, { players: [] }), { storage });
  await a.getMatchDetail('9025128045');
  await a.getMatchDetail('9025128045');
  assert.equal(calls.length, 1);
  assert.equal(storage.length, 0, 'большой ответ не пишется в localStorage');
});

test('таймаут', async () => {
  const a = create({ fetch: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))), minInterval: 0, timeout: 20, sleep: async () => { } });
  await assert.rejects(a.getPlayer('1'), (e) => e.code === 'timeout');
});
