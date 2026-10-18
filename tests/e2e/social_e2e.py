"""Браузерная проверка личных тегов, винрейта, рекомендаций, «Оценить всех», поиска по заметкам, напоминаний, экспорта и импорта.
Статический режим (без сервера) и режим с сервером (настоящий server.js, вход через DEV_LOGIN)."""
import os, sys, json, time, socket, shutil, tempfile, functools, threading, subprocess, urllib.request, http.server
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
res = []
def check(n, c, i=''):
    res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n + (f'  [{i}]' if i and not c else ''))
def fp():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message = lambda *a, **k: None
static = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h); threading.Thread(target=static.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{static.server_address[1]}/index.html'
tmp = tempfile.mkdtemp(prefix='dm-sx-')

def ctx(b, w=1200, hh=900, init=None):
    c = b.new_context(viewport={'width': w, 'height': hh}, accept_downloads=True); pg = c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/*', lambda r: r.abort() if ('fonts.g' in r.request.url or 'steamstatic' in r.request.url or 'opendota.com' in r.request.url) else r.continue_())
    if init: pg.add_init_script(init)
    return c, pg, errs
def ls(pg): return pg.evaluate("JSON.parse(localStorage.getItem('dotamate.v1')||'null')")
def players(pg):
    pg.click('.tabs >> text=Игроки'); pg.wait_for_selector('.sx-tabs')

DAY = 86400
def seeded(days_gone=40):
    """Состояние: хороший союзник 1 (последний раз давно), союзник 2 токсичный, без демо."""
    now = int(time.time()); S = {'v': 1, 'me': {'acc': '111', 'name': 'Я'}, 'matches': [], 'reviews': {}, 'pnotes': {}, 'tags': {}, 'heroNotes': {}, 'snooze': {}, 'avatars': {}, 'settings': {'avatars': False}, 'demo': False, 'lastSync': None}
    for i in range(4):
        S['matches'].append({'id': 's%d' % i, 'start': now - (days_gone + i) * DAY, 'mode': 'All Pick', 'ranked': False, 'win': i != 3, 'dur': 2000, 'hero': 'Axe', 'players': [
            {'sid': '111', 'name': 'Я', 'hero': 'Axe', 'ally': True, 'me': True}, {'sid': '1', 'name': 'Добрый', 'hero': 'Pudge', 'ally': True, 'me': False},
            {'sid': '2', 'name': 'Тильтер', 'hero': 'Lina', 'ally': True, 'me': False}, {'sid': '9', 'name': 'Враг', 'hero': 'Sven', 'ally': False, 'me': False}]})
        S['reviews']['s%d|1' % i] = {'rating': 5, 'cats': {}, 'note': 'ставит варды', 'ts': now}
    return S

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])

    # ---------- список, фильтры, поиск ----------
    c, pg, errs = ctx(b); pg.goto(URL); pg.wait_for_selector('.tabs'); players(pg)
    tabs = pg.locator('.sx-tab').all_inner_texts()
    check('вкладки страницы «Игроки»', all(any(t.startswith(x) for t in tabs) for x in ['Все', 'Для пати', 'Без оценки', 'Избегать', 'Статистика']), tabs)
    row = pg.inner_text('#plist .prow >> nth=0')
    check('в строке игрока виден счёт в скобках и теги', '(4–1)' in row and 'Можно в пати' in row, row)
    pg.select_option('#sx-tag', 'party'); n1 = pg.locator('#plist .prow').count()
    check('фильтр по тегу «Можно в пати»', n1 == 1 and 'Fenrir' in pg.inner_text('#plist'), n1)
    pg.select_option('#sx-tag', 'none'); n2 = pg.locator('#plist .prow').count(); check('фильтр «Без тегов»', 1 < n2 < 22 and 'Fenrir' not in pg.inner_text('#plist'))
    pg.click('text=Сбросить'); pg.select_option('#sx-rmin', '4'); names = pg.locator('#plist .pname').all_inner_texts()
    check('фильтр «оценка от 4»', set(names) == {'Fenrir', 'Мамкин саппорт', 'Lumen'}, names)
    pg.select_option('#sx-rmax', '4'); check('диапазон 4–4', pg.locator('#plist .prow').count() == 2)
    pg.click('text=Сбросить'); pg.select_option('#sx-rated', 'no'); check('фильтр «без оценки»', pg.locator('#plist .prow').count() == 17, pg.locator('#plist .prow').count())
    pg.click('text=Сбросить'); pg.fill('#q', 'варды'); pg.wait_for_timeout(150)
    t = pg.inner_text('#plist')
    check('поиск по тексту заметок: найден один игрок и виден фрагмент', pg.locator('#plist .prow').count() == 1 and 'Мамкин саппорт' in t and 'заметка к матчу' in t and 'Варды ставит' in t, t[:200])
    pg.fill('#q', 'Pudge'); pg.wait_for_timeout(100); check('поиск по заметкам о героях (нет таких)', pg.locator('#plist .prow').count() == 0)
    pg.fill('#q', 'сливается'); pg.wait_for_timeout(100); check('поиск по тексту тега', 'kotleta_pro' in pg.inner_text('#plist'))
    check('без JS-ошибок (список)', not errs, errs[:2]); c.close()

    # ---------- карточка игрока: теги, герои ----------
    c, pg, errs = ctx(b); pg.goto(URL); pg.wait_for_selector('.tabs'); players(pg)
    pg.click('#plist .prow >> nth=0'); pg.wait_for_selector('#sx-tags')
    t = pg.inner_text('.sx-kvs'); check('карточка: счёт вместе 4–1 и 80%', '4–1' in t and '80%' in t, t)
    pg.click('.sx-pill[data-id=core]'); check('тег «Кор» включён', pg.get_attribute('.sx-pill[data-id=core]', 'aria-pressed') == 'true')
    pg.fill('#sx-ctag', 'Любит мид'); pg.click('[data-a=s-tagadd]'); check('свой тег добавлен', pg.locator('.sx-pill[data-id="c:Любит мид"][aria-pressed=true]').count() == 1)
    pg.fill('#sx-ctag', 'любит мид'); pg.click('[data-a=s-tagadd]'); check('повтор тега не дублируется', pg.locator('.sx-pill[data-id="c:Любит мид"]').count() == 1 and 'уже есть' in pg.inner_text('#sx-tmsg'))
    pg.fill('#sx-hero', 'Pudge'); pg.fill('#sx-hnote', 'часто фидит на ганках'); pg.click('[data-a=s-herosave]')
    check('заметка о герое сохранена и показана', 'часто фидит на ганках' in pg.inner_text('#sx-hn'))
    st = ls(pg); sid = '120000000'
    check('данные в localStorage', 'core' in st['tags'][sid] and 'c:Любит мид' in st['tags'][sid] and st['heroNotes'][sid]['Pudge'] == 'часто фидит на ганках', st['tags'].get(sid))
    pg.reload(); pg.wait_for_selector('.tabs'); players(pg); pg.select_option('#sx-tag', 'c:Любит мид')
    check('после перезагрузки свой тег есть в фильтре и работает', pg.locator('#plist .prow').count() == 1)
    pg.fill('#q', 'Pudge'); pg.wait_for_timeout(100); check('поиск находит заметку о герое', 'заметка о герое' in pg.inner_text('#plist'))
    pg.fill('#q', ''); pg.click('text=Сбросить'); pg.click('#plist .prow >> nth=0'); pg.wait_for_selector('#sx-hn')
    pg.click('[data-a=s-heroedit]'); check('редактирование подставляет значения', pg.input_value('#sx-hero') == 'Pudge' and 'фидит' in pg.input_value('#sx-hnote'))
    pg.click('[data-a=s-herodel]'); check('удаление заметки о герое', 'пока нет' in pg.inner_text('#sx-hn') and 'heroNotes' in ls(pg) and sid not in ls(pg)['heroNotes'])
    check('без JS-ошибок (карточка)', not errs, errs[:2]); c.close()

    # ---------- рекомендации, избегать ----------
    c, pg, errs = ctx(b); pg.goto(URL); pg.wait_for_selector('.tabs'); players(pg); pg.click('.sx-tab[data-t=rec]')
    names = pg.locator('.sx-body .pname').all_inner_texts()
    check('«Для пати»: Fenrir первый, не больше 5, без избегаемых', names[0] == 'Fenrir' and len(names) <= 5 and 'xXdarkXx' not in names, names)
    pg.click('.sx-tab[data-t=all]'); pg.click('#plist .prow >> nth=0'); pg.click('.sx-pill[data-id=toxic]'); pg.click('[data-a=go][data-p=players]')
    pg.click('.sx-tab[data-t=rec]'); check('игрок с тегом «Токсик» исчез из рекомендаций', 'Fenrir' not in pg.locator('.sx-body .pname').all_inner_texts())
    pg.click('.sx-tab[data-t=avoid]'); t = pg.inner_text('.sx-body'); check('«Избегать»: игрок из демо в списке', 'xXdarkXx' in t, t[:200])
    pg.click('[data-a=s-tagoff]'); check('«Убрать» очищает список', 'Список пуст' in pg.inner_text('.sx-body'))
    pg.click('.sx-tab[data-t=stats]'); t = pg.inner_text('.sx-body')
    check('«Статистика»: блоки и винрейт по оценкам', all(x in t for x in ['С кем играю чаще всего', 'Против кого чаще всего', 'Оцениваю выше всего', 'Оцениваю ниже всего', 'Винрейт и ваши оценки']), t[:200])
    check('без JS-ошибок (вкладки)', not errs, errs[:2]); c.close()

    # ---------- «Оценить всех» и «Без оценки» ----------
    c, pg, errs = ctx(b); pg.goto(URL); pg.wait_for_selector('.tabs'); players(pg); pg.click('.sx-tab[data-t=unrated]')
    before = pg.locator('.sx-body .sx-row').count()
    sid = pg.get_attribute('.sx-row [data-a=s-rateall] >> nth=0', 'data-sid')
    pg.click('.sx-row [data-a=s-rateall] >> nth=0'); pg.wait_for_selector('.sx-q')
    first = pg.locator('.sx-q[data-sid="%s"]' % sid)
    first.locator('.sx-star >> nth=3').click(); first.locator('.sx-qnote').fill('играл спокойно')
    first.locator('.sx-pill[data-id=party]').click()
    check('звёзды и тег переключаются на месте, модалка не перерисована', first.locator('.sx-star.on').count() == 4 and first.locator('.sx-pill[data-id=party]').get_attribute('aria-pressed') == 'true')
    first.locator('.sx-pill[data-id=avoid]').click(); check('«Избегать» снимает «Можно в пати»', first.locator('.sx-pill[data-id=party]').get_attribute('aria-pressed') == 'false')
    pg.click('[data-a=s-qsave]'); pg.wait_for_timeout(200)
    st = ls(pg); rv = [v for k, v in st['reviews'].items() if k.endswith('|' + sid) and v.get('note') == 'играл спокойно']
    check('оценка и заметка сохранены, тег «Избегать» записан', rv and rv[0]['rating'] == 4 and 'avoid' in st['tags'].get(sid, []), (rv, st['tags'].get(sid)))
    pg.click('.sx-tab[data-t=unrated]'); check('игрок ушёл из «Без оценки»', pg.locator('.sx-body .sx-row').count() == before - 1, (before, pg.locator('.sx-body .sx-row').count()))
    # из карточки матча: вернуться в матч
    pg.click('.tabs >> text=Матчи'); pg.click('.mrow >> nth=0'); pg.wait_for_selector('.sx-qbar'); pg.click('.sx-qbar [data-a=s-rateall]'); pg.wait_for_selector('.sx-q')
    pg.click('[data-a=s-qsave]'); pg.wait_for_selector('.sx-qbar'); check('после сохранения возврат в карточку матча', pg.locator('#mt').count() == 1 and pg.locator('.sx-q').count() == 0)
    check('без JS-ошибок (оценка)', not errs, errs[:2]); c.close()

    # ---------- напоминания ----------
    S = seeded(); c, pg, errs = ctx(b, init="if(!localStorage.getItem('dotamate.v1'))localStorage.setItem('dotamate.v1',%s)" % json.dumps(json.dumps(S)))
    pg.goto(URL); pg.wait_for_selector('.tabs'); t = pg.inner_text('#main')
    check('главная: «Давно не играли с Добрый», токсичному и избегаемому не напоминаем', 'Давно не играли с Добрый' in t and 'Тильтер' not in t.split('Давно не играли')[1][:200], t[:300])
    check('главная: предложение оценить матч', 'без оценки' in t and 'Оценить всех' in t)
    pg.click('[data-a=s-snooze]'); check('«Напомнить позже» скрывает напоминание', 'Давно не играли' not in pg.inner_text('#main') and ls(pg)['snooze'].get('1', 0) > time.time())
    pg.click('.tabs >> text=Настройки'); pg.uncheck('#sx-remind'); check('настройка отключает напоминания', ls(pg)['settings']['remind'] is False)
    S2 = seeded(); S2['settings']['remind'] = False
    check('без JS-ошибок (напоминания)', not errs, errs[:2]); c.close()

    # ---------- экспорт и импорт ----------
    c, pg, errs = ctx(b); pg.goto(URL); pg.wait_for_selector('.tabs'); pg.click('.tabs >> text=Настройки'); pg.wait_for_selector('#sx-file')
    with pg.expect_download() as dl: pg.click('[data-a=s-export]')
    d = dl.value; path = os.path.join(tmp, 'exp.json'); d.save_as(path)
    j = json.load(open(path, encoding='utf8'))
    check('экспорт: файл .json с данными, без аватарок', d.suggested_filename.startswith('dota-mate-') and d.suggested_filename.endswith('.json') and j['app'] == 'dota-mate' and len(j['data']['matches']) == 9 and 'avatars' not in j['data'])
    # пустое устройство
    c2, pg2, errs2 = ctx(b, init="if(!localStorage.getItem('dotamate.v1'))localStorage.setItem('dotamate.v1',%s)" % json.dumps(json.dumps({'v': 1, 'me': {'acc': '777', 'name': 'Чужой'}, 'matches': [], 'reviews': {}, 'pnotes': {}, 'tags': {}, 'heroNotes': {}, 'snooze': {}, 'avatars': {}, 'settings': {}, 'demo': False, 'lastSync': None})))
    pg2.goto(URL); pg2.wait_for_selector('.tabs'); pg2.click('.tabs >> text=Настройки'); pg2.wait_for_selector('#sx-file')
    bad = os.path.join(tmp, 'bad.json'); open(bad, 'w').write('{"v":2}')
    pg2.set_input_files('#sx-file', bad); pg2.wait_for_function("document.getElementById('sx-fmsg').textContent.length>0"); check('импорт: чужой файл отвергнут с понятной ошибкой', 'не резервная копия' in pg2.inner_text('#sx-fmsg'), pg2.inner_text('#sx-fmsg'))
    pg2.set_input_files('#sx-file', path); pg2.wait_for_selector('#sx-imp .banner'); t = pg2.inner_text('#sx-imp')
    check('импорт: предпросмотр с числами', 'Матчей: 9' in t and 'игроков с тегами' in t, t)
    pg2.click('[data-a=s-impmerge]'); pg2.wait_for_timeout(300); st = ls(pg2)
    check('импорт «добавить»: матчи, теги перенесены, свой Steam ID сохранён', len(st['matches']) == 9 and st['me']['acc'] == '777' and st['tags'] and not st['demo'], (len(st['matches']), st['me']))
    pg2.click('.tabs >> text=Настройки'); pg2.set_input_files('#sx-file', path); pg2.wait_for_selector('#sx-imp .banner'); pg2.click('[data-a=s-impask]')
    check('замена требует подтверждения', pg2.locator('[data-a=s-impreplace]').count() == 1); pg2.click('[data-a=s-impreplace]'); pg2.wait_for_timeout(300)
    check('импорт «заменить»', len(ls(pg2)['matches']) == 9)
    check('без JS-ошибок (импорт)', not errs and not errs2, (errs[:2], errs2[:2])); c2.close(); c.close()

    # ---------- мобильная вёрстка ----------
    c, pg, errs = ctx(b, 390, 800); pg.goto(URL); pg.wait_for_selector('#nav .tab'); pg.click('#nav >> text=Игроки'); pg.wait_for_selector('.sx-tabs')
    def ov(): return pg.evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth')
    out = []
    for t_ in ['all', 'rec', 'unrated', 'avoid', 'stats']:
        pg.click(f'.sx-tab[data-t={t_}]'); pg.wait_for_timeout(100); out.append((t_, ov()))
    pg.click('.sx-tab[data-t=all]'); pg.click('#plist .prow >> nth=0'); pg.wait_for_selector('#sx-tags'); out.append(('player', ov()))
    pg.click('#nav [data-p=players]'); pg.click('.sx-tab[data-t=unrated]'); pg.click('.sx-row [data-a=s-rateall] >> nth=0'); pg.wait_for_selector('.sx-q'); out.append(('rateall', ov()))
    bx = pg.locator('#modal .panel').bounding_box(); out.append(('panel', 0 if bx['x'] >= 0 and bx['x'] + bx['width'] <= 391 else 99))
    check('мобильный: нет горизонтальной прокрутки', all(v <= 1 for _, v in out), out); check('без JS-ошибок (мобильный)', not errs, errs[:2]); c.close()
    b.close()

# ---------- режим с сервером: теги в серверном состоянии ----------
port = fp(); data = tempfile.mkdtemp(prefix='dm-sxs-')
srv = subprocess.Popen(['node', os.path.join(ROOT, 'server.js')], env=dict(os.environ, PORT=str(port), PUBLIC_URL=f'http://127.0.0.1:{port}', DATA_DIR=data, DEV_LOGIN='1'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
B = f'http://127.0.0.1:{port}'
try:
    for _ in range(80):
        try: urllib.request.urlopen(B + '/api/session', timeout=1); break
        except Exception: time.sleep(.1)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])
        c, pg, errs = ctx(b)
        pg.goto(B + '/auth/dev?acc=111'); pg.wait_for_selector('.tabs')
        pg.evaluate("""async()=>{const S=%s;await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json','X-DM':'1'},body:JSON.stringify(S)})}""" % json.dumps(seeded()))
        pg.reload(); pg.wait_for_selector('.tabs'); players(pg); pg.click('#plist .prow >> nth=0'); pg.wait_for_selector('#sx-tags')
        pg.click('.sx-pill[data-id=party]'); pg.wait_for_timeout(1200)
        st = pg.evaluate("fetch('/api/state').then(r=>r.json())")['state']
        check('сервер: тег сохранён в состоянии аккаунта', any('party' in v for v in st['tags'].values()), st.get('tags'))
        pg.reload(); pg.wait_for_selector('.tabs'); players(pg); pg.select_option('#sx-tag', 'party')
        check('сервер: после перезагрузки фильтр по тегу работает', pg.locator('#plist .prow').count() == 1)
        check('без JS-ошибок (сервер)', not errs, errs[:2]); c.close(); b.close()
finally:
    srv.terminate(); shutil.rmtree(data, ignore_errors=True); shutil.rmtree(tmp, ignore_errors=True); static.shutdown()
print(f'\nИТОГО: {sum(res)} прошло, {len(res) - sum(res)} не прошло'); sys.exit(0 if all(res) else 1)
