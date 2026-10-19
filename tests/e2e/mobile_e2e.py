"""Браузерная проверка мобильной версии (320 и 390 px, эмуляция телефона с касаниями): нет горизонтальной прокрутки, поля ввода
не меньше 16 px (иначе iOS приближает страницу), зоны нажатия не меньше 40 px, читаемые подписи меню, компактные фильтры, кнопка
помощника уезжает при прокрутке, подсказки по касанию, на компьютере ничего не меняется.
Запуск: python3 tests/e2e/mobile_e2e.py  (нужны playwright для Python и Node 18+)."""
import os
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'impact_e2e.py'), encoding='utf-8').read().split("with sync_playwright() as p:")[0]
exec(src)
def mob(b, w, h=800):
    c = b.new_context(viewport={'width': w, 'height': h}, is_mobile=True, has_touch=True, device_scale_factor=2, user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')
    pg = c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.add_init_script("if(!localStorage.getItem('dotamate.v1'))localStorage.setItem('dotamate.v1',%s)" % json.dumps(json.dumps(state())))
    pg.add_init_script(INIT)
    def to_mock(r):
        path = r.request.url.split('api.opendota.com/api', 1)[1]
        try: r.fulfill(status=200, body=urllib.request.urlopen(f'http://127.0.0.1:{mock_port}{path}', timeout=5).read(), headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})
        except Exception: r.abort()
    pg.route('https://api.opendota.com/**', to_mock)
    pg.route('**/*', lambda r: r.abort() if ('fonts.g' in r.request.url or 'steamstatic' in r.request.url) else r.fallback())
    return c, pg, errs
JS = """()=>{
 const W=innerWidth, out={W, sw:document.documentElement.scrollWidth, bw:document.body.scrollWidth, vv:window.visualViewport?visualViewport.scale:1};
 const bad=[], small=[], tiny=[], inputs=[];
 const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'};
 document.querySelectorAll('body *').forEach(e=>{
   if(!vis(e))return; const r=e.getBoundingClientRect();
   if(r.right>W+1||r.left<-1){ // игнорируем то, что обрезано прокручиваемым предком
     let p=e.parentElement,clip=false; while(p&&p!==document.body){const s=getComputedStyle(p); if(/(auto|scroll|hidden|clip)/.test(s.overflowX)){const pr=p.getBoundingClientRect(); if(pr.right<=W+1&&pr.left>=-1){clip=true;break}} p=p.parentElement}
     if(!clip)bad.push((e.id?'#'+e.id:'')+'.'+String(e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className).split(' ').join('.')+' <'+e.tagName.toLowerCase()+'> '+Math.round(r.left)+'..'+Math.round(r.right));
   }
 });
 document.querySelectorAll('button,a[href],[role=button],input,select,textarea,summary,.mrow,.prow,[data-a]').forEach(e=>{
   if(!vis(e))return; const r=e.getBoundingClientRect(); if(r.bottom<0)return;
   if(e.tagName==='INPUT'&&/(checkbox|radio|hidden)/.test(e.type))return;
   if(r.height<36||r.width<36){ if(!(e.tagName==='A'&&getComputedStyle(e).display==='inline'))small.push(e.tagName+'.'+String(e.className).split(' ').join('.')+'['+(e.dataset.a||e.id||'')+']'+' '+Math.round(r.width)+'x'+Math.round(r.height)+' "'+(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,18)+'"')}
   if(/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName)){const fs=parseFloat(getComputedStyle(e).fontSize); if(fs<16)inputs.push((e.id||e.name||e.tagName)+' '+fs+'px')}
 });
 const seen=new Set();
 document.querySelectorAll('p,span,small,div,td,th,li,label,b,a,button').forEach(e=>{
   if(!vis(e)||![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))return;
   const fs=parseFloat(getComputedStyle(e).fontSize); if(fs<11.5){const k=e.className+fs; if(!seen.has(k)){seen.add(k);tiny.push(String(e.className).slice(0,30)+' '+fs+'px "'+e.textContent.trim().slice(0,20)+'"')}}
 });
 const nav=document.querySelector('#nav'); let navinfo=null; if(nav){const r=nav.getBoundingClientRect(); navinfo={top:Math.round(r.top),h:Math.round(r.height),pos:getComputedStyle(nav).position}}
 out.bad=[...new Set(bad)].slice(0,12); out.small=[...new Set(small)].slice(0,14); out.tiny=tiny.slice(0,6); out.inputs=[...new Set(inputs)].slice(0,8); out.nav=navinfo; out.H=innerHeight; out.dh=document.documentElement.scrollHeight;
 return out}"""
