// Magic-link sign-in and cookie sessions.
import { json, fail, now, randomToken, newId, sha256Hex, parseCookies, isEmail, escapeHtml, page, hmac, safeEqual } from './util.js';
import { sendEmail, loginEmail } from './email.js';

const COOKIE = '__Host-sh_sid';
const SESSION_DAYS = 60;
const TOKEN_MINUTES = 15;

const clientIp = req => req.headers.get('cf-connecting-ip') || 'unknown';

export async function requestLink(req, env) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!isEmail(email)) fail(400, 'Enter a valid email address.');
  const ip = clientIp(req), t = now();

  // Rate limits: 5 links per email and 20 per IP address per hour
  const hourAgo = t - 3600;
  const byEmail = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?').bind(email, hourAgo).first('n');
  const byIp = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE ip = ? AND created_at > ?').bind(ip, hourAgo).first('n');
  if (byEmail >= 5 || byIp >= 20) fail(429, 'Too many sign-in emails. Please wait an hour and try again.');

  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO login_tokens (token_hash, email, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), email, t, t + TOKEN_MINUTES * 60, ip).run();

  const origin = new URL(req.url).origin;
  const link = `${origin}/auth/verify?token=${encodeURIComponent(token)}`;
  const msg = loginEmail(env, link);
  const r = await sendEmail(env, { to: email, ...msg });
  // In local development without an email key, hand the link back so you can click it.
  return json({ ok: true, ...(r && r.dev ? { devLink: link } : {}) });
}

// Step 1: the link from the email opens a confirmation page. A button POSTs the token.
// (Email security scanners open links automatically; a GET must never use up the token.)
export function verifyPage(url, env) {
  const token = url.searchParams.get('token') || '';
  return page(`Sign in · ${env.APP_NAME}`, `
    <div class="plain-logo">⚡ ${escapeHtml(env.APP_NAME)}</div>
    <h1>Sign in</h1><p>Continue to your bills on this device.</p>
    <form method="post" action="/auth/verify"><input type="hidden" name="token" value="${escapeHtml(token)}">
    <button class="btn primary big" type="submit">Continue</button></form>`);
}

// Step 2: validate the token, create the user if new, start a session.
export async function verifyToken(req, env) {
  const form = await req.formData();
  const token = String(form.get('token') || '');
  const hash = await sha256Hex(token), t = now();
  const row = await env.DB.prepare('SELECT email, expires_at, used_at FROM login_tokens WHERE token_hash = ?').bind(hash).first();
  if (!row || row.used_at || row.expires_at < t) {
    return page(`Link expired · ${env.APP_NAME}`, `<div class="plain-logo">⚡ ${escapeHtml(env.APP_NAME)}</div>
      <h1>This link has expired</h1><p>Sign-in links work once, for 15 minutes. Request a new one.</p><a class="btn primary big" href="/?signin=1">Get a new link</a>`, 400);
  }
  // Mark used first, conditionally, so the same token can't be replayed in parallel
  const upd = await env.DB.prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(t, hash).run();
  if (!upd.meta.changes) fail(400, 'Link already used.');

  let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(row.email).first();
  if (!user) {
    user = { id: newId() };
    await env.DB.prepare('INSERT INTO users (id, email, created_at, last_login_at) VALUES (?, ?, ?, ?)').bind(user.id, row.email, t, t).run();
  } else {
    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(t, user.id).run();
  }
  const sid = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(sid), user.id, t, t + SESSION_DAYS * 86400, (req.headers.get('user-agent') || '').slice(0, 200)).run();
  // Housekeeping: old tokens and expired sessions
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_tokens WHERE created_at < ?').bind(t - 86400),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
  ]);
  return new Response(null, {
    status: 303,
    headers: { location: '/?welcome=1', 'set-cookie': `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`, 'cache-control': 'no-store' },
  });
}

export async function currentUser(req, env) {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.email, u.reminders, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?'
  ).bind(await sha256Hex(sid), now()).first();
  return row || null;
}

export async function logout(req, env) {
  const sid = parseCookies(req)[COOKIE];
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256Hex(sid)).run();
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/* ---- one-click unsubscribe for reminder emails ---- */
const secret = env => {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.DEV_MODE === '1') return 'dev-secret';
  throw new Error('SESSION_SECRET is not set');
};
export async function unsubscribeUrl(env, userId) {
  const s = await hmac(secret(env), `unsub:${userId}`);
  return `${env.APP_URL}/auth/unsubscribe?u=${encodeURIComponent(userId)}&s=${encodeURIComponent(s)}`;
}
export async function unsubscribe(req, env, url) {
  let u = url.searchParams.get('u'), s = url.searchParams.get('s');
  const ok = u && s && safeEqual(s, await hmac(secret(env), `unsub:${u}`));
  if (req.method === 'POST' && ok) {
    await env.DB.prepare('UPDATE users SET reminders = 0 WHERE id = ?').bind(u).run();
    return page(`Unsubscribed · ${env.APP_NAME}`, `<div class="plain-logo">⚡ ${escapeHtml(env.APP_NAME)}</div><h1>Reminders stopped</h1><p>You won’t get monthly bill reminders any more. You can turn them back on from your account page.</p><a class="btn big" href="/">Open ${escapeHtml(env.APP_NAME)}</a>`);
  }
  if (!ok) return page(`Link not valid · ${env.APP_NAME}`, `<h1>This link isn’t valid</h1><p>Turn reminders off from your account page instead.</p><a class="btn big" href="/account">My account</a>`, 400);
  return page(`Stop reminders · ${env.APP_NAME}`, `<div class="plain-logo">⚡ ${escapeHtml(env.APP_NAME)}</div><h1>Stop monthly reminders?</h1><p>You’ll no longer get an email when your new bill is due.</p>
    <form method="post"><button class="btn primary big" type="submit">Stop reminders</button></form>`);
}
