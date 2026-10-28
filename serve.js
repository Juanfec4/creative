// Zero-dependency dev server: node serve.js [port]
// Auto-lists every folder containing index.html and serves a viewer at /.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function listSketches() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .filter(d => fs.existsSync(path.join(ROOT, d.name, 'index.html')))
    .map(d => {
      const html = fs.readFileSync(path.join(ROOT, d.name, 'index.html'), 'utf8');
      const m = html.match(/<title>(.*?)<\/title>/i);
      return { dir: d.name, title: m ? m[1] : d.name };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

const viewer = () => `<!doctype html>
<meta charset="utf-8">
<title>Creative</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; color: #ccc; font: 13px/1.4 monospace; }
  body { display: flex; }
  nav { width: 200px; flex: none; overflow-y: auto; border-right: 1px solid #222; padding: 8px 0; }
  nav.hidden { display: none; }
  nav a { display: block; padding: 6px 14px; color: #888; text-decoration: none; }
  nav a:hover { color: #fff; }
  nav a.active { color: #fff; background: #1a1a1a; }
  nav small { display: block; color: #555; }
  iframe { flex: 1; border: 0; background: #000; }
  #hint { position: fixed; right: 8px; bottom: 6px; color: #444; pointer-events: none; }
</style>
<nav id="nav"></nav>
<iframe id="frame"></iframe>
<div id="hint">← → switch · h hide menu · r reload</div>
<script>
  const nav = document.getElementById('nav');
  const frame = document.getElementById('frame');
  let items = [], idx = 0;

  function go(i) {
    idx = (i + items.length) % items.length;
    frame.src = '/' + items[idx].dir + '/';
    location.hash = items[idx].dir;
    [...nav.children].forEach((a, j) => a.classList.toggle('active', j === idx));
    document.title = items[idx].title;
    frame.focus();
  }

  function onKey(e) {
    if (e.key === 'ArrowRight') go(idx + 1);
    else if (e.key === 'ArrowLeft') go(idx - 1);
    else if (e.key === 'h') nav.classList.toggle('hidden');
    else if (e.key === 'r') frame.contentWindow.location.reload();
  }

  addEventListener('keydown', onKey);
  // same-origin iframe: forward its keys too
  frame.addEventListener('load', () => frame.contentWindow.addEventListener('keydown', onKey));

  fetch('/api/sketches').then(r => r.json()).then(list => {
    items = list;
    nav.innerHTML = list.map((s, i) =>
      '<a href="#' + s.dir + '" data-i="' + i + '">' + s.title + '<small>' + s.dir + '</small></a>').join('');
    nav.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a) { e.preventDefault(); go(+a.dataset.i); }
    });
    const start = items.findIndex(s => s.dir === location.hash.slice(1));
    go(start < 0 ? 0 : start);
  });
</script>`;

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return res.end(viewer());
  }
  if (url === '/api/sketches') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify(listSketches()));
  }

  let file = path.join(ROOT, url);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
