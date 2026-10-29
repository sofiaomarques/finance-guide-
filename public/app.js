const $ = (s) => document.querySelector(s);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (cent) => brl.format(cent / 100);
const pct = (n) => `${Math.round(n)}%`;

const pad = (n) => String(n).padStart(2, '0');
const isoHoje = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TIPOS = {
  gasto: { rota: 'gastos', nome: 'Gasto', chave: 'ultimaCategoria', placeholder: '0,00  ou  45 mercado' },
  ganho: { rota: 'ganhos', nome: 'Ganho', chave: 'ultimaCategoriaGanho', placeholder: '0,00  ou  3000 salário' },
};

const state = {
  mes: isoHoje().slice(0, 7),
  tipo: 'gasto',
  categorias: { gasto: [], ganho: [] },
  catSel: {
    gasto: Number(localStorage.getItem(TIPOS.gasto.chave)) || null,
    ganho: Number(localStorage.getItem(TIPOS.ganho.chave)) || null,
  },
  lancamentos: [],
  resumo: null,
  filtro: '',
  vista: localStorage.getItem('vista') === 'mes' ? 'mes' : 'painel',
  filtroMes: '',
};

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json();
  // sessão expirada no meio do uso: volta para o login
  if (res.status === 401 && !url.startsWith('/api/login')) mostrarAuth();
  if (!res.ok) throw new Error(json.erro || 'Erro');
  return json;
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, { erro = false, acao } = {}) {
  const el = $('#toast');
  el.className = `toast${erro ? ' erro' : ''}`;
  el.textContent = msg;
  if (acao) {
    const b = document.createElement('button');
    b.textContent = acao.label;
    b.onclick = () => { acao.fn(); el.hidden = true; };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), acao ? 5000 : 2200);
}

/* ---------- Mês ---------- */
const tituloMes = (mes) => {
  const [y, m] = mes.split('-').map(Number);
  const mesNome = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
  return `${mesNome[0].toUpperCase()}${mesNome.slice(1)} de ${y}`;
};
const deslocaMes = (mes, delta) => {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

/* ---------- Cadastro rápido ---------- */
function setTipo(tipo) {
  state.tipo = tipo;
  document.querySelectorAll('.tipo-abas button').forEach((b) => b.setAttribute('aria-checked', b.dataset.tipo === tipo));
  $('#form').classList.toggle('modo-ganho', tipo === 'ganho');
  $('#valor').placeholder = TIPOS[tipo].placeholder;
  $('#valor').setAttribute('aria-label', `Valor do ${TIPOS[tipo].nome.toLowerCase()}`);
  renderChips();
}
$('.tipo-abas').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  setTipo(b.dataset.tipo);
  $('#valor').focus();
});

function renderChips() {
  const sel = state.catSel[state.tipo];
  $('#chips').innerHTML = state.categorias[state.tipo]
    .map((c) => `<button type="button" class="chip" role="radio" data-id="${c.id}" style="--cor:${c.cor}" aria-checked="${c.id === sel}">${c.emoji} ${esc(c.nome)}</button>`)
    .join('');
}
function selecionaCategoria(tipo, id) {
  state.catSel[tipo] = id;
  localStorage.setItem(TIPOS[tipo].chave, id);
  if (tipo === state.tipo) renderChips();
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  // só escolhe a categoria; o valor digitado fica no campo até a pessoa salvar
  selecionaCategoria(state.tipo, Number(b.dataset.id));
  $('#valor').focus();
});

