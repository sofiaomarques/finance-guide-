const { HttpError } = require('./erros');
const { um, todos } = require('./banco');
const { hoje, reData, mesAnterior } = require('./util');

// gastos e ganhos têm o mesmo formato; muda só a tabela e de onde vêm as categorias.
// os nomes vêm só daqui, então dá para interpolar no SQL
const TIPOS = {
  gastos: { tabela: 'gastos', categorias: 'categorias', nome: 'Gasto' },
  ganhos: { tabela: 'ganhos', categorias: 'categorias_ganho', nome: 'Ganho' },
};

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

module.exports = { TIPOS, validar, selectLancamento, resumo };
