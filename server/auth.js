const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError } = require('./erros');
const { db, um } = require('./banco');
const { reEmail, sha256 } = require('./util');

const scrypt = promisify(crypto.scrypt);

const SESSAO_COOKIE = 'sessao';
const SESSAO_DIAS = 30;

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

// atrás do proxy do Vercel o IP real vem no x-forwarded-for
const ipDe = (req) => (process.env.VERCEL ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress);

// limite simples de tentativas por IP, em memória (no Vercel vale por instância)
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
  return { nome, email, senha: validarSenha(senha) };
}
function validarSenha(valor) {
  const senha = String(valor ?? '');
  if (senha.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres');
  if (senha.length > 200) throw new HttpError(400, 'Senha muito longa');
  return senha;
}

module.exports = {
  SESSAO_COOKIE, hashSenha, confereSenha, HASH_FICTICIO, lerCookies, criarSessao, usuarioDaSessao,
  ipDe, checaLimite, registraFalha, tentativas, validarCadastro, validarSenha,
};