// "45 mercado pão" -> valor 45, categoria Mercado, descrição "pão"
function interpreta(texto, categorias) {
  const m = texto.trim().match(/^(\d+(?:[.,]\d{1,2})?)\s*(.*)$/);
  if (!m) return null;
  let valor = m[1];
  let resto = m[2].trim();
  let catId = null;
  if (resto) {
    const [primeira, ...demais] = resto.split(/\s+/);
    const p = norm(primeira);
    const cat = categorias.find((c) => norm(c.nome) === p) ||
      (p.length >= 3 ? categorias.find((c) => norm(c.nome).startsWith(p)) : null);
    if (cat) {
      catId = cat.id;
      resto = demais.join(' ');
    }
  }
  return { valor, catId, resto };
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // "+3000 salário" lança um ganho mesmo com a aba Gasto aberta
  const texto = $('#valor').value;
  const tipo = /^\s*\+/.test(texto) ? 'ganho' : state.tipo;
  const parsed = interpreta(texto.replace(/^\s*\+/, ''), state.categorias[tipo]);
  if (!parsed) return toast('Digite um valor válido', { erro: true });
  const categoria_id = parsed.catId || state.catSel[tipo];
  if (!categoria_id) {
    if (tipo !== state.tipo) setTipo(tipo);
    return toast('Escolha uma categoria', { erro: true });
  }
  const descricao = [parsed.resto, $('#descricao').value.trim()].filter(Boolean).join(' ');
  const data = $('#data').value || isoHoje();

  // limpa já, para o próximo lançamento poder ser digitado sem esperar a rede
  const textos = { valor: texto, descricao: $('#descricao').value };
  if (parsed.catId) selecionaCategoria(tipo, parsed.catId);
  $('#valor').value = '';
  $('#descricao').value = '';
  resetData();
  $('#valor').focus();

  try {
    const g = await api(`/api/${TIPOS[tipo].rota}`, { method: 'POST', body: { valor: parsed.valor, categoria_id, descricao, data } });
    if (g.data.slice(0, 7) !== state.mes) state.mes = g.data.slice(0, 7);
    toast(`${g.emoji} ${tipo === 'ganho' ? '+' : ''}${money(g.valor_centavos)} em ${g.categoria}`, {
      acao: { label: 'Desfazer', fn: () => remover(tipo, g.id, false) },
    });
    await carregar();
  } catch (err) {
    if (!$('#valor').value) $('#valor').value = textos.valor;
    if (!$('#descricao').value) $('#descricao').value = textos.descricao;
    toast(err.message, { erro: true });
  }
});

function resetData() {
  $('#data').value = '';
  $('#data-txt').textContent = 'Hoje';
}
$('#data').addEventListener('change', () => {
  const v = $('#data').value;
  if (!v) return resetData();
  $('#data-txt').textContent = v === isoHoje() ? 'Hoje' : v.split('-').reverse().slice(0, 2).join('/');
});

/* ---------- Dados ---------- */
async function carregar() {
  const [resumo, gastos, ganhos] = await Promise.all([
    api(`/api/resumo?mes=${state.mes}`),
    api(`/api/gastos?mes=${state.mes}`),
    api(`/api/ganhos?mes=${state.mes}`),
  ]);
  state.resumo = resumo;
  state.lancamentos = [
    ...gastos.map((g) => ({ ...g, tipo: 'gasto' })),
    ...ganhos.map((g) => ({ ...g, tipo: 'ganho' })),
  ].sort((a, b) => b.data.localeCompare(a.data) || b.criado_em.localeCompare(a.criado_em) || b.id - a.id);
  render();
}

async function remover(tipo, id, confirmar = true) {
  try {
    await api(`/api/${TIPOS[tipo].rota}/${id}`, { method: 'DELETE' });
    if (confirmar) toast(`${TIPOS[tipo].nome} removido`);
    await carregar();
  } catch (err) {
    toast(err.message, { erro: true });
  }
}

/* ---------- Render ---------- */
function render() {
  $('#mes-titulo').textContent = tituloMes(state.mes);
  renderCards();
  renderRosca();
  renderGanhos();
  renderDias();
  renderFiltro();
  renderLista();
  renderMeuMes();
}

function renderCards() {
  const r = state.resumo;
  let variacao = 'sem mês anterior';
  if (r.total_mes_anterior > 0) {
    const v = ((r.total - r.total_mes_anterior) / r.total_mes_anterior) * 100;
    variacao = `${v >= 0 ? '▲' : '▼'} ${pct(Math.abs(v))} vs. mês anterior`;
  }
  let uso = r.total ? 'Lance seus ganhos para ver quanto do que entrou já foi gasto' : 'Nenhuma movimentação neste mês ainda';
  let barra = '';
  if (r.ganhos > 0) {
    const p = (r.total / r.ganhos) * 100;
    uso = r.saldo >= 0 ? `Gastou ${pct(p)} do que entrou` : 'Gastou mais do que entrou';
    barra = `<div class="uso" aria-hidden="true"><i style="width:${Math.min(100, p)}%"></i></div>`;
  }
  const n = r.quantidade_ganhos;
  // sem gastos, média e maior gasto não dizem nada: mostra um traço em vez de R$ 0,00
  const semGasto = '<dd class="val vazio-val">—</dd><dd class="sub">sem gastos ainda</dd>';
  $('#cards').classList.toggle('negativo', r.saldo < 0);
  $('#cards').innerHTML = `
    <div class="saldo"><div class="rot">Saldo do mês</div><div class="val">${money(r.saldo)}</div>${barra}<p class="sub">${uso}</p></div>
    <dl class="indicadores">
      <div><dt>Ganhos</dt><dd class="val ${r.ganhos ? 'ganho' : 'vazio-val'}">${money(r.ganhos)}</dd><dd class="sub">${n} ${n === 1 ? 'lançamento' : 'lançamentos'}</dd></div>
      <div><dt>Gastos</dt><dd class="val">${money(r.total)}</dd><dd class="sub">${variacao}</dd></div>
      <div><dt>Média por dia</dt>${r.total ? `<dd class="val">${money(r.media_diaria)}</dd><dd class="sub">gasto diário</dd>` : semGasto}</div>
      <div><dt>Maior gasto</dt>${r.total ? `<dd class="val">${money(r.maior)}</dd><dd class="sub">num só lançamento</dd>` : semGasto}</div>
    </dl>`;
}

