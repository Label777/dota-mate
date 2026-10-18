'use strict';
/* Поддельный API Anthropic для тестов помощника: возвращает фиксированный ответ и запоминает последний запрос. */
const http = require('node:http');
const s = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'Открой **Репутация → Жалобы**.\n\n- укажи Match ID\n- опиши эпизод <script>x</script>' }] })); });
});
s.listen(Number(process.argv[2]) || 0, '127.0.0.1', () => console.log('mock-anthropic :' + s.address().port));
