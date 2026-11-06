const crypto = require('node:crypto');
const { HttpError } = require('./erros');

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

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { hoje, reMes, reData, reEmail, mesAnterior, lerCorpo, sha256, escHtml };
