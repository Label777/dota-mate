"""Браузерная проверка: главная и меню, быстрый поиск, подсказки при наведении, автооценка игроков по игре и карточки игроков (в том числе скрытых).
Статический режим (как на GitHub Pages): OpenDota подменён поддельным (tests/helpers/mock-opendota.js), запросы считаются.
Запуск: python3 tests/e2e/home_perf_e2e.py  (нужны playwright для Python и Node 18+)."""
import os, sys, json, time, socket, functools, threading, subprocess, urllib.request, http.server
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
mock_port = free_port()
mock = subprocess.Popen(['node', os.path.join(ROOT, 'tests/helpers/mock-opendota.js'), str(mock_port)], stdout=subprocess.DEVNULL)
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message = lambda *a, **k: None
static = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h); threading.Thread(target=static.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{static.server_address[1]}/index.html'
for _ in range(60):
    try: urllib.request.urlopen(f'http://127.0.0.1:{mock_port}/heroes', timeout=1); break
    except Exception: time.sleep(0.1)

fails, passes = [], []
def check(name, cond, info=''):
    (passes if cond else fails).append(name); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if (info and not cond) else ''))

def until(pg, expr, timeout=15000):
    end = time.time() + timeout / 1000; last = None
    while time.time() < end:
        try:
            if pg.evaluate('()=>!!(' + expr + ')'): return True
        except Exception as e: last = e
        time.sleep(0.05)
    raise TimeoutError('условие не выполнилось: ' + expr[:120] + (' / ' + str(last) if last else ''))

NOW = int(time.time())
HN = {1: 'Anti-Mage', 2: 'Axe', 13: 'Puck', 14: 'Pudge', 26: 'Lion', 74: 'Invoker'}; HL = [1, 2, 13, 14, 26, 74]
def match(i):
    accs = [1001, 2002, 3003, 4004, 5005, None, None, None, None, None]
    ps = [{'sid': str(a) if a else None, 'name': ('Player %d' % a) if a else 'Скрытый игрок', 'hero': HN[HL[k % 6]], 'ally': k < 5, 'me': a == 1001} for k, a in enumerate(accs)]
    return {'id': str(7000000001 + i), 'start': NOW - (i + 1) * 86400, 'mode': 'All Pick', 'ranked': False, 'win': i % 2 == 0, 'dur': 2400, 'hero': HN[1], 'players': ps}
def state(n=4, extra=None):
    S = {'v': 1, 'me': {'acc': '1001', 'name': 'Роман'}, 'matches': [match(i) for i in range(n)], 'reviews': {}, 'pnotes': {}, 'tags': {}, 'heroNotes': {}, 'snooze': {}, 'avatars': {}, 'settings': {'avatars': False}, 'demo': False, 'lastSync': None}
    S.update(extra or {}); return S

hits = []
def setup(b, w=1280, hh=900, S=None, init=None):
    c = b.new_context(viewport={'width': w, 'height': hh}); pg = c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    if S is not None: pg.add_init_script("if(!localStorage.getItem('dotamate.v1'))localStorage.setItem('dotamate.v1',%s)" % json.dumps(json.dumps(S)))
    if init: pg.add_init_script(init)
    def to_mock(r):
        path = r.request.url.split('api.opendota.com/api', 1)[1]; hits.append(path)
        try: r.fulfill(status=200, body=urllib.request.urlopen(f'http://127.0.0.1:{mock_port}{path}', timeout=5).read(), headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})
        except Exception: r.abort()
    pg.route('https://api.opendota.com/**', to_mock)
    pg.route('**/*', lambda r: r.abort() if ('fonts.g' in r.request.url or 'steamstatic' in r.request.url) else r.fallback())
    return c, pg, errs
