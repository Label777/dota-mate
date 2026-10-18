"""Браузерная проверка раздела «Репутация»: настоящий server.js (SQLite, DEV_LOGIN), поддельный OpenDota, Chromium.
Запуск: python3 tests/e2e/rep_e2e.py  (нужны playwright для Python и Node 22)."""
import os, subprocess, sys, tempfile, time, shutil, socket, json, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

mock_port, port = free_port(), free_port()
data = tempfile.mkdtemp(prefix='dm-e2e-')
procs = [subprocess.Popen(['node', os.path.join(ROOT, 'tests/helpers/mock-opendota.js'), str(mock_port)], stdout=subprocess.DEVNULL)]
env = dict(os.environ, PORT=str(port), PUBLIC_URL=f'http://127.0.0.1:{port}', DATA_DIR=data, DEV_LOGIN='1', MODERATORS='9009', OPENDOTA_BASE=f'http://127.0.0.1:{mock_port}')
procs.append(subprocess.Popen(['node', os.path.join(ROOT, 'server.js')], env=env, stdout=subprocess.DEVNULL, stderr=open(os.path.join(data, 'server.err'), 'w')))
BASE = f'http://127.0.0.1:{port}'
for _ in range(80):
    try: urllib.request.urlopen(BASE + '/api/c/status', timeout=1); break
    except Exception: time.sleep(0.1)

fails, passes = [], []
def check(name, cond, info=''):
    (passes if cond else fails).append(name)
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if (info and not cond) else ''))

