// Google sign-in (OAuth 2.0 authorization code + PKCE) and cookie sessions.
import { json, now, randomToken, newId, sha256Hex, parseCookies, isEmail, escapeHtml, page, hmac, safeEqual } from './util.js';

const COOKIE = '__Host-sb_sid';
const OAUTH_COOKIE = '__Host-sb_oauth';
const SESSION_DAYS = 60;
const OAUTH_MINUTES = 10;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = url => `${url.origin}/auth/google/callback`;
const redirect = (location, cookies = []) => {
  const h = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 302, headers: h });
};
const oauthCookie = (v, age) => `${OAUTH_COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const failed = reason => { console.warn('Google sign-in failed:', reason); return redirect('/app?signin_error=1', [oauthCookie('', 0)]); };

// Step 1: send the browser to Google's account chooser.
export async function googleStart(req, env, url) {
  if (!env.GOOGLE_CLIENT_ID) {
    if (env.DEV_MODE === '1') return devSignInPage(env);
    throw new Error('GOOGLE_CLIENT_ID is not set');
  }
  const state = randomToken(24), verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code',
    scope: 'openid email', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, [oauthCookie(`${state}.${verifier}`, OAUTH_MINUTES * 60)]);
}

// Step 2: Google sends the browser back with a code. Check state, swap the code for an ID token, start a session.
export async function googleCallback(req, env, url) {
  const [state, verifier] = (parseCookies(req)[OAUTH_COOKIE] || '').split('.');
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error')) return failed(url.searchParams.get('error'));
  if (!state || !verifier || !code || !safeEqual(url.searchParams.get('state') || '', state)) return failed('state mismatch');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(url), grant_type: 'authorization_code', code_verifier: verifier }),
  });
  if (!r.ok) return failed(`token ${r.status}: ${await r.text()}`);
  const { id_token } = await r.json();
  // The ID token came straight from Google's token endpoint over TLS, so its claims can be trusted
  // without re-checking the signature (OpenID Connect Core 3.1.3.7). The claims are still validated.
  let c;
  try { c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0)))); }
  catch (e) { return failed('bad id_token'); }
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss) || c.aud !== env.GOOGLE_CLIENT_ID || !(c.exp > now())) return failed('bad claims');
  if (!c.sub || !c.email_verified || !isEmail(c.email)) return failed('email not verified');

  const sid = await startSession(req, env, String(c.email).toLowerCase(), String(c.sub));
  return redirect('/app?welcome=1', [sessionCookie(sid), oauthCookie('', 0)]);
}

// Local development without Google keys: type any email to sign in.
function devSignInPage(env) {
  return page(`Sign in · ${env.APP_NAME}`, `
    <h1>Dev sign-in</h1><p>GOOGLE_CLIENT_ID isn’t set, so DEV_MODE lets you sign in as any email.</p>
    <form method="post" action="/auth/dev" style="flex-direction:column;gap:10px"><input name="email" type="email" required placeholder="you@example.com" style="padding:10px;border-radius:10px;border:1px solid var(--line-2)">
    <button class="btn primary big" type="submit">Sign in</button></form>`);
}
export async function devSignIn(req, env) {
  if (env.DEV_MODE !== '1' || env.GOOGLE_CLIENT_ID) return new Response('Not found', { status: 404 });
  const email = String((await req.formData()).get('email') || '').trim().toLowerCase();
  if (!isEmail(email)) return redirect('/auth/google');
  return redirect('/app?welcome=1', [sessionCookie(await startSession(req, env, email, null))]);
}

// Find the user by Google account (then by email, for accounts made before Google sign-in), create if new.
async function startSession(req, env, email, sub) {
  const t = now();
  let user = (sub && await env.DB.prepare('SELECT id FROM users WHERE google_sub = ?').bind(sub).first())
    || await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    user = { id: newId() };
    await env.DB.prepare('INSERT INTO users (id, email, google_sub, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)').bind(user.id, email, sub, t, t).run();
  } else {
    await env.DB.prepare('UPDATE users SET google_sub = COALESCE(?, google_sub), last_login_at = ? WHERE id = ?').bind(sub, t, user.id).run();
  }
  const sid = randomToken(32);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(sid), user.id, t, t + SESSION_DAYS * 86400, (req.headers.get('user-agent') || '').slice(0, 200)),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
  ]);
  return sid;
}
const sessionCookie = sid => `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;

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
    return page(`Unsubscribed · ${env.APP_NAME}`, `<h1>Reminders stopped</h1><p>You won’t get monthly bill reminders any more. You can turn them back on from your account page.</p><a class="btn big" href="/app">Open ${escapeHtml(env.APP_NAME)}</a>`);
  }
  if (!ok) return page(`Link not valid · ${env.APP_NAME}`, `<h1>This link isn’t valid</h1><p>Turn reminders off from your account page instead.</p><a class="btn big" href="/account">My account</a>`, 400);
  return page(`Stop reminders · ${env.APP_NAME}`, `<h1>Stop monthly reminders?</h1><p>You’ll no longer get an email when your new bill is due.</p>
    <form method="post"><button class="btn primary big" type="submit">Stop reminders</button></form>`);
}
