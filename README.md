# Saldo

Dashboard de gastos e ganhos mensais com cadastro rápido.

**App online:** https://finance-guide-five.vercel.app

## Como usar
1. Abra o link acima (no computador ou no celular) e crie sua conta com nome, e-mail e senha.
2. Lance seus gastos e ganhos pela tela **Painel**.
3. Acompanhe o mês na aba **Meu mês**. As setas no topo trocam o mês exibido nas duas abas.

No celular, use "Adicionar à tela inicial" no menu do navegador para abrir como um app.

## Contas
- Cada pessoa cria sua conta e só vê os próprios lançamentos.
- Senhas guardadas com scrypt; sessão em cookie `HttpOnly` válido por 30 dias.
- Gastos lançados antes de existir cadastro ficam com quem criar a **primeira** conta.
- Login bloqueia por 15 min após 10 tentativas erradas do mesmo IP.

## Cadastro rápido
- Digite o valor, toque numa categoria e aperte Enter ou **Adicionar**. Trocar de categoria (ou de Gasto para Ganho) não apaga o valor digitado.
- Ou digite tudo no campo de valor: `45 mercado pão` → R$ 45, Mercado, "pão".
- A última categoria usada fica selecionada; Enter salva.
- A data é hoje por padrão; toque em **Hoje** para lançar em outro dia.
- Toast com **Desfazer** após cada cadastro.

## Ganhos e saldo do mês
- Troque para **Ganho** no topo do cadastro para lançar dinheiro que entrou (salário, freela, vendas…).
- Atalho: comece com `+` mesmo em Gasto, ex.: `+3000 salário`.
- O card principal mostra o **saldo do mês** (ganhos − gastos) e quanto dos ganhos já foi gasto; fica vermelho se o saldo ficar negativo.
- A lista de lançamentos junta gastos e ganhos; o filtro separa por tipo ou categoria.

## Meu mês
- Balanço do mês em verde (positivo) ou vermelho (negativo), com quanto entrou e saiu.
- Movimentações agrupadas por dia, com o saldo de cada dia.
- Filtro **Todos / Gastos / Ganhos**.
- A aba escolhida (Painel ou Meu mês) fica salva no navegador.

## Rodar localmente
Node 20+.

```bash
npm install
npm start
```

Abra http://localhost:3000. Os dados ficam em `data/gastos.db` (SQLite).

Para testar no celular sem publicar: com o Mac e o celular na mesma rede Wi-Fi, abra
`http://<ip-do-mac>:3000` (`ipconfig getifaddr en0` mostra o IP).

## Deploy (Vercel)
O Vercel não guarda arquivos entre execuções, então em produção os dados ficam num banco
[Turso](https://turso.tech) (SQLite na nuvem, plano grátis). Sem ele, o site abre mas o login
avisa "Banco de dados não configurado".

- `public/` é servido direto pelo CDN e `api/index.js` atende as rotas `/api/*` (ver `vercel.json`).
- Variáveis de ambiente no projeto do Vercel (Settings → Environment Variables):
  - `TURSO_DATABASE_URL`: URL do banco, ex. `libsql://financas-<usuario>.turso.io`
  - `TURSO_AUTH_TOKEN`: token de acesso ao banco
- Para criar o banco: pelo Vercel em **Storage → Turso**, com o prefixo `TURSO_DATABASE` (a integração
  cria `TURSO_DATABASE_URL` e `TURSO_DATABASE_TURSO_AUTH_TOKEN`, que o app também aceita), ou pela
  [CLI do Turso](https://docs.turso.tech/cli/introduction): `turso db create financas`,
  `turso db show financas --url` e `turso db tokens create financas`.
- Depois de salvar as variáveis, faça **Redeploy**. As tabelas e categorias são criadas sozinhas no primeiro acesso.
