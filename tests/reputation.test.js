'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/reputation.js');

const NOW = 1_800_000_000, DAY = 86400;
function mk(i, o) { return Object.assign({ id: String(9000000000 + i), start: NOW - i * 3600 * 12, dur: 2400, win: i % 2 === 0, hero: 1 + (i % 4), k: 5, d: 5, a: 8, gpm: 450, xpm: 500, leaver: 0 }, o || {}); }
function history(n, over) { const l = []; for (let i = 0; i < n; i++) l.push(mk(i, over && over(i))); return l; }

test('переходы статусов: допустимые и запрещённые', () => {
  assert.ok(R.canTransition('new', 'pending'));
  assert.ok(R.canTransition('pending', 'confirmed'));
  assert.ok(R.canTransition('confirmed', 'not_confirmed'), 'ошибочное решение можно исправить');
  assert.ok(R.canTransition('confirmed', 'disputed'));
  assert.ok(R.canTransition('closed', 'pending'), 'закрытое можно открыть заново');
  assert.ok(!R.canTransition('new', 'disputed'));
  assert.ok(!R.canTransition('closed', 'confirmed'), 'сразу подтвердить закрытое нельзя');
  assert.ok(!R.canTransition('confirmed', 'new'));
  assert.ok(!R.canTransition('nope', 'pending'));
  Object.keys(R.TRANSITIONS).forEach((s) => assert.ok(R.STATUS_LABEL[s], 'есть подпись ' + s));
  Object.values(R.TRANSITIONS).flat().forEach((s) => assert.ok(R.STATUS_LABEL[s]));
  assert.ok(R.isPublicStatus('confirmed') && !R.isPublicStatus('pending') && !R.isPublicStatus('disputed'));
});

test('ссылки на доказательства', () => {
  assert.ok(R.evidenceUrlOk('https://www.youtube.com/watch?v=abc'));
  assert.ok(R.evidenceUrlOk('https://imgur.com/a/xyz'));
  for (const bad of ['http://a.com/x', 'javascript:alert(1)', 'https://127.0.0.1/x', 'https://localhost/x', 'https://user:p@a.com/', 'https://a.com:8080/', 'https://a/x', 'не ссылка', 'https://a.com/x y', 'data:text/html;base64,AAA', 'https://192.168.0.1/a', 'https://' + 'a'.repeat(300) + '.com'])
    assert.ok(!R.evidenceUrlOk(bad), bad);
});

const GOOD = { target: '86745912', matchId: '9025128045', category: 'feeding', description: 'На 12 минуте игрок сознательно ходил на башню противника и умирал снова и снова.', evidence: ['https://youtu.be/abc123'], consent: true };

