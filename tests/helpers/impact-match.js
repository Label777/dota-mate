/* Фабрика записей матчей для тестов MVP / худшего игрока. Формат записи: DMPerf.fromDetail. */
'use strict';

/* бенчмарки в формате DMPerf.benchFrom: [[процентиль, значение]…] */
const T = (a, b, c) => [[0.1, a], [0.5, b], [0.9, c]];
const BENCH = {
  1: { gold_per_min: T(350, 500, 700), xp_per_min: T(400, 560, 760), hero_damage_per_min: T(400, 700, 1100), kills_per_min: T(0.1, 0.25, 0.5) },   // керри
  2: { gold_per_min: T(380, 520, 720), xp_per_min: T(450, 600, 800), hero_damage_per_min: T(450, 750, 1200), kills_per_min: T(0.1, 0.3, 0.55) },    // мид
  3: { gold_per_min: T(300, 420, 580), xp_per_min: T(380, 520, 700), hero_damage_per_min: T(300, 520, 850), kills_per_min: T(0.05, 0.2, 0.4) },     // оффлейн
  5: { gold_per_min: T(200, 300, 420), xp_per_min: T(300, 420, 560), hero_damage_per_min: T(150, 300, 550), kills_per_min: T(0.02, 0.1, 0.25), hero_healing_per_min: T(20, 80, 250) }, // саппорт
  6: { gold_per_min: T(210, 310, 430), xp_per_min: T(310, 430, 570), hero_damage_per_min: T(160, 320, 560), kills_per_min: T(0.02, 0.1, 0.25) }    // саппорт без лечения
};
const HEROES = [1, 2, 3, 6, 5, 1, 2, 3, 6, 5];   // индексы 0-4 Radiant, 5-9 Dire; 4 и 9 — саппорты с лечением

/* средний игрок: цифры равны медиане бенчмарков СВОЕГО героя (процентиль 0.5), убийства/смерти типичные для роли */
function base(i) {
  const h = HEROES[i], sup = h === 5 || h === 6, b = BENCH[h], med = (k) => b[k][1][1];
  return {
    h, r: i < 5 ? 1 : 0, a: String(1000 + i), k: sup ? 2 : 6, d: 5, s: sup ? 10 : 6,
    g: med('gold_per_min'), x: med('xp_per_min'), hd: med('hero_damage_per_min') * 30, hh: h === 5 ? med('hero_healing_per_min') * 30 : 0,
    lh: sup ? 40 : 220, td: sup ? 500 : 1500, lv: 0, st: null, ob: null, se: null
  };
}

/** over: {индекс: {поле: значение}}, extra: поля записи (dur, rw). Матч 30 минут, победа Radiant по умолчанию. */
function match(over, extra) {
  const rec = Object.assign({ v: 1, id: '8000000001', dur: 1800, mr: 1, rw: 1, p: [] }, extra || {});
  for (let i = 0; i < 10; i++) rec.p.push(Object.assign(base(i), (over && over[i]) || {}));
  return rec;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

module.exports = { BENCH, HEROES, base, match, clone };
