/* Dota Mate: личные теги, винрейт с игроками, рекомендации для пати, поиск по заметкам,
   заметки по героям, экспорт и импорт. Чистая логика без DOM: работает в браузере и в Node (тесты). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMSocial = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- теги ---------- */
  const PRESETS = [
    { id: 'good', label: 'Хороший тиммейт', tone: 'pos' },
    { id: 'support', label: 'Хороший саппорт', tone: 'pos' },
    { id: 'party', label: 'Можно в пати', tone: 'pos' },
    { id: 'core', label: 'Кор', tone: 'neu' },
    { id: 'smurf', label: 'Смурф', tone: 'warn' },
    { id: 'toxic', label: 'Токсик', tone: 'neg' },
    { id: 'avoid', label: 'Избегать', tone: 'neg' }
  ];
  const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
  const MAX_TAGS = 12, MAX_CUSTOM = 24, MAX_NOTE = 600, MAX_PNOTE = 4000, MAX_HERO = 40;
  const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const SAFE = (k) => typeof k === 'string' && k.length > 0 && k.length <= 160 && !BAD_KEYS.has(k);

  function cleanText(s, max) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  /* Строка пользователя -> идентификатор тега (готовый или «c:название»). null, если пусто. */
  function tagKey(input) {
    const s = String(input == null ? '' : input);
    if (PRESET_BY_ID[s]) return s;
    if (s.startsWith('c:')) { const t = cleanText(s.slice(2), MAX_CUSTOM); return t ? 'c:' + t : null; }
    const t = cleanText(s, MAX_CUSTOM);
    if (!t) return null;
    const low = t.toLowerCase();
    const pre = PRESETS.find((p) => p.label.toLowerCase() === low);
    return pre ? pre.id : 'c:' + t;
  }
  const isTagId = (id) => typeof id === 'string' && (!!PRESET_BY_ID[id] || (id.startsWith('c:') && id.length > 2 && id.length <= 2 + MAX_CUSTOM));
  const tagLabel = (id) => (PRESET_BY_ID[id] ? PRESET_BY_ID[id].label : String(id).replace(/^c:/, ''));
  const tagTone = (id) => (PRESET_BY_ID[id] ? PRESET_BY_ID[id].tone : 'neu');

  function ensure(S) {
    if (!S.tags || typeof S.tags !== 'object') S.tags = {};
    if (!S.heroNotes || typeof S.heroNotes !== 'object') S.heroNotes = {};
    if (!S.snooze || typeof S.snooze !== 'object') S.snooze = {};
    if (!S.pnotes || typeof S.pnotes !== 'object') S.pnotes = {};
    if (!S.reviews || typeof S.reviews !== 'object') S.reviews = {};
    return S;
  }
  const tagsOf = (S, sid) => (S.tags && Array.isArray(S.tags[sid]) ? S.tags[sid].filter(isTagId) : []);
  const hasTag = (S, sid, id) => tagsOf(S, sid).includes(id);

  /* Свой тег без учёта регистра: если такой уже есть у кого-то из игроков, берём прежнее написание. */
  function canonTag(S, id) {
    if (typeof id !== 'string' || !id.startsWith('c:')) return id;
    const low = id.toLowerCase();
    for (const sid of Object.keys(S.tags || {})) for (const x of tagsOf(S, sid)) if (x.toLowerCase() === low) return x;
    return id;
  }

  /* Включить или выключить тег. Возвращает true, если что-то изменилось. */
  function setTag(S, sid, id, on) {
    ensure(S);
    if (!SAFE(sid) || !isTagId(id)) return false;
    id = canonTag(S, id);
    const cur = tagsOf(S, sid), has = cur.includes(id);
    if (on && !has) {
      if (cur.length >= MAX_TAGS) return false;
      S.tags[sid] = cur.concat(id);
      return true;
    }
    if (!on && has) {
      const next = cur.filter((x) => x !== id);
      if (next.length) S.tags[sid] = next; else delete S.tags[sid];
      return true;
    }
    return false;
  }
  function toggleTag(S, sid, id) { return setTag(S, sid, id, !hasTag(S, sid, id)); }
  const playersWithTag = (S, id) => Object.keys(S.tags || {}).filter((sid) => hasTag(S, sid, id));
  function customTags(S) {
    const seen = new Map();
    for (const sid of Object.keys(S.tags || {})) for (const id of tagsOf(S, sid)) if (id.startsWith('c:')) seen.set(id.toLowerCase(), id);
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'ru'));
  }
  function removePlayerData(S, sid) {
    ensure(S);
    Object.keys(S.reviews).forEach((k) => { if (k.endsWith('|' + sid)) delete S.reviews[k]; });
    delete S.pnotes[sid]; delete S.tags[sid]; delete S.heroNotes[sid]; delete S.snooze[sid];
  }

  /* ---------- индекс знакомых и личный винрейт ---------- */
  function index(S) {
    const map = Object.create(null);
    for (const m of S.matches || []) for (const p of m.players || []) {
      if (p.me || !p.sid) continue;
      const e = map[p.sid] || (map[p.sid] = { sid: p.sid, name: p.name, last: 0, list: [] });
      e.list.push({ m, p, role: p.ally ? 'ally' : 'enemy' });
      if (m.start >= e.last) { e.last = m.start; e.name = p.name; }
    }
    for (const e of Object.values(map)) {
      e.list.sort((a, b) => b.m.start - a.m.start);
      e.count = e.list.length;
      e.withN = e.list.filter((x) => x.role === 'ally').length;
      e.vsN = e.count - e.withN;
      const rs = e.list.map((x) => (S.reviews || {})[x.m.id + '|' + e.sid]).filter((r) => r && r.rating);
      e.rated = rs.length;
      e.avg = rs.length ? rs.reduce((a, r) => a + r.rating, 0) / rs.length : null;
    }
    return map;
  }

  /* Ваши победы и поражения в матчах с игроком: «с ним 7–2», «против него 1–4». */
  function recordOf(e) {
    const mk = () => ({ w: 0, l: 0, n: 0, rate: null });
    const r = { with: mk(), vs: mk() };
    for (const x of e.list) {
      const t = x.role === 'ally' ? r.with : r.vs;
      t.n++;
      if (x.m.win) t.w++; else t.l++;
    }
    for (const t of [r.with, r.vs]) t.rate = t.n ? t.w / t.n : null;
    return r;
  }
  const record = (S, sid) => { const e = index(S)[sid]; return e ? recordOf(e) : null; };

  /* ---------- рекомендации для пати ---------- */
  /* Оценка = половина сглаженного винрейта (w+1)/(n+2) + половина вашей средней оценки.
     Нет оценок: вместо неё нейтральные 0.5, поэтому неоценённые игроки не получают бонус.
     Игроки с тегами «Токсик» и «Избегать» не попадают в список. */
  function recommend(S, opt) {
    const min = (opt && opt.min) || 2, limit = (opt && opt.limit) || 5;
    const out = [];
    for (const e of Object.values(index(S))) {
      const r = recordOf(e);
      if (r.with.n < min) continue;
      if (hasTag(S, e.sid, 'avoid') || hasTag(S, e.sid, 'toxic')) continue;
      const sm = (r.with.w + 1) / (r.with.n + 2);
      const rt = e.avg != null ? (e.avg - 1) / 4 : 0.5;
      out.push({ sid: e.sid, name: e.name, n: r.with.n, w: r.with.w, l: r.with.l, rate: r.with.rate, avg: e.avg, rated: e.rated, last: e.last, score: 0.5 * sm + 0.5 * rt, tags: tagsOf(S, e.sid) });
    }
    out.sort((a, b) => b.score - a.score || b.n - a.n || b.last - a.last);
    return out.slice(0, limit);
  }

  /* ---------- без оценки ---------- */
  function unrated(S, opt) {
    const role = opt && opt.role;
    let l = Object.values(index(S)).filter((e) => e.rated === 0);
    if (role === 'ally') l = l.filter((e) => e.withN > 0);
    else if (role === 'enemy') l = l.filter((e) => e.vsN > 0);
    return l.sort((a, b) => b.last - a.last);
  }
  function unratedInMatch(S, m) {
    return (m.players || []).filter((p) => !p.me && p.sid && !((S.reviews || {})[m.id + '|' + p.sid] || {}).rating);
  }

  /* ---------- заметки по героям ---------- */
  function setHeroNote(S, sid, hero, text) {
    ensure(S);
    const h = cleanText(hero, MAX_HERO), t = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NOTE);
    if (!SAFE(sid) || !h || BAD_KEYS.has(h)) return false;
    if (!t) {
      if (S.heroNotes[sid]) { delete S.heroNotes[sid][h]; if (!Object.keys(S.heroNotes[sid]).length) delete S.heroNotes[sid]; }
      return true;
    }
    const cur = S.heroNotes[sid] || (S.heroNotes[sid] = {});
    if (!(h in cur) && Object.keys(cur).length >= 60) return false;
    cur[h] = t;
    return true;
  }
  const getHeroNote = (S, sid, hero) => ((S.heroNotes || {})[sid] || {})[hero] || '';
  const heroNotesOf = (S, sid) => Object.entries((S.heroNotes || {})[sid] || {}).map(([hero, text]) => ({ hero, text })).sort((a, b) => a.hero.localeCompare(b.hero, 'ru'));

  /* ---------- поиск по тексту заметок ---------- */
  function snippet(text, q) {
    const t = String(text), i = t.toLowerCase().indexOf(q);
    if (i < 0) return t.slice(0, 80);
    const a = Math.max(0, i - 30), b = Math.min(t.length, i + q.length + 50);
    return (a > 0 ? '…' : '') + t.slice(a, b) + (b < t.length ? '…' : '');
  }
  /* Ищет по личным заметкам, заметкам о героях и тегам. Результат: { sid: [{kind, text, mid?, hero?}] }. */
  function searchNotes(S, query) {
    const q = cleanText(query, 80).toLowerCase();
    const hits = Object.create(null);
    if (q.length < 2) return hits;
    const add = (sid, h) => { (hits[sid] || (hits[sid] = [])).push(h); };
    for (const [k, r] of Object.entries(S.reviews || {})) {
      if (!r || !r.note || !r.note.toLowerCase().includes(q)) continue;
      const i = k.indexOf('|');
      add(k.slice(i + 1), { kind: 'review', text: snippet(r.note, q), mid: k.slice(0, i) });
    }
    for (const [sid, t] of Object.entries(S.pnotes || {})) if (t && String(t).toLowerCase().includes(q)) add(sid, { kind: 'player', text: snippet(t, q) });
    for (const [sid, hs] of Object.entries(S.heroNotes || {})) for (const [hero, t] of Object.entries(hs || {})) {
      if (hero.toLowerCase().includes(q) || String(t).toLowerCase().includes(q)) add(sid, { kind: 'hero', hero, text: snippet(t, q) });
    }
    for (const sid of Object.keys(S.tags || {})) for (const id of tagsOf(S, sid)) if (tagLabel(id).toLowerCase().includes(q)) add(sid, { kind: 'tag', text: tagLabel(id) });
    return hits;
  }

  /* ---------- фильтры списка игроков ---------- */
  /* f: { tag: '' | id | 'none', rated: 'all'|'yes'|'no', rmin, rmax } (оценка по вашей средней). */
  function applyFilters(S, list, f) {
    f = f || {};
    const rmin = f.rmin ? Number(f.rmin) : 0, rmax = f.rmax ? Number(f.rmax) : 0;
    return list.filter((e) => {
      if (f.tag === 'none') { if (tagsOf(S, e.sid).length) return false; }
      else if (f.tag && !hasTag(S, e.sid, f.tag)) return false;
      if (f.rated === 'yes' && e.avg == null) return false;
      if (f.rated === 'no' && e.avg != null) return false;
      if (rmin || rmax) {
        if (e.avg == null) return false;
        if (rmin && e.avg < rmin - 1e-9) return false;
        if (rmax && e.avg > rmax + 1e-9) return false;
      }
      return true;
    });
  }

  /* ---------- статистика ---------- */
  function stats(S) {
    const all = Object.values(index(S)), top = (arr, n) => arr.slice(0, n || 5);
    const byCount = (key) => all.filter((e) => e[key] > 0).sort((a, b) => b[key] - a[key] || b.last - a.last);
    const rated = all.filter((e) => e.avg != null);
    const high = rated.filter((e) => e.avg >= 4).sort((a, b) => b.avg - a.avg || b.rated - a.rated);
    const low = rated.filter((e) => e.avg <= 2.5).sort((a, b) => a.avg - b.avg || b.rated - a.rated);
    /* Матчи, где среди союзников были только высоко (4–5) или только низко (1–2) оценённые. */
    const hi = { w: 0, l: 0, n: 0 }, lo = { w: 0, l: 0, n: 0 };
    for (const m of S.matches || []) {
      let h = false, l = false;
      for (const p of m.players || []) {
        if (!p.ally || p.me || !p.sid) continue;
        const r = (S.reviews || {})[m.id + '|' + p.sid];
        if (r && r.rating >= 4) h = true;
        if (r && r.rating && r.rating <= 2) l = true;
      }
      const b = h && !l ? hi : l && !h ? lo : null;
      if (b) { b.n++; if (m.win) b.w++; else b.l++; }
    }
    return { mostWith: top(byCount('withN')), mostVs: top(byCount('vsN')), high: top(high), low: top(low), winByRating: { high: hi, low: lo }, players: all.length };
  }

  /* ---------- напоминания ---------- */
  const DAY = 86400;
  function reminders(S, opt) {
    const now = (opt && opt.now) || Math.floor(Date.now() / 1000), days = (opt && opt.days) || 14, limit = (opt && opt.limit) || 3;
    if (S.settings && S.settings.remind === false) return [];
    const out = [];
    for (const e of Object.values(index(S))) {
      if (e.withN < 2) continue;
      if (hasTag(S, e.sid, 'avoid') || hasTag(S, e.sid, 'toxic')) continue;
      const liked = (e.avg != null && e.avg >= 4) || hasTag(S, e.sid, 'good') || hasTag(S, e.sid, 'support') || hasTag(S, e.sid, 'party');
      if (!liked || now - e.last < days * DAY) continue;
      if ((S.snooze || {})[e.sid] > now) continue;
      out.push({ sid: e.sid, name: e.name, last: e.last, withN: e.withN, avg: e.avg, tags: tagsOf(S, e.sid) });
    }
    return out.sort((a, b) => a.last - b.last).slice(0, limit);
  }
  function snooze(S, sid, now, days) {
    ensure(S);
    if (!SAFE(sid)) return false;
    S.snooze[sid] = (now || Math.floor(Date.now() / 1000)) + (days || 14) * DAY;
    return true;
  }

  /* ---------- экспорт и импорт ---------- */
  const MAX_MATCHES = 5000, MAX_FILE = 8 * 1024 * 1024;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const int = (v, d) => (Number.isFinite(v) ? Math.trunc(v) : d);

  function cleanPlayer(p) {
    if (!p || typeof p !== 'object') return null;
    return { sid: p.sid == null ? null : str(String(p.sid), 64) || null, name: str(p.name, 64) || 'Игрок', hero: str(p.hero, 64) || '—', ally: !!p.ally, me: !!p.me };
  }
  function cleanMatch(m) {
    if (!m || typeof m !== 'object') return null;
    const id = str(String(m.id == null ? '' : m.id), 64);
    const players = Array.isArray(m.players) ? m.players.slice(0, 12).map(cleanPlayer).filter(Boolean) : [];
    if (!id || !SAFE(id) || !players.length) return null;
    return { id, start: Math.max(0, int(m.start, 0)), mode: str(m.mode, 40) || '—', ranked: !!m.ranked, win: !!m.win, dur: Math.max(0, int(m.dur, 0)), hero: str(m.hero, 64) || '—', players };
  }
  function cleanReview(r) {
    if (!r || typeof r !== 'object') return null;
    const rating = Math.min(5, Math.max(0, int(r.rating, 0)));
    const cats = {};
    for (const c of ['team', 'comm', 'beh', 'help']) { const v = int(r.cats && r.cats[c], 0); if (v >= 1 && v <= 5) cats[c] = v; }
    const note = cleanText(r.note, MAX_NOTE);
    if (!rating && !note && !Object.keys(cats).length) return null;
    return { rating, cats, note, ts: Math.max(0, int(r.ts, 0)) };
  }

  /* Приводит произвольный объект к безопасному состоянию Dota Mate. Лишние поля отбрасываются. */
  function sanitizeState(d) {
    const out = { v: 1, me: { acc: '', name: 'Вы' }, matches: [], reviews: {}, pnotes: {}, tags: {}, heroNotes: {}, snooze: {}, avatars: {}, settings: { avatars: true }, demo: false, lastSync: null };
    if (d.me && typeof d.me === 'object') {
      if (/^\d{1,12}$/.test(String(d.me.acc || ''))) out.me.acc = String(d.me.acc);
      out.me.name = cleanText(d.me.name, 40) || 'Вы';
    }
    const seen = new Set();
    for (const m of Array.isArray(d.matches) ? d.matches : []) {
      const c = cleanMatch(m);
      if (c && !seen.has(c.id)) { seen.add(c.id); out.matches.push(c); }
      if (out.matches.length >= MAX_MATCHES) break;
    }
    if (d.reviews && typeof d.reviews === 'object') for (const [k, r] of Object.entries(d.reviews)) {
      if (!SAFE(k) || !k.includes('|')) continue;
      const c = cleanReview(r); if (c) out.reviews[k] = c;
    }
    if (d.pnotes && typeof d.pnotes === 'object') for (const [k, t] of Object.entries(d.pnotes)) {
      if (!SAFE(k) || typeof t !== 'string') continue;
      const v = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_PNOTE);
      if (v.trim()) out.pnotes[k] = v;
    }
    if (d.tags && typeof d.tags === 'object') for (const [k, arr] of Object.entries(d.tags)) {
      if (!SAFE(k) || !Array.isArray(arr)) continue;
      const ids = [...new Set(arr.map((x) => (typeof x === 'string' ? tagKey(x) : null)).filter(Boolean))].slice(0, MAX_TAGS);
      if (ids.length) out.tags[k] = ids;
    }
    if (d.heroNotes && typeof d.heroNotes === 'object') for (const [k, hs] of Object.entries(d.heroNotes)) {
      if (!SAFE(k) || !hs || typeof hs !== 'object') continue;
      const cur = {};
      for (const [h, t] of Object.entries(hs)) {
        const hh = cleanText(h, MAX_HERO), tt = typeof t === 'string' ? t.trim().slice(0, MAX_NOTE) : '';
        if (hh && !BAD_KEYS.has(hh) && tt && Object.keys(cur).length < 60) cur[hh] = tt;
      }
      if (Object.keys(cur).length) out.heroNotes[k] = cur;
    }
    if (d.snooze && typeof d.snooze === 'object') for (const [k, t] of Object.entries(d.snooze)) if (SAFE(k) && Number.isFinite(t)) out.snooze[k] = Math.trunc(t);
    if (d.settings && typeof d.settings === 'object') {
      if (typeof d.settings.avatars === 'boolean') out.settings.avatars = d.settings.avatars;
      if (typeof d.settings.remind === 'boolean') out.settings.remind = d.settings.remind;
    }
    out.lastSync = Number.isFinite(d.lastSync) ? Math.trunc(d.lastSync) : null;
    return out;
  }

  function exportData(S, now) {
    const copy = JSON.parse(JSON.stringify(S));
    delete copy.avatars; copy.demo = false;
    return { app: 'dota-mate', format: 1, exportedAt: new Date((now || Date.now())).toISOString(), data: copy };
  }
  /* Принимает файл экспорта или «сырую» копию из настроек. Бросает понятную ошибку. */
  function parseImport(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Файл пустой.');
    if (text.length > MAX_FILE) throw new Error('Файл слишком большой для импорта (больше 8 МБ).');
    let j; try { j = JSON.parse(text); } catch (e) { throw new Error('Это не JSON. Выберите файл, который вы скачали из Dota Mate.'); }
    const d = j && j.app === 'dota-mate' && j.data ? j.data : j;
    if (!d || typeof d !== 'object' || d.v !== 1 || !Array.isArray(d.matches)) throw new Error('Это не резервная копия Dota Mate.');
    const data = sanitizeState(d);
    if (!data.matches.length && !Object.keys(data.reviews).length && !Object.keys(data.pnotes).length && !Object.keys(data.tags).length) throw new Error('В файле нет ни матчей, ни оценок, ни заметок.');
    return data;
  }
  function summary(d) {
    return { matches: d.matches.length, reviews: Object.keys(d.reviews).length, pnotes: Object.keys(d.pnotes).length, tagged: Object.keys(d.tags).length, heroNotes: Object.values(d.heroNotes).reduce((a, h) => a + Object.keys(h).length, 0) };
  }
  function keepMe(cur, imp) { return cur && cur.acc ? { acc: cur.acc, name: cur.name || imp.name } : imp; }

  /* Добавить импортированное к текущим данным. Ваши данные не перезаписываются, кроме более новых оценок. */
  function mergeImport(S, data) {
    const base = S.demo ? sanitizeState({ v: 1, me: S.me, matches: [], settings: S.settings }) : sanitizeState(S);
    const rep = { matches: 0, reviews: 0, updated: 0, pnotes: 0, tags: 0, heroNotes: 0 };
    const ids = new Set(base.matches.map((m) => m.id));
    for (const m of data.matches) if (!ids.has(m.id)) { if (base.matches.length >= MAX_MATCHES) throw new Error('Слишком много матчей: сервер хранит не больше ' + MAX_MATCHES + '.'); base.matches.push(m); ids.add(m.id); rep.matches++; }
    for (const [k, r] of Object.entries(data.reviews)) {
      const c = base.reviews[k];
      if (!c) { base.reviews[k] = r; rep.reviews++; }
      else if (r.ts > c.ts) { base.reviews[k] = r; rep.updated++; }
    }
    for (const [k, t] of Object.entries(data.pnotes)) if (!base.pnotes[k]) { base.pnotes[k] = t; rep.pnotes++; }
    for (const [k, ids2] of Object.entries(data.tags)) {
      const cur = base.tags[k] || [], add = ids2.filter((x) => !cur.includes(x));
      if (add.length) { base.tags[k] = cur.concat(add).slice(0, MAX_TAGS); rep.tags += add.length; }
    }
    for (const [k, hs] of Object.entries(data.heroNotes)) for (const [h, t] of Object.entries(hs)) {
      const cur = base.heroNotes[k] || (base.heroNotes[k] = {});
      if (!(h in cur)) { cur[h] = t; rep.heroNotes++; }
    }
    for (const [k, t] of Object.entries(data.snooze)) if (!(k in base.snooze)) base.snooze[k] = t;
    base.avatars = (S.avatars && typeof S.avatars === 'object') ? S.avatars : {};
    base.me = keepMe(S.me, data.me);
    base.settings = Object.assign({}, data.settings, base.settings);
    base.lastSync = Math.max(base.lastSync || 0, data.lastSync || 0) || null;
    return { state: base, report: rep };
  }
  /* Заменить всё содержимое. Ваш Steam ID сохраняется, если он уже указан. */
  function replaceWith(S, data) {
    const out = sanitizeState(data);
    out.me = keepMe(S.me, data.me);
    return out;
  }

  return {
    PRESETS, MAX_TAGS, MAX_CUSTOM, MAX_NOTE,
    tagKey, tagLabel, tagTone, isTagId, canonTag, ensure, tagsOf, hasTag, setTag, toggleTag, playersWithTag, customTags, removePlayerData,
    index, recordOf, record, recommend, unrated, unratedInMatch,
    setHeroNote, getHeroNote, heroNotesOf, searchNotes, applyFilters, stats, reminders, snooze,
    exportData, parseImport, summary, mergeImport, replaceWith, sanitizeState
  };
});
