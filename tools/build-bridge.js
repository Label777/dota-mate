#!/usr/bin/env node
'use strict';
/* Собирает bridge/dota-mate-bridge.js: один файл без зависимостей из js/draft.js, server/gsi-hub.js и tools/gsi-bridge.js.
   Пользователю достаточно скачать его и запустить: node dota-mate-bridge.js. Запуск: node tools/build-bridge.js [--check] */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/^#!.*\n/, '').replace(/^'use strict';\n/m, '');

function build() {
  const draft = read('js/draft.js');
  const hub = read('server/gsi-hub.js').replace("require('../js/draft.js')", '__M.draft');
  const cli = read('tools/gsi-bridge.js').replace("require('../server/gsi-hub.js')", '__M.hub').replace("require('../js/draft.js')", '__M.draft');
  for (const [n, src] of [['hub', hub], ['cli', cli]]) if (/require\('\.\.?\//.test(src)) throw new Error('В модуле ' + n + ' остался относительный require: сборка не будет автономной.');
  return `#!/usr/bin/env node
'use strict';
/* Dota Mate: локальный мост драфта (один файл, без зависимостей, нужен Node.js 18+).
   Файл собран из js/draft.js, server/gsi-hub.js и tools/gsi-bridge.js командой "node tools/build-bridge.js". Не правьте его руками.
   Мост слушает только 127.0.0.1, принимает данные Game State Integration от Dota 2 и отдаёт странице «Драфт» только блок draft,
   часть map и сторону игрока. В интернет он ничего не отправляет. Подробности: README проекта, раздел «Драфт». */
const __M = {};
__M.draft = (function () { const module = { exports: {} }; const exports = module.exports;
${draft}
return module.exports; })();
__M.hub = (function () { const module = { exports: {} }; const exports = module.exports;
${hub}
return module.exports; })();
(function () {
${cli}
})();
`;
}
const out = path.join(root, 'bridge', 'dota-mate-bridge.js');
if (require.main === module) {
  const text = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (cur !== text) { console.error('bridge/dota-mate-bridge.js устарел: выполните node tools/build-bridge.js'); process.exit(1); }
    console.log('bridge/dota-mate-bridge.js актуален'); return;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, { mode: 0o755 });
  console.log('Записано: ' + path.relative(root, out) + ' (' + text.length + ' байт)');
}
module.exports = { build };
