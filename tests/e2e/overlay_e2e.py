"""Браузерная проверка Live Draft Overlay с настоящим мостом (tools/gsi-bridge.js) и поддельным OpenDota (tests/helpers/mock-opendota.js).
Пакеты GSI отправляются на мост так же, как это делает Dota 2: POST /gsi с токеном. Запуск: python3 tests/e2e/overlay_e2e.py [--shots DIR]"""
import os, sys, json, time, socket, functools, threading, subprocess, urllib.request, http.server
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = sys.argv[sys.argv.index('--shots') + 1] if '--shots' in sys.argv else None
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
OFF = 76561197960265728
def sid(acc): return str(OFF + acc)

mock_port, bridge_port = free_port(), free_port()
TOKEN = 'e2e-token-123456'
mock = subprocess.Popen(['node', os.path.join(ROOT, 'tests/helpers/mock-opendota.js'), str(mock_port)], stdout=subprocess.DEVNULL)
def start_bridge():
    return subprocess.Popen(['node', os.path.join(ROOT, 'tools/gsi-bridge.js'), '--port', str(bridge_port), '--token', TOKEN, '--quiet'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
bridge = start_bridge()
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message = lambda *a, **k: None
static = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h); threading.Thread(target=static.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{static.server_address[1]}/overlay.html'
def wait_http(url):
    for _ in range(80):
        try: urllib.request.urlopen(url, timeout=1); return
        except urllib.error.HTTPError: return
        except Exception: time.sleep(0.1)
wait_http(f'http://127.0.0.1:{mock_port}/heroes'); wait_http(f'http://127.0.0.1:{bridge_port}/status?t=x')

fails, passes = [], []
def check(name, cond, info=''):
    (passes if cond else fails).append(name); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if (info and not cond) else ''))
def until(pg, expr, timeout=15000):
    end = time.time() + timeout / 1000
    while time.time() < end:
        try:
            if pg.evaluate('()=>!!(' + expr + ')'): return True
        except Exception: pass
        time.sleep(0.05)
    raise TimeoutError('условие не выполнилось: ' + expr[:140])

def gsi(body, token=TOKEN):
    body = dict(body); body['auth'] = {'token': token}
    req = urllib.request.Request(f'http://127.0.0.1:{bridge_port}/gsi', data=json.dumps(body).encode(), method='POST', headers={'content-type': 'application/json'})
    try: return urllib.request.urlopen(req, timeout=3).status
    except urllib.error.HTTPError as e: return e.code

DRAFT = {'activeteam': 2, 'pick': True, 'activeteam_time_remaining': 20,
         'team2': {'home_team': True, 'pick0_id': 1, 'pick0_class': 'npc_dota_hero_antimage', 'ban0_id': 13, 'ban0_class': 'npc_dota_hero_puck'},
         'team3': {'home_team': False, 'pick0_id': 14, 'pick0_class': 'npc_dota_hero_pudge'}}
def local(acc, match='9100000001', name='Меня зовут Игрок', side='radiant', slot=1, extra=None):
    b = {'map': {'matchid': match, 'game_state': 'DOTA_GAMERULES_STATE_HERO_SELECTION'}, 'draft': DRAFT,
         'player': {'steamid': sid(acc), 'name': name, 'team_name': side, 'team_slot': slot}}
    if extra: b.update(extra)
    return b

hits = []
def setup(b, bridged=True, w=1200, hh=800):
    c = b.new_context(viewport={'width': w, 'height': hh}); pg = c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    if bridged: pg.add_init_script("if(!localStorage.getItem('dotamate.bridge.v1'))localStorage.setItem('dotamate.bridge.v1',JSON.stringify({host:'127.0.0.1:%d',token:'%s'}))" % (bridge_port, TOKEN))
    def to_mock(r):
        path = r.request.url.split('api.opendota.com/api', 1)[1]; hits.append(path)
        try: r.fulfill(status=200, body=urllib.request.urlopen(f'http://127.0.0.1:{mock_port}{path}', timeout=5).read(), headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})
        except urllib.error.HTTPError as e: r.fulfill(status=e.code, body=e.read(), headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})
        except Exception: r.abort()
    pg.route('https://api.opendota.com/**', to_mock)
    pg.route('**/*', lambda r: r.abort() if ('steamstatic' in r.request.url or 'fonts.g' in r.request.url) else r.fallback())
    return c, pg, errs
def shot(pg, name):
    if SHOTS: os.makedirs(SHOTS, exist_ok=True); pg.screenshot(path=os.path.join(SHOTS, name + '.png'))
