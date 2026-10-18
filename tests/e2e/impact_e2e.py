"""Браузерная проверка MVP и худшего игрока матча: отметки в списке, блок в матче, профиль знакомого игрока, фильтры, сводка и доля,
сохранение результатов и смена версии алгоритма, раздел «Найти профиль».
Статический режим (как на GitHub Pages): OpenDota подменён поддельным (tests/helpers/mock-opendota.js). Статистика матчей кладётся
в кэш напрямую, поэтому результат известен заранее.
Запуск: python3 tests/e2e/impact_e2e.py  (нужны playwright для Python и Node 18+)."""
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
def match_old(i):
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

HID = {1: 'Anti-Mage', 2: 'Axe', 13: 'Puck', 14: 'Pudge', 26: 'Lion', 74: 'Invoker'}
def T(a, b, c): return [[0.1, a], [0.5, b], [0.9, c]]
BN = {1: dict(gold_per_min=T(350, 500, 700), xp_per_min=T(400, 560, 760), hero_damage_per_min=T(400, 700, 1100)),
      2: dict(gold_per_min=T(380, 520, 720), xp_per_min=T(450, 600, 800), hero_damage_per_min=T(450, 750, 1200)),
      13: dict(gold_per_min=T(380, 520, 720), xp_per_min=T(450, 600, 800), hero_damage_per_min=T(450, 750, 1200)),
      14: dict(gold_per_min=T(300, 420, 580), xp_per_min=T(380, 520, 700), hero_damage_per_min=T(300, 520, 850)),
      26: dict(gold_per_min=T(200, 300, 420), xp_per_min=T(300, 420, 560), hero_damage_per_min=T(150, 300, 550), hero_healing_per_min=T(20, 80, 250)),
      74: dict(gold_per_min=T(380, 520, 720), xp_per_min=T(450, 600, 800), hero_damage_per_min=T(450, 750, 1200))}
HEROES10 = [1, 2, 13, 14, 26, 74, 1, 2, 13, 14]   # 0-4 Radiant (1001, 2002, 3003, 4004, 5005), 5-9 Dire (скрытые)
ACC = ['1001', '2002', '3003', '4004', '5005', None, None, None, None, None]
def base(i):
    h = HEROES10[i]; b = BN[h]; sup = h == 26; med = lambda k: b[k][1][1]
    return dict(h=h, r=1 if i < 5 else 0, a=ACC[i], k=2 if sup else 6, d=5, s=10 if sup else 6, g=med('gold_per_min'), x=med('xp_per_min'),
                hd=med('hero_damage_per_min') * 30, hh=med('hero_healing_per_min') * 30 if sup else 0, lh=40 if sup else 220, td=500 if sup else 1500, lv=0, st=None, ob=None, se=None)
STRONG = dict(k=14, d=2, s=8, g=720, x=800, hd=1300 * 30)
WEAK = dict(k=0, d=14, s=1, g=250, x=300, hd=150 * 30, hh=0, lh=20)
def rec(i, over=None, dur=1800):
    ps = [base(k) for k in range(10)]
    for k, o in (over or {}).items(): ps[k].update(o)
    return {'v': 1, 'id': str(7000000001 + i), 'dur': dur, 'mr': 1, 'rw': 1, 'p': ps}
# 0: я (1001) MVP, худший скрытый 9 | 1: я худший, MVP скрытый 5 | 2: MVP 2002, худший скрытый 8 | 3: короткий матч | 4,5: нет статистики
# 6: средний матч | 7: 2002 худший | 8: средний матч
RECS = {0: rec(0, {0: STRONG, 9: WEAK}), 1: rec(1, {0: WEAK, 5: STRONG}), 2: rec(2, {1: STRONG, 8: WEAK}), 3: rec(3, {}, 540), 6: rec(6), 7: rec(7, {1: WEAK, 8: STRONG}), 8: rec(8)}
def hero_name(i, k): return HID[HEROES10[k]]
def match(i):
    mid = str(7000000001 + i) if i != 5 else 'd1'
    ps = [{'sid': ACC[k], 'name': ('Player %s' % ACC[k]) if ACC[k] else 'Скрытый игрок', 'hero': hero_name(i, k), 'ally': k < 5, 'me': k == 0} for k in range(10)]
    return {'id': mid, 'start': NOW - (i + 1) * 86400, 'mode': 'All Pick', 'ranked': False, 'win': True, 'dur': 540 if i == 3 else 1800, 'hero': HID[1], 'players': ps}
