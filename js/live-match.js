/*
 * Dota Mate: состояние матча для Live Draft Overlay. Только чистые функции (браузер: DMLive, Node: require).
 *
 * Здесь три роли (ТЗ называет их Game State Adapter, Draft State Manager, Player Identity Resolver):
 *  1. adapt(): сырой пакет моста -> единый внутренний вид;
 *  2. createSession(): жизненный цикл матча (idle -> draft_detected -> resolving_players -> loading_stats -> ready -> in_game -> finished,
 *     плюс disconnected при потере моста), изоляция матчей друг от друга (epoch);
 *  3. определение личности игроков по состояниям identified / pending / unavailable / private / error.
 *
 * Правила идентификации (проверяются тестами):
 *  - Steam ID берётся только из документированных полей GSI: player.steamid (свой аккаунт) и player.team2/team3.playerN.steamid
 *    (режим наблюдателя). Клиент игрока чужие Steam ID не отдаёт, и мы их не угадываем.
 *  - Никогда не сопоставляем игрока по нику, номеру слота в массиве, составу героев, аватару или прошлым матчам.
 *    Ник служит только подписью, ключ личности всегда accountId.
 *  - Ручной ввод (addManual) — отдельный источник «указано вручную» и всегда подписывается как таковой.
 *  - Новый матч не наследует ничего от старого: ни личности, ни ручные записи, ни статусы статистики.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./draft.js'));
  else root.DMLive = factory(root.DMDraft);
})(typeof self !== 'undefined' ? self : this, function (Draft) {
  'use strict';

  var PHASES = ['idle', 'draft_detected', 'resolving_players', 'loading_stats', 'ready', 'in_game', 'finished', 'disconnected'];
  var ID_STATES = ['identified', 'pending', 'unavailable', 'private', 'error'];
  var OFF = 76561197960265728n;
  var SIDES = ['radiant', 'dire'];
  /* Сколько ждём, прежде чем признать, что игра Steam ID не отдаст (мс). Один раз в одном месте, а не магическим числом по коду. */
  var CONFIG = { waitForIdsMs: 20000, maxManual: 5 };

  var IN_GAME = { DOTA_GAMERULES_STATE_STRATEGY_TIME: 1, DOTA_GAMERULES_STATE_TEAM_SHOWCASE: 1, DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD: 1, DOTA_GAMERULES_STATE_SCENARIO_SETUP: 1, DOTA_GAMERULES_STATE_PRE_GAME: 1, DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 1 };
  var FINISHED = { DOTA_GAMERULES_STATE_POST_GAME: 1, DOTA_GAMERULES_STATE_DISCONNECT: 1 };
  var DRAFTING = 'DOTA_GAMERULES_STATE_HERO_SELECTION';

  /* ---------- Steam ID ---------- */
  /** steamid64 (строка из 17 цифр) -> accountId (строка) или null. */
  function steamToAccount(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    var s = String(v);
    if (!/^\d{17}$/.test(s)) return null;
    var n = BigInt(s) - OFF;
    return n > 0n && n <= 4294967295n ? n.toString() : null;
  }
  /** accountId -> steamid64 или null. */
  function accountToSteam(acc) {
    var a = parseAccount(acc);
    return a ? (BigInt(a) + OFF).toString() : null;
  }
  /** Принимает accountId (до 10 цифр) или steamid64; возвращает accountId-строку или null. */
  function parseAccount(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    var s = String(v).trim();
    if (/^\d{17}$/.test(s)) return steamToAccount(s);
    if (!/^\d{1,10}$/.test(s)) return null;
    var n = BigInt(s);
    return n > 0n && n <= 4294967295n ? n.toString() : null;
  }

  /** Для ручного ввода: accountId, steamid64 или ссылка вида .../players/123, .../profiles/7656..., .../dota2/players/123. Иначе null. Ники не принимаются. */
  function parseAccountInput(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t || t.length > 200) return null;
    var m = /\/(?:players|profiles|id)\/(\d{1,17})(?:[/?#]|$)/i.exec(t);
    return parseAccount(m ? m[1] : t);
  }
  function cleanName(v) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : ''; }
  function sideOf(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).toLowerCase();
    return s === 'radiant' || s === '2' ? 'radiant' : s === 'dire' || s === '3' ? 'dire' : null;
  }

  /* ---------- 1. адаптер пакета ---------- */
  /**
   * Приводит пакет моста (уже урезанный pickGSI) к виду:
   * { matchId, gameState, mySide, draft: {state}|null, mode: 'local'|'spectator'|'none',
   *   ids: [{ source:'local'|'spectator', side, index|null, accountId, steamId, name, heroId|null }] }
   * Любые поля, которые не прошли проверку, молча отбрасываются: сюда попадает только то, что можно проверить.
   */
  function adapt(slim) {
    var out = { matchId: null, gameState: null, mySide: null, draft: null, mode: 'none', ids: [] };
    if (!slim || typeof slim !== 'object') return out;
    var d = Draft.fromGSI(slim);
    out.matchId = d.matchId; out.gameState = d.gameState; out.mySide = d.mySide;
    if (d.hasDraft) out.draft = d.state;
    var pl = slim.player && typeof slim.player === 'object' ? slim.player : null;
    var he = slim.hero && typeof slim.hero === 'object' ? slim.hero : null;
    if (!pl) return out;
    var spec = false;
    ['team2', 'team3'].forEach(function (t, ti) {
      var team = pl[t]; if (!team || typeof team !== 'object') return;
      spec = true;
      var side = SIDES[ti];
      for (var i = 0; i < 5; i++) {
        var p = team['player' + i]; if (!p || typeof p !== 'object') continue;
        var acc = steamToAccount(p.steamid);
        var hid = he && he[t] && he[t]['player' + i] && Draft.heroId ? Draft.heroId(he[t]['player' + i].id) : 0;
        if (!acc && !hid) continue;
        out.ids.push({ source: 'spectator', side: side, index: i, accountId: acc, steamId: acc ? accountToSteam(acc) : null, name: cleanName(p.name), heroId: hid || null });
      }
    });
    if (spec) { out.mode = 'spectator'; return out; }
    /* Играющий клиент: сведения только о себе. */
    var me = steamToAccount(pl.steamid);
    if (me || pl.steamid === undefined) out.mode = 'local';
    if (me) {
      var side2 = sideOf(pl.team_name) || sideOf(pl.team);
      var ts = Number(pl.team_slot);
      var hero = he && he.id && Draft.heroId ? Draft.heroId(he.id) : 0;
      /* Сторона обязательна: без неё мы не знаем, в какую колонку поставить игрока, и не гадаем. */
      if (side2) out.ids.push({ source: 'local', side: side2, index: Number.isInteger(ts) && ts >= 0 && ts < 5 ? ts : null, accountId: me, steamId: accountToSteam(me), name: cleanName(pl.name), heroId: hero || null });
      else out.mode = 'local';
    }
    return out;
  }

  /* ---------- 2. сессия матча ---------- */
  function blankRoster() { return { ids: {}, manual: [] }; }

  function createSession(opts) {
    var o = Object.assign({ now: function () { return Date.now(); }, waitForIdsMs: CONFIG.waitForIdsMs }, opts || {});
    var S = null;           // данные текущего матча
    var epoch = 0;          // счётчик матчей; всё, что относится к старому, имеет меньший номер
    var transport = 'connected', lastPacketAt = 0;

    function fresh(matchKey, at) {
      epoch++;
      S = { epoch: epoch, matchKey: matchKey || null, startedAt: at, lifecycle: 'idle', gameState: null, mySide: null, draft: null, draftSeenAt: 0, mode: 'none',
        roster: blankRoster(), stats: {}, override: {}, justDetected: false, packets: 0 };
    }
    function lifecycleOf(a) {
      if (a.gameState && FINISHED[a.gameState]) return 'finished';
      if (a.gameState && IN_GAME[a.gameState]) return 'in_game';
      if (a.draft || a.gameState === DRAFTING) return 'draft';
      return 'idle';
    }
    function total(d) { return d ? d.picks.radiant.length + d.picks.dire.length + d.bans.radiant.length + d.bans.dire.length : 0; }

    /** Подаёт очередной пакет. Возвращает { changed, newMatch, epoch, newIds: [accountId...] }. */
    function push(slim, at) {
      at = at == null ? o.now() : at;
      var a = adapt(slim);
      var lc = lifecycleOf(a);
      var res = { changed: false, newMatch: false, epoch: S ? S.epoch : 0, newIds: [] };
      lastPacketAt = at;
      /* Пакет без драфта и без состояния игры ничего не говорит о матче. */
      if (lc === 'idle' && !a.matchId && !a.ids.length && !a.draft) return res;

      var isNew = false;
      if (!S) isNew = true;
      else if (a.matchId && S.matchKey && a.matchId !== S.matchKey) isNew = true;
      else if (S.lifecycle === 'finished' && lc !== 'finished' && lc !== 'idle') isNew = true;
      else if (a.draft && S.draft && total(a.draft) < total(S.draft)) isNew = true;               // драфт «откатился»: это уже другой матч
      if (isNew) { fresh(a.matchId, at); res.newMatch = true; res.changed = true; }
      res.epoch = S.epoch;

      S.packets++;
      if (a.matchId && !S.matchKey) { S.matchKey = a.matchId; res.changed = true; }
      if (a.gameState && a.gameState !== S.gameState) { S.gameState = a.gameState; res.changed = true; }
      if (a.mySide && a.mySide !== S.mySide) { S.mySide = a.mySide; res.changed = true; }
      if (a.draft) {
        var k = JSON.stringify([a.draft.picks, a.draft.bans, a.draft.active, a.draft.timeLeft]);
        if (k !== S.draftKey) { S.draftKey = k; res.changed = true; }
        S.draft = a.draft; S.draftSeenAt = at;
      }
      if (a.mode !== 'none' && (S.mode === 'none' || a.mode === 'spectator')) { if (S.mode !== a.mode) res.changed = true; S.mode = a.mode; }

      var prevLc = S.lifecycle;
      S.lifecycle = lc === 'idle' ? (prevLc === 'idle' ? 'idle' : prevLc) : lc;
      if (prevLc === 'idle' && S.lifecycle === 'draft') { S.justDetected = true; res.changed = true; } else if (S.justDetected && S.packets > 1) S.justDetected = false;
      if (prevLc !== S.lifecycle) res.changed = true;

      a.ids.forEach(function (x) {
        var key = x.side + ':' + (x.index == null ? 'me' : x.index);
        var cur = S.roster.ids[key];
        var same = cur && cur.accountId === x.accountId && cur.name === x.name && cur.heroId === x.heroId;
        /* Уже известный accountId в другом слоте не дублируем: личность одна, а слотов у неё нет. */
        if (!same) {
          if (x.accountId) {
            var dup = Object.keys(S.roster.ids).filter(function (kk) { return kk !== key && S.roster.ids[kk].accountId === x.accountId; })[0];
            if (dup) { if (S.roster.ids[dup].source === 'spectator' || x.source === 'local') return; delete S.roster.ids[dup]; }
          }
          S.roster.ids[key] = x; res.changed = true;
          if (x.accountId && !cur) res.newIds.push(x.accountId);
          else if (x.accountId && cur && cur.accountId !== x.accountId) res.newIds.push(x.accountId);
        }
      });
      /* Ручная запись дублирует личность из игры -> убираем ручную, источник игры точнее. */
      var fromGame = {}; Object.keys(S.roster.ids).forEach(function (kk) { if (S.roster.ids[kk].accountId) fromGame[S.roster.ids[kk].accountId] = 1; });
      var before = S.roster.manual.length;
      S.roster.manual = S.roster.manual.filter(function (m) { return !fromGame[m.accountId]; });
      if (S.roster.manual.length !== before) res.changed = true;
      return res;
    }

    /** Ручное добавление игрока в сторону (приватные скриншоты, друзья из пати). Возвращает { ok, reason }. */
    function addManual(side, input, name) {
      if (!S) return { ok: false, reason: 'no_match' };
      if (SIDES.indexOf(side) < 0) return { ok: false, reason: 'bad_side' };
      var acc = parseAccountInput(input);
      if (!acc) return { ok: false, reason: 'bad_id' };
      var occupied = Object.keys(S.roster.ids).filter(function (k) { return S.roster.ids[k].side === side; }).length + S.roster.manual.filter(function (m) { return m.side === side; }).length;
      if (occupied >= 5) return { ok: false, reason: 'side_full' };
      var exists = Object.keys(S.roster.ids).some(function (k) { return S.roster.ids[k].accountId === acc; }) || S.roster.manual.some(function (m) { return m.accountId === acc; });
      if (exists) return { ok: false, reason: 'duplicate' };
      S.roster.manual.push({ source: 'manual', side: side, index: null, accountId: acc, steamId: accountToSteam(acc), name: cleanName(name || ''), heroId: null });
      return { ok: true, accountId: acc };
    }
    function removeManual(acc) {
      if (!S) return false;
      var n = S.roster.manual.length;
      S.roster.manual = S.roster.manual.filter(function (m) { return m.accountId !== String(acc); });
      return S.roster.manual.length !== n;
    }

    /** Служба статистики сообщает, что с accountId происходит: loading | ready | private | error | rate_limited | queued. */
    function setStats(acc, status, reason) {
      if (!S) return;
      acc = String(acc);
      S.stats[acc] = status;
      if (status === 'private' || status === 'error') S.override[acc] = { state: status, reason: reason || '' };
      else if (status === 'ready' || status === 'loading') delete S.override[acc];
      S.justDetected = false;
    }
    function setTransport(t) { transport = t === 'lost' ? 'lost' : 'connected'; }
    function reset() { S = null; }

    /** Причина, по которой у слота нет личности, в виде состояния + понятного текста. */
    function placeholder(side) {
      var mode = S ? S.mode : 'none', lc = S ? S.lifecycle : 'idle';
      var waited = S && lastPacketAt - S.startedAt >= o.waitForIdsMs;
      if (mode === 'local') return { state: 'unavailable', reason: 'Dota 2 передаёт Steam ID только вашего аккаунта. Остальных игроков игра в этот момент не раскрывает.' };
      if (mode === 'spectator') {
        if (lc === 'draft' && !waited) return { state: 'pending', reason: 'Steam ID этого игрока ещё не пришёл. Обновится сам, когда игра его передаст.' };
        return { state: 'unavailable', reason: 'Игра так и не передала Steam ID этого игрока.' };
      }
      if (!waited) return { state: 'pending', reason: 'Жду первые данные об игроках от Dota 2.' };
      return { state: 'unavailable', reason: 'Игра не передала Steam ID. Проверьте, что в cfg включены разделы player и draft (раздел «Драфт» в README).' };
    }

    function identityOf(x) {
      var ov = x.accountId ? S.override[x.accountId] : null;
      return { state: ov ? ov.state : 'identified', accountId: x.accountId, steamId: x.steamId, name: x.name || '', source: x.source, reason: ov ? ov.reason : '' };
    }

    /** Полное состояние для интерфейса. Каждый вызов собирает новый объект, внутренние данные наружу не отдаются. */
    function snapshot() {
      if (!S) return { epoch: epoch, phase: transport === 'lost' ? 'disconnected' : 'idle', lifecycle: 'idle', transport: transport, matchId: null, gameState: null, mySide: null, draft: null, mode: 'none', lastPacketAt: lastPacketAt, slots: [], counts: counts([]), draftLive: false };
      var slots = [];
      SIDES.forEach(function (side) {
        var list = [];
        Object.keys(S.roster.ids).forEach(function (k) { var x = S.roster.ids[k]; if (x.side === side) list.push(x); });
        list.sort(function (a, b) { return (a.index == null ? 9 : a.index) - (b.index == null ? 9 : b.index); });
        S.roster.manual.forEach(function (m) { if (m.side === side) list.push(m); });
        list = list.slice(0, 5);
        var ph = placeholder(side);
        list.forEach(function (x) {
          var id = x.accountId ? identityOf(x) : { state: ph.state, reason: ph.reason, accountId: null, steamId: null, name: x.name || '', source: x.source };
          slots.push({ key: side + ':' + (x.index == null ? (x.source === 'manual' ? 'm' + x.accountId : 'me') : x.index), side: side, index: x.index, self: x.source === 'local', identity: id, heroId: x.heroId || null });
        });
        for (var j = list.length; j < 5; j++) slots.push({ key: side + ':u' + (j - list.length), side: side, index: null, self: false, identity: { state: ph.state, accountId: null, steamId: null, name: '', source: null, reason: ph.reason }, heroId: null });
      });
      var c = counts(slots);
      return {
        epoch: S.epoch, phase: phaseOf(slots), lifecycle: S.lifecycle, transport: transport, matchId: S.matchKey, gameState: S.gameState, mySide: S.mySide,
        draft: S.draft ? clone(S.draft) : null, draftLive: !!S.draft && S.lifecycle === 'draft', mode: S.mode, lastPacketAt: lastPacketAt, slots: slots, counts: c
      };
    }
    function clone(x) { return JSON.parse(JSON.stringify(x)); }
    function counts(slots) {
      var c = { identified: 0, pending: 0, unavailable: 0, private: 0, error: 0, total: slots.length };
      slots.forEach(function (s) { c[s.identity.state]++; });
      return c;
    }
    function phaseOf(slots) {
      if (transport === 'lost') return 'disconnected';
      if (S.lifecycle === 'finished') return 'finished';
      if (S.lifecycle === 'in_game') return 'in_game';
      if (S.lifecycle === 'idle') return 'idle';
      if (S.justDetected) return 'draft_detected';
      var loading = slots.some(function (s) { return s.identity.accountId && (S.stats[s.identity.accountId] === 'loading' || S.stats[s.identity.accountId] === 'queued'); });
      if (loading) return 'loading_stats';
      var anyPending = slots.some(function (s) { return s.identity.state === 'pending'; });
      var anyId = slots.some(function (s) { return s.identity.accountId; });
      if (anyPending && !anyId) return 'resolving_players';
      var needStats = slots.some(function (s) { return s.identity.accountId && !S.stats[s.identity.accountId]; });
      if (needStats) return 'loading_stats';
      return anyPending ? 'resolving_players' : 'ready';
    }

    return { push: push, snapshot: snapshot, setStats: setStats, setTransport: setTransport, addManual: addManual, removeManual: removeManual, reset: reset, epoch: function () { return S ? S.epoch : epoch; } };
  }

  return { PHASES: PHASES, ID_STATES: ID_STATES, CONFIG: CONFIG, adapt: adapt, createSession: createSession, steamToAccount: steamToAccount, accountToSteam: accountToSteam, parseAccount: parseAccount, parseAccountInput: parseAccountInput };
});