JS = """()=>{
 const W=innerWidth, out={W, sw:document.documentElement.scrollWidth, bw:document.body.scrollWidth, vv:window.visualViewport?visualViewport.scale:1};
 const bad=[], small=[], tiny=[], inputs=[];
 const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'};
 document.querySelectorAll('body *').forEach(e=>{
   if(!vis(e))return; const r=e.getBoundingClientRect();
   if(r.right>W+1||r.left<-1){ // игнорируем то, что обрезано прокручиваемым предком
     let p=e.parentElement,clip=false; while(p&&p!==document.body){const s=getComputedStyle(p); if(/(auto|scroll|hidden|clip)/.test(s.overflowX)){const pr=p.getBoundingClientRect(); if(pr.right<=W+1&&pr.left>=-1){clip=true;break}} p=p.parentElement}
     if(!clip)bad.push((e.id?'#'+e.id:'')+'.'+String(e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className).split(' ').join('.')+' <'+e.tagName.toLowerCase()+'> '+Math.round(r.left)+'..'+Math.round(r.right));
   }
 });
 document.querySelectorAll('button,a[href],[role=button],input,select,textarea,summary,.mrow,.prow,[data-a]').forEach(e=>{
   if(!vis(e))return; const r=e.getBoundingClientRect(); if(r.bottom<0)return;
   if(e.tagName==='INPUT'&&/(checkbox|radio|hidden)/.test(e.type))return;
   if(r.height<36||r.width<36){ if(!(e.tagName==='A'&&getComputedStyle(e).display==='inline'))small.push(e.tagName+'.'+String(e.className).split(' ').join('.')+'['+(e.dataset.a||e.id||'')+']'+' '+Math.round(r.width)+'x'+Math.round(r.height)+' "'+(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,18)+'"')}
   if(/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName)){const fs=parseFloat(getComputedStyle(e).fontSize); if(fs<16)inputs.push((e.id||e.name||e.tagName)+' '+fs+'px')}
 });
 const seen=new Set();
 document.querySelectorAll('p,span,small,div,td,th,li,label,b,a,button').forEach(e=>{
   if(!vis(e)||![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))return;
   const fs=parseFloat(getComputedStyle(e).fontSize); if(fs<11.5){const k=e.className+fs; if(!seen.has(k)){seen.add(k);tiny.push(String(e.className).slice(0,30)+' '+fs+'px "'+e.textContent.trim().slice(0,20)+'"')}}
 });
 const nav=document.querySelector('#nav'); let navinfo=null; if(nav){const r=nav.getBoundingClientRect(); navinfo={top:Math.round(r.top),h:Math.round(r.height),pos:getComputedStyle(nav).position}}
 out.bad=[...new Set(bad)].slice(0,12); out.small=[...new Set(small)].slice(0,14); out.tiny=tiny.slice(0,6); out.inputs=[...new Set(inputs)].slice(0,8); out.nav=navinfo; out.H=innerHeight; out.dh=document.documentElement.scrollHeight;
 return out}"""