def text(pg, sel='#ov-panel'): return pg.inner_text(sel)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])

    # ---------- без моста ----------
    c, pg, errs = setup(b, bridged=False); pg.goto(URL); pg.wait_for_selector('.ov-banner')
    check('без настроенного моста: понятное состояние «Bridge не подключён» и кнопка настроек', 'Bridge не подключён' in text(pg) and pg.locator('.ov-banner [data-a=ov-settings]').count() == 1)
    pg.click('.ov-banner [data-a=ov-settings]'); pg.wait_for_selector('.ov-set')
    pg.fill('.ov-set input[name=host]', 'evil.example.com:80'); pg.fill('.ov-set input[name=token]', 'x'); pg.click('.ov-set button[type=submit]')
    check('адрес не из localhost и короткий токен отклоняются', 'Адрес вида 127.0.0.1' in text(pg), text(pg)[:200])
    check('без JS-ошибок (нет моста)', not errs, errs[:2]); c.close()

    # ---------- свой Steam ID, остальные не идентифицированы ----------
    hits.clear()
    c, pg, errs = setup(b); pg.goto(URL); pg.wait_for_selector('.ov-status.ok, .ov-status', timeout=10000)
    until(pg, "DMOverlay.state().conn.status==='on'", 10000)
    check('мост подключён, матча ещё нет: «Жду матч»', 'Жду матч' in text(pg), text(pg)[:200])
    gsi(local(2002)); until(pg, "document.querySelectorAll('.ov-card').length===10", 10000)
    pg.wait_for_selector('.ov-card.me .ov-m', timeout=15000)
    check('две колонки Radiant и Dire, по пять карточек', pg.locator('.ov-team.radiant .ov-card').count() == 5 and pg.locator('.ov-team.dire .ov-card').count() == 5)
    check('одна карточка с Steam ID, девять «Игрок не идентифицирован»', pg.locator('.ov-card.st-identified').count() == 1 and pg.locator('text=Игрок не идентифицирован').count() == 9, pg.locator('.ov-card.st-identified').count())
    me = text(pg, '.ov-card.me')
    check('на своей карточке винрейт 57% (40 из 70) и K/D/A', '57%' in me and '70 игр' in me and 'K/D/A' in me, me)
    check('форма последних матчей нарисована', pg.locator('.ov-card.me .ov-form i').count() == 20)
    check('три любимых героя с играми и винрейтом', pg.locator('.ov-card.me .ov-hr').count() == 3)
    check('у игрока 2002 есть сигнал «требует проверки», без слов «руинер»', 'требует проверки' in me and 'руинер' not in text(pg).lower(), me)
    check('статус фазы и счётчик игроков в шапке', '1/10 игроков' in text(pg, '.ov-status'), text(pg, '.ov-status'))
    check('в карточке указан источник и время обновления', 'OpenDota' in me and 'Обновлено' in me)
    check('пики из драфта показаны у команд', pg.locator('.ov-team.radiant .ov-picks .ov-hi').count() == 1 and pg.locator('.ov-team.dire .ov-picks .ov-hi').count() == 1)
    shot(pg, 'overlay_compact')
    n1 = len([x for x in hits if x.startswith('/players/2002')])
    for _ in range(6): gsi(local(2002))
    pg.wait_for_timeout(1500)
    n2 = len([x for x in hits if x.startswith('/players/2002')])
    check('повторные события GSI не вызывают новых запросов по тому же игроку', n1 == n2 and n1 >= 3, (n1, n2))

    # ---------- подробности и сигналы ----------
    pg.click('.ov-card.me .ov-open'); pg.wait_for_selector('.ov-detail')
    d = text(pg, '.ov-detail')
    check('подробная панель: матчи с датой и результатом, источник и возраст данных', 'Последние матчи' in d and 'Источник: OpenDota' in d and pg.locator('.ov-detail .ml tbody tr').count() == 10, d[:200])
    check('в сигналах есть объяснение, выборка и «другие объяснения»', 'Необычно много смертей' in d and 'Другие объяснения' in d and 'выборка' in d, d[-700:])
    check('есть ссылка на матч-доказательство и на полный профиль', pg.locator('.ov-detail a[href*="opendota.com/matches/"]').count() >= 1 and pg.locator('.ov-detail a[href*="#/profile/2002"]').count() == 1)
    check('на герое с малой выборкой честно «недостаточно данных» или таблица сравнения', 'Недостаточно данных' in d or 'Обычно' in d)
    shot(pg, 'overlay_detail')
    pg.click('[data-a=ov-close-detail]'); check('панель подробностей закрывается', pg.locator('.ov-detail').count() == 0)

    # ---------- режимы, настройки, горячая клавиша ----------
    pg.click('[data-a=ov-mode]'); check('подробный режим добавляет строку про выборку', pg.locator('.ov-card.me .ov-fresh').count() >= 2 and 'в выборке' in text(pg, '.ov-card.me'))
    pg.click('[data-a=ov-settings]'); pg.wait_for_selector('.ov-set')
    pg.evaluate("(()=>{const i=document.querySelector('[data-s=m-form]');i.checked=false;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    check('метрику можно скрыть', pg.locator('.ov-card.me .ov-form').count() == 0)
    pg.evaluate("(()=>{const i=document.querySelector('[data-s=opacity]');i.value=60;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    check('прозрачность применяется', abs(float(pg.evaluate("getComputedStyle(document.querySelector('#ov-root')).getPropertyValue('--ov-op')")) - 0.6) < 0.01)
    pg.evaluate("(()=>{const i=document.querySelector('[data-s=scale]');i.value=120;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    check('масштаб применяется', abs(float(pg.evaluate("getComputedStyle(document.querySelector('#ov-root')).getPropertyValue('--ov-scale')")) - 1.2) < 0.01)
    pg.click('[data-a=ov-settings]')
    pg.click('[data-a=ov-collapse]'); check('панель сворачивается до шапки', pg.locator('.ov-card').count() == 0 and pg.locator('.ov-h').count() == 1)
    pg.click('[data-a=ov-collapse]'); check('и разворачивается', pg.locator('.ov-card').count() == 10)
    pg.keyboard.press('Alt+Shift+KeyD'); pg.wait_for_timeout(100)
    check('горячая клавиша скрывает панель', pg.locator('#ov-panel').is_hidden() and pg.locator('#ov-show').is_visible())
    pg.keyboard.press('Alt+Shift+KeyD'); pg.wait_for_timeout(100); check('и показывает снова', pg.locator('#ov-panel').is_visible())
    b0 = pg.evaluate("document.querySelector('#ov-panel').getBoundingClientRect().left")
    box = pg.locator('.ov-h').bounding_box(); pg.mouse.move(box['x'] + 100, box['y'] + 10); pg.mouse.down(); pg.mouse.move(box['x'] + 160, box['y'] + 60, steps=4); pg.mouse.up()
    b1 = pg.evaluate("document.querySelector('#ov-panel').getBoundingClientRect().left")
    check('панель перетаскивается за шапку', abs(b1 - b0) > 30, (b0, b1))
    pg.reload(); pg.wait_for_selector('.ov-h')
    check('настройки (режим, положение, скрытая метрика) сохраняются после перезагрузки', 'подробный' in pg.locator('[data-a=ov-mode]').inner_text() and abs(pg.evaluate("document.querySelector('#ov-panel').getBoundingClientRect().left") - b1) < 3)
    check('без JS-ошибок (свой ID)', not errs, errs[:2]); c.close()

    # ---------- режим наблюдателя: ID приходят с задержкой, приватный профиль, одинаковые ники ----------
    hits.clear()
    c, pg, errs = setup(b); pg.goto(URL); until(pg, "DMOverlay.state().conn.status==='on'", 10000)
    spec = lambda ids, **kw: {'map': {'matchid': '9100000002', 'game_state': 'DOTA_GAMERULES_STATE_HERO_SELECTION'}, 'draft': DRAFT, 'player': ids}
    gsi(spec({'team2': {'player0': {'steamid': sid(3003), 'name': 'Same'}, 'player1': {'name': 'Same'}}}))
    pg.wait_for_selector('.ov-card.st-identified', timeout=10000)
    check('наблюдатель: пока пришёл один ID, остальные «Ждём Steam ID», а не чужие данные', pg.locator('.ov-card.st-identified').count() == 1 and pg.locator('text=Ждём Steam ID').count() == 9, text(pg)[:300])
    gsi(spec({'team2': {'player0': {'steamid': sid(3003), 'name': 'Same'}, 'player1': {'steamid': sid(4004), 'name': 'Same'}}, 'team3': {'player0': {'steamid': sid(9999), 'name': 'Скрыт'}, 'player3': {'steamid': sid(9998), 'name': 'Нет'}}}))
    until(pg, "document.querySelectorAll('.ov-card.st-identified,.ov-card.st-private').length>=4", 20000)
    pg.wait_for_selector('.ov-card:has-text("3003") .ov-m', timeout=40000); pg.wait_for_selector('.ov-card.st-private', timeout=40000); pg.wait_for_timeout(300)
    names = pg.locator('.ov-card .ov-nm').all_inner_texts()
    check('два игрока с одинаковым ником остаются двумя разными карточками', names.count('Same') == 2, names)
    ids = [x for x in pg.locator('.ov-card .ov-sub span[data-tip]').all_inner_texts()]
    check('у каждой карточки свой ID (3003, 4004, 9999, 9998)', all(any(i in t for t in ids) for i in ['3003', '4004', '9999', '9998']), ids)
    priv = pg.locator('.ov-card.st-private')
    check('приватный/пустой профиль: «Профиль приватный или статистика не предоставлена источником», нулей нет', priv.count() >= 1 and 'приватный' in priv.first.inner_text() and ' 0%' not in priv.first.inner_text(), priv.first.inner_text() if priv.count() else '')
    c3003 = pg.locator('.ov-card', has_text='3003').first.inner_text()
    check('у игрока с 8 матчами сигналы «мало данных», а не «подозрительно»', 'мало данных' in c3003 and 'требует проверки' not in c3003, c3003)
    check('игрок 9998 (HTTP 404) не ломает остальных, ошибки в консоли нет', not errs, errs[:2])
    shot(pg, 'overlay_spectator')

    # ---------- ручной ввод ----------
    pg.click('.ov-team.dire [data-a=ov-manual] >> nth=0'); pg.wait_for_selector('.ov-modal')
    pg.fill('.ov-modal input[name=id]', 'Просто ник'); pg.click('.ov-modal button[type=submit]')
    check('ник вместо ID не принимается', 'Не похоже' in text(pg, '.ov-modal'))
    pg.fill('.ov-modal input[name=id]', 'https://www.opendota.com/players/1001'); pg.click('.ov-modal button[type=submit]')
    pg.wait_for_selector('.ov-card:has-text("указан вручную")', timeout=15000)
    check('вручную добавленный игрок подписан «указан вручную»', pg.locator('.ov-card:has-text("указан вручную")').count() == 1)

    # ---------- новый матч не наследует старый ----------
    gsi(local(1001, match='9100000003', name='Другой'))
    until(pg, "DMOverlay.state().snap.matchId==='9100000003'", 10000); pg.wait_for_timeout(800)
    cards = pg.locator('.ov-card.st-identified, .ov-card.st-private').count()
    check('новый матч: карточки старого не остались, только игрок нового', cards == 1 and pg.locator('.ov-card:has-text("указан вручную")').count() == 0 and pg.locator('text=Same').count() == 0, cards)

    # ---------- завершение матча ----------
    hits.clear()
    gsi({'map': {'matchid': '9100000003', 'game_state': 'DOTA_GAMERULES_STATE_POST_GAME'}, 'player': {'steamid': sid(1001), 'team_name': 'radiant'}})
    until(pg, "DMOverlay.state().snap.phase==='finished'", 10000); pg.wait_for_timeout(500)
    check('после завершения матча статус «Матч завершён»', 'Матч завершён' in text(pg, '.ov-status'))
    check('мост без игры не создаёт пустых карточек: данные завершённого матча остаются на экране', pg.locator('.ov-card').count() == 10)
    c.close()

    # ---------- потеря и возврат моста ----------
    c, pg, errs = setup(b); pg.goto(URL); until(pg, "DMOverlay.state().conn.status==='on'", 10000)
    gsi(local(1001, match='9100000004')); pg.wait_for_selector('.ov-card.me .ov-m', timeout=15000)
    bridge.terminate(); bridge.wait()
    until(pg, "DMOverlay.state().conn.status==='off'", 10000)
    check('при остановке моста: «Мост не подключён» и уже загруженная статистика остаётся', 'Мост не подключён' in text(pg, '.ov-status') and pg.locator('.ov-card.me .ov-m').count() >= 1, text(pg, '.ov-status'))
    bridge = start_bridge(); wait_http(f'http://127.0.0.1:{bridge_port}/status?t=x')
    until(pg, "DMOverlay.state().conn.status==='on'", 20000)
    check('мост вернулся: оверлей переподключился сам', 'Мост не подключён' not in text(pg, '.ov-status'))
    check('без JS-ошибок (потеря моста)', not errs, errs[:2]); c.close()

    # ---------- неверный токен и мусорные пакеты ----------
    check('пакет с чужим токеном отклонён мостом', gsi(local(1001), token='wrong-token-xxxx') == 401)
    b.close()

bridge.terminate(); mock.terminate()
print(f'\nИтого: {len(passes)} пройдено, {len(fails)} провалено')
sys.exit(1 if fails else 0)
