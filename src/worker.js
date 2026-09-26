// Solar Bill Worker: API + auth routes. Everything else is served from /public as static assets.
import { json, HttpError } from './util.js';
import { googleStart, googleCallback, devSignIn, currentUser, logout, unsubscribe } from './auth.js';
import { listBills, uploadBill, getPdf, deleteBill, updateMeter, deleteMeter, me, updateMe, deleteAccount, exportData, adminStats } from './api.js';
import { runReminders } from './cron.js';

async function handle(req, env) {
  const url = new URL(req.url);
  const { pathname: p } = url, m = req.method;

  // Browsers always send Origin on cross-site POST/PATCH/DELETE; reject any that isn't us.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(m)) {
    const origin = req.headers.get('origin');
    // Mail clients' one-click unsubscribe POSTs carry no Origin; the signed link is its own proof.
    const oneClickUnsub = p === '/auth/unsubscribe' && (!origin || origin === 'null');
    if (!oneClickUnsub && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked.');
  }

  // ---- auth pages ----
  if (p === '/auth/google' && m === 'GET') return googleStart(req, env, url);
  if (p === '/auth/google/callback' && m === 'GET') return googleCallback(req, env, url);
  if (p === '/auth/dev' && m === 'POST') return devSignIn(req, env);
  if (p === '/auth/unsubscribe') return unsubscribe(req, env, url);
  if (p === '/api/auth/logout' && m === 'POST') return logout(req, env);

  // ---- signed-in API ----
  if (p.startsWith('/api/')) {
    const user = await currentUser(req, env);
    if (p === '/api/me' && m === 'GET' && !user) return json({ user: null });
    if (!user) throw new HttpError(401, 'Please sign in.');

    if (p === '/api/me') {
      if (m === 'GET') return me(env, user);
      if (m === 'PATCH') return updateMe(req, env, user);
      if (m === 'DELETE') return deleteAccount(req, env, user);
    }
    if (p === '/api/bills') {
      if (m === 'GET') return listBills(user, env);
      if (m === 'POST') return uploadBill(req, env, user);
    }
    let r;
    if ((r = p.match(/^\/api\/bills\/([\w-]+)\/pdf$/)) && m === 'GET') return getPdf(env, user, r[1], url.searchParams.has('download'));
    if ((r = p.match(/^\/api\/bills\/([\w-]+)$/)) && m === 'DELETE') return deleteBill(env, user, r[1]);
    if ((r = p.match(/^\/api\/meters\/([\w-]+)$/))) {
      if (m === 'PATCH') return updateMeter(req, env, user, r[1]);
      if (m === 'DELETE') return deleteMeter(env, user, r[1]);
    }
    if (p === '/api/export' && m === 'GET') return exportData(env, user, url.origin);
    if (p === '/api/admin/stats' && m === 'GET') return adminStats(env, user);
    if (p === '/api/admin/run-reminders' && m === 'POST' && env.DEV_MODE === '1') return json(await runReminders(env, url.searchParams.get('at') ? new Date(url.searchParams.get('at')) : new Date()));
    throw new HttpError(404, 'Not found.');
  }
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, new Date(event.scheduledTime)));
  },
};
