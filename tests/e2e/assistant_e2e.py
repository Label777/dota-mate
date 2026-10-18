"""Браузерная проверка помощника: справка без ИИ (статический режим) и ИИ-чат на сервере с поддельным API Anthropic."""
import os, subprocess, sys, tempfile, time, shutil, socket, urllib.request, functools, http.server, threading
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def fp():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
ap, port = fp(), fp(); data = tempfile.mkdtemp(prefix='dm-as-')
procs = [subprocess.Popen(['node', os.path.join(ROOT, 'tests/helpers/mock-anthropic.js'), str(ap)], stdout=subprocess.DEVNULL)]
procs.append(subprocess.Popen(['node', os.path.join(ROOT, 'server.js')], env=dict(os.environ, PORT=str(port), PUBLIC_URL=f'http://127.0.0.1:{port}', DATA_DIR=data, DEV_LOGIN='1', ANTHROPIC_API_KEY='sk-test', ANTHROPIC_BASE=f'http://127.0.0.1:{ap}'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
B = f'http://127.0.0.1:{port}'
for _ in range(80):
    try: urllib.request.urlopen(B + '/api/assistant/status', timeout=1); break
    except Exception: time.sleep(.1)
res = []
def check(n, c, i=''):
    res.append(c); print(('PASS ' if c else 'FAIL ') + n + (f'  [{i}]' if i and not c else ''))
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])
        def ctx(**kw):
            c = b.new_context(**kw); pg = c.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.route('**/*', lambda r: r.abort() if ('fonts.g' in r.request.url or 'steamstatic' in r.request.url) else r.continue_())
            return c, pg, errs
        # 1. сервер, без входа: справка и предложение войти
        c, pg, errs = ctx(viewport={'width': 1200, 'height': 900})
        pg.goto(B + '/'); pg.wait_for_selector('.as-fab'); pg.click('.as-fab'); pg.wait_for_selector('.as-item')
        t = pg.text_content('#as-panel')
        check('без входа: справочник и приглашение войти', 'Справочник' in t and 'Войти через Steam' in t and pg.locator('#as-in').count() == 0)
        pg.click('.as-item >> nth=4'); t = pg.text_content('.as-body')
        check('ответ справки по жалобам', 'Лимит: 5 в сутки' in t)
        pg.keyboard.press('Escape'); check('Escape закрывает панель', pg.locator('#as-panel').is_hidden())
        c.close()
        # 2. вошёл: ИИ-чат
        c, pg, errs = ctx(viewport={'width': 1200, 'height': 900})
        pg.goto(B + '/auth/dev?acc=1001'); pg.wait_for_selector('.as-fab'); pg.click('.as-fab'); pg.wait_for_selector('#as-in')
        check('после входа: ИИ-режим с полем ввода и предупреждением о передаче данных', 'ИИ-помощник' in pg.text_content('.as-mode') and 'ИИ-сервис Anthropic' in pg.text_content('#as-panel'))
        pg.fill('#as-in', 'Как подать жалобу?'); pg.keyboard.press('Enter'); pg.wait_for_selector('.as-msg.bot b', timeout=10000)
        msgs = pg.locator('.as-msg').all_text_contents()
        check('ответ ассистента показан, вопрос пользователя тоже', any('Как подать жалобу?' in m for m in msgs) and any('Жалобы' in m for m in msgs))
        check('ответ ИИ не исполняет HTML (экранирование)', pg.locator('.as-body script').count() == 0 and '<script>' in pg.text_content('.as-body'))
        pg.click('button[data-as=clear]'); check('очистка диалога', pg.locator('.as-msg.me').count() == 0)
        check('без JS-ошибок (чат)', not errs, str(errs[:3]))
        c.close()
        # 3. мобильный: панель не ломает вёрстку
        c, pg, errs = ctx(viewport={'width': 390, 'height': 800}); pg.goto(B + '/'); pg.wait_for_selector('.as-fab'); pg.click('.as-fab'); pg.wait_for_selector('.as-item')
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'); box = pg.locator('#as-panel').bounding_box()
        check('мобильный: панель помещается в экран', ov <= 1 and box['x'] >= 0 and box['x'] + box['width'] <= 391, f'{ov} {box}')
        c.close()
        # 4. статический режим (без сервера): только справка
        h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message = lambda *a, **k: None
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
        c, pg, errs = ctx(viewport={'width': 1200, 'height': 900}); pg.goto(f'http://127.0.0.1:{srv.server_address[1]}/index.html'); pg.wait_for_selector('.as-fab'); pg.click('.as-fab'); pg.wait_for_selector('.as-item')
        t = pg.text_content('#as-panel')
        check('GitHub Pages: честно сказано, что ИИ-чат выключен, справка работает', 'не ИИ' in t and 'ключ API' in t and pg.locator('#as-in').count() == 0)
        check('без JS-ошибок (статика)', not errs, str(errs[:3]))
        srv.shutdown(); c.close(); b.close()
finally:
    for pr in procs: pr.terminate()
    shutil.rmtree(data, ignore_errors=True)
print(f'\nИТОГО: {sum(res)} прошло, {len(res) - sum(res)} не прошло'); sys.exit(0 if all(res) else 1)
