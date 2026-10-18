/*
 * Dota Mate: репутация, аномалии и жалобы. Только чистые функции (браузер: DMRep, Node: require).
 * Один и тот же код работает в браузере (отчёты по матчам) и на сервере (проверка жалоб и переходов статусов),
 * поэтому правила нельзя обойти подменой фронтенда.
 *
 * Принципы:
 *  - факты игры, статистические аномалии, жалобы и решения модератора хранятся и показываются раздельно;
 *  - низкий KDA, поражения и количество жалоб сами по себе баллов не дают;
 *  - без подтверждения модератором итог никогда не бывает «Высокий» (это проверяется тестом);
 *  - при малой выборке уверенность низкая, при отсутствии данных оценки нет, а не 0.
 */
(function (root, factory) {
  var dma = typeof module === 'object' && module.exports ? require('./analytics.js') : root.DMA;
  if (typeof module === 'object' && module.exports) module.exports = factory(dma);
  else root.DMRep = factory(dma);
})(typeof self !== 'undefined' ? self : this, function (DMA) {
  'use strict';

  var DAY = 86400;

  /* ---------- категории и статусы ---------- */

  var CATEGORIES = {
    sabotage: 'Предполагаемый намеренный саботаж',
    feeding: 'Подозрение на намеренное кормление',
    afk: 'AFK или длительное бездействие',
    other: 'Другое поведение, мешающее игре'
  };

  var STATUS_LABEL = {
    new: 'Новый',
    pending: 'Ожидает проверки',
    needs_data: 'Требует дополнительных данных',
    confirmed: 'Подтверждён модератором',
    not_confirmed: 'Не подтверждён',
    rejected: 'Отклонён',
    disputed: 'Оспаривается',
    closed: 'Закрыт'
  };

  /** Допустимые переходы. Подтверждённое решение можно оспорить, исправить на «Не подтверждён» или закрыть; закрытое и отклонённое можно открыть заново. */
  var TRANSITIONS = {
    new: ['pending', 'needs_data', 'rejected', 'not_confirmed', 'confirmed'],
    pending: ['needs_data', 'confirmed', 'not_confirmed', 'rejected'],
    needs_data: ['pending', 'not_confirmed', 'rejected', 'closed'],
    confirmed: ['disputed', 'not_confirmed', 'closed'],
    not_confirmed: ['pending', 'closed'],
    rejected: ['pending', 'closed'],
    disputed: ['confirmed', 'not_confirmed', 'needs_data', 'closed'],
    closed: ['pending']
  };
  function canTransition(from, to) { return !!TRANSITIONS[from] && TRANSITIONS[from].indexOf(to) >= 0; }

  /** Эпизод публично считается подтверждённым только в статусе confirmed. */
  function isPublicStatus(s) { return s === 'confirmed'; }
  /** Жалобы, которые ещё могут повлиять на «неподтверждённые» счётчики. */
  function isOpenStatus(s) { return s === 'new' || s === 'pending' || s === 'needs_data' || s === 'disputed'; }

  var APPEAL_STATUS = { open: 'Открыто', needs_data: 'Нужны дополнительные данные', upheld: 'Отметка подтверждена', revoked: 'Отметка снята', closed: 'Закрыто' };

  /* ---------- проверка ввода жалобы ---------- */

  var LIMITS = { descMin: 20, descMax: 1000, evidenceMax: 3, urlMax: 300, appealMax: 1000, reasonMax: 500, noteMax: 200 };

  /** Ссылка на доказательство: только https, нормальное имя хоста, без адресов вида IP и localhost, без логина в адресе. */
  function evidenceUrlOk(u) {
    if (typeof u !== 'string' || u.length > LIMITS.urlMax || /\s/.test(u)) return false;
    var url;
    try { url = new URL(u); } catch (e) { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    var h = url.hostname.toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return false;
    if (/^\d+(\.\d+){3}$/.test(h) || h === 'localhost' || /\.(local|internal|localhost)$/.test(h)) return false;
    return true;
  }
  /** Расширения, которые нельзя прикладывать ссылкой (исполняемые и архивы): загрузка файлов сервисом не поддерживается вообще. */
  var BAD_EXT = /\.(exe|msi|bat|cmd|scr|dll|js|jar|apk|zip|rar|7z|iso|ps1|sh|vbs|lnk|html?)(\?|#|$)/i;

  function normAcc(v) {
    var r = DMA.parsePlayerInput(v);
    return r.ok ? r : null;
  }

  /** Проверка и нормализация жалобы. Возвращает {ok, value} или {ok:false, errors:{поле: сообщение}}. */
  function validateReport(input) {
    var errors = {}, v = {};
    input = input || {};
    var t = normAcc(input.target);
    if (!t) errors.target = 'Нужен корректный Steam ID, SteamID64 или ссылка вида /profiles/…';
    else v.target = t.acc;
    var mid = String(input.matchId == null ? '' : input.matchId).trim();
    if (!/^\d{6,13}$/.test(mid)) errors.matchId = 'Match ID — число из 6–13 цифр.';
    else v.matchId = mid;
    if (!CATEGORIES[input.category]) errors.category = 'Выберите категорию.';
    else v.category = input.category;
    var d = String(input.description == null ? '' : input.description).replace(/\s+/g, ' ').trim();
    if (d.length < LIMITS.descMin) errors.description = 'Опишите эпизод подробнее: что и в какой момент матча произошло (от ' + LIMITS.descMin + ' символов).';
    else if (d.length > LIMITS.descMax) errors.description = 'Описание не длиннее ' + LIMITS.descMax + ' символов.';
    else v.description = d;
    var ev = Array.isArray(input.evidence) ? input.evidence : (input.evidence ? [input.evidence] : []);
    ev = ev.map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
    if (ev.length > LIMITS.evidenceMax) errors.evidence = 'Не больше ' + LIMITS.evidenceMax + ' ссылок.';
    else if (ev.some(function (u) { return !evidenceUrlOk(u); })) errors.evidence = 'Ссылки должны начинаться с https:// и вести на обычный сайт (без IP-адресов и логинов).';
    else if (ev.some(function (u) { return BAD_EXT.test(u); })) errors.evidence = 'Ссылки на исполняемые файлы, архивы и HTML-страницы не принимаются. Приложите ссылку на видео, скриншот или страницу матча.';
    else v.evidence = ev.filter(function (u, i) { return ev.indexOf(u) === i; });
    if (input.consent !== true) errors.consent = 'Нужно согласие с правилами отправки жалоб.';
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    return { ok: true, value: v };
  }

  /** Ключ защиты от дубликатов: один пользователь, один матч, один обвиняемый. */
  function dupKey(reporter, target, matchId) { return reporter + '|' + target + '|' + matchId; }

  /* ---------- факты игры и аномалии ---------- */

  var LEAVER = {
    2: { t: 'Долгое отключение от игры', fact: false },
    3: { t: 'Покинул матч (по данным игры)', fact: true },
    4: { t: 'AFK (отметка игры)', fact: true },
    5: { t: 'Не подключился к матчу', fact: false },
    6: { t: 'Не подключился к матчу вовремя (по данным игры)', fact: true }
  };
  function leaverInfo(code) { return LEAVER[code] || null; }

  function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
  function std(a, m) { return Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / a.length); }

  /**
   * Ищет в истории игрока то, что стоит проверить. Каждая запись содержит основание (basis), по которому можно пересчитать вывод.
   * Сравнение идёт только с собственной историей игрока (позиции и роли разных игроков между собой не сравниваются);
   * по герою используется отдельная база, если на нём не меньше 5 матчей.
   * opts: {now, heroName(id), minBaseline (15)}.
   * Возвращает {ready, baselineN, items[], patterns[], stats{abandon, abandonRate, outliers, n}}.
   */
  function detectAnomalies(matches, opts) {
    opts = opts || {};
    var min = opts.minBaseline || 15, hn = opts.heroName || function (id) { return 'герой #' + id; };
    var list = DMA.newestFirst(matches), items = [], patterns = [];
    var timed = list.filter(function (m) { return m.dur != null && m.dur >= 900 && m.d != null; });
    var out = { ready: timed.length >= min, baselineN: timed.length, items: items, patterns: patterns, stats: { n: list.length, abandon: 0, abandonRate: null, outliers: 0 } };

    // факты, записанные самой игрой
    list.forEach(function (m) {
      var li = m.leaver != null ? leaverInfo(m.leaver) : null;
      if (!li) return;
      if (li.fact) out.stats.abandon++;
      items.push({ id: m.id + ':leaver', matchId: m.id, kind: 'leaver', group: li.fact ? 'fact' : 'info', level: li.fact ? 'notable' : 'info', start: m.start, hero: m.hero,
        title: li.t, facts: ['leaver_status = ' + m.leaver + ' (данные игры, передаются через OpenDota)'], basis: 'Отметка, записанная игрой. Причина (разрыв связи, вылет клиента, действия игрока) из неё не видна.' });
    });
    if (list.length >= 20) out.stats.abandonRate = out.stats.abandon / list.length;

    if (out.ready) {
      var rate = function (m) { return m.d / (m.dur / 600); };
      var rates = timed.map(rate), mu = mean(rates), sd = std(rates, mu);
      var byHero = {};
      timed.forEach(function (m) { if (m.hero != null) (byHero[m.hero] = byHero[m.hero] || []).push(rate(m)); });
      var floorSd = Math.max(sd, mu * 0.25, 0.3);
      timed.forEach(function (m) {
        if (m.d < 10) return;
        var hs = m.hero != null ? byHero[m.hero] : null, useHero = hs && hs.length >= 5, base = useHero ? mean(hs) : mu;
        var r = rate(m), z = (r - base) / floorSd;
        if (z < 2.5 || r < base * 1.8) return;
        out.stats.outliers++;
        items.push({ id: m.id + ':deaths', matchId: m.id, kind: 'deaths_outlier', group: 'anomaly', level: z >= 3.5 ? 'notable' : 'info', start: m.start, hero: m.hero, z: z,
          title: 'Необычно много смертей',
          facts: [m.d + ' ' + DMA.plural(m.d, 'смерть', 'смерти', 'смертей') + ' за ' + Math.round(m.dur / 60) + ' мин (' + r.toFixed(1) + ' на 10 минут)',
            'обычно у этого игрока ' + base.toFixed(1) + ' на 10 минут' + (useHero ? ' на ' + hn(m.hero) : ''),
            'отклонение +' + z.toFixed(1) + ' σ, база: ' + (useHero ? hs.length : timed.length) + ' матчей'],
          basis: 'Статистическое отклонение от собственной истории игрока. Не показывает причину: возможны тяжёлая игра, смена роли, плохой хард-лейн, соперник сильнее.' });
      });
      var recent = items.filter(function (i) { return i.kind === 'deaths_outlier'; }).filter(function (i) {
        var rank = list.findIndex(function (m) { return m.id === i.matchId; });
        return rank >= 0 && rank < 30;
      });
      if (recent.length >= 3) patterns.push({ kind: 'deaths_repeat', matchIds: recent.map(function (i) { return i.matchId; }), text: recent.length + ' матча с необычным числом смертей среди последних 30. Повторяемость усиливает повод посмотреть матчи, но не доказывает намерение.' });
    }

    // слабая игра по общей оценке: только справочная отметка, в репутацию не входит
    var sc = DMA.matchScores(list);
    if (sc.ready) list.forEach(function (m) {
      var s = sc.scores[m.id];
      if (s && s.v <= -40) items.push({ id: m.id + ':perf', matchId: m.id, kind: 'performance_low', group: 'info', level: 'info', start: m.start, hero: m.hero,
        title: 'Очень слабая игра относительно собственного уровня', facts: ['оценка игры ' + s.v + ' из −50…+50'], basis: 'Справочная отметка. Слабая игра не считается нарушением и в репутацию не входит.' });
    });

    // изменение активности: два последовательных окна по 14 дней
    if (opts.now) {
      var rec = list.filter(function (m) { return m.start != null && m.start >= opts.now - 14 * DAY; }).length;
      var prev = list.filter(function (m) { return m.start != null && m.start < opts.now - 14 * DAY && m.start >= opts.now - 28 * DAY; }).length;
      if (prev >= 10 && (rec >= prev * 3 || rec <= prev * 0.2)) {
        items.push({ id: 'activity', matchId: null, kind: 'activity_change', group: 'info', level: 'info', start: opts.now, hero: null,
          title: rec > prev ? 'Резко выросла игровая активность' : 'Резко упала игровая активность',
          facts: [rec + ' матчей за последние 14 дней против ' + prev + ' за предыдущие 14'], basis: 'Справочная отметка. Может быть отпуском, перерывом или сменой режима игры.' });
      }
    }
    items.sort(function (a, b) { return (b.start || 0) - (a.start || 0); });
    return out;
  }

  /* ---------- репутация ---------- */

  var STATE_LABEL = {
    insufficient: 'Недостаточно данных',
    no_signals: 'Нет обнаруженных сигналов',
    needs_review: 'Требуется проверка',
    confirmed: 'Есть подтверждённые эпизоды',
    stale: 'Данные устарели'
  };
  var W = { confirmedEach: 25, confirmedCap: 70, outlierEach: 2, outlierCap: 10, patternEach: 8, patternCap: 16, abandon10: 6, abandon20: 12, reportsEach: 2, reportsCap: 8 };

  /**
   * Прозрачная оценка. Вход: {matches (нормализованные), now, anomalies (результат detectAnomalies), fetchedAt, comm}.
   * comm (данные сообщества, если сервер доступен): {available, confirmed:[{matchId,category,decidedAt}], unconfirmed:{hidden, reporters, matches, reports}, openAppeals}.
   * Возвращает {state, stateLabel, risk, score, confidence, factors[], notCounted[], notes[], uniqueSignalMatches, confirmedCount, unconfirmedReports, lastCheck}.
   * Правила и веса открыты: см. W выше и README.
   */
  function computeReputation(input) {
    var now = input.now, an = input.anomalies || { items: [], patterns: [], stats: {} }, comm = input.comm || { available: false };
    var n = input.matches.length, factors = [], notes = [], score = 0;
    var newest = input.matches.reduce(function (a, m) { return m.start != null && m.start > a ? m.start : a; }, 0);
    var confirmed = comm.available && comm.confirmed ? comm.confirmed : [];
    var confUnique = {};
    confirmed.forEach(function (c) { confUnique[c.matchId] = c; });
    var confIds = Object.keys(confUnique);

    // 1. подтверждённые модератором эпизоды (с затуханием: старше года вес вдвое меньше)
    if (confIds.length) {
      var pts = 0;
      confIds.forEach(function (id) {
        var at = confUnique[id].decidedAt || now, old = now - at > 365 * DAY;
        pts += W.confirmedEach * (old ? 0.5 : 1);
      });
      pts = Math.min(W.confirmedCap, Math.round(pts));
      score += pts;
      factors.push({ id: 'confirmed', group: 'confirmed', label: 'Подтверждённые модератором эпизоды', points: pts, detail: confIds.length + ' ' + DMA.plural(confIds.length, 'матч', 'матча', 'матчей') + ' (по ' + W.confirmedEach + ' баллов, максимум ' + W.confirmedCap + ', старше года вес вдвое меньше)' });
    }
    // 2. статистические аномалии (только свои отклонения игрока)
    var outliers = an.items.filter(function (i) { return i.kind === 'deaths_outlier'; });
    if (outliers.length) {
      var p2 = Math.min(W.outlierCap, outliers.length * W.outlierEach);
      score += p2;
      factors.push({ id: 'outliers', group: 'anomaly', label: 'Матчи с необычным числом смертей', points: p2, detail: outliers.length + ' × ' + W.outlierEach + ', максимум ' + W.outlierCap + '. Статистическое отклонение от собственных обычных показателей, не доказательство' });
    }
    if (an.patterns.length) {
      var p3 = Math.min(W.patternCap, an.patterns.length * W.patternEach);
      score += p3;
      factors.push({ id: 'pattern', group: 'anomaly', label: 'Повторяемость отклонений', points: p3, detail: 'Три и более матча с необычным числом смертей среди последних 30' });
    }
    // 3. отметки игры об уходе из матча (при достаточной выборке)
    if (an.stats.abandonRate != null && an.stats.abandonRate >= 0.1) {
      var p4 = an.stats.abandonRate >= 0.2 ? W.abandon20 : W.abandon10;
      score += p4;
      factors.push({ id: 'abandon', group: 'fact', label: 'Доля матчей, покинутых по данным игры', points: p4, detail: Math.round(an.stats.abandonRate * 100) + '% из ' + an.stats.n + ' матчей (порог 10% и 20%, нужна выборка от 20 матчей)' });
    }
    // 4. неподтверждённые жалобы: ограниченный вклад, считаются независимые источники
    var unc = comm.available && comm.unconfirmed ? comm.unconfirmed : null;
    var uncCount = null;
    if (unc && !unc.hidden) {
      uncCount = unc.reports;
      var indep = Math.min(unc.reporters || 0, unc.matches || 0);
      var p5 = Math.min(W.reportsCap, indep * W.reportsEach);
      if (p5) {
        score += p5;
        factors.push({ id: 'reports', group: 'report', label: 'Неподтверждённые жалобы независимых пользователей', points: p5, detail: 'Учитывается меньшее из чисел «разных авторов» (' + unc.reporters + ') и «разных матчей» (' + unc.matches + '), по ' + W.reportsEach + ' балла, максимум ' + W.reportsCap + '. Жалоба — не доказательство, много жалоб от одного автора считаются как одна' });
      }
    }
    score = Math.min(100, Math.max(0, score));

    var notCounted = ['Поражения, винрейт и серии поражений', 'Низкий K/D/A сам по себе', 'Число жалоб от одного и того же пользователя', 'Скрытые и недоступные данные'];
    var uniqueSignal = {};
    an.items.forEach(function (i) { if (i.matchId && (i.group === 'fact' || i.group === 'anomaly')) uniqueSignal[i.matchId] = 1; });
    confIds.forEach(function (id) { uniqueSignal[id] = 1; });

    // состояние
    var stale = newest > 0 && now - newest > 90 * DAY, repeat = an.patterns.length > 0;
    var needs = repeat || (an.stats.abandonRate != null && an.stats.abandonRate >= 0.2) || (unc && !unc.hidden && unc.reporters >= 2 && unc.matches >= 2);
    var state;
    if (confIds.length) state = 'confirmed';
    else if (n < 20) state = 'insufficient';
    else if (stale) state = 'stale';
    else if (needs) state = 'needs_review';
    else state = 'no_signals';

    // уверенность в данных
    var conf, reason;
    if (n < 20) { conf = 'low'; reason = 'Загружено меньше 20 матчей.'; }
    else if (n < 60) { conf = 'medium'; reason = 'Загружено ' + n + ' матчей: выводы предварительные.'; }
    else { conf = 'high'; reason = 'Загружено ' + n + ' матчей.'; }
    if (!comm.available) { if (conf === 'high') conf = 'medium'; reason += ' Данные сообщества недоступны (нужен сервер Dota Mate), оценка построена только по статистике матчей.'; }
    if (an.baselineN != null && !an.ready && n >= 20) reason += ' Для поиска отклонений нужно хотя бы 15 матчей с длительностью и смертями.';
    if (confIds.length && conf === 'low') { conf = 'medium'; reason += ' Подтверждённые эпизоды проверены модератором.'; }

    var risk = null;
    if (state === 'confirmed' || state === 'needs_review') risk = score < 10 ? 'Низкий' : score < 30 ? 'Умеренный' : score < 60 ? 'Повышенный' : 'Высокий';
    if (state === 'confirmed' && !confIds.length) risk = null;

    if (state === 'no_signals') notes.push('Отсутствие сигналов не означает гарантированно идеальное поведение: анализ видит только публичную статистику.');
    if (state === 'insufficient') notes.push('Оценка не рассчитана: слишком мало данных. Это не означает ни хорошую, ни плохую репутацию.');
    if (state === 'stale') notes.push('Последний загруженный матч старше 90 дней. Сигналы могут не отражать текущее поведение.');
    if (unc && unc.hidden) notes.push('Есть жалобы, но их слишком мало, чтобы показывать счётчик публично: нужны минимум два разных автора и два разных матча.');
    if (state === 'needs_review') notes.push('«Требуется проверка» означает повод посмотреть матчи самому, а не вывод о нарушении.');

    return {
      state: state, stateLabel: STATE_LABEL[state], risk: risk,
      score: state === 'insufficient' ? null : score, scoreNote: 'Экспериментальный показатель 0–100. Без подтверждения модератором итог не превышает ' + (W.outlierCap + W.patternCap + W.abandon20 + W.reportsCap) + '.',
      confidence: { level: conf, label: conf === 'high' ? 'Высокая' : conf === 'medium' ? 'Средняя' : 'Низкая', reason: reason },
      factors: factors, notCounted: notCounted, notes: notes,
      uniqueSignalMatches: Object.keys(uniqueSignal).length, confirmedCount: confIds.length, unconfirmedReports: uncCount,
      hiddenReports: !!(unc && unc.hidden), openAppeals: comm.available ? comm.openAppeals || 0 : null,
      lastCheck: input.fetchedAt || null
    };
  }

  return {
    CATEGORIES: CATEGORIES, STATUS_LABEL: STATUS_LABEL, TRANSITIONS: TRANSITIONS, APPEAL_STATUS: APPEAL_STATUS, LIMITS: LIMITS, STATE_LABEL: STATE_LABEL, WEIGHTS: W,
    canTransition: canTransition, isPublicStatus: isPublicStatus, isOpenStatus: isOpenStatus,
    evidenceUrlOk: evidenceUrlOk, validateReport: validateReport, dupKey: dupKey, normAcc: normAcc,
    leaverInfo: leaverInfo, detectAnomalies: detectAnomalies, computeReputation: computeReputation
  };
});
