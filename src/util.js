// Small helpers shared by the Worker modules.

export const now = () => Math.floor(Date.now() / 1000);

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(n = 32) {
  const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a);
}
export const newId = () => randomToken(12);

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}

// Constant-time string compare
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

export function parseCookies(req) {
  const out = {}; const h = req.headers.get('cookie') || '';
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

export const isEmail = s => typeof s === 'string' && s.length <= 254 && /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i.test(s);

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Deep-clean untrusted JSON from the browser: bounded size, no markup, finite numbers only.
export function sanitize(v, depth = 0) {
  if (depth > 10) return null;
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 4000).replace(/[<>]/g, '');
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 400).map(x => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const o = {}; let n = 0;
    for (const [k, x] of Object.entries(v)) { if (++n > 200) break; if (/^[\w\-. ()]{1,64}$/.test(k)) o[k] = sanitize(x, depth + 1); }
    return o;
  }
  return null;
}

// Minimal HTML page used for the sign-in / unsubscribe confirmation steps.
// Server-rendered pages (sign-in, unsubscribe) share the site's header and footer.
const BOLT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
export function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600;700&display=swap">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/app.css"></head>
<body class="tinted plain">
<header class="nav"><div class="wrap"><a class="brand" href="/" aria-label="Solar Bill home">${BOLT}Solar Bill</a><a class="pill sm" href="/app">Check a bill</a></div></header>
<main class="page"><div class="plain-card">${body}</div></main>
<footer class="foot"><div class="wrap"><nav aria-label="Footer"><a href="/app">Check a bill</a><a href="/account">My account</a><a href="/privacy">Privacy</a></nav><p>© 2026 Solar Bill</p></div></footer>
</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'" } });
}
