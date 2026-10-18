'use strict';
/* Поддельный OpenDota для интеграционных и браузерных тестов: детерминированные данные, никаких внешних запросов. */
const http = require('node:http');

const NOW = Math.floor(Date.now() / 1000);
const HEROES = [[1, 'antimage', 'Anti-Mage'], [2, 'axe', 'Axe'], [13, 'puck', 'Puck'], [14, 'pudge', 'Pudge'], [26, 'lion', 'Lion'], [74, 'invoker', 'Invoker']];
const rnd = (i, k) => ((i * 2654435761 + k * 40503) % 1000) / 1000;
const ATTR = { 1: 'agi', 2: 'str', 13: 'agi', 14: 'str', 26: 'int', 74: 'all' };
const ROLES = { 1: ['Carry', 'Escape'], 2: ['Initiator', 'Durable'], 13: ['Nuker', 'Escape'], 14: ['Disabler', 'Initiator'], 26: ['Support', 'Disabler'], 74: ['Carry', 'Nuker'] };
const OUTLIERS = new Set([0, 3, 5, 9, 40]);   // у игрока 2002 в этих матчах необычно много смертей

function rowsFor(acc, n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const out = acc === '2002' && OUTLIERS.has(i);
    rows.push({ match_id: 7000000001 + i, player_slot: i % 2 ? 130 : 1, radiant_win: rnd(i, 2) < 0.5, duration: 1800 + Math.floor(rnd(i, 4) * 1000), game_mode: 22, lobby_type: 7,
      hero_id: HEROES[i % HEROES.length][0], start_time: NOW - i * 6 * 3600 - 1800, kills: 3 + Math.floor(rnd(i, 5) * 8), deaths: out ? 26 : 3 + Math.floor(rnd(i, 6) * 5), assists: 5 + Math.floor(rnd(i, 7) * 10),
      leaver_status: acc === '2002' && i === 7 ? 3 : 0, party_size: 1 });
  }
  return rows;
}
const EXTRA = { gold_per_min: (i) => 350 + Math.floor(rnd(i, 8) * 300), xp_per_min: (i) => 400 + Math.floor(rnd(i, 9) * 300), last_hits: (i) => 40 + Math.floor(rnd(i, 10) * 200), denies: (i) => Math.floor(rnd(i, 11) * 15), lane_role: (i) => 1 + (i % 3) };

function detail(id) {
  const i = id - 7000000001;
  const accs = [1001, 2002, 3003, 4004, 5005, null, null, null, null, null];
  const players = accs.map((a, k) => ({ account_id: a, personaname: a ? 'Player ' + a : undefined, hero_id: HEROES[k % HEROES.length][0], player_slot: k < 5 ? k : 128 + k - 5, isRadiant: k < 5,
    kills: 4, deaths: a === 2002 ? 22 : 4, assists: 6, gold_per_min: 400 + k * 10, xp_per_min: 450, last_hits: 120, leaver_status: 0, lane_role: 1 + (k % 3) }));
  return { match_id: id, start_time: NOW - Math.max(0, i) * 6 * 3600 - 1800, duration: 2400, radiant_win: true, game_mode: 22, players };
}

function create() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    const send = (o, code) => { res.statusCode = code || 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    let m;
    if (p === '/heroes') return send(HEROES.map((h) => ({ id: h[0], name: 'npc_dota_hero_' + h[1], localized_name: h[2], primary_attr: ATTR[h[0]] || 'str', roles: ROLES[h[0]] || ['Support'] })));
    if ((m = /^\/heroes\/(\d+)\/matchups$/.exec(p))) {
      const me = Number(m[1]);
      return send(HEROES.filter((h) => h[0] !== me).map((h) => ({ hero_id: h[0], games_played: 400 + h[0], wins: 150 + ((me * 7 + h[0] * 13) % 120), extra: 'лишнее поле' })));
    }
    if ((m = /^\/players\/(\d+)\/heroes$/.exec(p))) return send(HEROES.slice(0, 4).map((h, i) => ({ hero_id: h[0], games: 40 - i * 8, win: 22 - i * 3, last_played: NOW - i * 86400, with_games: 1 })));
    if ((m = /^\/players\/(\d+)\/matches$/.exec(p))) {
      const limit = Math.min(500, Number(u.searchParams.get('limit')) || 100), proj = u.searchParams.getAll('project');
      const acc = m[1], total = acc === '9999' ? 0 : acc === '3003' ? 8 : 70;
      let rows = rowsFor(acc, total).slice(Number(u.searchParams.get('offset')) || 0, limit);
      if (proj.length) rows = rows.map((r, i) => { const o = { match_id: r.match_id }; proj.slice(0, 1).forEach((f) => { o[f] = EXTRA[f] ? EXTRA[f](i) : r[f]; }); return o; });
      return send(rows);
    }
    if ((m = /^\/players\/(\d+)\/wl$/.exec(p))) return send({ win: 40, lose: 30 });
    if ((m = /^\/players\/(\d+)\/ratings$/.exec(p))) return send([]);
    if ((m = /^\/players\/(\d+)\/peers$/.exec(p))) return send([
      { account_id: 3003, personaname: 'Mate3003', with_games: 12, with_win: 7, against_games: 2, against_win: 1, last_played: NOW - 86400 },
      { account_id: 4004, personaname: 'Mate4004', with_games: 4, with_win: 2, against_games: 0, against_win: 0, last_played: NOW - 5 * 86400 },
      { account_id: 5005, personaname: 'Mate5005', with_games: 1, with_win: 1, against_games: 0, against_win: 0, last_played: NOW - 9 * 86400 }]);
    if ((m = /^\/players\/(\d+)$/.exec(p))) return m[1] === '9998' ? send({}, 404) : send({ profile: { account_id: Number(m[1]), personaname: 'Player ' + m[1], steamid: String(BigInt(m[1]) + 76561197960265728n), avatarfull: '' }, rank_tier: 53 });
    if ((m = /^\/matches\/(\d+)$/.exec(p))) { const id = Number(m[1]); return id >= 7000000001 && id <= 7000000070 ? send(detail(id)) : send({ error: 'not found' }, 404); }
    send({}, 404);
  });
}
module.exports = { create, NOW };
if (require.main === module) { const s = create().listen(Number(process.argv[2]) || 0, '127.0.0.1', () => console.log('mock-opendota :' + s.address().port)); }
