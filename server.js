const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'gastos.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    cor TEXT NOT NULL,
    emoji TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    descricao TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gastos_data ON gastos(data);
`);

const SEED = [
  ['Alimentação', '#e8743b', '🍽️'],
  ['Mercado', '#3a9d5d', '🛒'],
  ['Transporte', '#3b82c4', '🚌'],
  ['Moradia', '#8b5cf6', '🏠'],
  ['Saúde', '#d9485f', '💊'],
  ['Lazer', '#e0a800', '🎬'],
  ['Educação', '#0f9fb0', '📚'],
  ['Assinaturas', '#7c6f64', '🔁'],
  ['Compras', '#d65db1', '🛍️'],
  ['Outros', '#8a94a0', '📦'],
];
const insCat = db.prepare('INSERT OR IGNORE INTO categorias (nome, cor, emoji) VALUES (?, ?, ?)');
for (const c of SEED) insCat.run(...c);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const hoje = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const reMes = /^\d{4}-(0[1-9]|1[0-2])$/;
const reData = /^\d{4}-\d{2}-\d{2}$/;
const mesAnterior = (m) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e5) reject(new HttpError(413, 'Corpo muito grande'));
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new HttpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function validar(body, parcial = false) {
  const out = {};
  if (!parcial || 'valor' in body) {
    const v = typeof body.valor === 'string' ? Number(body.valor.replace(',', '.')) : body.valor;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1e9) throw new HttpError(400, 'Valor inválido');
    out.valor_centavos = Math.round(v * 100);
  }
  if (!parcial || 'categoria_id' in body) {
    const id = Number(body.categoria_id);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM categorias WHERE id = ?').get(id)) {
      throw new HttpError(400, 'Categoria inexistente');
    }
    out.categoria_id = id;
  }
  if ('descricao' in body) out.descricao = String(body.descricao ?? '').slice(0, 200).trim();
  if ('data' in body || !parcial) {
    const data = body.data || hoje();
    if (!reData.test(data) || Number.isNaN(Date.parse(data))) throw new HttpError(400, 'Data inválida');
    out.data = data;
  }
  return out;
}

const SELECT_GASTO = `
  SELECT g.id, g.valor_centavos, g.categoria_id, g.descricao, g.data, g.criado_em,
         c.nome AS categoria, c.cor, c.emoji
  FROM gastos g JOIN categorias c ON c.id = g.categoria_id`;

function resumo(mes) {
  const total = (m) =>
    db.prepare("SELECT COALESCE(SUM(valor_centavos),0) AS t, COUNT(*) AS n, COALESCE(MAX(valor_centavos),0) AS maior FROM gastos WHERE substr(data,1,7)=?").get(m);
  const atual = total(mes);
  const anterior = total(mesAnterior(mes));
  const porCategoria = db.prepare(`
    SELECT c.id, c.nome, c.cor, c.emoji, COALESCE(SUM(g.valor_centavos),0) AS total, COUNT(g.id) AS n
    FROM categorias c JOIN gastos g ON g.categoria_id = c.id AND substr(g.data,1,7) = ?
    GROUP BY c.id ORDER BY total DESC`).all(mes);
  const porDia = db.prepare(`
    SELECT CAST(substr(data,9,2) AS INTEGER) AS dia, SUM(valor_centavos) AS total
    FROM gastos WHERE substr(data,1,7)=? GROUP BY data ORDER BY data`).all(mes);

  const [y, mo] = mes.split('-').map(Number);
  const diasNoMes = new Date(y, mo, 0).getDate();
  const ehMesAtual = mes === hoje().slice(0, 7);
  const diasDecorridos = ehMesAtual ? new Date().getDate() : diasNoMes;
  return {
    mes,
    total: atual.t,
    quantidade: atual.n,
    maior: atual.maior,
    media_diaria: Math.round(atual.t / diasDecorridos),
    dias_no_mes: diasNoMes,
    total_mes_anterior: anterior.t,
    por_categoria: porCategoria,
    por_dia: porDia,
  };
}

async function api(req, res, url) {
  const { pathname, searchParams } = url;
  const m = req.method;
  let match;

  if (pathname === '/api/categorias' && m === 'GET') {
    return db.prepare('SELECT * FROM categorias ORDER BY id').all();
  }
  if (pathname === '/api/gastos' && m === 'GET') {
    const mes = searchParams.get('mes') || hoje().slice(0, 7);
    if (!reMes.test(mes)) throw new HttpError(400, 'Mês inválido (use YYYY-MM)');
    return db.prepare(`${SELECT_GASTO} WHERE substr(g.data,1,7)=? ORDER BY g.data DESC, g.id DESC`).all(mes);
  }
  if (pathname === '/api/gastos' && m === 'POST') {
    const d = validar(await lerCorpo(req));
    const r = db.prepare('INSERT INTO gastos (valor_centavos, categoria_id, descricao, data) VALUES (?,?,?,?)')
      .run(d.valor_centavos, d.categoria_id, d.descricao ?? '', d.data);
    res.statusCode = 201;
    return db.prepare(`${SELECT_GASTO} WHERE g.id=?`).get(r.lastInsertRowid);
  }
  if ((match = pathname.match(/^\/api\/gastos\/(\d+)$/))) {
    const id = Number(match[1]);
    if (m === 'DELETE') {
      const r = db.prepare('DELETE FROM gastos WHERE id=?').run(id);
      if (!r.changes) throw new HttpError(404, 'Gasto não encontrado');
      return { ok: true };
    }
    if (m === 'PATCH') {
      const d = validar(await lerCorpo(req), true);
      const campos = Object.keys(d);
      if (!campos.length) throw new HttpError(400, 'Nada para atualizar');
      const r = db.prepare(`UPDATE gastos SET ${campos.map((c) => `${c}=?`).join(', ')} WHERE id=?`)
        .run(...campos.map((c) => d[c]), id);
      if (!r.changes) throw new HttpError(404, 'Gasto não encontrado');
      return db.prepare(`${SELECT_GASTO} WHERE g.id=?`).get(id);
    }
  }
  if (pathname === '/api/resumo' && m === 'GET') {
    const mes = searchParams.get('mes') || hoje().slice(0, 7);
    if (!reMes.test(mes)) throw new HttpError(400, 'Mês inválido (use YYYY-MM)');
    return resumo(mes);
  }
  throw new HttpError(404, 'Rota não encontrada');
}

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return estatico(req, res, url.pathname);
  try {
    const out = await api(req, res, url);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = e.status || 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!e.status) console.error(e);
    res.end(JSON.stringify({ erro: e.status ? e.message : 'Erro interno' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Finanças rodando em http://localhost:${PORT}`);
});
