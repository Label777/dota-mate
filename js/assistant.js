/*
 * Dota Mate: помощник. Два честно разделённых режима:
 *  - ИИ-чат (только на сервере с ANTHROPIC_API_KEY и после входа через Steam): сообщения уходят на ваш сервер, а он обращается к API Anthropic;
 *  - встроенная справка (везде, в том числе на GitHub Pages): готовые ответы по сайту, без ИИ и без отправки данных.
 * Личные оценки и заметки в чат не передаются.
 */
(function () {
  'use strict';
  var H = null, st = { open: false, mode: 'guide', info: null, msgs: [], busy: false, err: '', guideId: null, draft: '' };

  var GUIDE = [
    ['Как добавить матч?', '**Автоматически:** Настройки → укажи Steam ID → на Главной нажми «Синхронизировать матчи». У тебя в Dota 2 должна быть включена настройка «Открытые данные матчей», иначе список будет пуст.\n\n**Вручную или по ссылке:** раздел Матчи → добавить матч → вставь ссылку OpenDota/Dotabuff или заполни героев и ники.'],
    ['Как открыть профиль игрока?', 'Раздел «Найти профиль» → вставь Steam ID, SteamID64 или ссылку вида steamcommunity.com/profiles/… → «Найти игрока». У каждого профиля есть своя ссылка (`#/profile/ID`), её можно отправить другу. Ссылки вида /id/имя сначала нужно превратить в числовой ID.'],
    ['Как читать репутацию?', 'Репутация не «рейтинг токсичности». Сайт показывает отдельно:\n- **факты игры:** выход из матча, потеря связи;\n- **отклонения от нормы** самого игрока (например, смертей заметно больше обычного);\n- **жалобы** без решения;\n- **решения модераторов.**\n\nСмотри на «Достоверность» и число матчей, затем открывай эпизоды и сам матч. Блок «Почему сформирована эта оценка?» показывает все основания.'],
    ['Что значит «Недостаточно данных»?', 'Загружено меньше 20 матчей, поэтому оценки нет. Это не плохо и не хорошо: просто не на чем строить вывод. Открой «Загрузить более ранние матчи» в профиле.'],
    ['Как подать жалобу?', 'Нужна версия сайта с сервером и вход через Steam. Репутация → Жалобы: игрок, Match ID, категория, описание с минутой матча, ссылки на доказательства (https). Вы оба должны быть участниками матча не старше 60 дней. Жалоба не публична: её проверяет модератор. Лимит: 5 в сутки.\n\nНа GitHub Pages жалобы недоступны.'],
    ['Как оспорить отметку против меня?', 'Репутация → Обжалования. Там видны отметки против тебя и их основание. Нажми «Оспорить», опиши ошибку и приложи ссылки. Пока обращение рассматривается, отметка помечена как «Оспаривается» и в оценку не входит. Решение принимает модератор и пишет обоснование.'],
    ['Что значит оценка игры от −50 до +50?', '0 значит «сыграл как обычно». Плюс лучше, минус хуже. Считается по (K+A)/D, GPM и XPM относительно твоих же средних (на герое, если на нём от 5 матчей). Результат матча не учитывается. Это сравнение с собой, а не с другими игроками.'],
    ['Почему позиция игрока не определена?', 'Точная позиция известна только по матчам, которые OpenDota разобрал. Для остальных сайт оценивает роль по золоту команды и показывает её со знаком «≈». В профиле можно отправить матчи на разбор в OpenDota.'],
    ['Что такое оверлей игроков?', 'Кнопка «Оверлей игроков» на вкладке «Драфт» открывает панель с десятью игроками матча: винрейт, K/D/A, любимые герои, форма и сигналы для проверки. Работает через тот же мост. Игра отдаёт Steam ID только твоего аккаунта (у наблюдателя всех), поэтому остальные карточки пишут «Игрок не идентифицирован», пока ты не укажешь ID вручную. Сигнал это повод посмотреть матчи, а не вывод о нарушении.'],
    ['Как отслеживать драфт в реальном времени?', 'Раздел «Драфт». Сайт сам не получает данные от Dota 2, нужен маленький мост на твоём компьютере: скачай его кнопкой «Подключить Dota 2», запусти `node dota-mate-bridge.js`, положи cfg в папку gamestate_integration, добавь параметр запуска `-gamestateintegration` и открой ссылку из консоли моста. Без игры можно вести драфт вручную или посмотреть «Демо». Подсказки строятся по винрейту героев против выбранных врагов (OpenDota). Блок драфта присылает не каждый режим игры, и с настоящим клиентом это не проверялось.'],
    ['Как работает авто-оценка игрока?', 'Это оценка от 1 до 5 звёзд по игре, а не по характеру. Считается по цифрам матча: GPM, XPM, убийства, добитые крипы, урон и лечение относительно других игроков на этом герое (OpenDota), плюс участие в боях и смерти. Матчи короче 10 минут не считаются, выход из игры сильно снижает оценку. Общение и поведение она не видит. Карточка игрока, в том числе со скрытым профилем, открывается из строки матча. Данные хранятся только в твоём браузере, фоновую догрузку можно выключить в настройках.'],
    ['Что за значок репутации возле ника?', 'Короткая сводка из раздела «Репутация»: «Нет сигналов», «Мало данных», «Проверить», «Подтверждено», «Давно не играл». Считается по открытой истории игрока (OpenDota) и решениям модераторов, в фоне, только для игроков на экране. Это не вывод о нарушении: «Нет сигналов» не гарантия, «Проверить» не приговор. У игроков со скрытым профилем стоит «Профиль скрыт». Выключить и очистить можно в настройках.'],
    ['Как быстро найти игрока или раздел?', 'Нажми Ctrl+K или иконку лупы в шапке: поиск по разделам, действиям, игрокам и матчам. На телефоне нижнее меню показывает четыре раздела, остальные под кнопкой «Ещё».'],
    ['Где хранятся мои данные?', 'На GitHub Pages только в твоём браузере. В версии с сервером данные аккаунта лежат на сервере и привязаны к Steam. Личные оценки и заметки видны только тебе. Публичны лишь решения модераторов и обобщённые счётчики в разделе «Репутация».'],
    ['Чего сайт не умеет?', 'Не определяет намеренное кормление, сломанные предметы и блокировку союзников: OpenDota не отдаёт таких данных, для них есть только жалобы с проверкой модератором. Не называет игрока нарушителем по статистике, не делает выводов о сговоре и не принимает файлы.']
  ];

  function e(s) { return H.esc(s); }
  function md(t) {
    var h = e(t).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
    return h.split(/\n{2,}/).map(function (p) {
      var lines = p.split('\n');
      if (lines.every(function (l) { return /^\s*[-•]\s+/.test(l); })) return '<ul>' + lines.map(function (l) { return '<li>' + l.replace(/^\s*[-•]\s+/, '') + '</li>'; }).join('') + '</ul>';
      var out = '', inList = false;
      lines.forEach(function (l) {
        var li = /^\s*[-•]\s+(.*)/.exec(l);
        if (li) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + li[1] + '</li>'; }
        else { if (inList) { out += '</ul>'; inList = false; } out += (out && !/<\/ul>$/.test(out) ? '<br>' : '') + l; }
      });
      return '<p>' + out + (inList ? '</ul>' : '') + '</p>';
    }).join('');
  }

  function root() { return document.getElementById('as-root'); }
  function modeLabel() { return st.mode === 'ai' ? 'ИИ-помощник' : 'Справочник'; }
  function render() {
    var r = root(); if (!r) return;
    var body = '', foot = '';
    if (st.mode === 'ai' && st.info && st.info.user) {
      body = '<div class="as-msg bot">' + md('Привет! Я помощник Dota Mate. Помогу добавить матч, разобрать игрока, написать заметку или жалобу и понять репутацию. С чего начнём?') + '</div>' +
        st.msgs.map(function (m) { return '<div class="as-msg ' + (m.role === 'user' ? 'me' : 'bot') + '">' + (m.role === 'user' ? '<p>' + e(m.content).replace(/\n/g, '<br>') + '</p>' : md(m.content)) + '</div>'; }).join('') +
        (st.busy ? '<div class="as-msg bot as-typing" role="status" aria-label="Помощник отвечает"><i></i><i></i><i></i></div>' : '') +
        (st.err ? '<div class="as-err" role="alert">' + e(st.err) + '</div>' : '') +
        (!st.msgs.length ? '<div class="as-chips">' + GUIDE.slice(0, 4).map(function (g, i) { return '<button type="button" class="as-chip" data-as="ask" data-i="' + i + '">' + e(g[0]) + '</button>'; }).join('') + '</div>' : '');
      foot = '<form class="as-form" data-as-form="1"><textarea id="as-in" rows="1" maxlength="2000" placeholder="Спроси про матчи, игроков или репутацию" aria-label="Сообщение помощнику">' + e(st.draft) + '</textarea><button class="btn primary sm2" type="submit"' + (st.busy ? ' disabled' : '') + '>Отправить</button></form>' +
        '<p class="as-note">Сообщения отправляются на сервер Dota Mate и в ИИ-сервис Anthropic. Не пиши пароли и личные данные. Личные оценки и заметки в чат не передаются.' + (st.msgs.length ? ' <button type="button" class="as-link" data-as="clear">Очистить диалог</button>' : '') + '</p>';
    } else {
      var g = st.guideId != null ? GUIDE[st.guideId] : null;
      if (g) body = '<button type="button" class="as-back" data-as="back">← Все вопросы</button><h3 class="as-q">' + e(g[0]) + '</h3><div class="as-a">' + md(g[1]) + '</div>';
      else body = '<p class="as-lead">Быстрые ответы по сайту. Это встроенная справка, не ИИ: она ничего не отправляет и работает без сервера.</p><div class="as-list">' +
        GUIDE.map(function (x, i) { return '<button type="button" class="as-item" data-as="open" data-i="' + i + '">' + e(x[0]) + '</button>'; }).join('') + '</div>' + aiHint();
    }
    r.querySelector('.as-body').innerHTML = body;
    r.querySelector('.as-foot').innerHTML = foot;
    r.querySelector('.as-mode').textContent = modeLabel();
    var b = r.querySelector('.as-body'); b.scrollTop = st.mode === 'ai' && st.info && st.info.user ? b.scrollHeight : 0;
  }
  function aiHint() {
    var i = st.info;
    if (!i) return '';
    if (!i.available) return '<p class="as-note">ИИ-чат выключен: на этом сервере не задан ключ API. Администратор включает его переменной ANTHROPIC_API_KEY.</p>';
    if (!i.user) return '<div class="as-login"><p>Чтобы пользоваться ИИ-чатом, войди через Steam.</p><a class="btn primary sm2" href="/auth/steam">Войти через Steam</a></div>';
    return '';
  }

  function shell() {
    if (root()) return;
    var d = document.createElement('div'); d.id = 'as-root';
    d.innerHTML = '<button type="button" class="as-fab" data-as="toggle" aria-expanded="false" aria-controls="as-panel" aria-label="Помощник" data-tip="Помощник: ответы про сайт, матчи, игроков и репутацию">' + H.ico('rune') + '<span>Помощник</span></button>' +
      '<section id="as-panel" class="as-panel" role="dialog" aria-label="Помощник Dota Mate" hidden><header class="as-head"><div><b>Помощник</b><span class="as-mode"></span></div><button type="button" class="iconbtn" data-as="toggle" aria-label="Закрыть помощника">' + H.ico('x') + '</button></header><div class="as-body"></div><div class="as-foot"></div></section>';
    document.body.appendChild(d);
  }
  function setOpen(v) {
    st.open = v; var r = root(); if (!r) return;
    var p = r.querySelector('.as-panel'), f = r.querySelector('.as-fab');
    p.hidden = !v; f.setAttribute('aria-expanded', String(v)); f.classList.toggle('on', v);
    if (v) { refresh().then(function () { var i = document.getElementById('as-in'); if (i) i.focus(); }); }
    else f.focus();
  }
  function refresh() {
    var base = H.server() ? fetch('/api/assistant/status', { headers: { 'X-DM': '1' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).catch(function () { return { available: false }; }) : Promise.resolve({ available: false });
    return base.then(function (j) {
      var user = H.server() && H.loggedIn();
      st.info = { available: !!j.available, user: !!user };
      st.mode = j.available && user ? 'ai' : 'guide';
      render();
    });
  }
  function send(text) {
    text = String(text || '').trim();
    if (!text || st.busy) return;
    st.msgs.push({ role: 'user', content: text }); st.draft = ''; st.busy = true; st.err = ''; render();
    fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DM': '1' }, credentials: 'same-origin', body: JSON.stringify({ page: H.page(), messages: st.msgs.slice(-12) }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j, status: r.status }; }); })
      .then(function (x) {
        st.busy = false;
        if (x.ok && x.j.reply) st.msgs.push({ role: 'assistant', content: x.j.reply });
        else { st.err = x.j.message || (x.status === 401 ? 'Войдите через Steam.' : 'Не удалось получить ответ. Повторите позже.'); st.msgs.pop(); st.draft = text; }
        render();
      }, function () { st.busy = false; st.err = 'Нет связи с сервером. Повторите позже.'; st.msgs.pop(); st.draft = text; render(); });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('#as-root [data-as]'); if (!t) return;
    var a = t.dataset.as;
    if (a === 'toggle') setOpen(!st.open);
    else if (a === 'open') { st.guideId = Number(t.dataset.i); render(); }
    else if (a === 'back') { st.guideId = null; render(); }
    else if (a === 'ask') send(GUIDE[Number(t.dataset.i)][0]);
    else if (a === 'clear') { st.msgs = []; st.err = ''; render(); }
  });
  document.addEventListener('submit', function (ev) {
    if (!ev.target.dataset || !ev.target.dataset.asForm) return;
    ev.preventDefault(); send(document.getElementById('as-in').value);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && st.open) setOpen(false);
    else if (ev.key === 'Enter' && !ev.shiftKey && ev.target && ev.target.id === 'as-in') { ev.preventDefault(); send(ev.target.value); }
  });
  document.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'as-in') st.draft = ev.target.value; });

  window.DMAssist = {
    init: function (host) { H = host; shell(); },
    open: function () { setOpen(true); },
    _state: st
  };
})();