const itemLegenda = (c, total) => {
  const p = (c.total / total) * 100;
  return `<li><div class="leg-topo"><span>${c.emoji} ${esc(c.nome)}</span><span class="v">${money(c.total)}<span class="p">${pct(p)}</span></span></div><div class="barra"><i style="width:${p}%;background:${c.cor}"></i></div></li>`;
};

function renderRosca() {
  const r = state.resumo;
  const R = 42, C = 2 * Math.PI * R;
  // pequena folga entre os arcos para separar categorias vizinhas
  const folga = r.por_categoria.length > 1 ? 1.2 : 0;
  let acc = 0;
  const arcos = r.por_categoria.map((c) => {
    const len = (c.total / r.total) * C;
    const s = `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${c.cor}" stroke-width="10" stroke-dasharray="${Math.max(0.5, len - folga)} ${C - Math.max(0.5, len - folga)}" stroke-dashoffset="${-acc}"><title>${esc(c.nome)}: ${money(c.total)}</title></circle>`;
    acc += len;
    return s;
  }).join('');
  $('#rosca').innerHTML = `<svg viewBox="0 0 100 100" role="img" aria-label="Gastos por categoria">
    <circle class="trilha" cx="50" cy="50" r="${R}" fill="none" stroke-width="10"/>${arcos}
    <text class="centro centro-val" x="50" y="51" font-size="9" font-weight="650">${money(r.total)}</text>
    <text class="centro centro-rot" x="50" y="61" font-size="6">no mês</text></svg>`;
  if (!r.total) {
    $('#legenda').innerHTML = '<li class="vazio">Os gastos aparecem aqui, divididos por categoria, assim que você lançar o primeiro.</li>';
    return;
  }
  $('#legenda').innerHTML = r.por_categoria.map((c) => itemLegenda(c, r.total)).join('');
}

function renderGanhos() {
  const r = state.resumo;
  $('#painel-ganhos').hidden = !r.ganhos;
  $('#legenda-ganhos').innerHTML = r.ganhos ? r.ganhos_por_categoria.map((c) => itemLegenda(c, r.ganhos)).join('') : '';
}

function renderDias() {
  const r = state.resumo;
  const W = 310, H = 100;
  const max = Math.max(1, ...r.por_dia.map((d) => d.total));
  const slot = W / r.dias_no_mes;
  const mapa = new Map(r.por_dia.map((d) => [d.dia, d.total]));
  let barras = '', rotulos = '';
  for (let d = 1; d <= r.dias_no_mes; d++) {
    const t = mapa.get(d) || 0;
    const h = t ? Math.max(2, (t / max) * (H - 6)) : 0;
    const x = (d - 1) * slot;
    if (t) barras += `<rect x="${x + slot * 0.18}" y="${H - h}" width="${slot * 0.64}" height="${h}"><title>Dia ${d}: ${money(t)}</title></rect>`;
    // o eixo fica fora do SVG para os números não esticarem junto com as barras
    if (d === 1 || d % 5 === 0) rotulos += `<span style="left:${((x + slot / 2) / W) * 100}%">${d}</span>`;
  }
  const vazio = r.total ? '' : '<p class="vazio">Nenhum gasto lançado neste mês.</p>';
  $('#dias').innerHTML = `<div class="dias-graf"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gasto por dia">${barras}</svg><div class="eixo-x" aria-hidden="true">${rotulos}</div>${vazio}</div>`;
}