def run():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])
        def newctx(**kw):
            c = b.new_context(**kw); pg = c.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'fonts' not in m.text else None)
            pg.route('**/*', lambda r: r.abort() if ('fonts.g' in r.request.url or 'steamstatic' in r.request.url) else r.continue_())
            return c, pg, errs
        def login(pg, acc):
            pg.goto(f'{BASE}/auth/dev?acc={acc}'); pg.wait_for_selector('#main')
        txt = lambda pg: pg.text_content('#main')

        # --- 1. анонимно: главная раздела, поиск, профиль, матч
        ctx, pg, errs = newctx(viewport={'width': 1200, 'height': 900})
        pg.goto(BASE + '/#/home'); pg.wait_for_selector('#rp-root .rp-tabs')
        t = txt(pg)
        check('главная репутации: формы поиска игрока и матча', pg.locator('#rp-pin').count() == 1 and pg.locator('#rp-min').count() == 1)
        check('пустое состояние и объяснение расчёта', 'Пока пусто' in t and 'Как устроена репутация' in t)
        check('нет выдуманных счётчиков', 'жалоб подано' not in t.lower() and 'нарушителей' not in t.lower())
        pg.fill('#rp-pin', 'абракадабра'); pg.click('form[data-kind=player] button'); pg.wait_for_selector('.rp-err')
        check('ошибка для неверного ID', 'Не удалось распознать' in pg.inner_text('.rp-err'))
        pg.fill('#rp-pin', '76561197960267730'); pg.click('form[data-kind=player] button')   # = 2002
        pg.wait_for_selector('.rp-card', timeout=20000)
        check('адрес профиля содержит ID', pg.url.endswith('#/profile/2002'), pg.url)
        t = txt(pg)
        check('карточка: требуется проверка (повторяющиеся отклонения)', 'Требуется проверка' in t, t[:300])
        check('уровень «Высокий» недостижим без модератора', 'Высокий' not in pg.locator('.rp-kv', has_text='Уровень риска').text_content())
        check('сообщество недоступно без входа → честная пометка', 'Подтверждено модератором' in t)
        pg.click('.rp-why summary')
        wt = pg.text_content('.rp-why')
        check('блок «Почему сформирована эта оценка?» с факторами и методикой', 'необычным числом смертей' in wt and 'Как считается' in wt and 'Что не учитывается' in wt)
        pg.wait_for_selector('.mt-r', timeout=20000)
        check('в таблице матчей есть бейджи аномалий и ссылки на отчёт', pg.locator('.mt-r .rp-b.s-warn').count() >= 3 and pg.locator('.mt-r a[href^="#/match/"]').count() > 5)
        n_all = pg.locator('.mt-r').count()
        pg.select_option('select[data-pf="tf.flag"]', 'anomaly')
        n_flag = pg.locator('.mt-r').count()
        check('фильтр «Аномалии и факты игры»', 0 < n_flag < n_all, f'{n_flag}/{n_all}')
        pg.goto(BASE + '/#/match/7000000001'); pg.wait_for_selector('.rp-wide tbody tr', timeout=20000)
        t = txt(pg)
        check('исследование матча: участники и сигнал по 2002', 'Player 2002' in t and 'Отклонение:' in t and 'Скрытый профиль' in t)
        check('честное предупреждение об ограничениях OpenDota', 'не отдаёт данные о намеренном кормлении' in t)
        pg.click('button[data-rp=hist][data-acc="2002"]'); pg.wait_for_selector('text=Необычно много смертей', timeout=20000)
        check('сверка с историей игрока находит матч в аномалиях', True)
        pg.goto(BASE + '/#/match/7000099999'); pg.wait_for_selector('.banner[role=alert]', timeout=20000)
        check('несуществующий матч → понятная ошибка', 'не знает такого' in txt(pg))
        pg.goto(BASE + '/#/episodes/2002'); pg.wait_for_selector('.rp-ep', timeout=20000)
        t = txt(pg)
        check('эпизоды: категории A/C/B и факты', 'A · Статистические аномалии' in t and 'C · Подтверждено модератором' in t and 'B · Подозрения без решения' in t and 'Факты игры' in t)
        check('эпизод показывает статус и источник', 'автоматический сигнал, человеком не проверялся' in t)
        pg.select_option('select[data-rpset=cat]', 'anomaly')
        heads = pg.locator('#rp-res section h2').all_text_contents()
        check('фильтр категории эпизодов', len(heads) == 2 and 'A ·' in heads[1], str(heads))
        pg.goto(BASE + '/#/timeline/2002'); pg.wait_for_selector('.rp-tl li', timeout=20000)
        n90 = pg.locator('.rp-tl li').count(); pg.select_option('select[data-rpset=period]', '7'); n7 = pg.locator('.rp-tl li').count()
        check('хронология: фильтр периода', 0 < n7 < n90, f'{n7}/{n90}')
        pg.goto(BASE + '/#/report/2002'); pg.wait_for_selector('.rp-report', timeout=20000)
        t = txt(pg)
        check('публичный отчёт: дата, источники, методика, ограничения', 'Отчёт сформирован' in t and 'Источники' in t and 'Методика' in t and 'Ограничения' in t)
        check('публичный отчёт не содержит приватных данных', 'localStorage' not in t and 'Mate3003' not in t and 'Player 3003' not in t)
        pg.goto(BASE + '/#/party'); pg.wait_for_selector('#rp-party')
        pg.fill('#rp-party', '1 2 3 4 5 6'); pg.click('form[data-rpform=party] button'); pg.wait_for_selector('.rp-err')
        check('Party Safety: не больше 5 игроков', 'не больше пяти' in pg.inner_text('.rp-err'))
        pg.fill('#rp-party', '2002, 3003'); pg.click('form[data-rpform=party] button'); pg.wait_for_selector('text=Сводка по группе', timeout=30000)
        t = txt(pg)
        check('Party Safety: нет вердикта «опасная группа», недостаточно данных показано', 'не выносит вердикт «опасная группа»' in t and 'Недостаточно данных по 1 из 2' in t, t[-600:])
        pg.goto(BASE + '/#/network/2002'); pg.wait_for_selector('.rp-graph', timeout=20000)
        n_nodes = pg.locator('.rp-node').count()
        pg.select_option('select[data-rpset=min]', '5'); n5 = pg.locator('.rp-node').count()
        check('сеть: узлы и фильтр по общим матчам', n_nodes == 2 and n5 == 1, f'{n_nodes}/{n5}')
        pg.select_option('select[data-rpset=min]', '20')
        check('сеть: пустое состояние', 'Связей не найдено' in txt(pg))
        pg.select_option('select[data-rpset=min]', '3'); pg.click('.rp-node >> nth=0'); pg.wait_for_selector('button[data-rp=shared]')
        pg.click('button[data-rp=shared]'); pg.wait_for_selector('.rp-list a[href^="#/match/"]', timeout=20000)
        check('сеть: общие матчи со ссылками', pg.locator('.rp-list a[href^="#/match/"]').count() > 0 and 'сговор' in txt(pg))
        pg.goto(BASE + '/#/reports'); pg.wait_for_selector('.rp-form')
        t = txt(pg)
        check('жалобы без входа: нужен вход, кнопка отправки отключена', 'Нужен вход' in t and pg.locator('form[data-rpform=reports] button[type=submit]').is_disabled())
        pg.goto(BASE + '/#/mod'); 
        check('панель модератора скрыта для не-модератора', pg.locator('.rp-tab:has-text("Модерация")').count() == 0)
        pg.goto(BASE + '/'); pg.wait_for_selector('.tabs .tab')
        pg.click('.tabs [data-p=rep]'); pg.wait_for_selector('#rp-pin')
        check('вкладка «Репутация» в навигации открывает раздел, адрес обновился', pg.url.endswith('#/home'), pg.url)
        pg.click('.tabs [data-p=settings]'); pg.wait_for_selector('#rp-settings')
        check('в настройках есть блок репутации и сообщества', 'Репутация и сообщество' in pg.text_content('#rp-settings') and not pg.url.endswith('#/home'))
        pg.click('button[data-a=repClear]'); pg.wait_for_selector('#toast .toast')
        check('очистка локальных данных репутации', 'удалены' in pg.text_content('#toast'))
        check('без JS-ошибок (анонимно)', not errs, str(errs[:3]))
        ctx.close()

        # --- 2. пользователь 1001: жалоба
        ctx, pg, errs = newctx(viewport={'width': 1200, 'height': 900}); login(pg, 1001)
        pg.goto(BASE + '/#/reports'); pg.wait_for_selector('.rp-form')
        pg.click('form[data-rpform=reports] button[type=submit]'); pg.wait_for_selector('.rp-err')
        check('форма жалобы: ошибки по полям', pg.locator('.rp-err').count() >= 4 and pg.locator('#rf-target[aria-invalid=true]').count() == 1)
        pg.fill('#rf-target', '2002'); pg.fill('#rf-match', '7000000001'); pg.select_option('#rf-cat', 'feeding')
        pg.fill('#rf-desc', 'Умышленно умирал на линии с 10 по 30 минуту, отказывался сражаться'); pg.fill('#rf-ev', 'http://127.0.0.1/x')
        pg.check('.rp-check input'); pg.click('form[data-rpform=reports] button[type=submit]'); pg.wait_for_selector('.rp-err')
        check('плохая ссылка на доказательство отклонена', 'https://' in pg.inner_text('#err-evidence'))
        pg.fill('#rf-ev', 'https://example.com/clip'); pg.click('form[data-rpform=reports] button[type=submit]')
        pg.wait_for_selector('text=Жалоб принято: 1', timeout=15000)
        check('жалоба принята сервером, статус «Новый»', 'Новый' in txt(pg))
        pg.fill('#rf-desc', 'Умышленно умирал на линии с 10 по 30 минуту, отказывался сражаться'); pg.check('.rp-check input'); pg.click('form[data-rpform=reports] button[type=submit]'); pg.wait_for_selector('.banner.soft', timeout=15000)
        check('повторная отправка отклонена (защита от дубликатов)', 'уже подавали' in txt(pg))
        pg.goto(BASE + '/#/watchlist'); pg.wait_for_selector('#wl-in')
        pg.fill('#wl-in', '2002'); pg.click('form[data-rpform=watchlist] button'); pg.wait_for_selector('text=Игрок добавлен', timeout=10000)
        pg.click('button[data-rp=check]'); pg.wait_for_selector('text=Требуется проверка', timeout=30000)
        check('наблюдение на сервере: проверка сохраняет статус', 'хранится на сервере' in txt(pg))
        pg.goto(BASE + '/#/appeals'); pg.wait_for_selector('#ap-id')
        pg.wait_for_selector('text=нет публичных отметок', timeout=10000)
        check('обжалования: у 1001 нет отметок', True)
        pg.goto(BASE + '/#/mod')
        check('жалобы: 1001 не модератор', pg.locator('.rp-tab:has-text("Модерация")').count() == 0 and 'Нет доступа' in txt(pg))
        check('без JS-ошибок (пользователь)', not errs, str(errs[:3]))
        ctx.close()

        # --- 3. модератор
        ctx, pg, errs = newctx(viewport={'width': 1200, 'height': 900}); login(pg, 9009)
        pg.goto(BASE + '/#/mod'); pg.wait_for_selector('button[data-rp=mdopen]', timeout=15000)
        check('модератор видит очередь', pg.locator('.rp-tab:has-text("Модерация")').count() == 1)
        pg.click('button[data-rp=mdopen]'); pg.wait_for_selector('.rp-md select[name=to]')
        pg.select_option('.rp-md select[name=to]', 'confirmed'); pg.click('button[data-rp=mdsave]'); pg.wait_for_selector('.rp-md-msg:not(:empty)', timeout=10000)
        check('решение без обоснования не сохраняется, выбор статуса сохранён', 'Укажите обоснование' in pg.text_content('.rp-md-msg') and pg.input_value('.rp-md select[name=to]') == 'confirmed')
        pg.fill('.rp-md textarea[name=reason]', 'Смерти без боя видны в реплее, подтверждаю'); pg.fill('.rp-md textarea[name=pub]', 'Умышленные смерти на линии')
        pg.click('button[data-rp=mdsave]'); pg.wait_for_selector('text=Статус изменён', timeout=10000)
        check('модератор подтвердил, запись в журнале', True)
        pg.click('button[data-rp=mdtab][data-t=log]'); pg.wait_for_selector('.rp-tbl tbody tr', timeout=10000)
        check('журнал действий содержит решение', 'confirmed' in pg.text_content('#rp-res') or 'Подтверждён модератором' in pg.text_content('#rp-res'))
        check('без JS-ошибок (модератор)', not errs, str(errs[:3]))
        ctx.close()

        # --- 4. публично видно решение; профиль; обжалование владельцем
        ctx, pg, errs = newctx(viewport={'width': 1200, 'height': 900})
        pg.goto(BASE + '/#/episodes/2002')
        pg.wait_for_selector('.rp-ep.e-bad', timeout=20000)
        t = txt(pg)
        check('публично видно подтверждённый эпизод с пояснением модератора', 'Умышленные смерти на линии' in t and 'Подтверждён модератором' in t)
        check('автор жалобы не раскрыт', '1001' not in t)
        pg.goto(BASE + '/#/profile/2002'); pg.wait_for_selector('.rp-card', timeout=20000); pg.wait_for_selector('.rp-card.s-bad', timeout=15000)
        check('карточка профиля учла решение', 'Подтверждено модератором' in pg.text_content('.rp-card'))
        ctx.close()
        ctx, pg, errs = newctx(viewport={'width': 1200, 'height': 900}); login(pg, 2002)
        pg.goto(BASE + '/#/appeals'); pg.wait_for_selector('button[data-rp=pick]', timeout=15000)
        check('владелец видит основание отметки', 'Умышленные смерти на линии' in txt(pg))
        pg.click('button[data-rp=pick]'); pg.fill('#ap-text', 'Это была смена стратегии, а не умышленные смерти'); pg.click('form[data-rpform=appeals] button[type=submit]')
        pg.wait_for_selector('text=принято', timeout=10000)
        check('обращение принято', 'Открыто' in txt(pg) or 'Обращение №' in txt(pg))
        pg.goto(BASE + '/#/episodes/2002'); pg.wait_for_selector('.rp-ep', timeout=20000)
        check('оспариваемая отметка помечена отдельно', 'Оспаривается' in txt(pg))
        ctx.close()
        ctx, pg, errs = newctx(viewport={'width': 1200, 'height': 900}); login(pg, 9009)
        pg.goto(BASE + '/#/mod'); pg.wait_for_selector('button[data-rp=mdtab]'); pg.click('button[data-rp=mdtab][data-t=appeals]'); pg.wait_for_selector('button[data-rp=mdappeal]', timeout=10000)
        pg.select_option('.rp-md select[name=decision]', 'revoke'); pg.fill('.rp-md textarea[name=reason]', 'Повторный просмотр: умысла в смертях нет'); pg.click('button[data-rp=mdappeal]')
        pg.wait_for_selector('text=Решение по обращению сохранено', timeout=10000)
        check('модератор снял отметку по обращению', True)
        ctx.close()
        ctx, pg, errs = newctx(viewport={'width': 1200, 'height': 900})
        pg.goto(BASE + '/#/episodes/2002'); pg.wait_for_selector('.rp-ep', timeout=20000)
        check('после снятия отметка пропала из публичного профиля', pg.locator('.rp-ep.e-bad').count() == 0 and 'Подтверждённых эпизодов нет' in txt(pg))
        ctx.close()

        # --- 5. мобильный вид: нет горизонтальной прокрутки
        ctx, pg, errs = newctx(viewport={'width': 390, 'height': 800})
        for h in ['home', 'match/7000000001', 'episodes/2002', 'timeline/2002', 'party', 'network/2002', 'report/2002', 'reports', 'watchlist', 'appeals', 'profile/2002']:
            pg.goto(BASE + '/#/' + h); pg.wait_for_timeout(1500)
            if h in ('episodes/2002', 'timeline/2002', 'network/2002', 'report/2002', 'match/7000000001'): pg.wait_for_timeout(2500)
            ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            check(f'мобильный: нет горизонтальной прокрутки ({h})', ov <= 1, f'overflow {ov}px')
        ctx.close()

        # --- 6. без сервера (статический сайт): честные сообщения
        import http.server, threading, functools
        h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
        h.log_message = lambda *a, **k: None
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h); sp = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
        ctx, pg, errs = newctx(viewport={'width': 1200, 'height': 900})
        def od(route):
            u = route.request.url.replace('https://api.opendota.com/api', f'http://127.0.0.1:{mock_port}')
            try:
                with urllib.request.urlopen(u, timeout=5) as r: route.fulfill(status=200, content_type='application/json', body=r.read(), headers={'access-control-allow-origin': '*'})
            except urllib.error.HTTPError as e: route.fulfill(status=e.code, content_type='application/json', body='{}', headers={'access-control-allow-origin': '*'})
        pg.route('https://api.opendota.com/**', od)
        pg.goto(f'http://127.0.0.1:{sp}/index.html#/reports'); pg.wait_for_selector('.rp-form')
        pg.wait_for_selector('text=Сообщество недоступно', timeout=10000)
        check('GitHub Pages: жалобы честно недоступны без сервера', pg.locator('form[data-rpform=reports] button[type=submit]').is_disabled())
        pg.goto(f'http://127.0.0.1:{sp}/index.html#/watchlist'); pg.wait_for_selector('#wl-in'); pg.fill('#wl-in', '2002'); pg.click('form[data-rpform=watchlist] button'); pg.wait_for_selector('text=Игрок добавлен', timeout=5000)
        check('без сервера: локальный список наблюдения', 'только в этом браузере' in txt(pg) and '2002' in txt(pg))
        pg.goto(f'http://127.0.0.1:{sp}/index.html#/profile/2002'); pg.wait_for_selector('.rp-card', timeout=30000)
        check('без сервера профиль и репутация считаются по OpenDota', 'нет данных' in pg.text_content('.rp-card') and 'Достоверность' in pg.text_content('.rp-card'))
        check('без JS-ошибок (статический режим)', not errs, str(errs[:3]))
        srv.shutdown(); ctx.close(); b.close()

try:
    run()
finally:
    try: print('SERVER-ERR', open(os.path.join(data, 'server.err')).read()[-1500:])
    except Exception: pass
    for pr in procs: pr.terminate()
    shutil.rmtree(data, ignore_errors=True)
print(f'\nИТОГО: {len(passes)} прошло, {len(fails)} не прошло')
for f in fails: print('  ✗', f)
sys.exit(1 if fails else 0)
