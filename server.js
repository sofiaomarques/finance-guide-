const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const SESSAO_COOKIE = 'sessao';
const SESSAO_DIAS = 30;

const db = new DatabaseSync(path.join(DATA, 'gastos.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    cor TEXT NOT NULL,
    emoji TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    senha_hash TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    descricao TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS categorias_ganho (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    cor TEXT NOT NULL,
    emoji TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ganhos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
    categoria_id INTEGER NOT NULL REFERENCES categorias_ganho(id),
    descricao TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ganhos_usuario_data ON ganhos(usuario_id, data);
`);
// bancos criados antes do cadastro de usuários não têm a coluna usuario_id
if (!db.prepare('PRAGMA table_info(gastos)').all().some((c) => c.name === 'usuario_id')) {
  db.exec('ALTER TABLE gastos ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE');
}
db.exec(`
  DROP INDEX IF EXISTS idx_gastos_data;
  CREATE INDEX IF NOT EXISTS idx_gastos_usuario_data ON gastos(usuario_id, data);
  CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_id);
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

const SEED_GANHO = [
  ['Salário', '#2f8a4e', '💼'],
  ['Freela', '#0f9fb0', '💻'],
  ['Vendas', '#e0a800', '🏷️'],
  ['Investimentos', '#3b82c4', '📈'],
  ['Presente', '#d65db1', '🎁'],
  ['Reembolso', '#8b5cf6', '↩️'],
  ['Outros', '#8a94a0', '💰'],
];
const insCatGanho = db.prepare('INSERT OR IGNORE INTO categorias_ganho (nome, cor, emoji) VALUES (?, ?, ?)');
for (const c of SEED_GANHO) insCatGanho.run(...c);

// gastos e ganhos têm o mesmo formato; muda só a tabela e de onde vêm as categorias.
// os nomes vêm só daqui, então dá para interpolar no SQL
const TIPOS = {
  gastos: { tabela: 'gastos', categorias: 'categorias', nome: 'Gasto' },
  ganhos: { tabela: 'ganhos', categorias: 'categorias_ganho', nome: 'Ganho' },
};

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
const reEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

/* ---------- Usuários e sessões ---------- */
async function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(senha, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function confereSenha(senha, guardado) {
  const [, saltHex, hashHex] = guardado.split('$');
  const esperado = Buffer.from(hashHex, 'hex');
  const hash = await scrypt(senha, Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(hash, esperado);
}
// usado quando o e-mail não existe, para o login levar o mesmo tempo nos dois casos
const HASH_FICTICIO = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function lerCookies(req) {
  const out = {};
  for (const par of (req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0) out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return out;
}

function criarSessao(res, usuarioId) {
  db.prepare("DELETE FROM sessoes WHERE expira_em <= datetime('now')").run();
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, datetime('now', '+${SESSAO_DIAS} days'))`)
    .run(sha256(token), usuarioId);
  res.setHeader('Set-Cookie', `${SESSAO_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSAO_DIAS * 86400}`);
}

function usuarioDaSessao(req) {
  const token = lerCookies(req)[SESSAO_COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.nome, u.email FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token_hash = ? AND s.expira_em > datetime('now')`).get(sha256(token)) || null;
}

// limite simples de tentativas de login por IP, em memória
const tentativas = new Map();
const JANELA_MS = 15 * 60 * 1000;
const MAX_TENTATIVAS = 10;
function checaLimite(ip) {
  const t = tentativas.get(ip);
  if (t && Date.now() - t.inicio < JANELA_MS && t.n >= MAX_TENTATIVAS) {
    throw new HttpError(429, 'Muitas tentativas. Tente de novo em alguns minutos.');
  }
}
function registraFalha(ip) {
  const t = tentativas.get(ip);
  if (!t || Date.now() - t.inicio >= JANELA_MS) tentativas.set(ip, { inicio: Date.now(), n: 1 });
  else t.n++;
}

function validarCadastro(body) {
  const nome = String(body.nome ?? '').trim().slice(0, 80);
  const email = String(body.email ?? '').trim().toLowerCase();
  const senha = String(body.senha ?? '');
  if (!nome) throw new HttpError(400, 'Informe seu nome');
  if (!reEmail.test(email) || email.length > 254) throw new HttpError(400, 'E-mail inválido');
  if (senha.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres');
  if (senha.length > 200) throw new HttpError(400, 'Senha muito longa');
  return { nome, email, senha };
}

/* ---------- Gastos e ganhos ---------- */
function validar(body, tipo, parcial = false) {
  const out = {};
  if (!parcial || 'valor' in body) {
    const v = typeof body.valor === 'string' ? Number(body.valor.replace(',', '.')) : body.valor;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1e9) throw new HttpError(400, 'Valor inválido');
    out.valor_centavos = Math.round(v * 100);
  }
  if (!parcial || 'categoria_id' in body) {
    const id = Number(body.categoria_id);
    if (!Number.isInteger(id) || !db.prepare(`SELECT 1 FROM ${tipo.categorias} WHERE id = ?`).get(id)) {
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

const selectLancamento = (tipo) => `
  SELECT g.id, g.valor_centavos, g.categoria_id, g.descricao, g.data, g.criado_em,
         c.nome AS categoria, c.cor, c.emoji
  FROM ${tipo.tabela} g JOIN ${tipo.categorias} c ON c.id = g.categoria_id`;

function resumo(uid, mes) {
  const total = (tipo, m) =>
    db.prepare(`SELECT COALESCE(SUM(valor_centavos),0) AS t, COUNT(*) AS n, COALESCE(MAX(valor_centavos),0) AS maior FROM ${tipo.tabela} WHERE usuario_id=? AND substr(data,1,7)=?`).get(uid, m);
  const porCategoria = (tipo) => db.prepare(`
    SELECT c.id, c.nome, c.cor, c.emoji, COALESCE(SUM(g.valor_centavos),0) AS total, COUNT(g.id) AS n
    FROM ${tipo.categorias} c JOIN ${tipo.tabela} g ON g.categoria_id = c.id AND g.usuario_id = ? AND substr(g.data,1,7) = ?
    GROUP BY c.id ORDER BY total DESC`).all(uid, mes);
  const atual = total(TIPOS.gastos, mes);
  const anterior = total(TIPOS.gastos, mesAnterior(mes));
  const ganhos = total(TIPOS.ganhos, mes);
  const porDia = db.prepare(`
    SELECT CAST(substr(data,9,2) AS INTEGER) AS dia, SUM(valor_centavos) AS total
    FROM gastos WHERE usuario_id=? AND substr(data,1,7)=? GROUP BY data ORDER BY data`).all(uid, mes);

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
    por_categoria: porCategoria(TIPOS.gastos),
    por_dia: porDia,
    ganhos: ganhos.t,
    quantidade_ganhos: ganhos.n,
    ganhos_por_categoria: porCategoria(TIPOS.ganhos),
    saldo: ganhos.t - atual.t,
  };
}

async function api(req, res, url) {
  const { pathname, searchParams } = url;
  const m = req.method;
  let match;

  // só aceita JSON em escritas: um formulário de outro site não consegue enviar isso sem preflight
  if ((m === 'POST' || m === 'PATCH') && !String(req.headers['content-type']).startsWith('application/json')) {
    throw new HttpError(415, 'Envie JSON');
  }

  /* ----- Autenticação ----- */
  if (pathname === '/api/cadastro' && m === 'POST') {
    const d = validarCadastro(await lerCorpo(req));
    const senhaHash = await hashSenha(d.senha);
    // daqui em diante tudo é síncrono, então ninguém cadastra o mesmo e-mail no meio do caminho
    if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(d.email)) {
      throw new HttpError(409, 'Já existe uma conta com esse e-mail');
    }
    const primeiro = !db.prepare('SELECT 1 FROM usuarios LIMIT 1').get();
    const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)').run(d.nome, d.email, senhaHash);
    // gastos lançados antes de existir cadastro ficam com quem criar a primeira conta
    if (primeiro) db.prepare('UPDATE gastos SET usuario_id = ? WHERE usuario_id IS NULL').run(r.lastInsertRowid);
    criarSessao(res, r.lastInsertRowid);
    res.statusCode = 201;
    return { id: Number(r.lastInsertRowid), nome: d.nome, email: d.email };
  }
  if (pathname === '/api/login' && m === 'POST') {
    const ip = req.socket.remoteAddress;
    checaLimite(ip);
    const body = await lerCorpo(req);
    const email = String(body.email ?? '').trim().toLowerCase();
    const senha = String(body.senha ?? '');
    const u = db.prepare('SELECT id, nome, email, senha_hash FROM usuarios WHERE email = ?').get(email);
    const ok = await confereSenha(senha, u ? u.senha_hash : HASH_FICTICIO);
    if (!u || !ok) {
      registraFalha(ip);
      throw new HttpError(401, 'E-mail ou senha incorretos');
    }
    tentativas.delete(ip);
    criarSessao(res, u.id);
    return { id: u.id, nome: u.nome, email: u.email };
  }
  if (pathname === '/api/logout' && m === 'POST') {
    const token = lerCookies(req)[SESSAO_COOKIE];
    if (token) db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sha256(token));
    res.setHeader('Set-Cookie', `${SESSAO_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  }

  const usuario = usuarioDaSessao(req);
  if (!usuario) throw new HttpError(401, 'Faça login para continuar');
  const uid = usuario.id;

  if (pathname === '/api/eu' && m === 'GET') return usuario;

  if (pathname === '/api/categorias' && m === 'GET') {
    return db.prepare('SELECT * FROM categorias ORDER BY id').all();
  }
  if (pathname === '/api/categorias-ganho' && m === 'GET') {
    return db.prepare('SELECT * FROM categorias_ganho ORDER BY id').all();
  }
  if ((match = pathname.match(/^\/api\/(gastos|ganhos)$/))) {
    const tipo = TIPOS[match[1]];
    if (m === 'GET') {
      const mes = searchParams.get('mes') || hoje().slice(0, 7);
      if (!reMes.test(mes)) throw new HttpError(400, 'Mês inválido (use YYYY-MM)');
      return db.prepare(`${selectLancamento(tipo)} WHERE g.usuario_id=? AND substr(g.data,1,7)=? ORDER BY g.data DESC, g.id DESC`).all(uid, mes);
    }
    if (m === 'POST') {
      const d = validar(await lerCorpo(req), tipo);
      const r = db.prepare(`INSERT INTO ${tipo.tabela} (usuario_id, valor_centavos, categoria_id, descricao, data) VALUES (?,?,?,?,?)`)
        .run(uid, d.valor_centavos, d.categoria_id, d.descricao ?? '', d.data);
      res.statusCode = 201;
      return db.prepare(`${selectLancamento(tipo)} WHERE g.id=?`).get(r.lastInsertRowid);
    }
  }
  if ((match = pathname.match(/^\/api\/(gastos|ganhos)\/(\d+)$/))) {
    const tipo = TIPOS[match[1]];
    const id = Number(match[2]);
    if (m === 'DELETE') {
      const r = db.prepare(`DELETE FROM ${tipo.tabela} WHERE id=? AND usuario_id=?`).run(id, uid);
      if (!r.changes) throw new HttpError(404, `${tipo.nome} não encontrado`);
      return { ok: true };
    }
    if (m === 'PATCH') {
      const d = validar(await lerCorpo(req), tipo, true);
      const campos = Object.keys(d);
      if (!campos.length) throw new HttpError(400, 'Nada para atualizar');
      const r = db.prepare(`UPDATE ${tipo.tabela} SET ${campos.map((c) => `${c}=?`).join(', ')} WHERE id=? AND usuario_id=?`)
        .run(...campos.map((c) => d[c]), id, uid);
      if (!r.changes) throw new HttpError(404, `${tipo.nome} não encontrado`);
      return db.prepare(`${selectLancamento(tipo)} WHERE g.id=?`).get(id);
    }
  }
  if (pathname === '/api/resumo' && m === 'GET') {
    const mes = searchParams.get('mes') || hoje().slice(0, 7);
    if (!reMes.test(mes)) throw new HttpError(400, 'Mês inválido (use YYYY-MM)');
    return resumo(uid, mes);
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
    res.setHeader('Cache-Control', 'no-store');
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
