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

const state = {
  mes: isoHoje().slice(0, 7),
  categorias: [],
  catSel: Number(localStorage.getItem('ultimaCategoria')) || null,
  gastos: [],
  resumo: null,
  filtro: '',
};

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json();
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
function renderChips() {
  $('#chips').innerHTML = state.categorias
    .map((c) => `<button type="button" class="chip" role="radio" data-id="${c.id}" style="--cor:${c.cor}" aria-checked="${c.id === state.catSel}">${c.emoji} ${esc(c.nome)}</button>`)
    .join('');
}
function selecionaCategoria(id) {
  state.catSel = id;
  localStorage.setItem('ultimaCategoria', id);
  renderChips();
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  selecionaCategoria(Number(b.dataset.id));
  const valor = $('#valor');
  // com valor já digitado, tocar na categoria salva direto
  if (valor.value.trim()) $('#form').requestSubmit();
  else valor.focus();
});

// "45 mercado pão" -> valor 45, categoria Mercado, descrição "pão"
function interpreta(texto) {
  const m = texto.trim().match(/^(\d+(?:[.,]\d{1,2})?)\s*(.*)$/);
  if (!m) return null;
  let valor = m[1];
  let resto = m[2].trim();
  let catId = null;
  if (resto) {
    const [primeira, ...demais] = resto.split(/\s+/);
    const p = norm(primeira);
    const cat = state.categorias.find((c) => norm(c.nome) === p) ||
      (p.length >= 3 ? state.categorias.find((c) => norm(c.nome).startsWith(p)) : null);
    if (cat) {
      catId = cat.id;
      resto = demais.join(' ');
    }
  }
  return { valor, catId, resto };
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const parsed = interpreta($('#valor').value);
  if (!parsed) return toast('Digite um valor válido', { erro: true });
  const categoria_id = parsed.catId || state.catSel;
  if (!categoria_id) return toast('Escolha uma categoria', { erro: true });
  const descricao = [parsed.resto, $('#descricao').value.trim()].filter(Boolean).join(' ');
  const data = $('#data').value || isoHoje();

  // limpa já, para o próximo lançamento poder ser digitado sem esperar a rede
  const textos = { valor: $('#valor').value, descricao: $('#descricao').value, data: $('#data').value };
  if (parsed.catId) selecionaCategoria(parsed.catId);
  $('#valor').value = '';
  $('#descricao').value = '';
  resetData();
  $('#valor').focus();

  try {
    const g = await api('/api/gastos', { method: 'POST', body: { valor: parsed.valor, categoria_id, descricao, data } });
    if (g.data.slice(0, 7) !== state.mes) state.mes = g.data.slice(0, 7);
    toast(`${g.emoji} ${money(g.valor_centavos)} em ${g.categoria}`, {
      acao: { label: 'Desfazer', fn: () => remover(g.id, false) },
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
  const [resumo, gastos] = await Promise.all([
    api(`/api/resumo?mes=${state.mes}`),
    api(`/api/gastos?mes=${state.mes}`),
  ]);
  state.resumo = resumo;
  state.gastos = gastos;
  render();
}

async function remover(id, confirmar = true) {
  try {
    await api(`/api/gastos/${id}`, { method: 'DELETE' });
    if (confirmar) toast('Gasto removido');
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
  renderDias();
  renderFiltro();
  renderLista();
}

function renderCards() {
  const r = state.resumo;
  let variacao = 'sem mês anterior';
  if (r.total_mes_anterior > 0) {
    const v = ((r.total - r.total_mes_anterior) / r.total_mes_anterior) * 100;
    variacao = `${v >= 0 ? '▲' : '▼'} ${pct(Math.abs(v))} vs. mês anterior`;
  }
  $('#cards').innerHTML = `
    <div class="card destaque"><div class="rot">Total do mês</div><div class="val">${money(r.total)}</div><div class="sub">${variacao}</div></div>
    <div class="card"><div class="rot">Média por dia</div><div class="val">${money(r.media_diaria)}</div></div>
    <div class="card"><div class="rot">Lançamentos</div><div class="val">${r.quantidade}</div></div>
    <div class="card"><div class="rot">Maior gasto</div><div class="val">${money(r.maior)}</div></div>`;
}

function renderRosca() {
  const r = state.resumo;
  if (!r.total) {
    $('#rosca').innerHTML = '';
    $('#legenda').innerHTML = '<li class="vazio">Nenhum gasto neste mês ainda.</li>';
    return;
  }
  const R = 42, C = 2 * Math.PI * R;
  let acc = 0;
  const arcos = r.por_categoria.map((c) => {
    const len = (c.total / r.total) * C;
    const s = `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${c.cor}" stroke-width="14" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}"><title>${esc(c.nome)}: ${money(c.total)}</title></circle>`;
    acc += len;
    return s;
  }).join('');
  $('#rosca').innerHTML = `<svg viewBox="0 0 100 100" role="img" aria-label="Gastos por categoria">${arcos}<text class="centro" x="50" y="53" font-size="9" font-weight="700">${r.por_categoria.length} cat.</text></svg>`;
  $('#legenda').innerHTML = r.por_categoria.map((c) => {
    const p = (c.total / r.total) * 100;
    return `<li><div class="leg-topo"><span>${c.emoji} ${esc(c.nome)}</span><span class="v">${money(c.total)}<span class="p">${pct(p)}</span></span></div><div class="barra"><i style="width:${p}%;background:${c.cor}"></i></div></li>`;
  }).join('');
}

function renderDias() {
  const r = state.resumo;
  if (!r.total) { $('#dias').innerHTML = '<p class="vazio">Sem dados.</p>'; return; }
  const W = 310, H = 100, base = 88;
  const max = Math.max(...r.por_dia.map((d) => d.total));
  const slot = W / r.dias_no_mes;
  const mapa = new Map(r.por_dia.map((d) => [d.dia, d.total]));
  let barras = '', rotulos = '';
  for (let d = 1; d <= r.dias_no_mes; d++) {
    const t = mapa.get(d) || 0;
    const h = t ? Math.max(2, (t / max) * (base - 6)) : 0;
    const x = (d - 1) * slot;
    if (t) barras += `<rect x="${x + 1}" y="${base - h}" width="${Math.max(2, slot - 2)}" height="${h}" rx="2" fill="var(--brand)"><title>Dia ${d}: ${money(t)}</title></rect>`;
    if (d === 1 || d % 5 === 0) rotulos += `<text class="eixo" x="${x + slot / 2}" y="${H}">${d}</text>`;
  }
  $('#dias').innerHTML = `<svg viewBox="0 0 ${W} ${H + 4}" preserveAspectRatio="none" role="img" aria-label="Gasto por dia">${barras}${rotulos}</svg>`;
}

function renderFiltro() {
  const sel = $('#filtro');
  sel.innerHTML = '<option value="">Todas as categorias</option>' +
    state.categorias.map((c) => `<option value="${c.id}">${c.emoji} ${esc(c.nome)}</option>`).join('');
  sel.value = state.filtro;
}

function renderLista() {
  const itens = state.filtro ? state.gastos.filter((g) => String(g.categoria_id) === state.filtro) : state.gastos;
  if (!itens.length) { $('#lista').innerHTML = '<li class="vazio">Nenhum lançamento.</li>'; return; }
  $('#lista').innerHTML = itens.map((g) => {
    const [, mm, dd] = g.data.split('-');
    return `<li class="item" style="--cor:${g.cor}">
      <div class="ico">${g.emoji}</div>
      <div class="meio"><div class="t1">${esc(g.descricao || g.categoria)}</div><div class="t2">${dd}/${mm}${g.descricao ? ` · ${esc(g.categoria)}` : ''}</div></div>
      <div class="valor">${money(g.valor_centavos)}</div>
      <button class="del" data-id="${g.id}" aria-label="Excluir gasto">✕</button>
    </li>`;
  }).join('');
}

$('#lista').addEventListener('click', (e) => {
  const b = e.target.closest('.del');
  if (b) remover(Number(b.dataset.id));
});
$('#filtro').addEventListener('change', (e) => { state.filtro = e.target.value; renderLista(); });
$('#mes-ant').addEventListener('click', () => { state.mes = deslocaMes(state.mes, -1); carregar(); });
$('#mes-prox').addEventListener('click', () => { state.mes = deslocaMes(state.mes, 1); carregar(); });

/* ---------- Início ---------- */
(async function init() {
  try {
    state.categorias = await api('/api/categorias');
    if (!state.categorias.some((c) => c.id === state.catSel)) state.catSel = null;
    renderChips();
    await carregar();
    $('#valor').focus();
  } catch (err) {
    toast(err.message, { erro: true });
  }
})();
