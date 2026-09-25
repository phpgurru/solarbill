// Email through Resend (https://resend.com). In DEV_MODE without a key, emails are logged instead.
import { escapeHtml } from './util.js';

export async function sendEmail(env, { to, subject, html, text, headers }) {
  if (!env.RESEND_API_KEY) {
    if (env.DEV_MODE === '1') { console.log(`[dev email] to=${to} subject=${subject}\n${text}`); return { dev: true }; }
    throw new Error('RESEND_API_KEY is not set');
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text, headers }),
  });
  if (!r.ok) throw new Error(`Resend error ${r.status}: ${await r.text()}`);
  return r.json();
}

// Up to 100 emails in one call
export async function sendBatch(env, emails) {
  if (!emails.length) return;
  if (!env.RESEND_API_KEY) {
    if (env.DEV_MODE === '1') { for (const e of emails) console.log(`[dev email] to=${e.to} subject=${e.subject}`); return; }
    throw new Error('RESEND_API_KEY is not set');
  }
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(emails.map(e => ({ from: env.EMAIL_FROM, to: [e.to], subject: e.subject, html: e.html, text: e.text, headers: e.headers }))),
  });
  if (!r.ok) throw new Error(`Resend batch error ${r.status}: ${await r.text()}`);
}

const shell = (env, inner) => `<!doctype html><html><body style="margin:0;background:#eef3f5;font-family:Segoe UI,Arial,sans-serif;color:#10212b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #dde6ea" cellpadding="0" cellspacing="0"><tr><td style="padding:28px">
<div style="font-weight:800;font-size:18px;margin-bottom:18px">⚡ ${escapeHtml(env.APP_NAME)}</div>
${inner}
</td></tr></table>
<p style="font-size:12px;color:#7a8b95;margin-top:14px">${escapeHtml(env.APP_NAME)} · ${escapeHtml(new URL(env.APP_URL).host)}</p>
</td></tr></table></body></html>`;

const button = (href, label) => `<a href="${escapeHtml(href)}" style="display:inline-block;background:#10212b;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">${escapeHtml(label)}</a>`;

export function loginEmail(env, link) {
  return {
    subject: `Your ${env.APP_NAME} sign-in link`,
    html: shell(env, `<h1 style="font-size:22px;margin:0 0 10px">Sign in to ${escapeHtml(env.APP_NAME)}</h1>
      <p style="font-size:15px;line-height:1.5;color:#465864;margin:0 0 20px">Tap the button to sign in. The link works once and expires in 15 minutes.</p>
      ${button(link, 'Sign in')}
      <p style="font-size:13px;color:#7a8b95;margin:22px 0 0">Didn’t ask for this? You can ignore this email; nobody can sign in without it.</p>`),
    text: `Sign in to ${env.APP_NAME}: ${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
  };
}

export function reminderEmail(env, { monthLabel, unsubscribeUrl, meterCount }) {
  return {
    subject: `Your ${monthLabel} electricity bill should be out`,
    html: shell(env, `<h1 style="font-size:22px;margin:0 0 10px">Time to check your ${escapeHtml(monthLabel)} bill ☀️</h1>
      <p style="font-size:15px;line-height:1.5;color:#465864;margin:0 0 20px">Your new bill should now be on your DISCO’s web bill page. Download the PDF and add it to ${escapeHtml(env.APP_NAME)} to see what your panels sent back, what the evening cost you, and how your credit moved${meterCount > 1 ? ` across your ${meterCount} meters` : ''}.</p>
      ${button(env.APP_URL, 'Add my bill')}
      <p style="font-size:12px;color:#7a8b95;margin:22px 0 0">You get one reminder a month. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7a8b95">Stop these reminders</a>.</p>`),
    text: `Your ${monthLabel} electricity bill should be out. Add it at ${env.APP_URL}\n\nStop these reminders: ${unsubscribeUrl}`,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}
