"""Браузерная проверка страницы «Драфт»: ручной ввод, подсказки (по данным поддельного OpenDota), демо, история, живое подключение
к настоящему локальному мосту (tools/gsi-bridge.js) с ПОДДЕЛЬНЫМИ пакетами GSI, мобильная вёрстка.
Реальный клиент Dota 2 здесь не участвует: формат пакетов взят из описаний открытых библиотек.
Запуск: python3 tests/e2e/draft_e2e.py  (нужны playwright для Python и Node 18+)."""
import os, subprocess, sys, tempfile, time, socket, json, urllib.request, urllib.error, functools, threading, http.server
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

mock_port, port, bport = free_port(), free_port(), free_port()
TOKEN = 'e2e-token-0123456789abcdef'
data = tempfile.mkdtemp(prefix='dm-draft-')
home = tempfile.mkdtemp(prefix='dm-home-')
procs = [subprocess.Popen(['node', os.path.join(ROOT, 'tests/helpers/mock-opendota.js'), str(mock_port)], stdout=subprocess.DEVNULL)]
env = dict(os.environ, PORT=str(port), PUBLIC_URL=f'http://127.0.0.1:{port}', DATA_DIR=data, OPENDOTA_BASE=f'http://127.0.0.1:{mock_port}')
procs.append(subprocess.Popen(['node', os.path.join(ROOT, 'server.js')], env=env, stdout=subprocess.DEVNULL, stderr=open(os.path.join(data, 'server.err'), 'w')))
BASE = f'http://127.0.0.1:{port}'
for _ in range(80):
    try: urllib.request.urlopen(BASE + '/api/c/status', timeout=1); break
    except Exception: time.sleep(0.1)

fails, passes = [], []
def check(name, cond, info=''):
    (passes if cond else fails).append(name)
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if (info and not cond) else ''))

