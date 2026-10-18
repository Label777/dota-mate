'use strict';
/*
 * Ассистент Dota Mate: тонкая прослойка к API Anthropic (Messages API).
 * Ключ хранится только на сервере (ANTHROPIC_API_KEY) и в браузер не попадает.
 * Системный промпт лежит в server/assistant-prompt.txt. История диалога приходит от клиента и проходит проверку:
 * длина, число сообщений, чередование ролей. Личные оценки и заметки пользователя на сервер ассистента автоматически не отправляются.
 */
const MAX_MSGS = 12, MAX_LEN = 2000;
const PAGES = { dash: 'Главная', matches: 'Матчи', players: 'Игроки', player: 'Карточка игрока', me: 'Профиль', rep: 'Репутация', settings: 'Настройки' };

/** Оставляет последние сообщения, чистит текст, приводит к виду «user, assistant, user…». Возвращает null, если нечего отправлять. */
function sanitize(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const m of list.slice(-MAX_MSGS * 2)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const text = m.content.replace(/\u0000/g, '').trim().slice(0, MAX_LEN);
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n' + text; else out.push({ role: m.role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  const res = out.slice(-MAX_MSGS);
  while (res.length && res[0].role !== 'user') res.shift();
  if (!res.length || res[res.length - 1].role !== 'user') return null;
  return res;
}

function create(o) {
  const f = o.fetch || fetch;
  const enabled = !!(o.key && o.prompt);
  async function ask(messages, ctx) {
    ctx = ctx || {};
    const page = PAGES[ctx.page] ? PAGES[ctx.page] : null;
    const system = o.prompt + '\n\n### Контекст сеанса\nРежим сайта: версия с сервером, пользователь вошёл через Steam.' + (page ? '\nСейчас открыт раздел: ' + page + '.' : '');
    const r = await f(o.base + '/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(o.timeout || 30000),
      headers: { 'content-type': 'application/json', 'x-api-key': o.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: o.model, max_tokens: 700, system: system, messages: messages })
    });
    if (!r.ok) throw Object.assign(new Error('upstream ' + r.status), { code: r.status === 429 ? 'rate' : 'upstream' });
    const j = await r.json();
    const text = (j.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw Object.assign(new Error('empty'), { code: 'upstream' });
    return text;
  }
  return { enabled, ask };
}
module.exports = { create, sanitize, MAX_MSGS, MAX_LEN };
