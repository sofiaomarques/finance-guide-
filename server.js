const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');

const SESSAO_COOKIE = 'sessao';
const SESSAO_DIAS = 30;

// no Vercel o disco é somente leitura e não guarda nada entre execuções, então lá os dados
// ficam num banco Turso (SQLite na nuvem, via HTTP); rodando local, usa o arquivo em data/
function abrirBanco() {
  const url = process.env.TURSO_DATABASE_URL;
  if (url) return require('@libsql/client/web').createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  if (process.env.VERCEL) return null;
  fs.mkdirSync(DATA, { recursive: true });
  return require('@libsql/client').createClient({ url: `file:${path.join(DATA, 'gastos.db')}` });
}
const db = abrirBanco();

const roda = (sql, ...args) => db.execute({ sql, args });
const um = async (sql, ...args) => (await roda(sql, ...args)).rows[0] || null;
const todos = async (sql, ...args) => (await roda(sql, ...args)).rows;

const SEED = [
  ['Alimentação', '#c8743f', '🍽️'],
  ['Mercado', '#6f8a3a', '🛒'],
  ['Transporte', '#4f7a8c', '🚌'],
  ['Moradia', '#8a6a8f', '🏠'],
  ['Saúde', '#b5585a', '💊'],
  ['Lazer', '#c9a23a', '🎬'],
  ['Educação', '#4f8a7c', '📚'],
  ['Assinaturas', '#7c6f64', '🔁'],
  ['Compras', '#b07a9a', '🛍️'],
  ['Outros', '#8a8c7e', '📦'],
];
const SEED_GANHO = [
  ['Salário', '#5f7d3a', '💼'],
  ['Freela', '#4f8a7c', '💻'],
  ['Vendas', '#c9a23a', '🏷️'],
  ['Investimentos', '#4f7a8c', '📈'],
  ['Presente', '#b07a9a', '🎁'],
  ['Reembolso', '#8a6a8f', '↩️'],
  ['Outros', '#8a8c7e', '💰'],
];