test('validateReport: нормализация и ошибки по полям', () => {
  let r = R.validateReport(GOOD);
  assert.ok(r.ok); assert.equal(r.value.target, '86745912'); assert.deepEqual(r.value.evidence, ['https://youtu.be/abc123']);
  r = R.validateReport(Object.assign({}, GOOD, { target: '76561198047011640' }));
  assert.equal(r.value.target, '86745912', 'SteamID64 приводится к account id');
  r = R.validateReport({});
  assert.ok(!r.ok);
  ['target', 'matchId', 'category', 'description', 'consent'].forEach((k) => assert.ok(r.errors[k], 'ошибка ' + k));
  assert.ok(R.validateReport(Object.assign({}, GOOD, { consent: 'true' })).errors.consent, 'согласие строго true');
  assert.ok(R.validateReport(Object.assign({}, GOOD, { description: 'коротко' })).errors.description);
  assert.ok(R.validateReport(Object.assign({}, GOOD, { description: 'я'.repeat(1001) })).errors.description);
  assert.ok(R.validateReport(Object.assign({}, GOOD, { category: 'hack' })).errors.category);
  assert.ok(R.validateReport(Object.assign({}, GOOD, { matchId: '12ab' })).errors.matchId);
  assert.ok(R.validateReport(Object.assign({}, GOOD, { evidence: ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://a.com/4'] })).errors.evidence);
  assert.ok(R.validateReport(Object.assign({}, GOOD, { evidence: ['https://a.com/virus.exe'] })).errors.evidence);
  assert.ok(R.validateReport(Object.assign({}, GOOD, { evidence: ['http://a.com/x'] })).errors.evidence);
  assert.deepEqual(R.validateReport(Object.assign({}, GOOD, { evidence: ['https://a.com/1', 'https://a.com/1'] })).value.evidence, ['https://a.com/1'], 'дубликаты ссылок убираются');
  assert.equal(R.dupKey('1', '2', '3'), '1|2|3');
});

test('аномалии: мало данных — не считаем', () => {
  const r = R.detectAnomalies(history(10), { now: NOW });
  assert.equal(r.ready, false);
  assert.equal(r.items.filter((i) => i.group === 'anomaly').length, 0);
});

test('аномалии: обычная история без выбросов даёт пустой список', () => {
  const r = R.detectAnomalies(history(40, (i) => ({ d: 4 + (i % 4) })), { now: NOW });
  assert.equal(r.ready, true);
  assert.equal(r.items.filter((i) => i.kind === 'deaths_outlier').length, 0);
});

test('аномалии: выброс по смертям найден, с основанием; нормализация по длительности', () => {
  const l = history(40, (i) => ({ d: 4 + (i % 4) }));
  l[7] = mk(7, { d: 26, k: 0, a: 1 });
  const r = R.detectAnomalies(l, { now: NOW });
  const o = r.items.filter((i) => i.kind === 'deaths_outlier');
  assert.equal(o.length, 1);
  assert.equal(o[0].matchId, l[7].id);
  assert.ok(o[0].facts.length >= 3 && /σ/.test(o[0].facts[2]) && /Не показывает причину/.test(o[0].basis));
  // длинный матч с таким же числом смертей — не выброс
  const l2 = history(40, (i) => ({ d: 4 + (i % 4) })); l2[7] = mk(7, { d: 26, dur: 6000 });
  assert.equal(R.detectAnomalies(l2, { now: NOW }).items.filter((i) => i.kind === 'deaths_outlier').length, 0, 'смерти на 10 минут: в 100-минутном матче это обычный темп');
  // короткие матчи (до 15 мин) в расчёт не идут
  const l3 = history(40, (i) => ({ d: 4 + (i % 4) })); l3[7] = mk(7, { d: 12, dur: 600 });
  assert.equal(R.detectAnomalies(l3, { now: NOW }).items.filter((i) => i.kind === 'deaths_outlier').length, 0);
});

test('аномалии: повторяемость и факты игры', () => {
  const l = history(40, (i) => ({ d: 4 + (i % 4) }));
  [2, 5, 9].forEach((i) => { l[i] = mk(i, { d: 28 }); });
  l[11] = mk(11, { leaver: 3 }); l[12] = mk(12, { leaver: 1 }); l[13] = mk(13, { leaver: 2 });
  const r = R.detectAnomalies(l, { now: NOW });
  assert.equal(r.patterns.length, 1);
  assert.equal(r.items.filter((i) => i.kind === 'leaver' && i.group === 'fact').length, 1, 'только отметки об уходе из матча — факт');
  assert.ok(r.items.some((i) => i.kind === 'leaver' && i.group === 'info'), 'долгое отключение — справочно');
  assert.ok(!r.items.some((i) => i.matchId === l[12].id), 'обычное отключение (1) не упоминается');
});

const rep = (matches, extra) => {
  const an = R.detectAnomalies(matches, { now: NOW });
  return R.computeReputation(Object.assign({ matches, now: NOW, anomalies: an, fetchedAt: NOW }, extra || {}));
};

test('репутация: мало матчей — оценки нет, а не 0', () => {
  const r = rep(history(8));
  assert.equal(r.state, 'insufficient'); assert.equal(r.score, null); assert.equal(r.confidence.level, 'low'); assert.equal(r.risk, null);
});

test('репутация: чистая история — «нет сигналов», уровень уверенности без сервера не выше средней', () => {
  const r = rep(history(80, (i) => ({ d: 4 + (i % 4) })));
  assert.equal(r.state, 'no_signals'); assert.equal(r.score, 0); assert.equal(r.risk, null);
  assert.equal(r.confidence.level, 'medium', 'без данных сообщества');
  assert.ok(r.notes.some((n) => /не означает гарантированно/.test(n)));
});

test('репутация: поражения, низкий KDA и серии не дают баллов', () => {
  const lose = rep(history(60, () => ({ win: false, k: 0, d: 9, a: 1, gpm: 200, xpm: 250 })));
  assert.equal(lose.score, 0);
  assert.equal(lose.state, 'no_signals');
  assert.ok(lose.notCounted.some((x) => /Поражения/.test(x)));
});

test('репутация: устаревшие данные', () => {
  const old = history(40, (i) => ({ start: NOW - 200 * DAY - i * 3600 }));
  assert.equal(rep(old).state, 'stale');
});

test('репутация: жалобы без подтверждения никогда не дают «Высокий» риск, дубли одного автора не растут', () => {
  const m = history(80, (i) => ({ d: 4 + (i % 4) }));
  const many = rep(m, { comm: { available: true, confirmed: [], unconfirmed: { hidden: false, reporters: 1, matches: 30, reports: 30 }, openAppeals: 0 } });
  assert.equal(many.factors.find((f) => f.id === 'reports').points, 2, 'один автор = один независимый источник');
  assert.equal(many.state, 'no_signals', 'один автор не запускает «Требуется проверка»');
  const two = rep(m, { comm: { available: true, confirmed: [], unconfirmed: { hidden: false, reporters: 2, matches: 2, reports: 2 }, openAppeals: 0 } });
  assert.equal(two.state, 'needs_review');
  // максимально неблагоприятная картина без подтверждения
  const l = history(60, (i) => ({ d: 4 + (i % 4), leaver: i % 3 === 0 ? 3 : 0 }));
  [2, 5, 9, 14, 20, 25].forEach((i) => { l[i] = mk(i, { d: 28 }); });
  const worst = rep(l, { comm: { available: true, confirmed: [], unconfirmed: { hidden: false, reporters: 50, matches: 50, reports: 500 }, openAppeals: 0 } });
  assert.ok(worst.score <= 46, 'без подтверждения не больше ' + 46 + ', получилось ' + worst.score);
  assert.notEqual(worst.risk, 'Высокий');
  assert.equal(worst.state, 'needs_review');
});

test('репутация: подтверждённые эпизоды, затухание и пояснение факторов', () => {
  const m = history(80, (i) => ({ d: 4 + (i % 4) }));
  const c = (n, at) => Array.from({ length: n }, (_, i) => ({ matchId: '10' + i + '0000000', category: 'feeding', decidedAt: at }));
  const one = rep(m, { comm: { available: true, confirmed: c(1, NOW - DAY), unconfirmed: { hidden: true }, openAppeals: 0 } });
  assert.equal(one.state, 'confirmed'); assert.equal(one.confirmedCount, 1); assert.equal(one.score, 25); assert.equal(one.risk, 'Умеренный');
  const old = rep(m, { comm: { available: true, confirmed: c(1, NOW - 400 * DAY), unconfirmed: { hidden: true } } });
  assert.equal(old.score, 13, 'после года вес вдвое меньше');
  const three = rep(m, { comm: { available: true, confirmed: c(3, NOW - DAY), unconfirmed: { hidden: true } } });
  assert.equal(three.score, 70); assert.equal(three.risk, 'Высокий');
  const dup = rep(m, { comm: { available: true, confirmed: [].concat(c(1, NOW), c(1, NOW)), unconfirmed: { hidden: true } } });
  assert.equal(dup.confirmedCount, 1, 'один матч = один эпизод');
  assert.ok(one.factors.every((f) => f.label && f.detail && Number.isFinite(f.points)));
  assert.equal(one.factors.reduce((s, f) => s + f.points, 0), one.score, 'вклады факторов в сумме дают оценку');
});

test('репутация: скрытые жалобы объясняются, снятая отметка возвращает состояние', () => {
  const m = history(80, (i) => ({ d: 4 + (i % 4) }));
  const hidden = rep(m, { comm: { available: true, confirmed: [], unconfirmed: { hidden: true } } });
  assert.equal(hidden.hiddenReports, true); assert.equal(hidden.unconfirmedReports, null);
  assert.ok(hidden.notes.some((n) => /минимум два разных автора/.test(n)));
  const withMark = rep(m, { comm: { available: true, confirmed: [{ matchId: '1000000001', decidedAt: NOW }], unconfirmed: { hidden: true } } });
  const revoked = rep(m, { comm: { available: true, confirmed: [], unconfirmed: { hidden: true } } });
  assert.equal(withMark.state, 'confirmed'); assert.equal(revoked.state, 'no_signals', 'после снятия отметки профиль пересчитывается');
});