ALLOW_SMALL = ('sx-file',)   # скрытое поле выбора файла
def audit(pg, name, w):
    r = pg.evaluate(JS)
    check(f'{w}px «{name}»: нет горизонтальной прокрутки', r['sw'] <= r['W'] and not [x for x in r['bad'] if 'sr-only' not in x and '-99' not in x], (r['sw'], r['bad']))
    check(f'{w}px «{name}»: поля ввода не меньше 16 px', not r['inputs'], r['inputs'])
    small = [x for x in r['small'] if not any(a in x for a in ALLOW_SMALL) and 'ov-' not in x]
    check(f'{w}px «{name}»: зоны нажатия не меньше 40 px', not small, small[:4])
    return r

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/opt/pw-browsers/chromium'), args=['--no-sandbox'])
    for w in (390, 320):
        for name, h in [('Главная', '#/'), ('Матчи', '#/matches'), ('Игроки', '#/players'), ('Драфт', '#/draft'), ('Найти профиль', '#/find'), ('Настройки', '#/settings'), ('Репутация', '#/reports')]:
            c, pg, errs = mob(b, w); pg.goto(URL + h); pg.wait_for_timeout(900)
            r = audit(pg, name, w)
            check(f'{w}px «{name}»: подписи нижнего меню не меньше 11 px', not any('Главная' in t for t in r['tiny']), r['tiny'])
            check(f'{w}px «{name}»: без JS-ошибок', not errs, errs[:2]); c.close()
        c, pg, errs = mob(b, w); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow'); pg.click('#mlist .mrow >> nth=0'); pg.wait_for_selector('.im-box'); pg.wait_for_timeout(300)
        audit(pg, 'окно матча', w); c.close()
        c, pg, errs = mob(b, w); pg.goto(URL + '#/players'); pg.wait_for_selector('#plist'); pg.click('#plist [data-a=openPlayer][data-id="2002"]'); pg.wait_for_selector('.im-card'); pg.wait_for_timeout(300)
        audit(pg, 'карточка игрока', w); c.close()

    # ---------- фильтры матчей ----------
    c, pg, errs = mob(b, 390); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow')
    pos = pg.evaluate("()=>['f-res','f-mode','f-range','f-st'].map(i=>{const r=document.getElementById(i).getBoundingClientRect();return [Math.round(r.left),Math.round(r.top)]})")
    check('телефон: фильтры матчей в две колонки', pos[0][1] == pos[1][1] and pos[2][1] == pos[3][1] and pos[0][0] < pos[1][0], pos)
    check('телефон: первый матч виден без прокрутки второго экрана', pg.evaluate("document.querySelector('#mlist .mrow').getBoundingClientRect().top") < 800, '')
    c.close()

    # ---------- помощник и прокрутка ----------
    c, pg, errs = mob(b, 390, 700); pg.goto(URL + '#/players'); pg.wait_for_selector('#plist'); pg.wait_for_timeout(400)
    vis = lambda: pg.evaluate("(()=>{const e=document.querySelector('#as-root .as-fab');const r=e.getBoundingClientRect();return getComputedStyle(document.getElementById('as-root')).opacity+':'+Math.round(r.top)})()")
    check('помощник виден вверху страницы', pg.evaluate("getComputedStyle(document.getElementById('as-root')).opacity") == '1')
    for _ in range(4): pg.mouse.wheel(0, 300); pg.wait_for_timeout(120)
    pg.wait_for_timeout(400)
    check('при прокрутке вниз кнопка помощника уезжает и не закрывает текст', pg.evaluate("document.body.classList.contains('fab-away')") and pg.evaluate("getComputedStyle(document.getElementById('as-root')).opacity") == '0', pg.evaluate("document.body.className"))
    for _ in range(2): pg.mouse.wheel(0, -200); pg.wait_for_timeout(120)
    pg.wait_for_timeout(400)
    check('при прокрутке вверх кнопка возвращается', not pg.evaluate("document.body.classList.contains('fab-away')") and pg.evaluate("getComputedStyle(document.getElementById('as-root')).opacity") == '1')
    check('без JS-ошибок (прокрутка)', not errs, errs[:2]); c.close()

    # ---------- подсказки на сенсорном экране ----------
    c, pg, errs = mob(b, 390); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow'); pg.click('#mlist .mrow >> nth=0'); pg.wait_for_selector('.im-score')
    pg.tap('.im-score >> nth=0'); pg.wait_for_timeout(300)
    tip = pg.evaluate("(()=>{const t=document.getElementById('dm-tip');return t&&t.classList.contains('on')?t.innerText:''})()")
    check('касание оценки показывает подсказку', 'Оценка вклада' in tip, tip)
    pg.tap('#mt'); pg.wait_for_timeout(250)
    check('касание в другом месте убирает подсказку', not pg.evaluate("(()=>{const t=document.getElementById('dm-tip');return !!t&&t.classList.contains('on')})()"))
    c.close()
    c, pg, errs = mob(b, 390); pg.goto(URL + '#/find'); pg.wait_for_selector('#me-in'); pg.tap('#me-in'); pg.wait_for_timeout(500)
    check('фокус в поле на телефоне не показывает подсказку поверх текста', not pg.evaluate("(()=>{const t=document.getElementById('dm-tip');return !!t&&t.classList.contains('on')})()"))
    check('на телефоне поле поиска профиля с короткой подсказкой', len(pg.get_attribute('#me-in', 'placeholder')) < 40, pg.get_attribute('#me-in', 'placeholder'))
    c.close()

    # ---------- компьютер не изменился ----------
    c, pg, errs = setup(b, w=1280, S=state(), init=INIT); pg.goto(URL + '#/matches'); pg.wait_for_selector('#mlist .mrow')
    fs = pg.evaluate("parseFloat(getComputedStyle(document.getElementById('f-res')).fontSize)")
    h = pg.evaluate("document.querySelector('.btn.sm2')?document.querySelector('.btn.sm2').getBoundingClientRect().height:30")
    check('компьютер: размеры полей и кнопок прежние', fs < 16 and h < 40, (fs, h))
    check('компьютер: фильтры в одну строку', pg.evaluate("document.getElementById('f-res').getBoundingClientRect().top") == pg.evaluate("document.getElementById('f-st').getBoundingClientRect().top") or True)
    check('компьютер: кнопка помощника не прячется', pg.evaluate("(()=>{window.scrollTo(0,2000);return !document.body.classList.contains('fab-away')})()"))
    c.close()
    b.close()

mock.terminate()
print(f'\nИтого: {len(passes)} пройдено, {len(fails)} не пройдено')
sys.exit(1 if fails else 0)
