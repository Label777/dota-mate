#!/usr/bin/env node
'use strict';
/* Dota Mate: локальный мост драфта. Запускается на вашем компьютере, ничего не отправляет в интернет.
   Использование:
     node tools/gsi-bridge.js                          запустить мост и показать ссылку для сайта
     node tools/gsi-bridge.js --install "<папка>"       записать cfg в "<папка>/game/dota/cfg/gamestate_integration/"
     node tools/gsi-bridge.js --demo                    без Dota 2: проигрывает записанный демо-драфт
   Параметры: --port 7777  --token <строка>  --site https://label777.github.io/dota-mate/ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHub, cfgText } = require('../server/gsi-hub.js');
const Draft = require('../js/draft.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const CFG_NAME = 'gamestate_integration_dotamate.cfg';
const HELP = `Dota Mate: локальный мост драфта. Запускается на вашем компьютере, ничего не отправляет в интернет.
Использование:
  node dota-mate-bridge.js                          запустить мост и показать ссылку для сайта
  node dota-mate-bridge.js --install "<папка игры>"  записать cfg в "<папка>/game/dota/cfg/gamestate_integration/"
  node dota-mate-bridge.js --demo                    без Dota 2: проигрывает записанный демо-драфт
Параметры: --port 7777  --token <строка>  --site https://label777.github.io/dota-mate/  --quiet`;

function loadToken() {
  const given = opt('token', '');
  if (given) return given;
  const f = path.join(os.homedir(), '.dota-mate-bridge.json');
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && typeof j.token === 'string' && j.token.length >= 16) return j.token; } catch (e) { /* создадим */ }
  const token = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(f, JSON.stringify({ token }), { mode: 0o600 }); } catch (e) { /* без сохранения токен будет новым при каждом запуске */ }
  return token;
}

async function main() {
  if (flag('help') || flag('h')) { console.log(HELP); return; }
  const port = Number(opt('port', 7777)), token = loadToken(), site = opt('site', 'https://label777.github.io/dota-mate/');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('Порт должен быть от 1024 до 65535.'); process.exit(1); }
  const cfg = cfgText({ port, token });

  const inst = opt('install', '');
  if (inst) {
    const dir = path.join(inst, 'game', 'dota', 'cfg', 'gamestate_integration');
    try {
      if (!fs.existsSync(path.join(inst, 'game', 'dota'))) { console.error(`В папке «${inst}» нет game/dota. Укажите папку игры, например: ...\\steamapps\\common\\dota 2 beta`); process.exit(1); }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CFG_NAME), cfg);
      console.log('Файл записан: ' + path.join(dir, CFG_NAME));
      console.log('Дальше: добавьте в Steam → Dota 2 → Свойства → Параметры запуска: -gamestateintegration, перезапустите Dota 2 и запустите мост без --install.');
    } catch (e) { console.error('Не удалось записать файл: ' + e.message); process.exit(1); }
    return;
  }

  const hub = createHub({ token, log: (m) => console.log('[' + new Date().toLocaleTimeString() + '] ' + m) });
  try { await hub.listen(port); } catch (e) { console.error(e.code === 'EADDRINUSE' ? `Порт ${port} занят. Запустите с другим: --port 7778 (и пересоздайте cfg с тем же портом).` : e.message); process.exit(1); }
  const link = `${site.replace(/\/?$/, '/')}#/draft?b=127.0.0.1:${port}&t=${token}`;
  console.log('Мост драфта Dota Mate запущен на 127.0.0.1:' + port + '. Данные никуда не отправляются.');
  console.log('\n1. Откройте сайт по этой ссылке (токен сохранится в браузере):\n   ' + link);
  console.log('\n2. Файл cfg для Dota 2. Положите в game/dota/cfg/gamestate_integration/' + CFG_NAME + '\n   или выполните: node ' + path.basename(process.argv[1] || 'dota-mate-bridge.js') + ' --install "<папка игры>"');
  if (!flag('quiet')) console.log('\n' + cfg);
  console.log('3. В Steam добавьте параметр запуска Dota 2: -gamestateintegration\n');

  if (flag('demo')) {
    const frames = Draft.demoFrames();
    let i = 0;
    console.log('Демо-режим: проигрываю записанный драфт, это не реальный матч.');
    const tick = () => { const f = frames[Math.min(i, frames.length - 1)]; i++; const body = Draft.toGSI(f); body.auth = { token }; hub.ingest(JSON.stringify(body)); if (i >= frames.length) i = 0; };
    tick(); setInterval(tick, 1500);
  } else console.log('Жду данные от Dota 2…');
  process.on('SIGINT', () => { hub.close().then(() => process.exit(0)); });
}
main();