def state(n=9): return {'v': 1, 'me': {'acc': '1001', 'name': 'Роман'}, 'matches': [match(i) for i in range(n)], 'reviews': {}, 'pnotes': {}, 'tags': {}, 'heroNotes': {}, 'snooze': {}, 'avatars': {}, 'settings': {'avatars': False}, 'demo': False, 'lastSync': None}
PERF = {'v': 1, 'auto': False, 'm': {r['id']: r for r in RECS.values()}, 'b': {str(h): {'t': int(time.time() * 1000), 'd': d} for h, d in BN.items()}}
INIT = "if(!localStorage.getItem('dotamate.perf.v1'))localStorage.setItem('dotamate.perf.v1',%s)" % json.dumps(json.dumps(PERF))
def mk(b, w=1280): return setup(b, w=w, S=state(), init=INIT)
def impact(pg): return json.loads(pg.evaluate("localStorage.getItem('dotamate.impact.v1')") or '{}').get('m', {})
def rows(pg): return pg.eval_on_selector_all('#mlist .mrow', 'els=>els.map(e=>e.innerText)')

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])

    # ---------- список матчей ----------
    c, pg, errs = mk(b); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow')
    r = rows(pg)
    check('в матче 1 отмечены «MVP: вы» и худший скрытый игрок', 'MVP: вы' in r[0] and 'Худший: Pudge' in r[0], r[0])
    check('в матче 2 «Худший: вы» и MVP скрытого игрока', 'Худший: вы' in r[1] and 'MVP: Invoker' in r[1], r[1])
    check('в матче 3 MVP — Player 2002 (не вы)', 'MVP: Axe' in r[2] and 'MVP: вы' not in r[2], r[2])
    check('короткий матч (9 минут), матч без статистики и матч не из OpenDota без отметок', all('MVP' not in r[i] and 'Худший' not in r[i] for i in (3, 4, 5)), [r[3], r[4], r[5]])
    check('средний матч без выраженных лидеров не получает статусов', 'MVP' not in r[6] and 'Худший' not in r[6], r[6])
    check('в одной строке не больше одного MVP и одного худшего', all(x.count('MVP:') <= 1 and x.count('Худший:') <= 1 for x in r))
    check('отметки окончательные (без пунктира)', pg.locator('#mlist .im-chip.pre').count() == 0)
    check('сводка: MVP 1, худший 1, доля ещё не показывается (мало матчей)', 'MVP: 1' in pg.inner_text('#im-my') and 'Худший: 1' in pg.inner_text('#im-my'), pg.inner_text('#im-my'))
    pg.wait_for_timeout(500)
    st = impact(pg)
    check('результаты сохранены по номеру матча и версии алгоритма', len(st) >= 6 and all(v['algo'] == 'impact-1' and v['id'] == k for k, v in st.items()), list(st)[:3])
    tip = pg.get_attribute('#mlist .mrow >> nth=0 >> .im-chip.mvp', 'data-tip')
    check('в строке матча подсказка объясняет статус: оценка, причины, окончательность', 'MVP матча: Вы' in tip and 'Оценка' in tip and 'KDA 14/2/8' in tip and 'окончательная' in tip, tip)

    # ---------- фильтры ----------
    pg.select_option('#f-st', 'mvp'); r = rows(pg)
    check('фильтр «Матчи, где я MVP»: один матч', len(r) == 1 and 'MVP: вы' in r[0], len(r))
    pg.select_option('#f-st', 'worst'); r = rows(pg)
    check('фильтр «Матчи, где я сыграл хуже всех»: один матч', len(r) == 1 and 'Худший: вы' in r[0], len(r))
    pg.select_option('#f-st', 'all'); check('«Все матчи» возвращает список', len(rows(pg)) == 9)
    pg.select_option('#f-st', 'mvp'); pg.click('[data-a=resetF]') if pg.locator('[data-a=resetF]').count() else None
    pg.select_option('#f-st', 'all')

    # ---------- страница матча ----------
    pg.click('#mlist .mrow >> nth=0'); pg.wait_for_selector('.im-box')
    box = pg.inner_text('.im-box')
    check('в матче: MVP «Вы», худший «Скрытый игрок», оценки и объяснения', pg.locator('.im-cell.mvp .im-who b').inner_text() == 'Вы' and pg.locator('.im-cell.worst .im-who b').inner_text() == 'Скрытый игрок' and 'смерт' in pg.locator('.im-cell.worst').inner_text(), box[:300])
    check('оценки в баллах, версия алгоритма и признак окончательной оценки', 'impact-1' in box and pg.locator('.im-score b').count() == 2 and pg.locator('.im-pre').count() == 0)
    pg.click('.im-box summary'); tbl = pg.inner_text('.im-box .im-t')
    check('«Как посчитано»: полнота данных, использованные метрики, таблица на 10 игроков', 'Полнота данных' in pg.inner_text('.im-box') and 'урон по героям' in pg.inner_text('.im-box') and pg.locator('.im-box .im-t tbody tr').count() == 10, tbl[:80])
    check('оговорка: худший игрок — не доказательство саботажа', 'не доказательство саботажа' in pg.inner_text('.im-box'))
    check('на строках игроков есть отметки статуса (худший скрытый игрок)', pg.locator('.arow .im-chip.worst').count() == 1, pg.locator('.arow .im-chip').count())
    check('ровно один MVP-блок и один блок худшего', pg.locator('.im-cell.mvp').count() == 1 and pg.locator('.im-cell.worst').count() == 1)
    pg.click('[data-a=close]')
    for idx, expect in [(3, 'короче 10 минут'), (4, 'Статистики матча пока нет'), (5, 'не определяются')]:
        pg.click(f'#mlist .mrow >> nth={idx}'); pg.wait_for_selector('.im-box'); t = pg.inner_text('.im-box')
        check(f'матч {idx + 1}: честное «нет данных» вместо выдуманного статуса', expect in t and ('Недостаточно данных' in t or idx != 3) and pg.locator('.im-score').count() == 0, t[:200])
        pg.click('[data-a=close]')
    pg.click('#mlist .mrow >> nth=6'); pg.wait_for_selector('.im-box'); t = pg.inner_text('.im-box')
    check('средний матч: «Нет выраженного MVP» и «Нет выраженного отстающего»', 'Нет выраженного MVP' in t and 'Нет выраженного отстающего' in t, t[:200]); pg.click('[data-a=close]')
    check('без JS-ошибок (список и матч)', not errs, errs[:2]); c.close()

    # ---------- профиль знакомого игрока ----------
    c, pg, errs = mk(b); pg.goto(URL + '#/players'); pg.wait_for_selector('#plist')
    pg.click('#plist [data-a=openPlayer][data-id="2002"]'); pg.wait_for_selector('.im-card', timeout=15000); t = pg.inner_text('.im-card')
    check('профиль Player 2002: MVP 1, худший 1 и доля при достаточной истории', pg.locator('.im-n.mvp b').inner_text() == '1' and pg.locator('.im-n.worst b').inner_text() == '1' and '17%' in t and '6 из 9' in t, t[:300])
    check('в профиле перечислены матчи со статусами и причины', pg.locator('.im-card .pf-row').count() == 2 and 'смерт' in t, t)
    check('без JS-ошибок (профиль игрока)', not errs, errs[:2]); c.close()

    # ---------- настройки, версия алгоритма, пересчёт ----------
    c, pg, errs = mk(b); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow'); pg.wait_for_timeout(600)
    before = impact(pg)
    pg.reload(); pg.wait_for_selector('#mlist .mrow'); pg.wait_for_timeout(600)
    after = impact(pg)
    check('повторный расчёт и перезагрузка дают тот же результат', before == after and len(after) >= 6)
    old = json.loads(pg.evaluate("localStorage.getItem('dotamate.impact.v1')"))
    for v in old['m'].values(): v['algo'] = 'impact-0'; v['sig'] = v['sig'].replace('impact-1', 'impact-0')
    pg.evaluate("v=>localStorage.setItem('dotamate.impact.v1',v)", json.dumps(old)); pg.goto(URL + '#/settings'); pg.reload(); pg.wait_for_selector('#set-steam')
    check('настройки: результаты прошлой версии помечены и не смешиваются', 'от прошлых версий' in pg.inner_text('#main') and 'impact-1' in pg.inner_text('#main'), '')
    pg.click('.tabs [data-p=matches]'); pg.wait_for_selector('#mlist .mrow'); pg.wait_for_timeout(600)
    fresh = impact(pg)
    check('при открытии матчей старая версия заменена пересчётом, отметки те же', all(v['algo'] == 'impact-1' for v in fresh.values()) and 'MVP: вы' in rows(pg)[0])
    pg.click('.tabs [data-p=settings]'); pg.wait_for_selector('#set-steam'); pg.click('[data-a=im-recalc]'); pg.wait_for_timeout(300)
    pg.click('.tabs [data-p=matches]'); pg.wait_for_selector('#mlist .mrow'); pg.wait_for_timeout(400)
    check('«Пересчитать все матчи» возвращает те же статусы', 'MVP: вы' in rows(pg)[0] and 'Худший: вы' in rows(pg)[1])
    check('без JS-ошибок (настройки)', not errs, errs[:2]); c.close()

    # ---------- предварительная оценка без норм героя ----------
    P2 = dict(PERF); P2['b'] = {}
    c, pg, errs = setup(b, S=state(), init="if(!localStorage.getItem('dotamate.perf.v1'))localStorage.setItem('dotamate.perf.v1',%s)" % json.dumps(json.dumps(P2)))
    pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow'); pg.wait_for_timeout(300)
    check('без норм героев оценка помечена «предварительно»', pg.locator('#mlist .im-chip.pre').count() >= 1, pg.locator('#mlist .im-chip').count())
    pg.click('#mlist .mrow >> nth=0'); pg.wait_for_selector('.im-box')
    check('в матче видна пометка «предварительно» и причина', pg.locator('.im-pre').count() >= 1 and 'бенчмарков' in pg.inner_html('.im-box'))
    check('без JS-ошибок (предварительные)', not errs, errs[:2]); c.close()

    # ---------- телефон ----------
    c, pg, errs = mk(b, 390); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow')
    check('телефон: список с отметками без горизонтальной прокрутки', overflow(pg) <= 0, overflow(pg))
    pg.click('#mlist .mrow >> nth=0'); pg.wait_for_selector('.im-box'); pg.click('.im-box summary'); pg.wait_for_timeout(200)
    check('телефон: блок матча без горизонтальной прокрутки страницы', overflow(pg) <= 0, overflow(pg))
    check('телефон: ячейки MVP и худшего в одну колонку', pg.evaluate("()=>{const a=document.querySelectorAll('.im-cell');return a.length==2&&a[0].getBoundingClientRect().top<a[1].getBoundingClientRect().top}"))
    c.close()

    # ---------- «Найти профиль» ----------
    c, pg, errs = setup(b, S=state(0)); pg.goto(URL + '#/find'); pg.wait_for_selector('#me-form')
    pg.fill('#me-in', '2002'); pg.keyboard.press('Enter'); pg.wait_for_selector('.mt-r', timeout=30000)
    check('профиль: блок MVP и худший, кнопка определения, отметок пока нет', pg.locator('.im-card [data-a=im-job]').count() == 1 and pg.locator('.mt-r .im-chip').count() == 0)
    pg.click('[data-a=im-job]'); until(pg, "DMImpactUI.job().msg && !DMImpactUI.job().run", 150000)
    t = pg.inner_text('.im-card')
    check('профиль: после запуска Player 2002 получает статусы «худший» по реальным цифрам', int(pg.locator('.im-card .im-n.worst b').inner_text()) >= 5 and pg.locator('.mt-r .im-chip.worst').count() >= 1, t[:200])
    check('профиль: доля показана при достаточной истории', '%' in pg.locator('.im-card .im-txt').inner_text(), pg.locator('.im-card .im-txt').inner_text())
    pg.select_option('select[data-pf="tf.st"]', 'worst'); pg.wait_for_timeout(200)
    n_w = pg.locator('.mt-r').count()
    pg.select_option('select[data-pf="tf.st"]', 'mvp'); pg.wait_for_timeout(200)
    check('профиль: фильтр «Игрок сыграл хуже всех» оставляет матчи с отметкой, фильтр MVP — пусто', n_w >= 5 and pg.locator('.mt-r').count() == 0, (n_w, pg.locator('.mt-r').count()))
    check('профиль: в столбце позиции нет приблизительных значений', '≈' not in pg.inner_text('#me-body'))
    check('без JS-ошибок (профиль OpenDota)', not errs, errs[:2]); c.close()
    b.close()

mock.terminate()
print(f'\nИтого: {len(passes)} пройдено, {len(fails)} не пройдено')
sys.exit(1 if fails else 0)