async function prepararBanco() {
  if (!db) throw new HttpError(503, 'Banco de dados não configurado no servidor (falta TURSO_DATABASE_URL)');
  if (!process.env.TURSO_DATABASE_URL) await db.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await db.executeMultiple(`
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
  if (!(await todos('PRAGMA table_info(gastos)')).some((c) => c.name === 'usuario_id')) {
    await roda('ALTER TABLE gastos ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE');
  }
  await db.batch([
    'DROP INDEX IF EXISTS idx_gastos_data',
    'CREATE INDEX IF NOT EXISTS idx_gastos_usuario_data ON gastos(usuario_id, data)',
    'CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_id)',
    // a cor segue o seed, então bancos antigos pegam a paleta nova
    ...SEED.map((args) => ({ sql: 'INSERT INTO categorias (nome, cor, emoji) VALUES (?, ?, ?) ON CONFLICT(nome) DO UPDATE SET cor = excluded.cor', args })),
    ...SEED_GANHO.map((args) => ({ sql: 'INSERT INTO categorias_ganho (nome, cor, emoji) VALUES (?, ?, ?) ON CONFLICT(nome) DO UPDATE SET cor = excluded.cor', args })),
  ], 'write');
}
// cada instância prepara o banco uma vez; as requisições esperam isso terminar
let pronto;
const bancoPronto = () => (pronto ??= prepararBanco().catch((e) => { pronto = undefined; throw e; }));

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

// o servidor do Vercel roda em UTC; "hoje" é sempre o dia no horário de Brasília
const fmtHoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
const hoje = () => fmtHoje.format(new Date());
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

async function criarSessao(res, usuarioId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.batch([
    "DELETE FROM sessoes WHERE expira_em <= datetime('now')",
    {
      sql: `INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, datetime('now', '+${SESSAO_DIAS} days'))`,
      args: [sha256(token), usuarioId],
    },
  ], 'write');
  res.setHeader('Set-Cookie', `${SESSAO_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSAO_DIAS * 86400}`);
}

async function usuarioDaSessao(req) {
  const token = lerCookies(req)[SESSAO_COOKIE];
  if (!token) return null;
  return um(`
    SELECT u.id, u.nome, u.email FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token_hash = ? AND s.expira_em > datetime('now')`, sha256(token));
}

// limite simples de tentativas de login por IP, em memória (no Vercel vale por instância)
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
async function validar(body, tipo, parcial = false) {
  const out = {};
  if (!parcial || 'valor' in body) {
    const v = typeof body.valor === 'string' ? Number(body.valor.replace(',', '.')) : body.valor;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1e9) throw new HttpError(400, 'Valor inválido');
    out.valor_centavos = Math.round(v * 100);
  }
  if (!parcial || 'categoria_id' in body) {
    const id = Number(body.categoria_id);
    if (!Number.isInteger(id) || !(await um(`SELECT 1 FROM ${tipo.categorias} WHERE id = ?`, id))) {
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

async function resumo(uid, mes) {
  const total = (tipo, m) =>
    um(`SELECT COALESCE(SUM(valor_centavos),0) AS t, COUNT(*) AS n, COALESCE(MAX(valor_centavos),0) AS maior FROM ${tipo.tabela} WHERE usuario_id=? AND substr(data,1,7)=?`, uid, m);
  const porCategoria = (tipo) => todos(`
    SELECT c.id, c.nome, c.cor, c.emoji, COALESCE(SUM(g.valor_centavos),0) AS total, COUNT(g.id) AS n
    FROM ${tipo.categorias} c JOIN ${tipo.tabela} g ON g.categoria_id = c.id AND g.usuario_id = ? AND substr(g.data,1,7) = ?
    GROUP BY c.id ORDER BY total DESC`, uid, mes);
  const [atual, anterior, ganhos, porDia, gastosPorCategoria, ganhosPorCategoria] = await Promise.all([
    total(TIPOS.gastos, mes),
    total(TIPOS.gastos, mesAnterior(mes)),
    total(TIPOS.ganhos, mes),
    todos(`
      SELECT CAST(substr(data,9,2) AS INTEGER) AS dia, SUM(valor_centavos) AS total
      FROM gastos WHERE usuario_id=? AND substr(data,1,7)=? GROUP BY data ORDER BY data`, uid, mes),
    porCategoria(TIPOS.gastos),
    porCategoria(TIPOS.ganhos),
  ]);

  const [y, mo] = mes.split('-').map(Number);
  const diasNoMes = new Date(y, mo, 0).getDate();
  const ehMesAtual = mes === hoje().slice(0, 7);
  const diasDecorridos = ehMesAtual ? Number(hoje().slice(8)) : diasNoMes;
  return {
    mes,
    total: atual.t,
    quantidade: atual.n,
    maior: atual.maior,
    media_diaria: Math.round(atual.t / diasDecorridos),
    dias_no_mes: diasNoMes,
    total_mes_anterior: anterior.t,
    por_categoria: gastosPorCategoria,
    por_dia: porDia,
    ganhos: ganhos.t,
    quantidade_ganhos: ganhos.n,
    ganhos_por_categoria: ganhosPorCategoria,
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
    const jaExiste = () => new HttpError(409, 'Já existe uma conta com esse e-mail');
    if (await um('SELECT 1 FROM usuarios WHERE email = ?', d.email)) throw jaExiste();
    let r;
    try {
      // numa transação só: o e-mail é UNIQUE, então dois cadastros iguais ao mesmo tempo não passam,
      // e os gastos lançados antes de existir cadastro ficam com quem criar a primeira conta
      [r] = await db.batch([
        { sql: 'INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)', args: [d.nome, d.email, senhaHash] },
        {
          sql: `UPDATE gastos SET usuario_id = (SELECT id FROM usuarios WHERE email = ?)
                WHERE usuario_id IS NULL AND (SELECT COUNT(*) FROM usuarios) = 1`,
          args: [d.email],
        },
      ], 'write');
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw jaExiste();
      throw e;
    }
    const id = Number(r.lastInsertRowid);
    await criarSessao(res, id);
    res.statusCode = 201;
    return { id, nome: d.nome, email: d.email };
  }
  if (pathname === '/api/login' && m === 'POST') {
    // atrás do proxy do Vercel o IP real vem no x-forwarded-for
    const ip = process.env.VERCEL ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress;
    checaLimite(ip);
    const body = await lerCorpo(req);
    const email = String(body.email ?? '').trim().toLowerCase();
    const senha = String(body.senha ?? '');
    const u = await um('SELECT id, nome, email, senha_hash FROM usuarios WHERE email = ?', email);
    const ok = await confereSenha(senha, u ? u.senha_hash : HASH_FICTICIO);
    if (!u || !ok) {
      registraFalha(ip);
      throw new HttpError(401, 'E-mail ou senha incorretos');
    }
    tentativas.delete(ip);
    await criarSessao(res, u.id);
    return { id: u.id, nome: u.nome, email: u.email };
  }
  if (pathname === '/api/logout' && m === 'POST') {
    const token = lerCookies(req)[SESSAO_COOKIE];
    if (token) await roda('DELETE FROM sessoes WHERE token_hash = ?', sha256(token));
    res.setHeader('Set-Cookie', `${SESSAO_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  }

  const usuario = await usuarioDaSessao(req);
  if (!usuario) throw new HttpError(401, 'Faça login para continuar');
  const uid = usuario.id;

  if (pathname === '/api/eu' && m === 'GET') return usuario;

  if (pathname === '/api/categorias' && m === 'GET') {
    return todos('SELECT * FROM categorias ORDER BY id');
  }
  if (pathname === '/api/categorias-ganho' && m === 'GET') {
    return todos('SELECT * FROM categorias_ganho ORDER BY id');
  }
  if ((match = pathname.match(/^\/api\/(gastos|ganhos)$/))) {
    const tipo = TIPOS[match[1]];
    if (m === 'GET') {
      const mes = searchParams.get('mes') || hoje().slice(0, 7);
      if (!reMes.test(mes)) throw new HttpError(400, 'Mês inválido (use YYYY-MM)');
      return todos(`${selectLancamento(tipo)} WHERE g.usuario_id=? AND substr(g.data,1,7)=? ORDER BY g.data DESC, g.id DESC`, uid, mes);
    }
    if (m === 'POST') {
      const d = await validar(await lerCorpo(req), tipo);
      const r = await roda(`INSERT INTO ${tipo.tabela} (usuario_id, valor_centavos, categoria_id, descricao, data) VALUES (?,?,?,?,?)`,
        uid, d.valor_centavos, d.categoria_id, d.descricao ?? '', d.data);
      res.statusCode = 201;
      return um(`${selectLancamento(tipo)} WHERE g.id=?`, r.lastInsertRowid);
    }
  }
  if ((match = pathname.match(/^\/api\/(gastos|ganhos)\/(\d+)$/))) {
    const tipo = TIPOS[match[1]];
    const id = Number(match[2]);
    if (m === 'DELETE') {
      const r = await roda(`DELETE FROM ${tipo.tabela} WHERE id=? AND usuario_id=?`, id, uid);
      if (!r.rowsAffected) throw new HttpError(404, `${tipo.nome} não encontrado`);
      return { ok: true };
    }
    if (m === 'PATCH') {
      const d = await validar(await lerCorpo(req), tipo, true);
      const campos = Object.keys(d);
      if (!campos.length) throw new HttpError(400, 'Nada para atualizar');
      const r = await roda(`UPDATE ${tipo.tabela} SET ${campos.map((c) => `${c}=?`).join(', ')} WHERE id=? AND usuario_id=?`,
        ...campos.map((c) => d[c]), id, uid);
      if (!r.rowsAffected) throw new HttpError(404, `${tipo.nome} não encontrado`);
      return um(`${selectLancamento(tipo)} WHERE g.id=?`, id);
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
