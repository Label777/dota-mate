'use strict';
/*
 * Сервис сообщества Dota Mate: жалобы, модерация, обжалования, списки наблюдения, уведомления.
 * Все проверки (права, лимиты, переходы статусов, участие в матче) выполняются здесь, на сервере.
 * Интерфейс только показывает результат и ничего не решает сам.
 *
 * create({db, fetchMatch(id) -> detail|throws, now(), moderators:Set<acc>, limits}) возвращает {route(...), ...методы}.
 * Каждый метод возвращает {status, body}; HTTP-слой (server.js) только передаёт их клиенту.
 */
const R = require('../js/reputation.js');

const DAY = 86400;
const DEFAULT_LIMITS = {
  reportsPerDay: 5, openReportsPerUser: 20, perTargetPerWeek: 3, matchMaxAgeDays: 60,
  volumeWindowH: 24, volumeReporters: 5, appealsPerDay: 5, flagsPerDay: 10, watchlistMax: 50, textMax: 1000
};

const ok = (body, status) => ({ status: status || 200, body });
const fail = (status, code, message, extra) => ({ status, body: Object.assign({ error: code, message }, extra || {}) });

function create(opts) {
  const db = opts.db;
  const now = opts.now || (() => Math.floor(Date.now() / 1000));
  const mods = opts.moderators || new Set();
  const L = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  const fetchMatch = opts.fetchMatch;

  const q = (sql) => db.prepare(sql);
  const S = {
    getReport: q('SELECT * FROM reports WHERE id = ?'),
    evidenceOfReport: q('SELECT url FROM report_evidence WHERE report_id = ? ORDER BY id'),
    evidenceOfAppeal: q('SELECT url FROM report_evidence WHERE appeal_id = ? ORDER BY id'),
    actionsOfReport: q('SELECT id, actor, action, from_status, to_status, reason, created_at FROM moderation_actions WHERE report_id = ? ORDER BY id'),
    actionsOfAppeal: q('SELECT id, actor, action, from_status, to_status, reason, created_at FROM moderation_actions WHERE appeal_id = ? ORDER BY id'),
    insertAction: q('INSERT INTO moderation_actions (report_id, appeal_id, actor, action, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    insertNotif: q('INSERT INTO notifications (user_acc, kind, target_acc, text, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    watchers: q('SELECT user_acc FROM watchlist_entries WHERE target_acc = ?')
  };

  const isMod = (acc) => !!acc && mods.has(String(acc));
  const need = (user) => (user ? null : fail(401, 'auth', 'Войдите через Steam: жалобы и списки наблюдения привязаны к аккаунту.'));
  const needMod = (user) => need(user) || (isMod(user.acc) ? null : fail(403, 'forbidden', 'Нужны права модератора.'));
  const logAction = (reportId, appealId, actor, action, from, to, reason) => S.insertAction.run(reportId || null, appealId || null, actor, action, from || null, to || null, reason || null, now());
  function notifyWatchers(target, kind, text, ref, exceptAcc) {
    for (const w of S.watchers.all(target)) if (w.user_acc !== exceptAcc) S.insertNotif.run(w.user_acc, kind, target, text, ref || null, now());
  }
  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* уже откатано */ } throw e; }
  }
  const accOf = (v) => { const r = R.normAcc(v); return r ? r.acc : null; };

  /* ---------- публичные сведения об игроке ---------- */

  /**
   * Что можно показывать всем: подтверждённые модератором эпизоды (категория, матч, дата, пояснение модератора),
   * оспариваемые отметки отдельно (в расчёт репутации не идут) и счётчик непроверенных жалоб, только если их написали
   * минимум два разных автора по двум разным матчам. Авторы жалоб и тексты жалоб не публикуются никогда.
   */
  function playerSummary(accRaw) {
    const acc = accOf(accRaw);
    if (!acc) return fail(400, 'bad_acc', 'Некорректный Steam ID.');
    const rows = db.prepare("SELECT id, match_id, category, status, public_reason, decided_at FROM reports WHERE target = ? AND status IN ('confirmed','disputed') ORDER BY decided_at DESC, id DESC").all(acc);
    const mk = (r) => ({ id: r.id, matchId: r.match_id, category: r.category, decidedAt: r.decided_at, reason: r.public_reason || '' });
    const confirmed = rows.filter((r) => r.status === 'confirmed').map(mk);
    const disputed = rows.filter((r) => r.status === 'disputed').map(mk);
    const u = db.prepare("SELECT COUNT(*) AS reports, COUNT(DISTINCT reporter) AS reporters, COUNT(DISTINCT match_id) AS matches FROM reports WHERE target = ? AND status IN ('new','pending','needs_data')").get(acc);
    const hidden = !(u.reporters >= 2 && u.matches >= 2);
    const unconfirmed = hidden ? { hidden: true } : { hidden: false, reports: u.reports, reporters: u.reporters, matches: u.matches };
    const openAppeals = db.prepare("SELECT COUNT(*) AS n FROM appeals a JOIN reports r ON r.id = a.report_id WHERE r.target = ? AND a.status IN ('open','needs_data')").get(acc).n;
    // публичная хронология: только решения о подтверждении и о снятии отметки, без авторов и описаний
    const tl = db.prepare(`SELECT m.created_at AS at, m.to_status AS to_status, m.from_status AS from_status, r.match_id AS match_id, r.category AS category
      FROM moderation_actions m JOIN reports r ON r.id = m.report_id
      WHERE r.target = ? AND m.report_id IS NOT NULL AND (m.to_status = 'confirmed' OR m.from_status = 'confirmed' OR m.from_status = 'disputed') AND m.actor <> r.reporter
      ORDER BY m.id DESC LIMIT 50`).all(acc);
    const timeline = tl.map((e) => (e.to_status === 'confirmed' ? { at: e.at, type: 'confirmed', matchId: e.match_id, category: e.category } : { at: e.at, type: 'revoked' }));
    const last = db.prepare("SELECT MAX(decided_at) AS t FROM reports WHERE target = ?").get(acc).t || null;
    return ok({ acc, confirmed, disputed, unconfirmed, openAppeals, timeline, lastReviewed: last, generatedAt: now() });
  }

  /* ---------- жалобы ---------- */

  async function createReport(user, body) {
    const a = need(user); if (a) return a;
    const v = R.validateReport(body);
    if (!v.ok) return fail(400, 'validation', 'Проверьте поля формы.', { fields: v.errors });
    const x = v.value;
    if (x.target === user.acc) return fail(400, 'self', 'Нельзя подать жалобу на себя.');
    const t = now();
    const dupe = db.prepare('SELECT id FROM reports WHERE reporter = ? AND target = ? AND match_id = ?').get(user.acc, x.target, x.matchId);
    if (dupe) return fail(409, 'duplicate', 'Вы уже подавали жалобу на этого игрока по этому матчу. Дополнить её нельзя, статус можно смотреть в «Мои жалобы».', { reportId: dupe.id });
    if (db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND created_at > ?').get(user.acc, t - DAY).n >= L.reportsPerDay)
      return fail(429, 'rate_limit', 'Достигнут суточный лимит жалоб (' + L.reportsPerDay + '). Это защита от массовых обращений, попробуйте завтра.');
    if (db.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND status IN ('new','pending','needs_data')").get(user.acc).n >= L.openReportsPerUser)
      return fail(429, 'too_many_open', 'У вас слишком много нерассмотренных жалоб. Дождитесь решения по прежним.');
    if (db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND target = ? AND created_at > ?').get(user.acc, x.target, t - 7 * DAY).n >= L.perTargetPerWeek)
      return fail(429, 'target_limit', 'Слишком много жалоб на одного игрока за неделю. Если нарушений правда несколько, дождитесь решения по поданным.');

    // участие в матче проверяется по данным источника: нельзя пожаловаться на игрока, которого в матче не было
    let detail;
    try { detail = await fetchMatch(x.matchId); } catch (e) {
      if (e && e.code === 'not_found') return fail(404, 'match_not_found', 'Матч не найден в источнике данных. Проверьте Match ID.');
      return fail(503, 'match_unavailable', 'Не удалось загрузить матч для проверки. Повторите позже.');
    }
    const players = detail && Array.isArray(detail.players) ? detail.players : [];
    const byAcc = {};
    players.forEach((p) => { if (p && p.account_id != null) byAcc[String(p.account_id)] = p; });
    if (!players.length) return fail(503, 'match_unavailable', 'Подробности матча пока недоступны. Повторите позже.');
    if (!byAcc[user.acc]) return fail(422, 'not_participant', 'Вас нет среди открытых участников этого матча (или ваш профиль скрыт в нём), жалоба не принимается.');
    if (!byAcc[x.target]) return fail(422, 'target_not_in_match', 'Этого игрока нет среди участников матча (или его профиль скрыт в нём). Проверьте Steam ID и Match ID.');
    const started = Number(detail.start_time) || 0;
    if (started && t - started > L.matchMaxAgeDays * DAY) return fail(422, 'match_too_old', 'Жалобы принимаются только на матчи не старше ' + L.matchMaxAgeDays + ' дней.');

    const res = tx(() => {
      db.prepare('INSERT OR IGNORE INTO matches (id, started_at, duration, game_mode, fetched_at) VALUES (?, ?, ?, ?, ?)').run(x.matchId, started || null, Number(detail.duration) || null, Number(detail.game_mode) || null, t);
      const ins = db.prepare('INSERT OR REPLACE INTO match_players (match_id, acc, hero_id, is_radiant, kills, deaths, assists) VALUES (?, ?, ?, ?, ?, ?, ?)');
      [user.acc, x.target].forEach((acc) => {
        const p = byAcc[acc];
        ins.run(x.matchId, acc, p.hero_id == null ? null : Number(p.hero_id), p.isRadiant != null ? (p.isRadiant ? 1 : 0) : (Number(p.player_slot) < 128 ? 1 : 0), p.kills == null ? null : Number(p.kills), p.deaths == null ? null : Number(p.deaths), p.assists == null ? null : Number(p.assists));
      });
      const tp = byAcc[x.target];
      db.prepare('INSERT INTO players (acc, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(acc) DO UPDATE SET name = COALESCE(excluded.name, players.name), updated_at = excluded.updated_at').run(x.target, tp.personaname ? String(tp.personaname).slice(0, 40) : null, t);
      // подозрительный всплеск: много разных авторов за сутки. Такие жалобы помечаются для модератора и в публичный счётчик попадают как обычные
      const recent = db.prepare("SELECT COUNT(DISTINCT reporter) AS n FROM reports WHERE target = ? AND created_at > ?").get(x.target, t - L.volumeWindowH * 3600).n;
      const volume = recent + 1 >= L.volumeReporters ? 1 : 0;
      const r = db.prepare('INSERT INTO reports (reporter, target, match_id, category, description, status, volume_flag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(user.acc, x.target, x.matchId, x.category, x.description, 'new', volume, t, t);
      const id = Number(r.lastInsertRowid);
      x.evidence.forEach((u) => db.prepare('INSERT INTO report_evidence (report_id, url, created_at) VALUES (?, ?, ?)').run(id, u, t));
      logAction(id, null, user.acc, 'create', null, 'new', null);
      notifyWatchers(x.target, 'message', 'Поступила новая непроверенная жалоба. Это не подтверждённое нарушение.', 'report:' + id, user.acc);
      return { id, volume };
    });
    return ok({ id: res.id, status: 'new', statusLabel: R.STATUS_LABEL.new, flaggedForReview: !!res.volume }, 201);
  }

  function reportView(r, withEvidence) {
    return { id: r.id, target: r.target, matchId: r.match_id, category: r.category, categoryLabel: R.CATEGORIES[r.category], description: r.description, status: r.status, statusLabel: R.STATUS_LABEL[r.status], createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at,
      evidence: withEvidence ? S.evidenceOfReport.all(r.id).map((e) => e.url) : undefined };
  }
  function myReports(user) {
    const a = need(user); if (a) return a;
    const rows = db.prepare('SELECT * FROM reports WHERE reporter = ? ORDER BY id DESC LIMIT 100').all(user.acc);
    return ok({ reports: rows.map((r) => Object.assign(reportView(r, true), { history: S.actionsOfReport.all(r.id).map((h) => ({ at: h.created_at, action: h.action, from: h.from_status, to: h.to_status, by: h.actor === user.acc ? 'вы' : (isMod(h.actor) ? 'модератор' : 'система'), reason: h.actor === user.acc ? null : h.reason })) })) });
  }
  /** Отметки против меня: основание видно, автор жалобы и её текст — нет. */
  function againstMe(user) {
    const a = need(user); if (a) return a;
    const rows = db.prepare("SELECT * FROM reports WHERE target = ? AND status IN ('confirmed','disputed','not_confirmed','rejected','needs_data','pending','new','closed') ORDER BY id DESC LIMIT 100").all(user.acc);
    const publicOnes = rows.filter((r) => r.status === 'confirmed' || r.status === 'disputed');
    const appeals = db.prepare('SELECT a.id, a.report_id, a.status, a.created_at FROM appeals a JOIN reports r ON r.id = a.report_id WHERE a.author = ? ORDER BY a.id DESC').all(user.acc);
    return ok({
      marks: publicOnes.map((r) => ({ id: r.id, matchId: r.match_id, category: r.category, categoryLabel: R.CATEGORIES[r.category], status: r.status, statusLabel: R.STATUS_LABEL[r.status], reason: r.public_reason || '', decidedAt: r.decided_at, myAppeal: appeals.find((x) => x.report_id === r.id) || null })),
      pendingCount: rows.filter((r) => R.isOpenStatus(r.status) && r.status !== 'disputed').length
    });
  }

  function flagReport(user, id, body) {
    const a = need(user); if (a) return a;
    const r = S.getReport.get(Number(id));
    if (!r) return fail(404, 'not_found', 'Жалоба не найдена.');
    if (r.reporter === user.acc) return fail(400, 'own', 'Нельзя пожаловаться на собственную жалобу.');
    const reason = String((body && body.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (reason.length < 10) return fail(400, 'validation', 'Опишите причину (от 10 символов): почему жалоба ложная или злоупотребляет системой.');
    if (db.prepare('SELECT COUNT(*) AS n FROM report_flags WHERE flagger = ? AND created_at > ?').get(user.acc, now() - DAY).n >= L.flagsPerDay) return fail(429, 'rate_limit', 'Слишком много обращений за сутки.');
    // пожаловаться на жалобу может только тот, кого она касается, или участник того же матча, поэтому массовые флаги из ниоткуда невозможны
    const inMatch = db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND acc = ?').get(r.match_id, user.acc);
    if (user.acc !== r.target && !inMatch && !isMod(user.acc)) return fail(403, 'forbidden', 'Сообщить о ложной жалобе может обвиняемый или участник этого матча.');
    return tx(() => {
      const ins = db.prepare('INSERT OR IGNORE INTO report_flags (report_id, flagger, reason, created_at) VALUES (?, ?, ?, ?)').run(r.id, user.acc, reason, now());
      if (!ins.changes) return fail(409, 'duplicate', 'Вы уже сообщали об этой жалобе.');
      db.prepare('UPDATE reports SET flags = (SELECT COUNT(*) FROM report_flags WHERE report_id = ?), updated_at = ? WHERE id = ?').run(r.id, now(), r.id);
      logAction(r.id, null, user.acc, 'flag_false', null, null, reason);
      return ok({ ok: true }, 201);
    });
  }

  /* ---------- обжалования ---------- */

  function createAppeal(user, body) {
    const a = need(user); if (a) return a;
    const r = S.getReport.get(Number(body && body.reportId));
    if (!r || (r.status !== 'confirmed' && r.status !== 'disputed')) return fail(404, 'not_found', 'Оспорить можно только публичную отметку (подтверждённый эпизод).');
    const text = String((body && body.text) || '').replace(/\s+/g, ' ').trim();
    if (text.length < 10 || text.length > R.LIMITS.appealMax) return fail(400, 'validation', 'Опишите, в чём ошибка (от 10 до ' + R.LIMITS.appealMax + ' символов).', { fields: { text: 'Опишите, в чём ошибка.' } });
    const ev = (Array.isArray(body.evidence) ? body.evidence : []).map((s) => String(s || '').trim()).filter(Boolean);
    if (ev.length > R.LIMITS.evidenceMax || ev.some((u) => !R.evidenceUrlOk(u))) return fail(400, 'validation', 'Ссылки должны начинаться с https:// (не больше ' + R.LIMITS.evidenceMax + ').', { fields: { evidence: 'Проверьте ссылки.' } });
    if (db.prepare('SELECT COUNT(*) AS n FROM appeals WHERE author = ? AND created_at > ?').get(user.acc, now() - DAY).n >= L.appealsPerDay) return fail(429, 'rate_limit', 'Слишком много обращений за сутки.');
    if (db.prepare("SELECT 1 FROM appeals WHERE report_id = ? AND author = ? AND status IN ('open','needs_data')").get(r.id, user.acc)) return fail(409, 'duplicate', 'У вас уже есть открытое обращение по этой отметке.');
    const byTarget = user.acc === r.target ? 1 : 0, t = now();
    return tx(() => {
      const ins = db.prepare('INSERT INTO appeals (report_id, author, by_target, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.id, user.acc, byTarget, text, 'open', t, t);
      const id = Number(ins.lastInsertRowid);
      ev.forEach((u) => db.prepare('INSERT INTO report_evidence (appeal_id, url, created_at) VALUES (?, ?, ?)').run(id, u, t));
      logAction(r.id, id, user.acc, 'appeal_open', null, null, null);
      // обжалование самим игроком ставит отметку в статус «Оспаривается»: она остаётся видимой, но в оценку не входит до решения
      if (byTarget && r.status === 'confirmed') {
        db.prepare("UPDATE reports SET status = 'disputed', updated_at = ? WHERE id = ?").run(t, r.id);
        logAction(r.id, null, user.acc, 'status', 'confirmed', 'disputed', 'Обращение владельца аккаунта');
      }
      return ok({ id, status: 'open', statusLabel: R.APPEAL_STATUS.open }, 201);
    });
  }
  function appealView(a, viewerIsMod) {
    const r = S.getReport.get(a.report_id);
    return { id: a.id, reportId: a.report_id, matchId: r && r.match_id, category: r && r.category, categoryLabel: r && R.CATEGORIES[r.category], reportStatus: r && r.status, reportStatusLabel: r && R.STATUS_LABEL[r.status], byTarget: !!a.by_target,
      status: a.status, statusLabel: R.APPEAL_STATUS[a.status], text: a.text, evidence: S.evidenceOfAppeal.all(a.id).map((e) => e.url), decisionReason: a.decision_reason || null, createdAt: a.created_at, updatedAt: a.updated_at,
      author: viewerIsMod ? a.author : undefined, target: viewerIsMod && r ? r.target : undefined,
      history: S.actionsOfAppeal.all(a.id).map((h) => ({ at: h.created_at, action: h.action, to: h.to_status, reason: h.reason, by: viewerIsMod ? h.actor : (isMod(h.actor) ? 'модератор' : 'вы') })) };
  }
  function myAppeals(user) {
    const a = need(user); if (a) return a;
    return ok({ appeals: db.prepare('SELECT * FROM appeals WHERE author = ? ORDER BY id DESC LIMIT 100').all(user.acc).map((x) => appealView(x, false)) });
  }

  /* ---------- модератор ---------- */

  function modReports(user, query) {
    const a = needMod(user); if (a) return a;
    const st = query && query.status;
    const rows = st && R.STATUS_LABEL[st] ? db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY volume_flag DESC, flags DESC, id ASC LIMIT 200').all(st) : db.prepare("SELECT * FROM reports WHERE status IN ('new','pending','needs_data','disputed') ORDER BY volume_flag DESC, flags DESC, id ASC LIMIT 200").all();
    const counts = {}; db.prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status').all().forEach((r) => { counts[r.status] = r.n; });
    return ok({ counts, reports: rows.map((r) => Object.assign(reportView(r, true), { reporter: r.reporter, flags: r.flags, volumeFlag: !!r.volume_flag, publicReason: r.public_reason || '', allowed: R.TRANSITIONS[r.status] || [] })) });
  }
  function modReport(user, id) {
    const a = needMod(user); if (a) return a;
    const r = S.getReport.get(Number(id));
    if (!r) return fail(404, 'not_found', 'Жалоба не найдена.');
    const mp = db.prepare('SELECT * FROM match_players WHERE match_id = ?').all(r.match_id);
    const flags = db.prepare('SELECT flagger, reason, created_at FROM report_flags WHERE report_id = ?').all(r.id);
    return ok({ report: Object.assign(reportView(r, true), { reporter: r.reporter, flags: r.flags, volumeFlag: !!r.volume_flag, publicReason: r.public_reason || '', allowed: R.TRANSITIONS[r.status] || [] }), history: S.actionsOfReport.all(r.id), flagReasons: flags, matchPlayers: mp,
      otherReportsOnTarget: db.prepare('SELECT id, status, category, match_id FROM reports WHERE target = ? AND id <> ? ORDER BY id DESC LIMIT 20').all(r.target, r.id) });
  }
  function modSetStatus(user, id, body) {
    const a = needMod(user); if (a) return a;
    const r = S.getReport.get(Number(id));
    if (!r) return fail(404, 'not_found', 'Жалоба не найдена.');
    const to = String((body && body.to) || '');
    if (!R.STATUS_LABEL[to]) return fail(400, 'validation', 'Неизвестный статус.');
    if (!R.canTransition(r.status, to)) return fail(409, 'bad_transition', 'Переход «' + R.STATUS_LABEL[r.status] + '» → «' + R.STATUS_LABEL[to] + '» недопустим.', { allowed: R.TRANSITIONS[r.status] || [] });
    if (user.acc === r.reporter || user.acc === r.target) return fail(403, 'conflict', 'Нельзя модерировать жалобу, в которой вы участвуете.');
    const reason = String((body && body.reason) || '').replace(/\s+/g, ' ').trim();
    if (reason.length < 10 || reason.length > R.LIMITS.reasonMax) return fail(400, 'validation', 'Укажите обоснование решения (от 10 до ' + R.LIMITS.reasonMax + ' символов).', { fields: { reason: 'Нужно обоснование.' } });
    let pub = body && body.publicReason != null ? String(body.publicReason).replace(/\s+/g, ' ').trim().slice(0, 300) : null;
    const t = now();
    tx(() => {
      const final = to === 'confirmed' || to === 'not_confirmed' || to === 'rejected' || to === 'closed';
      db.prepare('UPDATE reports SET status = ?, updated_at = ?, decided_at = CASE WHEN ? THEN ? ELSE decided_at END, public_reason = CASE WHEN ? THEN ? ELSE public_reason END WHERE id = ?')
        .run(to, t, final ? 1 : 0, t, to === 'confirmed' ? 1 : 0, pub || (to === 'confirmed' ? r.public_reason : null), r.id);
      logAction(r.id, null, user.acc, 'status', r.status, to, reason);
      if (to === 'confirmed') notifyWatchers(r.target, 'decision', 'Модератор подтвердил эпизод. Это проверенное решение, а не жалоба.', 'report:' + r.id, null);
      if (r.status === 'confirmed' && (to === 'not_confirmed' || to === 'closed')) notifyWatchers(r.target, 'decision', 'Отметка снята после проверки.', 'report:' + r.id, null);
    });
    return ok({ id: r.id, status: to, statusLabel: R.STATUS_LABEL[to] });
  }
  function modAppeals(user, query) {
    const a = needMod(user); if (a) return a;
    const st = query && query.status;
    const rows = st ? db.prepare('SELECT * FROM appeals WHERE status = ? ORDER BY id ASC LIMIT 200').all(st) : db.prepare("SELECT * FROM appeals WHERE status IN ('open','needs_data') ORDER BY by_target DESC, id ASC LIMIT 200").all();
    return ok({ appeals: rows.map((x) => appealView(x, true)) });
  }
  function modDecideAppeal(user, id, body) {
    const a = needMod(user); if (a) return a;
    const ap = db.prepare('SELECT * FROM appeals WHERE id = ?').get(Number(id));
    if (!ap) return fail(404, 'not_found', 'Обращение не найдено.');
    if (ap.status !== 'open' && ap.status !== 'needs_data') return fail(409, 'closed', 'Обращение уже рассмотрено.');
    const r = S.getReport.get(ap.report_id);
    if (user.acc === ap.author || user.acc === r.reporter || user.acc === r.target) return fail(403, 'conflict', 'Нельзя рассматривать обращение, в котором вы участвуете.');
    const dec = String((body && body.decision) || '');
    const map = { uphold: 'upheld', revoke: 'revoked', need_data: 'needs_data', close: 'closed' };
    if (!map[dec]) return fail(400, 'validation', 'Решение: uphold, revoke, need_data или close.');
    const reason = String((body && body.reason) || '').replace(/\s+/g, ' ').trim();
    if (reason.length < 10 || reason.length > R.LIMITS.reasonMax) return fail(400, 'validation', 'Укажите обоснование решения (от 10 символов).', { fields: { reason: 'Нужно обоснование.' } });
    const t = now();
    // какой статус получит сама отметка
    let to = null;
    if (dec === 'revoke') to = 'not_confirmed';
    else if (dec === 'uphold' || dec === 'close') to = r.status === 'disputed' ? 'confirmed' : null;
    else if (dec === 'need_data') to = r.status === 'disputed' ? 'needs_data' : null;
    if (to && !R.canTransition(r.status, to)) return fail(409, 'bad_transition', 'Переход статуса отметки недопустим: ' + R.STATUS_LABEL[r.status] + ' → ' + R.STATUS_LABEL[to] + '.');
    tx(() => {
      db.prepare('UPDATE appeals SET status = ?, decision_reason = ?, decided_by = ?, updated_at = ? WHERE id = ?').run(map[dec], reason, user.acc, t, ap.id);
      logAction(r.id, ap.id, user.acc, 'appeal_' + dec, ap.status, map[dec], reason);
      if (to) {
        db.prepare('UPDATE reports SET status = ?, updated_at = ?, decided_at = ? WHERE id = ?').run(to, t, t, r.id);
        logAction(r.id, null, user.acc, 'status', r.status, to, 'По обращению №' + ap.id + ': ' + reason);
        if (to === 'not_confirmed') notifyWatchers(r.target, 'decision', 'Отметка снята после рассмотрения обращения.', 'report:' + r.id, null);
      }
      S.insertNotif.run(ap.author, 'decision', r.target, 'Обращение №' + ap.id + ': ' + R.APPEAL_STATUS[map[dec]] + '.', 'appeal:' + ap.id, t);
    });
    return ok({ id: ap.id, status: map[dec], statusLabel: R.APPEAL_STATUS[map[dec]], reportStatus: to || r.status });
  }
  function modLog(user, query) {
    const a = needMod(user); if (a) return a;
    const lim = Math.min(200, Math.max(1, parseInt(query && query.limit, 10) || 100));
    return ok({ log: db.prepare('SELECT id, report_id, appeal_id, actor, action, from_status, to_status, reason, created_at FROM moderation_actions ORDER BY id DESC LIMIT ?').all(lim) });
  }

  /* ---------- список наблюдения, снимки, уведомления ---------- */

  function wlList(user) {
    const a = need(user); if (a) return a;
    return ok({ entries: db.prepare('SELECT target_acc AS acc, note, added_at AS addedAt, last_checked_at AS lastCheckedAt, last_state AS lastState, last_anomalies AS lastAnomalies FROM watchlist_entries WHERE user_acc = ? ORDER BY added_at DESC').all(user.acc), max: L.watchlistMax });
  }
  function wlAdd(user, body) {
    const a = need(user); if (a) return a;
    const acc = accOf(body && body.target);
    if (!acc) return fail(400, 'validation', 'Нужен корректный Steam ID или ссылка на профиль.');
    const note = String((body && body.note) || '').replace(/\s+/g, ' ').trim().slice(0, R.LIMITS.noteMax);
    if (db.prepare('SELECT COUNT(*) AS n FROM watchlist_entries WHERE user_acc = ?').get(user.acc).n >= L.watchlistMax) return fail(409, 'limit', 'В списке наблюдения не больше ' + L.watchlistMax + ' игроков.');
    const r = db.prepare('INSERT OR IGNORE INTO watchlist_entries (user_acc, target_acc, note, added_at) VALUES (?, ?, ?, ?)').run(user.acc, acc, note || null, now());
    return r.changes ? ok({ acc }, 201) : fail(409, 'duplicate', 'Игрок уже в списке.');
  }
  function wlRemove(user, accRaw) {
    const a = need(user); if (a) return a;
    const acc = accOf(accRaw); if (!acc) return fail(400, 'validation', 'Некорректный Steam ID.');
    db.prepare('DELETE FROM watchlist_entries WHERE user_acc = ? AND target_acc = ?').run(user.acc, acc);
    return ok({ ok: true });
  }
  /** Клиент присылает результат своей проверки (статистика считается в браузере по данным OpenDota). Сервер сохраняет снимок и при росте числа аномалий создаёт нейтральное уведомление. */
  function wlCheck(user, accRaw, body) {
    const a = need(user); if (a) return a;
    const acc = accOf(accRaw); if (!acc) return fail(400, 'validation', 'Некорректный Steam ID.');
    const e = db.prepare('SELECT * FROM watchlist_entries WHERE user_acc = ? AND target_acc = ?').get(user.acc, acc);
    if (!e) return fail(404, 'not_found', 'Игрока нет в списке наблюдения.');
    const state = String((body && body.state) || '');
    if (!R.STATE_LABEL[state]) return fail(400, 'validation', 'Неизвестное состояние проверки.');
    const an = Math.max(0, Math.min(1000, parseInt(body.anomalies, 10) || 0)), score = body.score == null ? null : Math.max(0, Math.min(100, parseInt(body.score, 10) || 0));
    const conf = ['low', 'medium', 'high'].includes(body.confidence) ? body.confidence : null, t = now();
    tx(() => {
      db.prepare('INSERT INTO reputation_snapshots (target_acc, user_acc, computed_at, state, score, confidence, anomalies) VALUES (?, ?, ?, ?, ?, ?, ?)').run(acc, user.acc, t, state, score, conf, an);
      db.prepare('UPDATE watchlist_entries SET last_checked_at = ?, last_state = ?, last_anomalies = ? WHERE user_acc = ? AND target_acc = ?').run(t, state, an, user.acc, acc);
      if (e.last_anomalies != null && an > e.last_anomalies) S.insertNotif.run(user.acc, 'anomaly', acc, 'Появились новые статистические аномалии (+' + (an - e.last_anomalies) + '). Это повод посмотреть матчи, а не вывод о нарушении.', 'profile:' + acc, t);
    });
    return ok({ acc, checkedAt: t, notified: e.last_anomalies != null && an > e.last_anomalies });
  }
  function wlSnapshots(user, accRaw) {
    const a = need(user); if (a) return a;
    const acc = accOf(accRaw); if (!acc) return fail(400, 'validation', 'Некорректный Steam ID.');
    return ok({ snapshots: db.prepare('SELECT computed_at AS at, state, score, confidence, anomalies FROM reputation_snapshots WHERE user_acc = ? AND target_acc = ? ORDER BY id DESC LIMIT 30').all(user.acc, acc) });
  }
  function notifList(user) {
    const a = need(user); if (a) return a;
    return ok({ notifications: db.prepare('SELECT id, kind, target_acc AS target, text, ref, created_at AS createdAt, read_at AS readAt FROM notifications WHERE user_acc = ? ORDER BY id DESC LIMIT 100').all(user.acc), unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_acc = ? AND read_at IS NULL').get(user.acc).n });
  }
  function notifRead(user) {
    const a = need(user); if (a) return a;
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_acc = ? AND read_at IS NULL').run(now(), user.acc);
    return ok({ ok: true });
  }

  /* ---------- маршрутизация ---------- */

  /** route(method, path, {user, query, body}); path без префикса /api/c. */
  async function route(method, p, ctx) {
    const user = ctx.user || null, query = ctx.query || {}, body = ctx.body || {};
    let m;
    try {
      if (method === 'GET' && p === '/status') return ok({ available: true, user: user ? { acc: user.acc, moderator: isMod(user.acc) } : null, limits: { reportsPerDay: L.reportsPerDay, matchMaxAgeDays: L.matchMaxAgeDays } });
      if (method === 'GET' && (m = /^\/player\/(\d{1,10})$/.exec(p))) return playerSummary(m[1]);
      if (method === 'POST' && p === '/reports') return await createReport(user, body);
      if (method === 'GET' && p === '/my/reports') return myReports(user);
      if (method === 'GET' && p === '/against-me') return againstMe(user);
      if (method === 'POST' && (m = /^\/reports\/(\d+)\/flag$/.exec(p))) return flagReport(user, m[1], body);
      if (method === 'POST' && p === '/appeals') return createAppeal(user, body);
      if (method === 'GET' && p === '/my/appeals') return myAppeals(user);
      if (method === 'GET' && p === '/mod/reports') return modReports(user, query);
      if (method === 'GET' && (m = /^\/mod\/reports\/(\d+)$/.exec(p))) return modReport(user, m[1]);
      if (method === 'POST' && (m = /^\/mod\/reports\/(\d+)\/status$/.exec(p))) return modSetStatus(user, m[1], body);
      if (method === 'GET' && p === '/mod/appeals') return modAppeals(user, query);
      if (method === 'POST' && (m = /^\/mod\/appeals\/(\d+)$/.exec(p))) return modDecideAppeal(user, m[1], body);
      if (method === 'GET' && p === '/mod/log') return modLog(user, query);
      if (method === 'GET' && p === '/watchlist') return wlList(user);
      if (method === 'POST' && p === '/watchlist') return wlAdd(user, body);
      if (method === 'DELETE' && (m = /^\/watchlist\/(\d{1,10})$/.exec(p))) return wlRemove(user, m[1]);
      if (method === 'POST' && (m = /^\/watchlist\/(\d{1,10})\/check$/.exec(p))) return wlCheck(user, m[1], body);
      if (method === 'GET' && (m = /^\/watchlist\/(\d{1,10})\/snapshots$/.exec(p))) return wlSnapshots(user, m[1]);
      if (method === 'GET' && p === '/notifications') return notifList(user);
      if (method === 'POST' && p === '/notifications/read') return notifRead(user);
      return fail(404, 'not_found', 'Неизвестный метод.');
    } catch (e) {
      if (opts.log) opts.log(e);
      return fail(500, 'server_error', 'Внутренняя ошибка сервера.');
    }
  }

  return { route, isMod, playerSummary, createReport, modSetStatus, modDecideAppeal, createAppeal, flagReport, wlCheck, wlAdd, myReports, againstMe };
}

/** Список модераторов из переменной окружения MODERATORS: account id или SteamID64 через запятую. */
function parseModerators(s) {
  const out = new Set();
  String(s || '').split(/[\s,;]+/).filter(Boolean).forEach((x) => { const r = R.normAcc(x); if (r) out.add(r.acc); });
  return out;
}

module.exports = { create, parseModerators, DEFAULT_LIMITS };
