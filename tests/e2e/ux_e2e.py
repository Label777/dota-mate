"""Браузерная проверка UX-аудита: навигация есть на любой ширине (в том числе 760–820 px, iPad вертикально), подписи разделов
на широком экране, первый экран без аккаунта (подключение Steam ID и сразу загрузка матчей), фильтры матчей в одну строку,
честно отключённая форма жалобы без сервера, строки MVP в карточке игрока, нейтральные метки вместо красных, иконка и превью ссылки.
Запуск: python3 tests/e2e/ux_e2e.py  (нужны playwright для Python и Node 18+)."""
import os
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'impact_e2e.py'), encoding='utf-8').read().split("with sync_playwright() as p:")[0]
exec(src)
import time
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VIS = "(s)=>{const e=document.querySelector(s);if(!e)return false;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'}"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])

    # ---------- навигация на любой ширине ----------
    for w in (700, 760, 790, 820, 1000, 1080, 1280):
        c, pg, errs = setup(b, w=w, S=state(), init=INIT); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow')
        top, bottom = pg.evaluate(VIS, '.top .tabs'), pg.evaluate(VIS, '#nav')
        check(f'{w}px: есть навигация по разделам', top or bottom, (top, bottom))
        if w >= 760:
            check(f'{w}px: верхние вкладки видны и помещаются', top and overflow(pg) <= 0 and pg.evaluate("document.querySelector('.top-in').getBoundingClientRect().height") < 70, overflow(pg))
        lab = pg.evaluate("getComputedStyle(document.querySelector('.top .tabs .tab span')).display") != 'none'
        if w >= 1080: check(f'{w}px: у разделов есть подписи, а не только значки', lab)
        elif w >= 760: check(f'{w}px: узкий экран: только значки, у каждого подпись для экранного диктора', not lab and pg.evaluate("[...document.querySelectorAll('.top .tabs .tab')].every(t=>t.getAttribute('aria-label'))"))
        if w == 790:
            pg.click('.top .tabs [data-p=players]'); pg.wait_for_selector('#plist')
            check('790px: переход в «Игроки» через верхние вкладки', pg.get_attribute('.top .tabs [aria-current=page]', 'data-p') == 'players')
        c.close()

    # ---------- первый экран без аккаунта ----------
    c, pg, errs = setup(b, w=1280); pg.goto(URL); pg.wait_for_selector('.ob')
    check('новый пользователь видит, что делает сайт, и подключение аккаунта', 'Подключите аккаунт Dota 2' in pg.inner_text('.ob') and 'OpenDota' in pg.inner_text('.ob-lead'))
    check('без аккаунта в шапке нет кнопки синхронизации, которой нечего загружать', pg.locator('.pagehead [data-a=sync]').count() == 0)
    check('шаги начала работы пронумерованы списком', pg.locator('.ob-steps li').count() == 3)
    check('пример с выдуманными данными подписан на первом экране', 'выдуманными' in pg.inner_text('.ob-demo'))
    pg.click('#ob-f button[type=submit]'); pg.wait_for_selector('#ob-err')
    check('пустое поле: понятная ошибка', 'Введите Steam ID' in pg.inner_text('#ob-err') and pg.get_attribute('#ob-id', 'aria-invalid') == 'true')
    pg.fill('#ob-id', 'steamcommunity.com/id/someone'); pg.press('#ob-id', 'Enter'); pg.wait_for_timeout(200)
    check('ссылка с именем: объяснение, какая ссылка нужна, введённое не стирается', 'profiles' in pg.inner_text('#ob-err') and pg.input_value('#ob-id') == 'steamcommunity.com/id/someone')
    hits.clear()
    pg.fill('#ob-id', 'https://steamcommunity.com/profiles/76561197960266729'); pg.press('#ob-id', 'Enter')
    pg.wait_for_function("!document.querySelector('.ob')", timeout=5000)
    check('после подключения ID сохранён (SteamID64 переведён в ID Dota 2)', pg.evaluate("JSON.parse(localStorage.getItem('dotamate.v1')).me.acc") == '1001')
    check('после подключения сразу запрошены матчи из OpenDota', any(h.startswith('/players/1001/matches') for h in hits), hits[:3])
    check('после подключения появилась кнопка синхронизации', pg.locator('.pagehead [data-a=sync]').count() == 1)
    pg.wait_for_function("(()=>{const t=document.querySelector('.dh-status');return t&&/Добавлено матчей|Новых матчей нет|недоступны|Не удалось/.test(t.innerText)})()", timeout=30000)
    check('синхронизация завершилась с понятным итогом', 'Добавлено матчей' in pg.inner_text('.dh-status'), pg.inner_text('.dh-status'))
    check('демо-данные удалены после первого матча', pg.evaluate("JSON.parse(localStorage.getItem('dotamate.v1')).demo") is False)
    check('без JS-ошибок (первый экран)', not errs, errs[:2]); c.close()
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT); pg.goto(URL); pg.wait_for_selector('.dsr')
    check('с аккаунтом первый экран подключения не показывается', pg.locator('.ob').count() == 0 and pg.locator('.pagehead [data-a=sync]').count() == 1)
    c.close()

    # ---------- матчи, игроки, карточка ----------
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow')
    tops = pg.evaluate("['f-res','f-mode','f-range','f-st'].map(i=>Math.round(document.getElementById(i).getBoundingClientRect().top))")
    check('1280px: четыре фильтра матчей в одну строку', len(set(tops)) == 1, tops)
    pg.click('#mlist .mrow >> nth=0'); pg.wait_for_selector('.im-box')
    meet = pg.locator('.panel .banner[role=note]').first
    check('«вы уже играли вместе» — нейтральный блок, а не красное предупреждение', meet.count() == 1 and 'soft' not in (meet.get_attribute('class') or ''))
    tag = pg.evaluate("(()=>{const t=[...document.querySelectorAll('.panel .tag')].find(x=>/встречались/.test(x.innerText));return t?getComputedStyle(t).backgroundColor:''})()")
    check('метка «встречались» не красная', tag and '240, 68, 82' not in tag, tag)
    pg.keyboard.press('Escape')
    pg.goto(URL + '#/players'); pg.wait_for_selector('#plist')
    check('фильтр «Союзники и соперники» не путается с «Оценки»', 'Союзники и соперники' in pg.inner_text('#prole') and 'С оценкой и без' in pg.inner_text('#sx-rated'))
    pg.click('#plist [data-a=openPlayer][data-id="2002"]'); pg.wait_for_selector('.im-card .im-prow')
    ws = pg.evaluate("[...document.querySelectorAll('.im-card .im-prow .im-why')].map(e=>Math.round(e.getBoundingClientRect().width))")
    hs = pg.evaluate("[...document.querySelectorAll('.im-card .im-prow')].map(e=>Math.round(e.getBoundingClientRect().height))")
    check('карточка игрока: пояснение к MVP читается строкой, а не узким столбиком', ws and min(ws) > 400 and max(hs) < 120, (ws, hs))
    c.close()
    c, pg, errs = mock_mob = setup(b, w=390, S=state(), init=INIT); pg.goto(URL + '#/players'); pg.wait_for_selector('#plist'); pg.click('#plist [data-a=openPlayer][data-id="2002"]'); pg.wait_for_selector('.im-card .im-prow')
    hs = pg.evaluate("[...document.querySelectorAll('.im-card .im-prow')].map(e=>Math.round(e.getBoundingClientRect().height))")
    check('390px: строка MVP в карточке игрока компактная', max(hs) < 200 and overflow(pg) <= 0, hs)
    c.close()

    # ---------- репутация без сервера ----------
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT); pg.goto(URL + '#/reports'); pg.wait_for_selector('form[data-rpform=reports]'); pg.wait_for_timeout(600)
    check('без сервера поля жалобы честно отключены, а не выглядят рабочими', pg.locator('form[data-rpform=reports] fieldset[disabled]').count() == 1 and pg.locator('#rf-target').is_disabled())
    check('подписи полей остаются читаемыми', pg.evaluate("getComputedStyle(document.querySelector('label[for=rf-target]')).opacity") == '1')
    check('вкладки репутации по-русски', 'Проверка пати' in pg.inner_text('main') and 'Party Safety' not in pg.inner_text('main'))
    c.close()

    # ---------- первая отрисовка после ответа /api/session (версия с сервером) ----------
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT); held = []; direct = []
    pg.route('**/api/session', lambda r: held.append(r))
    pg.on('request', lambda r: direct.append(r.url) if 'api.opendota.com' in r.url else None)
    pg.goto(URL); pg.wait_for_timeout(600)
    check('пока сервер не ответил, страница не ходит в OpenDota напрямую', not direct and len(held) == 1, direct[:2])
    held[0].fulfill(status=200, body=json.dumps({'server': True, 'user': None}), headers={'content-type': 'application/json'})
    pg.wait_for_selector('.top .tabs .tab', timeout=5000); pg.click('.top .tabs [data-p=rep]'); pg.wait_for_selector('#rp-root', timeout=5000); pg.wait_for_timeout(800)
    check('на сервере главная и «Репутация» обращаются к OpenDota только через сервер', not direct, direct[:2])
    c.close()
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT)
    pg.add_init_script("new MutationObserver(function(m,o){var e=document.getElementById('main');if(e&&e.children.length){window.__painted=performance.now();o.disconnect()}}).observe(document,{childList:true,subtree:true})")
    pg.goto(URL); pg.wait_for_selector('.dsr')
    gap = pg.evaluate("(()=>{const e=performance.getEntriesByType('resource').find(x=>x.name.includes('/api/session'));return e?Math.round(window.__painted-e.responseEnd):null})()")
    check('без сервера страница рисуется сразу после ответа /api/session, а не по таймеру', gap is not None and gap < 600, gap)
    c.close()
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT); hang = []; pg.route('**/api/session', lambda r: hang.append(r)); t0 = time.time(); pg.goto(URL); pg.wait_for_selector('.dsr', timeout=6000); dt = time.time() - t0
    check('если /api/session завис, страница всё равно открывается', dt < 4, round(dt, 2))
    for r in hang: r.abort()
    pg.wait_for_timeout(100); c.close()

    # ---------- клавиатура ----------
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow')
    pg.keyboard.press('Tab'); pg.wait_for_timeout(250)
    check('первый Tab — ссылка «Перейти к содержимому», она видна', pg.evaluate("document.activeElement.classList.contains('skip')") and pg.evaluate("document.activeElement.getBoundingClientRect().top") >= 0, pg.evaluate("document.activeElement.outerHTML.slice(0,80)"))
    pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
    check('Enter переводит фокус в содержимое и не меняет адрес раздела', pg.evaluate("document.activeElement.id") == 'main' and pg.evaluate("location.hash") == '#/matches', pg.evaluate("location.hash"))
    pg.keyboard.press('Tab')
    check('следующий Tab попадает в содержимое страницы, а не в шапку', pg.evaluate("!!document.activeElement.closest('main')"))
    c.close()

    # ---------- настройки, иконка, превью ----------
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT); pg.goto(URL + '#/settings'); pg.wait_for_selector('#set-steam')
    lv = pg.evaluate("[...document.querySelectorAll('main h1,main h2,main h3,main h4')].filter(h=>h.getBoundingClientRect().width>0).map(h=>+h.tagName[1])")
    check('настройки: уровни заголовков идут без пропусков', lv and lv[0] == 1 and all(b2 - a2 <= 1 for a2, b2 in zip(lv, lv[1:])), lv)
    check('у страницы есть иконка, описание и превью ссылки', pg.locator('link[rel=icon]').count() == 1 and len(pg.get_attribute('meta[name=description]', 'content') or '') > 60 and 'og.png' in (pg.get_attribute('meta[property="og:image"]', 'content') or ''))
    fav = pg.evaluate("fetch('favicon.svg').then(r=>r.ok&&r.headers.get('content-type')||'')")
    check('иконка вкладки загружается', 'svg' in fav, fav)
    c.close()
    import struct
    with open(os.path.join(ROOT, 'og.png'), 'rb') as f: hdr = f.read(24)
    check('превью ссылки 1200×630', hdr[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', hdr[16:24]) == (1200, 630))
    b.close()

mock.terminate()
print(f'\nИтого: {len(passes)} пройдено, {len(fails)} не пройдено')
sys.exit(1 if fails else 0)
