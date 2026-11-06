const crypto = require('node:crypto');
const { HttpError } = require('./erros');
const { db, roda, um, todos } = require('./banco');
const { hoje, reMes, reEmail, lerCorpo, sha256 } = require('./util');
const {
  SESSAO_COOKIE, hashSenha, confereSenha, HASH_FICTICIO, lerCookies, criarSessao, usuarioDaSessao,
  ipDe, checaLimite, registraFalha, tentativas, validarCadastro, validarSenha,
} = require('./auth');
const { REDEFINIR_MIN, emailConfigurado, enderecoDoApp, emailRedefinicao, enviarEmail } = require('./email');
const { TIPOS, validar, selectLancamento, resumo } = require('./lancamentos');

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
    const ip = ipDe(req);
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
  if (pathname === '/api/esqueci-senha' && m === 'POST') {
    if (!emailConfigurado()) throw new HttpError(503, 'A recuperação de senha por e-mail ainda não foi configurada');
    // cada pedido conta como tentativa: segura quem tentar lotar a caixa de alguém com e-mails
    const chave = `esqueci:${ipDe(req)}`;
    checaLimite(chave);
    registraFalha(chave);
    const email = String((await lerCorpo(req)).email ?? '').trim().toLowerCase();
    if (!reEmail.test(email)) throw new HttpError(400, 'E-mail inválido');
    const u = await um('SELECT id, nome, email FROM usuarios WHERE email = ?', email);
    if (u) {
      // o banco guarda só o hash do token, como nas sessões; um link novo invalida os anteriores
      const token = crypto.randomBytes(32).toString('base64url');
      await db.batch([
        { sql: "DELETE FROM redefinicoes WHERE usuario_id = ? OR expira_em <= datetime('now')", args: [u.id] },
        {
          sql: `INSERT INTO redefinicoes (token_hash, usuario_id, expira_em) VALUES (?, ?, datetime('now', '+${REDEFINIR_MIN} minutes'))`,
          args: [sha256(token), u.id],
        },
      ], 'write');
      // o token vai depois do #, que o navegador não manda para o servidor nem para outros sites
      await enviarEmail(emailRedefinicao(u, `${enderecoDoApp()}/#redefinir=${token}`));
    }
    // a resposta é a mesma exista ou não a conta
    return { ok: true };
  }
  if (pathname === '/api/redefinir-senha' && m === 'POST') {
    const body = await lerCorpo(req);
    const senhaHash = await hashSenha(validarSenha(body.senha));
    // apaga e lê numa operação só, então o mesmo link não serve duas vezes
    const r = await um(`DELETE FROM redefinicoes WHERE token_hash = ? AND expira_em > datetime('now') RETURNING usuario_id`,
      sha256(String(body.token ?? '')));
    if (!r) throw new HttpError(400, 'Este link não vale mais. Peça um novo em "Esqueci minha senha".');
    const uid = r.usuario_id;
    // senha nova derruba as sessões abertas em outros aparelhos
    await db.batch([
      { sql: 'UPDATE usuarios SET senha_hash = ? WHERE id = ?', args: [senhaHash, uid] },
      { sql: 'DELETE FROM redefinicoes WHERE usuario_id = ?', args: [uid] },
      { sql: 'DELETE FROM sessoes WHERE usuario_id = ?', args: [uid] },
    ], 'write');
    await criarSessao(res, uid);
    return um('SELECT id, nome, email FROM usuarios WHERE id = ?', uid);
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

module.exports = api;
