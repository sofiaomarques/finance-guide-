const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./erros');

const DATA = path.join(__dirname, '..', 'data');

// no Vercel o disco é somente leitura e não guarda nada entre execuções, então lá os dados
// ficam num banco Turso (SQLite na nuvem, via HTTP); rodando local, usa o arquivo em data/
function abrirBanco() {
  const url = process.env.TURSO_DATABASE_URL;
  // a integração Turso do Vercel cria o token com o prefixo escolhido: TURSO_DATABASE_TURSO_AUTH_TOKEN
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_DATABASE_TURSO_AUTH_TOKEN;
  if (url) return require('@libsql/client/web').createClient({ url, authToken });
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
  CREATE TABLE IF NOT EXISTS redefinicoes (
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

module.exports = { db, roda, um, todos, bancoPronto };