def overflow(pg): return pg.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])

    # ---------- главная и меню ----------
    c, pg, errs = setup(b, S=state()); pg.goto(URL); pg.wait_for_selector('.tile')
    check('приветствие с именем', 'Роман' in pg.inner_text('.home-hero h1'), pg.inner_text('.home-hero h1'))
    check('на главной шесть плиток разделов', pg.locator('.tile').count() == 6)
    check('четыре показателя, винрейт 50%', pg.locator('.kpi').count() == 4 and '50%' in pg.inner_text('.kpis'), pg.inner_text('.kpis'))
    check('в шапке семь вкладок и поиск', pg.locator('.top .tabs .tab').count() == 7 and pg.locator('.srch').count() == 1)
    pg.click('.tile[data-p=draft]'); pg.wait_for_selector('#dr-board'); check('плитка «Драфт» ведёт на драфт', 'Драфт' in pg.inner_text('.tabs [aria-current=page]'))
    for w in (1280, 1100, 1024):
        c.close(); c, pg, errs = setup(b, w=w, S=state())
        for tab, sel in [('Главная', '.tile'), ('Матчи', '#mlist'), ('Игроки', '#plist'), ('Драфт', '#dr-board'), ('Настройки', '.card')]:
            pg.goto(URL) if tab == 'Главная' else pg.click(f'.tabs [data-p={ {"Матчи":"matches","Игроки":"players","Драфт":"draft","Настройки":"settings"}[tab] }]')
            pg.wait_for_selector(sel); pg.wait_for_timeout(150)
            ov = overflow(pg); check(f'ширина {w}: «{tab}» без горизонтальной прокрутки', ov <= 0, ov)
    c.close()
    c, pg, errs = setup(b, w=1100, S=state()); pg.goto(URL); pg.wait_for_selector('.tile')
    check('на ширине 1100 вкладки только с иконками, названия в aria-label', not pg.locator('.top .tabs .tab span').first.is_visible() and pg.get_attribute('.top .tabs .tab >> nth=2', 'aria-label') == 'Игроки')
    c.close()

    # ---------- телефон: «Ещё» ----------
    c, pg, errs = setup(b, 390, 800, S=state()); pg.goto(URL); pg.wait_for_selector('.tile')
    check('телефон: пять пунктов нижнего меню', pg.locator('#nav .tab').count() == 5)
    tops = pg.evaluate("()=>[...document.querySelectorAll('#nav .tab')].map(t=>Math.round(t.getBoundingClientRect().top))"); check('телефон: меню в один ряд', len(set(tops)) == 1, tops)
    pg.click('#nav [data-a=more]'); pg.wait_for_selector('#nav .more')
    check('«Ещё» содержит Профиль, Репутацию, Настройки и поиск', all(x in pg.inner_text('#nav .more') for x in ['Профиль', 'Репутация', 'Настройки', 'Быстрый поиск']))
    check('при открытом «Ещё» кнопка помощника скрыта', not pg.locator('#as-root').first.is_visible())
    pg.click('#nav .more [data-p=settings]'); pg.wait_for_selector('#set-steam')
    check('после перехода «Ещё» закрыто и подсвечено', pg.locator('#nav .more').count() == 0 and pg.get_attribute('#nav [data-a=more]', 'aria-current') == 'page')
    pg.click('#nav [data-a=more]'); pg.click('.pagehead h1'); check('клик вне меню закрывает «Ещё»', pg.locator('#nav .more').count() == 0)
    check('телефон: настройки без горизонтальной прокрутки', overflow(pg) <= 0, overflow(pg))
    check('без JS-ошибок (меню)', not errs, errs[:2]); c.close()

    # ---------- быстрый поиск ----------
    c, pg, errs = setup(b, S=state(), init="localStorage.setItem('dotamate.perf.v1',JSON.stringify({v:1,auto:false,m:{},b:{}}))"); pg.goto(URL); pg.wait_for_selector('.tile')
    pg.keyboard.press('Control+k'); pg.wait_for_selector('.qk'); check('Ctrl+K открывает быстрый поиск, фокус в поле', pg.evaluate("document.activeElement.tagName") == 'INPUT')
    check('без запроса есть разделы и действия', 'Драфт' in pg.inner_text('.qk') and 'Синхронизировать матчи' in pg.inner_text('.qk'))
    pg.keyboard.type('3003'); pg.wait_for_timeout(100)
    check('поиск по Steam ID находит игрока', 'Player 3003' in pg.inner_text('.qk-list'))
    pg.keyboard.press('Enter'); pg.wait_for_selector('.profile-h')
    check('Enter открывает карточку игрока, окно поиска закрыто', 'Player 3003' in pg.inner_text('.profile-h') and pg.locator('.qk').count() == 0)
    pg.keyboard.press('/'); pg.wait_for_selector('.qk'); check('«/» открывает поиск', True)
    pg.keyboard.type('драф'); pg.keyboard.press('ArrowDown'); pg.keyboard.press('ArrowUp'); pg.keyboard.press('Enter'); pg.wait_for_selector('#dr-board')
    check('поиск «драф» ведёт в раздел драфта', 'Драфт' in pg.locator('.tabs [aria-current=page]').inner_text())
    pg.keyboard.press('Control+k'); pg.wait_for_selector('.qk'); pg.keyboard.press('Escape'); check('Esc закрывает поиск', pg.locator('.qk').count() == 0)
    pg.click('.tabs [data-p=settings]'); pg.click('#pnote') if pg.locator('#pnote').count() else pg.click('#set-name'); pg.keyboard.type('/')
    check('«/» в поле ввода пишет символ, а не открывает поиск', pg.locator('.qk').count() == 0 and pg.input_value('#set-name').endswith('/'))
    pg.keyboard.press('Control+k'); pg.wait_for_selector('.qk'); pg.keyboard.type('76561198000001234'); pg.wait_for_timeout(100)
    check('вставленный SteamID64 предлагает открыть профиль', 'Открыть профиль игрока' in pg.inner_text('.qk-list'), pg.inner_text('.qk-list'))
    pg.keyboard.press('Escape')
    check('без JS-ошибок (поиск)', not errs, errs[:2]); c.close()

    # ---------- подсказки ----------
    c, pg, errs = setup(b, S=state(), init="localStorage.setItem('dotamate.perf.v1',JSON.stringify({v:1,auto:false,m:{},b:{}}))"); pg.goto(URL); pg.wait_for_selector('.tile')
    pg.hover('.tabs [data-p=players]'); pg.wait_for_selector('#dm-tip.on', timeout=3000)
    check('подсказка у вкладки «Игроки» появляется при наведении', 'теги' in pg.inner_text('#dm-tip'), pg.inner_text('#dm-tip'))
    r = pg.evaluate("(()=>{const t=document.querySelector('#dm-tip').getBoundingClientRect();return [t.left,t.top,t.right,innerWidth,t.bottom,innerHeight]})()")
    check('подсказка целиком в окне', r[0] >= 0 and r[2] <= r[3] and r[1] >= 0 and r[4] <= r[5], r)
    pg.mouse.move(5, 500); pg.wait_for_timeout(200); check('подсказка исчезает, когда курсор уходит', pg.locator('#dm-tip.on').count() == 0)
    pg.hover('[data-a=sync] >> nth=0'); pg.wait_for_selector('#dm-tip.on'); check('подсказка у кнопки синхронизации', 'OpenDota' in pg.inner_text('#dm-tip'))
    pg.hover('.kpi >> nth=1'); pg.wait_for_timeout(600); check('подсказка у показателя (data-tip)', '20' in pg.inner_text('#dm-tip'), pg.inner_text('#dm-tip'))
    pg.hover('.mrow .av >> nth=0'); pg.wait_for_timeout(700)
    check('родной title заменён нашей подсказкой (атрибута title не осталось)', pg.get_attribute('.mrow .av >> nth=0', 'title') is None and pg.locator('#dm-tip.on').count() == 1)
    pg.mouse.move(5, 500); pg.keyboard.press('Tab')
    pg.evaluate("document.querySelector('.tabs [data-p=matches]').focus()"); pg.keyboard.press('Shift+Tab'); pg.keyboard.press('Tab'); pg.wait_for_selector('#dm-tip.on', timeout=3000)
    check('подсказка показывается при фокусе с клавиатуры', 'матчи' in pg.inner_text('#dm-tip').lower(), pg.inner_text('#dm-tip'))
    pg.keyboard.press('Escape'); check('Esc скрывает подсказку', pg.locator('#dm-tip.on').count() == 0)
    # словарь по id и тексту
    pg.click('.tabs [data-p=matches]'); pg.hover('#f-res'); pg.wait_for_selector('#dm-tip.on'); check('подсказка у фильтра по id', 'победы' in pg.inner_text('#dm-tip').lower())
    pg.click('.tabs [data-p=players]'); pg.hover('.sx-tab[data-t=unrated]'); pg.wait_for_selector('#dm-tip.on'); check('подсказка у вкладки «Без оценки»', 'не поставили' in pg.inner_text('#dm-tip'), pg.inner_text('#dm-tip'))
    check('без JS-ошибок (подсказки)', not errs, errs[:2]); c.close()

    # словарь: у каждого интерактивного элемента на основных страницах есть подсказка или он самоочевиден (список из аудита)
    c, pg, errs = setup(b, S=state(), init="localStorage.setItem('dotamate.perf.v1',JSON.stringify({v:1,auto:false,m:{},b:{}}))"); pg.goto(URL); pg.wait_for_selector('.tile')
    JS = """()=>{const miss=[];const sel='button[data-a],select,input:not([type=checkbox]),textarea';document.querySelectorAll(sel).forEach(e=>{const r=e.getBoundingClientRect();if(!r.width)return;if(!window.DMTips.find(e))miss.push((e.dataset.a||e.id||e.tagName)+':'+(e.innerText||'').trim().slice(0,20))});return miss}"""
    miss_all = {}
    for tab, key in [('Главная', 'dash'), ('Матчи', 'matches'), ('Игроки', 'players'), ('Драфт', 'draft'), ('Настройки', 'settings')]:
        pg.click(f'.tabs [data-p={key}]'); pg.wait_for_timeout(300); miss_all[tab] = pg.evaluate(JS)
    for tab, m in miss_all.items(): check(f'страница «{tab}»: у всех кнопок и полей есть подсказка', not m, m[:6])
    pg.click('.tabs [data-p=matches]'); pg.click('.mrow >> nth=0'); pg.wait_for_selector('.arow'); m1 = pg.evaluate(JS); check('окно матча: у кнопок есть подсказки', not m1, m1[:6])
    pg.click('[data-a=review] >> nth=0'); pg.wait_for_selector('#rv-note'); m2 = pg.evaluate(JS); check('окно оценки: у кнопок и полей есть подсказки', not m2, m2[:6])
    c.close()

    # ---------- автооценка по игре ----------
    hits.clear()
    c, pg, errs = setup(b, S=state()); pg.goto(URL); pg.wait_for_selector('.tile')
    until(pg, "DMPerfUI.state().st==='done'", 40000)
    check('анализ запустился сам, без нажатия кнопки', True)
    nm = [x for x in hits if x.startswith('/matches/')]; nb = [x for x in hits if x.startswith('/benchmarks')]
    check('загружены 4 матча и бенчмарки героев (по одному запросу на героя)', len(nm) == 4 and len(nb) == len(set(nb)) and len(nb) >= 5, (len(nm), nb))
    check('на главной статус: «Готово»', 'Готово' in pg.inner_text('.home-hero'), pg.inner_text('.home-hero'))
    pg.click('.tabs [data-p=players]'); pg.wait_for_selector('#plist .prow')
    chips = pg.locator('#plist .pf-chip').count(); check('в списке игроков у каждого есть значок оценки по игре', chips == 4, chips)
    pg.select_option('#sort', 'auto'); pg.wait_for_timeout(200)
    names = pg.locator('#plist .pname').all_inner_texts()
    vals = pg.evaluate("()=>[...document.querySelectorAll('#plist .prow')].map(r=>parseFloat(r.querySelector('.pf-chip').textContent))")
    check('сортировка «По оценке по игре» — по убыванию', vals == sorted(vals, reverse=True) and len(vals) == 4, vals)
    check('самый слабый (22 смерти) оказался последним', names[-1] == 'Player 2002', names)
    tip = pg.get_attribute('#plist .pf-chip >> nth=0', 'data-tip'); check('подсказка значка объясняет, что оценка по цифрам, а не по поведению', 'не по поведению' in tip, tip)
    nprof = pg.locator('#plist .prow-prof').count(); check('справа в каждой строке игрока есть кнопка «Профиль»', nprof == 4, nprof)
    ptip = pg.get_attribute('#plist .prow-prof >> nth=0', 'data-tip'); check('у кнопки «Профиль» есть подсказка', bool(ptip) and 'профиль' in ptip.lower(), ptip)
    sid0 = pg.get_attribute('#plist .prow-prof >> nth=0', 'data-id')
    pg.click('#plist .prow-prof >> nth=0'); pg.wait_for_selector('#me-root')
    check('кнопка открывает профиль игрока (адрес #/profile/ID)', ('#/profile/' + sid0) in pg.url, pg.url)
    pg.click('.tabs [data-p=players]'); pg.wait_for_selector('#plist .prow')
    pg.click('#plist .prow >> nth=0'); pg.wait_for_selector('.pf-card')
    t = pg.inner_text('.pf-card')
    check('карточка игрока: итог, вердикт и список матчей', 'из 5' in t and ('игра' in t) and t.count('gpm') == 4, t[:300])
    pg.click('.pf-how summary'); check('«Как считается» раскрывается и называет ограничения', 'не знает' in pg.inner_text('.pf-how') or 'Общение' in pg.inner_text('.pf-how'))
    pg.click('.tabs [data-p=matches]'); pg.click('.mrow >> nth=0'); pg.wait_for_selector('.arow')
    check('в окне матча значки оценок есть у каждого из 9 игроков', pg.locator('.arow .pf-chip').count() == 9, pg.locator('.arow .pf-chip').count())
    check('у скрытых игроков есть кнопка «Карточка»', pg.locator('.arow:has-text("Скрытый игрок") [data-a=pf-card]').count() == 5)
    pg.click('.arow:has-text("Скрытый игрок") [data-a=pf-card] >> nth=0'); pg.wait_for_selector('.pf-parts')
    ct = pg.inner_text('#modal .panel')
    check('карточка скрытого игрока: герой, оценка, разбор и пояснение про скрытый профиль', 'Скрытый игрок' in ct and 'Вклад по меркам героя' in ct and 'скрыл профиль' in ct and 'К / С / П' in ct, ct[:200])
    pg.click('#modal [data-a=openMatch]'); pg.wait_for_selector('.arow'); check('«К матчу» возвращает в состав', pg.locator('.arow').count() >= 9)
    check('без JS-ошибок (автооценка)', not errs, errs[:2])
    # повторная загрузка: кэш, ни одного запроса за подробностями
    hits.clear(); pg.reload(); pg.wait_for_selector('.tile'); pg.wait_for_timeout(3500)
    check('после перезагрузки данные берутся из кэша: запросов подробностей нет', not [x for x in hits if x.startswith('/matches/') or x.startswith('/benchmarks')], hits[:4])
    # настройки: отключение и очистка
    pg.click('.tabs [data-p=settings]'); pg.wait_for_selector('#pf-auto'); check('в настройках есть переключатель автоанализа (включён)', pg.is_checked('#pf-auto'))
    pg.uncheck('#pf-auto'); pg.wait_for_timeout(600); check('переключатель сохраняется в кэше', json.loads(pg.evaluate("localStorage.getItem('dotamate.perf.v1')") or '{}').get('auto') is False)
    pg.click('[data-a=pf-clear]'); pg.wait_for_timeout(300)
    check('«Очистить кэш» убирает оценки из списка игроков', pg.evaluate("Object.keys(DMPerfUI.cache().m).length") == 0)
    c.close()

    # автоанализ выключен: запросов нет, ручной запуск работает
    hits.clear()
    c, pg, errs = setup(b, S=state(), init="localStorage.setItem('dotamate.perf.v1',JSON.stringify({v:1,auto:false,m:{},b:{}}))"); pg.goto(URL); pg.wait_for_selector('.tile'); pg.wait_for_timeout(4000)
    check('при выключенном автоанализе запросов к OpenDota нет', not [x for x in hits if x.startswith('/matches/') or x.startswith('/benchmarks')], hits[:3])
    pg.click('.home-hero [data-a=pf-scan]'); until(pg, "DMPerfUI.state().st==='done'", 40000); check('кнопка «Проанализировать» запускает анализ вручную', len([x for x in hits if x.startswith('/matches/')]) == 4)
    c.close()

    # новый матч из JSON OpenDota: статистика уже в ответе, лишних запросов нет
    hits.clear()
    detail = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{mock_port}/matches/7000000005').read())
    c, pg, errs = setup(b, S=state(0), init="localStorage.setItem('dotamate.perf.v1',JSON.stringify({v:1,auto:false,m:{},b:{}}))"); pg.goto(URL); pg.wait_for_selector('.tile')
    pg.click('.hero-x, [data-a=add] >> nth=0'); pg.wait_for_selector('[data-a=tab][data-t=link]'); pg.click('[data-a=tab][data-t=link]'); pg.fill('#m-json', json.dumps(detail)); pg.click('[data-a=importJson]'); pg.wait_for_selector('.arow')
    check('импорт матча из JSON сохраняет статистику без запроса подробностей', pg.evaluate("Object.keys(DMPerfUI.cache().m)") == ['7000000005'] and not [x for x in hits if x.startswith('/matches/')], hits)
    check('без JS-ошибок (импорт)', not errs, errs[:2]); c.close()
    b.close()

mock.terminate()
print(f'\nИтого: {len(passes)} пройдено, {len(fails)} не пройдено')
sys.exit(1 if fails else 0)
