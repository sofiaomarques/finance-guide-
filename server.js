const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { bancoPronto } = require('./server/banco');
const api = require('./server/rotas');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function estatico(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.statusCode = 403;
    return res.end('Proibido');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.statusCode = 404;
      return res.end('Não encontrado');
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return estatico(req, res, url.pathname);
  try {
    await bancoPronto();
    const out = await api(req, res, url);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = e.status || 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!e.status) console.error(e);
    res.end(JSON.stringify({ erro: e.status ? e.message : 'Erro interno' }));
  }
}

// no Vercel o handler é exportado para api/index.js; local, sobe o servidor
module.exports = handler;
if (require.main === module) {
  http.createServer(handler).listen(PORT, '0.0.0.0', () => {
    console.log(`Finanças rodando em http://localhost:${PORT}`);
  });
}