// valores do filtro: "" (tudo), "gasto", "ganho" ou "tipo:categoria_id"
function renderFiltro() {
  const grupo = (tipo, rotulo, todos) =>
    `<optgroup label="${rotulo}"><option value="${tipo}">${todos}</option>` +
    state.categorias[tipo].map((c) => `<option value="${tipo}:${c.id}">${c.emoji} ${esc(c.nome)}</option>`).join('') +
    '</optgroup>';
  const sel = $('#filtro');
  sel.innerHTML = '<option value="">Tudo</option>' + grupo('gasto', 'Gastos', 'Todos os gastos') + grupo('ganho', 'Ganhos', 'Todos os ganhos');
  sel.value = state.filtro;
}

// comData: mostra dd/mm na segunda linha (no Meu mês a data já está no cabeçalho do dia)
function itemLancamento(l, comData = true) {
  const [, mm, dd] = l.data.split('-');
  const ganho = l.tipo === 'ganho';
  const t2 = [comData ? `${dd}/${mm}` : TIPOS[l.tipo].nome, l.descricao && esc(l.categoria)].filter(Boolean).join(' · ');
  return `<li class="item" style="--cor:${l.cor}">
      <div class="ico">${l.emoji}</div>
      <div class="meio"><div class="t1">${esc(l.descricao || l.categoria)}</div><div class="t2">${t2}</div></div>
      <div class="valor${ganho ? ' ganho' : ''}">${ganho ? '+' : '−'}${money(l.valor_centavos)}</div>
      <button class="del" data-tipo="${l.tipo}" data-id="${l.id}" aria-label="Excluir ${TIPOS[l.tipo].nome.toLowerCase()}">✕</button>
    </li>`;
}

function renderLista() {
  const [tipo, cat] = state.filtro.split(':');
  const itens = state.lancamentos.filter((l) => (!tipo || l.tipo === tipo) && (!cat || String(l.categoria_id) === cat));
  if (!itens.length) {
    const dica = state.lancamentos.length ? 'Nenhum lançamento com esse filtro.' : 'Nenhum lançamento neste mês. Digite um valor no campo acima, por exemplo “45 mercado”.';
    $('#lista').innerHTML = `<li class="vazio">${dica}</li>`;
    return;
  }
  $('#lista').innerHTML = itens.map((l) => itemLancamento(l)).join('');
}

/* ---------- Meu mês ---------- */
function renderBalanco() {
  const r = state.resumo;
  const positivo = r.saldo >= 0;
  let frase = 'Nenhuma movimentação neste mês ainda.';
  if (r.ganhos || r.total) frase = positivo ? 'Sobrou dinheiro este mês' : 'Saiu mais do que entrou este mês';
  $('#balanco').className = `resumo balanco ${positivo ? 'positivo' : 'negativo'}`;
  $('#balanco').innerHTML = `
    <div class="rot">Balanço do mês</div>
    <div class="val">${r.saldo > 0 ? '+' : r.saldo < 0 ? '−' : ''}${money(Math.abs(r.saldo))}</div>
    <p class="frase">${frase}</p>
    <div class="fluxo">
      <div><span>Entrou</span><b class="ganho">+${money(r.ganhos)}</b></div>
      <div><span>Saiu</span><b class="gasto">−${money(r.total)}</b></div>
    </div>`;
}

const PLURAL = { '': ['movimentação', 'movimentações'], gasto: ['gasto', 'gastos'], ganho: ['ganho', 'ganhos'] };

function renderMeuMes() {
  renderBalanco();
  const f = state.filtroMes;
  document.querySelectorAll('#mes-filtro button').forEach((b) => b.setAttribute('aria-checked', b.dataset.filtro === f));
  const itens = state.lancamentos.filter((l) => !f || l.tipo === f);

  const soma = itens.reduce((s, l) => s + (l.tipo === 'ganho' ? l.valor_centavos : -l.valor_centavos), 0);
  const [um, varios] = PLURAL[f];
  $('#mes-subtotal').textContent = itens.length
    ? `${itens.length} ${itens.length === 1 ? um : varios} · ${f ? money(Math.abs(soma)) : `${soma >= 0 ? '+' : '−'}${money(Math.abs(soma))}`}`
    : '';
  if (!itens.length) {
    const nada = { '': 'Nenhuma movimentação', gasto: 'Nenhum gasto', ganho: 'Nenhum ganho' }[f];
    $('#mes-lista').innerHTML = `<p class="vazio">${nada} neste mês.</p>`;
    return;
  }

  // agrupa por dia; a lista já vem ordenada da data mais recente para a mais antiga
  const dias = new Map();
  for (const l of itens) {
    if (!dias.has(l.data)) dias.set(l.data, []);
    dias.get(l.data).push(l);
  }
  $('#mes-lista').innerHTML = [...dias].map(([data, ls]) => {
    const [y, m, d] = data.split('-').map(Number);
    const semana = new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long' });
    const rotulo = data === isoHoje() ? 'Hoje' : `${pad(d)}/${pad(m)} · ${semana[0].toUpperCase()}${semana.slice(1)}`;
    const totalDia = ls.reduce((s, l) => s + (l.tipo === 'ganho' ? l.valor_centavos : -l.valor_centavos), 0);
    return `<div class="dia">
      <div class="dia-topo"><span>${rotulo}</span><span class="${totalDia >= 0 ? 'ganho' : ''}">${totalDia >= 0 ? '+' : '−'}${money(Math.abs(totalDia))}</span></div>
      <ul class="lista">${ls.map((l) => itemLancamento(l, false)).join('')}</ul>
    </div>`;
  }).join('');
}

