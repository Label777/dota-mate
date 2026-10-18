/*
 * Dota Mate: клиент к API сообщества (/api/c/*, см. server/community.js).
 * Ничего не решает сам: права, лимиты и проверки выполняет сервер. Если сайт открыт без сервера
 * (например, на GitHub Pages), функции жалоб, модерации и серверного списка наблюдения недоступны, и модуль честно это сообщает.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMComm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var hostServer = function () { return false; };
  var st = null, stAt = 0;

  function call(method, path, body) {
    if (!hostServer()) return Promise.resolve({ ok: false, status: 0, error: 'no_server', message: 'Сайт открыт без сервера Dota Mate, поэтому сообщество недоступно.' });
    var init = { method: method, headers: { 'X-DM': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch('/api/c' + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) return { ok: true, status: r.status, data: j };
        return { ok: false, status: r.status, error: j.error || 'error', message: j.message || (r.status === 429 ? 'Слишком много запросов, подождите минуту.' : r.status === 401 ? 'Войдите через Steam.' : 'Запрос не выполнен (' + r.status + ').'), fields: j.fields || null, data: j };
      });
    }, function () { return { ok: false, status: 0, error: 'network', message: 'Не удалось связаться с сервером. Повторите позже.' }; });
  }

  /** Состояние: {available, user:{acc,moderator}|null, reason}. Кэшируется на 30 секунд. */
  function status(force) {
    if (!force && st && Date.now() - stAt < 30000) return Promise.resolve(st);
    if (!hostServer()) { return Promise.resolve({ available: false, user: null, reason: 'Сайт открыт без сервера Dota Mate (например, на GitHub Pages).' }); }
    return call('GET', '/status').then(function (r) {
      st = r.ok ? r.data : { available: false, user: null, reason: r.message };
      stAt = Date.now();
      return st;
    });
  }

  /**
   * Превращает ответ /player/{acc} в формат, который ждёт DMRep.computeReputation (поле comm).
   * confirmed: подтверждённые, не оспариваемые; disputed показываются отдельно и в расчёт не входят.
   */
  function toComm(sum) {
    if (!sum) return { available: false };
    return {
      available: true,
      confirmed: (sum.confirmed || []).map(function (c) { return { matchId: c.matchId, category: c.category, decidedAt: c.decidedAt }; }),
      disputed: (sum.disputed || []).length,
      unconfirmed: sum.unconfirmed && !sum.unconfirmed.hidden ? { hidden: false, reports: sum.unconfirmed.reports, reporters: sum.unconfirmed.reporters, matches: sum.unconfirmed.matches } : { hidden: true },
      openAppeals: sum.openAppeals || 0
    };
  }

  function summary(acc) {
    return call('GET', '/player/' + acc).then(function (r) { return r.ok ? r.data : null; });
  }

  return {
    init: function (o) { hostServer = o.server || hostServer; },
    call: call, status: status, summary: summary, toComm: toComm,
    reset: function () { st = null; stAt = 0; }
  };
});
