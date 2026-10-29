# Meus Gastos

Dashboard de gastos mensais com cadastro rápido. Node 22.13+ (usa `node:sqlite`), sem dependências.

```bash
npm start
```

Abra http://localhost:3000. Os dados ficam em `data/gastos.db`.

## Cadastro rápido
- Digite o valor e toque numa categoria: salva na hora.
- Ou digite tudo no campo de valor: `45 mercado pão` → R$ 45, Mercado, "pão".
- A última categoria usada fica selecionada; Enter salva.
- Toast com **Desfazer** após cada cadastro.

## Usar no celular
Com o Mac e o celular na mesma rede Wi-Fi, abra `http://<ip-do-mac>:3000` no celular
(`ipconfig getifaddr en0` mostra o IP) e use "Adicionar à tela inicial".
