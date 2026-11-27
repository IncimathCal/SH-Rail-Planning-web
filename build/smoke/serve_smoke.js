// 查看器冒烟专用静态服务（只读 site/）：/__hold 挂起推迟 load、/__release 放行（dump-dom 路数）
// 用法：node serve_smoke.js [端口]
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, 'site');
const PORT = Number(process.argv[2] || 8801);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPhjwAAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let holders = [];
http.createServer((req, res) => {
  let u = req.url.split('?')[0];
  if (u === '/__hold') { holders.push(res); return; }
  if (u === '/__release') {
    res.writeHead(204); res.end();
    for (const h of holders) { h.writeHead(200, { 'Content-Type': 'image/png' }); h.end(PNG); }
    holders = [];
    return;
  }
  try { u = decodeURIComponent(u); } catch (e) { res.writeHead(400); res.end(); return; }
  const fp = path.join(ROOT, u === '/' ? '/index.html' : u);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('smoke on http://127.0.0.1:' + PORT + '/index.html'));