function setVista(vista) {
  state.vista = vista;
  localStorage.setItem('vista', vista);
  document.querySelectorAll('.vista-abas button').forEach((b) => b.setAttribute('aria-selected', b.dataset.vista === vista));
  $('#vista-painel').hidden = vista !== 'painel';
  $('#vista-mes').hidden = vista !== 'mes';
}
$('.vista-abas').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setVista(b.dataset.vista);
});
$('#mes-filtro').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.filtroMes = b.dataset.filtro;
  renderMeuMes();
});

for (const lista of ['#lista', '#mes-lista']) {
  $(lista).addEventListener('click', (e) => {
    const b = e.target.closest('.del');
    if (b) remover(b.dataset.tipo, Number(b.dataset.id));
  });
}
$('#filtro').addEventListener('change', (e) => { state.filtro = e.target.value; renderLista(); });
$('#mes-ant').addEventListener('click', () => { state.mes = deslocaMes(state.mes, -1); carregar(); });
$('#mes-prox').addEventListener('click', () => { state.mes = deslocaMes(state.mes, 1); carregar(); });

/* ---------- Login e cadastro ---------- */
let modoAuth = 'login';
function mostrarAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#auth-email').focus();
}
function trocaModo(modo) {
  modoAuth = modo;
  const cadastro = modo === 'cadastro';
  document.querySelectorAll('.auth-abas button').forEach((b) => b.setAttribute('aria-selected', b.dataset.modo === modo));
  $('#campo-nome').hidden = !cadastro;
  $('#auth-senha').autocomplete = cadastro ? 'new-password' : 'current-password';
  $('#auth-senha').placeholder = cadastro ? 'Mínimo de 8 caracteres' : '';
  $('#auth-btn').textContent = cadastro ? 'Criar conta' : 'Entrar';
  $('#auth-erro').hidden = true;
  (cadastro ? $('#auth-nome') : $('#auth-email')).focus();
}
$('.auth-abas').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) trocaModo(b.dataset.modo);
});
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { email: $('#auth-email').value, senha: $('#auth-senha').value };
  if (modoAuth === 'cadastro') body.nome = $('#auth-nome').value;
  $('#auth-btn').disabled = true;
  $('#auth-erro').hidden = true;
  try {
    const usuario = await api(modoAuth === 'cadastro' ? '/api/cadastro' : '/api/login', { method: 'POST', body });
    $('#auth-senha').value = '';
    await iniciarApp(usuario);
  } catch (err) {
    $('#auth-erro').textContent = err.message;
    $('#auth-erro').hidden = false;
  } finally {
    $('#auth-btn').disabled = false;
  }
});
$('#sair').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  state.lancamentos = [];
  state.resumo = null;
  $('#toast').hidden = true;
  mostrarAuth();
  trocaModo('login');
});

/* ---------- Início ---------- */
async function iniciarApp(usuario) {
  $('#conta-nome').textContent = `Olá, ${usuario.nome}`;
  $('#auth').hidden = true;
  $('#app').hidden = false;
  state.mes = isoHoje().slice(0, 7);
  const [gasto, ganho] = await Promise.all([api('/api/categorias'), api('/api/categorias-ganho')]);
  state.categorias = { gasto, ganho };
  for (const t of ['gasto', 'ganho']) {
    if (!state.categorias[t].some((c) => c.id === state.catSel[t])) state.catSel[t] = null;
  }
  setTipo('gasto');
  setVista(state.vista);
  await carregar();
  $('#valor').focus();
}

(async function init() {
  let usuario;
  try {
    usuario = await api('/api/eu');
  } catch {
    return mostrarAuth();
  }
  try {
    await iniciarApp(usuario);
  } catch (err) {
    toast(err.message, { erro: true });
  }
})();