def start_bridge():
    p = subprocess.Popen(['node', os.path.join(ROOT, 'tools/gsi-bridge.js'), '--port', str(bport), '--token', TOKEN, '--quiet'], env=dict(os.environ, HOME=home, USERPROFILE=home), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try: urllib.request.urlopen(f'http://127.0.0.1:{bport}/status?t={TOKEN}', timeout=1); return p
        except Exception: time.sleep(0.1)
    return p

def gsi(radiant=(), dire=(), rban=(), dban=(), active=3, left=30, gs='DOTA_GAMERULES_STATE_HERO_SELECTION', draft=True, team='radiant', token=TOKEN):
    d = {'provider': {'name': 'Dota 2', 'appid': 570}, 'map': {'game_state': gs, 'matchid': '8123456789'}, 'player': {'team_name': team}, 'auth': {'token': token}}
    if draft:
        t2 = {'home_team': True}; t3 = {'home_team': False}
        for i, h in enumerate(radiant): t2[f'pick{i}_id'] = h
        for i, h in enumerate(dire): t3[f'pick{i}_id'] = h
        for i, h in enumerate(rban): t2[f'ban{i}_id'] = h
        for i, h in enumerate(dban): t3[f'ban{i}_id'] = h
        d['draft'] = {'activeteam': active, 'pick': True, 'activeteam_time_remaining': left, 'radiant_bonus_time': 130, 'dire_bonus_time': 130, 'team2': t2, 'team3': t3}
    return d
def post(pkt):
    r = urllib.request.Request(f'http://127.0.0.1:{bport}/gsi', data=json.dumps(pkt).encode(), headers={'content-type': 'application/json'}, method='POST')
    try: return urllib.request.urlopen(r, timeout=3).status
    except urllib.error.HTTPError as e: return e.code

def until(pg, expr, timeout=8000):
    """Ожидание условия без eval (CSP сервера запрещает строки как код): опрашиваем через evaluate с функцией."""
    end = time.time() + timeout / 1000; last = None
    while time.time() < end:
        try:
            if pg.evaluate('()=>!!(' + expr + ')'): return True
        except Exception as e: last = e
        time.sleep(0.05)
    raise TimeoutError('условие не выполнилось: ' + expr[:120] + (' / ' + str(last) if last else ''))

def ls(pg, k): return pg.evaluate("k=>JSON.parse(localStorage.getItem(k)||'null')", k)
def expected_top(enemy, cands):
    """Сглаженный винрейт кандидата против врага по формуле подсказок: (g-w+25)/(g+50), данные мока: игры 400+c, победы врага 150+((E*7+c*13)%120)."""
    sc = {}
    for c in cands:
        g = 400 + c; w = 150 + ((enemy * 7 + c * 13) % 120)
        sc[c] = ((g - w) + 25) / (g + 50)
    return sorted(sc, key=lambda c: -sc[c]), sc

NAMES = {1: 'Anti-Mage', 2: 'Axe', 13: 'Puck', 14: 'Pudge', 26: 'Lion', 74: 'Invoker'}

def static_checks():
    r = urllib.request.urlopen(BASE + '/bridge/dota-mate-bridge.js', timeout=5)
    body = r.read().decode()
    check('сервер отдаёт файл моста на скачивание', r.status == 200 and 'attachment' in (r.headers.get('Content-Disposition') or '') and 'createHub' in body)
    csp = urllib.request.urlopen(BASE + '/', timeout=5).headers.get('Content-Security-Policy', '')
    check('CSP разрешает подключение страницы только к себе и к localhost', "connect-src 'self' http://127.0.0.1:* http://localhost:*" in csp, csp)

def run():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])
        def newctx(w=1280, h=900):
            c = b.new_context(viewport={'width': w, 'height': h}); pg = c.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.route('**/*', lambda r: r.abort() if ('fonts.g' in r.request.url or 'steamstatic' in r.request.url) else r.continue_())
            return c, pg, errs

        # ---------- ручной ввод и подсказки ----------
        c, pg, errs = newctx(); pg.goto(BASE + '/#/draft'); pg.wait_for_selector('#dr-board .dr-team')
        check('страница открылась по адресу #/draft, вкладка «Драфт» выбрана', pg.locator('.tabs [aria-current=page]').inner_text().strip() == 'Драфт')
        check('режим по умолчанию: ручной ввод', 'Ручной ввод' in pg.inner_text('#dr-head'))
        pg.wait_for_selector('.dr-h[data-id="2"]'); until(pg, "document.querySelectorAll('.dr-h').length===6")
        check('сетка героев из OpenDota (6 героев мока)', pg.locator('.dr-h').count() == 6, pg.locator('.dr-h').count())
        pg.click('.dr-segb[data-k=picks][data-side=radiant]'); pg.click('.dr-h[data-id="2"]')
        check('выбор Axe попал в слот Radiant', 'Axe' in pg.inner_text('.dr-team.radiant .dr-slots'))
        check('занятый герой в сетке недоступен', pg.locator('.dr-h[data-id="2"]').is_disabled())
        pg.click('.dr-segb[data-k=picks][data-side=dire]'); pg.click('.dr-h[data-id="14"]')
        check('выбор Pudge попал в слот Dire', 'Pudge' in pg.inner_text('.dr-team.dire .dr-slots'))
        pg.wait_for_selector('#dr-sugg .dr-row')
        until(pg, "document.querySelectorAll('#dr-sugg .dr-row').length>=4 && document.querySelector('#dr-sugg .dr-sc:not(.na)')")
        names = pg.locator('#dr-sugg .dr-row .pname').all_inner_texts()
        exp, sc = expected_top(14, [1, 13, 26, 74])
        check('подсказки не содержат занятых героев', 'Axe' not in names and 'Pudge' not in names, names)
        check('порядок подсказок совпадает с расчётом по данным мока', names == [NAMES[i] for i in exp], (names, [NAMES[i] for i in exp]))
        first = pg.inner_text('#dr-sugg .dr-row >> nth=0 >> .dr-sc').strip()
        check('процент первого совета совпадает с расчётом', first == f'{round(sc[exp[0]] * 100)}%', (first, sc[exp[0]]))
        check('у совета показан винрейт против Pudge', 'Pudge' in pg.inner_text('#dr-sugg .dr-row >> nth=0 >> .dr-chips'))
        # баны
        pg.click('.dr-segb[data-k=bans][data-side=dire]'); pg.click('.dr-h[data-id="74"]')
        check('бан попал в ряд банов Dire', pg.locator('.dr-team.dire .dr-ban').count() == 1)
        check('забаненный герой исчез из подсказок', 'Invoker' not in pg.locator('#dr-sugg .dr-row .pname').all_inner_texts())
        # быстрый выбор из подсказки
        pg.click('#dr-sugg .dr-row >> nth=0')
        check('клик по подсказке добавляет героя в выбор Radiant', pg.locator('.dr-team.radiant .dr-slot:not(.empty)').count() == 2)
        # отмена и удаление
        pg.click('[data-a=d-undo]'); check('«Отменить» убирает последний выбор', pg.locator('.dr-team.radiant .dr-slot:not(.empty)').count() == 1)
        pg.click('.dr-team.dire .dr-slot:not(.empty) .dr-x'); check('крестик убирает героя', pg.locator('.dr-team.dire .dr-slot:not(.empty)').count() == 0)
        # фильтры и поиск
        pg.fill('#dr-q', 'pud'); check('поиск героя по части имени', pg.locator('.dr-h').count() == 1 and 'Pudge' in pg.inner_text('#dr-grid'))
        pg.fill('#dr-q', ''); pg.select_option('#dr-pattr', 'int'); check('фильтр по атрибуту', pg.locator('.dr-h').count() == 1 and 'Lion' in pg.inner_text('#dr-grid'))
        pg.select_option('#dr-pattr', ''); pg.select_option('#dr-prole', 'Carry'); check('фильтр по роли', pg.locator('.dr-h').count() == 2, pg.locator('.dr-h').count())
        pg.select_option('#dr-prole', '')
        # заполняем состав и сохраняем
        pg.click('.dr-segb[data-k=picks][data-side=dire]'); pg.click('.dr-h[data-id="14"]'); pg.click('.dr-h[data-id="26"]')
        check('состав Dire из двух героев', pg.locator('.dr-team.dire .dr-slot:not(.empty)').count() == 2)
        pg.click('[data-a=d-save]'); pg.wait_for_selector('.dr-hist')
        check('драфт сохранён в историю', pg.locator('.dr-hist').count() == 1)
        check('в истории лежат только ID и имена, без токена', 'dotamate.drafts.v1' in pg.evaluate("Object.keys(localStorage).join()") and 'e2e-token' not in json.dumps(ls(pg, 'dotamate.drafts.v1')))
        pg.reload(); pg.wait_for_selector('.dr-hist'); check('история переживает перезагрузку', pg.locator('.dr-hist').count() == 1)
        check('после перезагрузки доска пуста', pg.locator('.dr-team .dr-slot:not(.empty)').count() == 0)
        pg.click('[data-a=d-open]'); check('«Открыть» из истории возвращает состав', pg.locator('.dr-team .dr-slot:not(.empty)').count() == 3)
        pg.click('[data-a=d-reset]'); check('«Новый драфт» очищает доску', pg.locator('.dr-team .dr-slot:not(.empty)').count() == 0)
        pg.click('[data-a=d-hdel]'); check('удаление записи истории', pg.locator('.dr-hist').count() == 0)
        check('без JS-ошибок (ручной режим)', not errs, errs[:2])
        c.close()

        # ---------- демонстрация ----------
        c, pg, errs = newctx(); pg.goto(BASE + '/#/draft'); pg.wait_for_selector('#dr-board .dr-team')
        pg.evaluate("DMDraftUI.state.demoMs=60"); pg.click('[data-a=d-demo]')
        until(pg, "document.querySelectorAll('.dr-slot:not(.empty)').length===10", 15000)
        check('демо заполняет 5+5 героев', pg.locator('.dr-team.radiant .dr-slot:not(.empty)').count() == 5 and pg.locator('.dr-team.dire .dr-slot:not(.empty)').count() == 5)
        check('демо честно подписано', 'Демонстрация' in pg.inner_text('#dr-head'))
        check('в ленте есть баны, выборы и завершение', all(x in pg.inner_text('#dr-side') for x in ['бан', 'выбор', 'Драфт завершён']), pg.inner_text('#dr-side')[:200])
        check('по завершении виден статус «Драфт завершён»', 'Драфт завершён' in pg.inner_text('#dr-head'))
        check('демо не пишет в историю само', ls(pg, 'dotamate.drafts.v1') in (None, []))
        check('без JS-ошибок (демо)', not errs, errs[:2]); c.close()

        # ---------- живое подключение к мосту ----------
        bridge = start_bridge()
        try:
            c, pg, errs = newctx()
            pg.goto(BASE + '/#/draft?b=127.0.0.1:%d&t=%s' % (bport, TOKEN)); pg.wait_for_selector('#dr-board .dr-team')
            until(pg, "document.querySelector('#dr-head .pill') && document.querySelector('#dr-head .pill').textContent.includes('Мост подключён')", 8000)
            check('по ссылке от моста страница подключилась', True)
            check('токен убран из адресной строки', 'e2e-token' not in pg.url and pg.url.endswith('#/draft'), pg.url)
            check('адрес и токен моста запомнены локально', (ls(pg, 'dotamate.bridge.v1') or {}).get('host') == f'127.0.0.1:{bport}')
            check('пока блока драфта нет, страница ждёт', 'Жду данные' in pg.inner_text('#dr-head') or 'блока драфта' in pg.inner_text('#dr-head'))
            post(gsi(draft=False, gs='DOTA_GAMERULES_STATE_GAME_IN_PROGRESS'))
            until(pg, "document.querySelector('#dr-head .sm').textContent.includes('блока драфта')", 5000)
            check('пакет без драфта: статус «блока драфта пока нет»', True)
            check('пакет с неверным токеном отклоняется', post(gsi(token='wrong-token-wrong')) == 401)
            # ход драфта
            post(gsi(rban=[14], dban=[74], active=3, left=25))
            until(pg, "document.querySelector('#dr-head .pill').textContent.includes('Данные из Dota 2')", 5000)
            check('пакет с драфтом переключает режим «Данные из Dota 2»', True)
            check('баны из игры отрисованы', pg.locator('.dr-team.radiant .dr-ban').count() == 1 and pg.locator('.dr-team.dire .dr-ban').count() == 1)
            check('показан активный ход Dire', 'Ход: Dire' in pg.inner_text('#dr-head') and pg.locator('.dr-team.dire.active').count() == 1)
            t0 = pg.inner_text('#dr-timer')
            pg.wait_for_timeout(1600); t1 = pg.inner_text('#dr-timer')
            def secs(t): m, s = t.split(':'); return int(m) * 60 + int(s)
            check('таймер хода идёт вниз', secs(t1) < secs(t0), (t0, t1))
            check('ваша сторона определена по team_name', 'ваша сторона' in pg.inner_text('.dr-team.radiant'))
            check('ручной ввод в режиме игры отключён (нет крестиков и сетки)', pg.locator('.dr-x').count() == 0 and pg.locator('#dr-grid').count() == 0)
            post(gsi(radiant=[2], rban=[14], dban=[74], active=3, left=20))
            until(pg, "document.querySelectorAll('.dr-team.radiant .dr-slot:not(.empty)').length===1", 5000)
            post(gsi(radiant=[2], dire=[14], rban=[14, 26], dban=[74], active=2, left=28))
            until(pg, "document.querySelectorAll('.dr-team.dire .dr-slot:not(.empty)').length===1", 5000)
            pg.wait_for_selector('#dr-sugg .dr-row .dr-sc:not(.na)')
            names = pg.locator('#dr-sugg .dr-row .pname').all_inner_texts()
            exp, _ = expected_top(14, [1, 13])
            check('подсказки для стороны игрока строятся против вражеского пика', names == [NAMES[i] for i in exp], names)
            log = pg.inner_text('#dr-side')
            check('в ленте видны события игры', 'Axe' in log and 'Pudge' in log and 'Ход: Radiant' in log, log[:300])
            check('в режиме игры строка подсказки не кликабельна', pg.locator('#dr-sugg button.dr-rm').count() == 0)
            # завершение: полные составы
            post(gsi(radiant=[2, 1, 13, 26, 74], dire=[14, 2 + 100, 3 + 100, 4 + 100, 5 + 100], rban=[14], dban=[74], active=2, left=0))
            post(gsi(radiant=[2, 1, 13, 26, 74], dire=[14, 102, 103, 104, 105], rban=[], dban=[], active=2, left=0, gs='DOTA_GAMERULES_STATE_STRATEGY_TIME'))
            until(pg, "document.querySelectorAll('.dr-slot:not(.empty)').length===10", 5000)
            pg.wait_for_selector('.dr-hist', timeout=5000)
            h = ls(pg, 'dotamate.drafts.v1')
            check('завершённый драфт из игры сохранён в историю сам', isinstance(h, list) and len(h) == 1 and h[0]['source'] == 'gsi' and h[0]['mySide'] == 'radiant', h)
            check('в истории записан номер матча', h and h[0].get('matchId') == '8123456789', h)
            # новый драфт: полный сброс игровых данных
            post(gsi(active=2, left=30, rban=[], dban=[]))
            until(pg, "document.querySelectorAll('.dr-slot:not(.empty)').length===0", 5000)
            check('начало нового драфта очищает доску, а запись остаётся', pg.locator('.dr-hist').count() == 1)
            check('без JS-ошибок (живой режим)', not errs, errs[:2])
            # отключение
            pg.click('[data-a=d-conn]'); pg.click('[data-a=d-disconnect]')
            check('«Отключить» возвращает ручной режим', 'Ручной ввод' in pg.inner_text('#dr-head'))
            pg.click('[data-a=d-connect]')   # панель подключения после «Отключить» осталась открытой, поля заполнены сохранённым адресом
            until(pg, "document.querySelector('#dr-head .pill').textContent.includes('Мост подключён') || document.querySelector('#dr-head .pill').textContent.includes('Данные из')", 8000)
            check('повторное подключение вручную работает', True)
            # мост пропал
            bridge.terminate(); bridge.wait(timeout=5)
            until(pg, "document.querySelector('#dr-head .pill').textContent.includes('не отвечает')", 8000)
            check('при остановке моста страница сообщает об отсутствии связи', 'Нет связи' in pg.inner_text('#dr-head'))
            bridge = start_bridge()
            until(pg, "document.querySelector('#dr-head .pill').textContent.includes('Мост подключён')", 15000)
            check('после перезапуска моста страница переподключилась сама', True)
            c.close()

            # недопустимая ссылка: чужой хост
            c, pg, errs = newctx(); pg.goto(BASE + '/#/draft?b=evil.example.com:80&t=%s' % TOKEN); pg.wait_for_selector('#dr-board .dr-team')
            check('ссылка с чужим хостом не принимается и не сохраняется', ls(pg, 'dotamate.bridge.v1') is None and pg.evaluate("DMDraftUI.state.es") is None)
            pg.click('[data-a=d-conn]'); pg.fill('#dr-host', 'evil.example.com:80'); pg.fill('#dr-token', TOKEN); pg.click('[data-a=d-connect]')
            check('ручной ввод чужого адреса отклоняется', ls(pg, 'dotamate.bridge.v1') is None and 'Адрес должен быть' in pg.inner_text('#dr-conn'))
            c.close()

            # ---------- мобильная вёрстка ----------
            c, pg, errs = newctx(390, 800); pg.goto(BASE + '/#/draft'); pg.wait_for_selector('#dr-board .dr-team')
            pg.evaluate("DMDraftUI.state.demoMs=40"); pg.click('[data-a=d-demo]')
            until(pg, "document.querySelectorAll('.dr-slot:not(.empty)').length===10", 15000)
            pg.wait_for_selector('#dr-sugg .dr-row')
            ov = pg.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")
            check('мобильная ширина 390: нет горизонтальной прокрутки', ov <= 0, ov)
            pg.click('[data-a=d-reset]'); pg.wait_for_selector('.dr-slot.empty')
            ov0 = pg.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")
            check('мобильная ширина 390: пустая доска без горизонтальной прокрутки', ov0 <= 0, ov0)
            check('на мобильной нижняя навигация показывает 7 вкладок', pg.locator('#nav .tab').count() == 7)
            tops = pg.evaluate("()=>[...document.querySelectorAll('#nav .tab')].map(t=>Math.round(t.getBoundingClientRect().top))")
            check('нижняя навигация в один ряд', len(set(tops)) == 1, tops)
            pg.click('[data-a=d-conn]'); ov = pg.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")
            check('мобильная ширина: панель подключения без прокрутки', ov <= 0, ov)
            check('без JS-ошибок (мобильная)', not errs, errs[:2]); c.close()

            # ---------- отдельное компактное окно ----------
            c, pg, errs = newctx(1280, 900)
            pg.goto(BASE + '/#/draft?b=127.0.0.1:%d&t=%s' % (bport, TOKEN)); pg.wait_for_selector('#dr-board .dr-team')
            until(pg, "document.querySelector('#dr-head .pill').textContent.includes('Мост подключён')", 8000)
            with c.expect_page() as pop_info:
                pg.click('[data-a=d-pop]')
            pop = pop_info.value; perrs = []; pop.on('pageerror', lambda e: perrs.append(str(e)))
            pop.wait_for_selector('#dr-board .dr-team')
            check('кнопка «Отдельное окно» открывает окно с #/draft?w=1', pop.url.endswith('#/draft?w=1'), pop.url)
            until(pop, "document.body.classList.contains('dr-compact')")
            vis = lambda sel: pop.evaluate("s=>{const e=document.querySelector(s);return !!e&&getComputedStyle(e).display!=='none'}", sel)
            check('в компактном окне скрыты шапка, навигация, заголовок и история', not any(vis(x) for x in ['.top', '#nav', '.pagehead', '.dr-histcard']))
            check('в компактном окне видны доска и подсказки', vis('#dr-board') and vis('#dr-sugg'))
            until(pop, "document.querySelector('#dr-head .pill').textContent.includes('Мост подключён')", 8000)
            check('компактное окно само подключилось к тому же мосту', True)
            post(gsi(radiant=[2], rban=[14], dban=[74], active=2, left=22))
            until(pop, "document.querySelectorAll('.dr-team.radiant .dr-slot:not(.empty)').length===1", 5000)
            until(pg, "document.querySelectorAll('.dr-team.radiant .dr-slot:not(.empty)').length===1", 5000)
            check('данные игры одновременно видны в обоих окнах', True)
            check('кнопки «Отдельное окно» в компактном окне нет', not vis('[data-a=d-pop]'))
            pop.set_viewport_size({'width': 440, 'height': 780}); pop.wait_for_timeout(200)
            wide = pop.evaluate("()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(e).position!=='fixed').slice(0,4).map(e=>e.tagName+'.'+e.className)")
            check('компактное окно 440 px без горизонтальной прокрутки', pop.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth") <= 0, wide)
            check('без JS-ошибок (два окна)', not errs and not perrs, (errs + perrs)[:2])
            c.close()
        finally:
            try: bridge.terminate()
            except Exception: pass

        # ---------- режим GitHub Pages (без сервера, OpenDota напрямую) ----------
        h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message = lambda *a, **k: None
        static = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h); threading.Thread(target=static.serve_forever, daemon=True).start()
        c, pg, errs = newctx()
        def to_mock(r):
            u = r.request.url
            if 'api.opendota.com/api/' in u:
                path = u.split('api.opendota.com/api', 1)[1]
                try: body = urllib.request.urlopen(f'http://127.0.0.1:{mock_port}{path}', timeout=5).read(); return r.fulfill(status=200, body=body, headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})
                except Exception: return r.abort()
            return r.fallback()
        pg.route('https://api.opendota.com/**', to_mock)
        pg.goto(f'http://127.0.0.1:{static.server_address[1]}/index.html#/draft'); pg.wait_for_selector('#dr-board .dr-team'); pg.wait_for_selector('.dr-h[data-id="2"]', timeout=10000)
        pg.click('.dr-h[data-id="14"]'); pg.click('.dr-segb[data-k=picks][data-side=dire]'); pg.click('.dr-h[data-id="2"]')
        pg.wait_for_selector('#dr-sugg .dr-row .dr-sc:not(.na)', timeout=15000)
        check('статический режим: подсказки работают без сервера', pg.locator('#dr-sugg .dr-row').count() >= 1 and 'Axe' in pg.inner_text('#dr-sugg .dr-row >> nth=0 >> .dr-chips'), pg.inner_text('#dr-sugg')[:300])
        check('без JS-ошибок (статический режим)', not errs, errs[:2]); c.close()
        static.shutdown()
        b.close()

try:
    static_checks()
    run()
finally:
    for pr in procs:
        try: pr.terminate()
        except Exception: pass
print(f'\nИтого: {len(passes)} пройдено, {len(fails)} не пройдено')
sys.exit(1 if fails else 0)
