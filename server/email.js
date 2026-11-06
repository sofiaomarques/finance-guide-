const { HttpError } = require('./erros');
const { escHtml } = require('./util');

const REDEFINIR_MIN = 60;

/* ---------- E-mail (Resend) ---------- */
// sem RESEND_API_KEY: rodando local, o e-mail sai no terminal; no Vercel, a recuperação de senha fica desligada
const emailConfigurado = () => Boolean(process.env.RESEND_API_KEY) || !process.env.VERCEL;

// o link do e-mail não usa o Host da requisição, que quem pede o e-mail poderia forjar
function enderecoDoApp() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

function emailRedefinicao(u, link) {
  return {
    para: u.email,
    assunto: 'Crie uma senha nova no Saldo',
    texto: `Olá, ${u.nome}!\n\nPara criar uma senha nova, abra este link (vale por ${REDEFINIR_MIN} minutos):\n${link}\n\n`
      + 'Se não foi você que pediu, ignore este e-mail: sua senha continua a mesma.',
    html: `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#23251b">
      <p>Olá, ${escHtml(u.nome)}!</p>
      <p>Para criar uma senha nova no Saldo, toque no botão abaixo. O link vale por ${REDEFINIR_MIN} minutos.</p>
      <p><a href="${link}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#56652a;color:#fff;text-decoration:none;font-weight:600">Criar senha nova</a></p>
      <p style="color:#67664f;font-size:14px">Se não foi você que pediu, ignore este e-mail: sua senha continua a mesma.</p>
    </div>`,
  };
}

async function enviarEmail({ para, assunto, texto, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`\n[e-mail para ${para}] ${assunto}\n${texto}\n`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_REMETENTE || 'Saldo <onboarding@resend.dev>',
      to: [para],
      subject: assunto,
      text: texto,
      html,
    }),
  });
  if (!r.ok) {
    console.error('Resend recusou o e-mail:', r.status, await r.text());
    throw new HttpError(502, 'Não foi possível enviar o e-mail agora. Tente de novo em alguns minutos.');
  }
}

module.exports = { REDEFINIR_MIN, emailConfigurado, enderecoDoApp, emailRedefinicao, enviarEmail };
