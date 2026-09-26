// Bills, meters, account and admin endpoints. Every query is scoped to the signed-in user.
import '../public/engine.js';
import { json, fail, now, newId, sha256Hex, sanitize } from './util.js';
import { clearCookie } from './auth.js';

const NM = globalThis.NM;
const MAX_PDF = 10 * 1024 * 1024;
const MAX_PAYLOAD = 256 * 1024;
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/* The browser sends { text, qrs, fileName } — the raw material it read from the PDF.
   The server rebuilds the bill with the same engine, so derived numbers can't drift. */
function rebuild(payload) {
  const text = payload.text && typeof payload.text === 'object' ? payload.text : {};
  const qrs = Array.isArray(payload.qrs) ? payload.qrs.filter(q => typeof q === 'string').slice(0, 6) : [];
  // Re-parse QR strings so the raw text is authoritative for everything the QR carries
  const bill = NM.buildBill(text, qrs, { source: 'pdf', fileName: String(payload.fileName || '').slice(0, 120) });
  return { text, qrs, bill };
}

function billRow(r) {
  let payload = {}; try { payload = JSON.parse(r.parsed_json); } catch {}
  return {
    id: r.id, meterId: r.meter_id, month: r.month, fileName: r.file_name, fileSize: r.file_size,
    hasPdf: !!r.r2_key, createdAt: r.created_at, payload,
  };
}

export async function listBills(user, env) {
  const [meters, bills] = await Promise.all([
    env.DB.prepare('SELECT id, consumer_id, ref_no, disco, label, created_at FROM meters WHERE user_id = ? ORDER BY created_at').bind(user.id).all(),
    env.DB.prepare('SELECT * FROM bills WHERE user_id = ? ORDER BY month').bind(user.id).all(),
  ]);
  return json({ meters: meters.results.map(meterOut), bills: bills.results.map(billRow) });
}
const meterOut = m => ({ id: m.id, consumerId: m.consumer_id, refNo: m.ref_no, disco: m.disco, label: m.label, createdAt: m.created_at });

export async function uploadBill(req, env, user) {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('multipart/form-data')) fail(415, 'Upload as multipart form data.');
  const form = await req.formData();
  const raw = form.get('payload');
  if (typeof raw !== 'string' || raw.length > MAX_PAYLOAD) fail(400, 'Bill data is missing or too large.');
  let payload; try { payload = sanitize(JSON.parse(raw)); } catch { fail(400, 'Bill data is not valid JSON.'); }
  const { text, qrs, bill } = rebuild(payload);

  const consumerId = String(bill.consumerId || '').replace(/\D/g, '');
  const month = bill.month;
  if (!/^\d{6,12}$/.test(consumerId)) fail(422, 'Couldn’t find the consumer ID on this bill.');
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month || '')) fail(422, 'Couldn’t find the bill month on this bill.');

  // Optional PDF
  const file = form.get('file');
  let pdf = null;
  if (file && typeof file === 'object' && file.size) {
    if (file.size > MAX_PDF) fail(413, 'That PDF is larger than 10 MB.');
    pdf = await file.arrayBuffer();
    const head = new Uint8Array(pdf.slice(0, 5));
    if (String.fromCharCode(...head) !== '%PDF-') fail(415, 'That file is not a PDF.');
  }

  const t = now();
  // Meter: one per consumer ID per user
  let meter = await env.DB.prepare('SELECT id FROM meters WHERE user_id = ? AND consumer_id = ?').bind(user.id, consumerId).first();
  if (!meter) {
    meter = { id: newId() };
    await env.DB.prepare('INSERT INTO meters (id, user_id, consumer_id, ref_no, disco, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(meter.id, user.id, consumerId, bill.refNo || null, bill.disco || null, null, t).run();
  } else {
    await env.DB.prepare('UPDATE meters SET ref_no = COALESCE(?, ref_no), disco = COALESCE(?, disco) WHERE id = ?').bind(bill.refNo || null, bill.disco || null, meter.id).run();
  }

  const existing = await env.DB.prepare('SELECT id, r2_key FROM bills WHERE meter_id = ? AND month = ?').bind(meter.id, month).first();
  const id = existing ? existing.id : newId();
  let r2Key = existing ? existing.r2_key : null, sha = null;
  if (pdf) {
    sha = await sha256Hex(pdf);
    r2Key = `u/${user.id}/${consumerId}/${month}.pdf`;
    await env.BILLS.put(r2Key, pdf, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { userId: user.id, billId: id, month } });
  }

  const e = bill.energy || {};
  const issueDay = (() => { const m = String(bill.issueDate || '').match(/^(\d{1,2})\s+([A-Z]{3})/i); return m && MON[m[2].toUpperCase()] ? +m[1] : null; })();
  const stored = JSON.stringify({ v: 1, text, qrs, fileName: bill.fileName });
  const vals = [meter.id, month, r2Key, bill.fileName || null, pdf ? pdf.byteLength : null, sha, bill.disco || null,
    e.imp ?? null, e.exp ?? null, e.net ?? null, bill.currentBill ?? null, bill.grandTotal ?? null, issueDay, stored];
  if (existing) {
    await env.DB.prepare(`UPDATE bills SET meter_id=?, month=?, r2_key=?, file_name=COALESCE(?, file_name), file_size=COALESCE(?, file_size), sha256=COALESCE(?, sha256), disco=?,
      imp_units=?, exp_units=?, net_units=?, current_bill=?, grand_total=?, issue_day=?, parsed_json=?, created_at=? WHERE id=? AND user_id=?`)
      .bind(...vals, t, id, user.id).run();
  } else {
    await env.DB.prepare(`INSERT INTO bills (meter_id, month, r2_key, file_name, file_size, sha256, disco, imp_units, exp_units, net_units, current_bill, grand_total, issue_day, parsed_json, created_at, id, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...vals, t, id, user.id).run();
  }
  const row = await env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first();
  const m = await env.DB.prepare('SELECT * FROM meters WHERE id = ?').bind(meter.id).first();
  return json({ bill: billRow(row), meter: meterOut(m), replaced: !!existing }, existing ? 200 : 201);
}

async function ownBill(env, user, id) {
  const b = await env.DB.prepare('SELECT * FROM bills WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!b) fail(404, 'Bill not found.');
  return b;
}

export async function getPdf(env, user, id, download) {
  const b = await ownBill(env, user, id);
  if (!b.r2_key) fail(404, 'No PDF was saved for this bill.');
  const obj = await env.BILLS.get(b.r2_key);
  if (!obj) fail(404, 'PDF not found in storage.');
  const name = `bill-${b.month}.pdf`;
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    },
  });
}

export async function deleteBill(env, user, id) {
  const b = await ownBill(env, user, id);
  if (b.r2_key) await env.BILLS.delete(b.r2_key);
  await env.DB.prepare('DELETE FROM bills WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return json({ ok: true });
}

export async function updateMeter(req, env, user, id) {
  const body = await req.json().catch(() => ({}));
  const label = String(body.label ?? '').replace(/[<>]/g, '').trim().slice(0, 40) || null;
  const r = await env.DB.prepare('UPDATE meters SET label = ? WHERE id = ? AND user_id = ?').bind(label, id, user.id).run();
  if (!r.meta.changes) fail(404, 'Meter not found.');
  return json({ ok: true, label });
}

export async function deleteMeter(env, user, id) {
  const m = await env.DB.prepare('SELECT id FROM meters WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!m) fail(404, 'Meter not found.');
  const keys = (await env.DB.prepare('SELECT r2_key FROM bills WHERE meter_id = ? AND r2_key IS NOT NULL').bind(id).all()).results.map(r => r.r2_key);
  for (let i = 0; i < keys.length; i += 1000) await env.BILLS.delete(keys.slice(i, i + 1000));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM bills WHERE meter_id = ? AND user_id = ?').bind(id, user.id),
    env.DB.prepare('DELETE FROM meters WHERE id = ? AND user_id = ?').bind(id, user.id),
  ]);
  return json({ ok: true });
}

export async function me(env, user) {
  const meters = (await env.DB.prepare('SELECT id, consumer_id, ref_no, disco, label, created_at FROM meters WHERE user_id = ? ORDER BY created_at').bind(user.id).all()).results.map(meterOut);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(file_size),0) AS bytes FROM bills WHERE user_id = ?').bind(user.id).first();
  return json({ user: { email: user.email, reminders: !!user.reminders, createdAt: user.created_at, isAdmin: isAdmin(env, user) }, meters, billCount: count.n, storageBytes: count.bytes });
}

export async function updateMe(req, env, user) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.reminders === 'boolean') await env.DB.prepare('UPDATE users SET reminders = ? WHERE id = ?').bind(body.reminders ? 1 : 0, user.id).run();
  return json({ ok: true });
}

export async function deleteAccount(req, env, user) {
  const body = await req.json().catch(() => ({}));
  if (String(body.confirm || '').trim().toLowerCase() !== user.email) fail(400, 'Type your email address to confirm.');
  // Remove every PDF under this user's prefix
  let cursor;
  do {
    const list = await env.BILLS.list({ prefix: `u/${user.id}/`, cursor });
    if (list.objects.length) await env.BILLS.delete(list.objects.map(o => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM bills WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM meters WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM reminder_log WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie });
}

export async function exportData(env, user, origin) {
  const meters = (await env.DB.prepare('SELECT * FROM meters WHERE user_id = ? ORDER BY created_at').bind(user.id).all()).results.map(meterOut);
  const rows = (await env.DB.prepare('SELECT * FROM bills WHERE user_id = ? ORDER BY month').bind(user.id).all()).results;
  const bills = rows.map(r => {
    const out = billRow(r);
    const { bill } = rebuild(out.payload || {});
    return {
      id: out.id, meterId: out.meterId, month: out.month, fileName: out.fileName,
      pdfUrl: out.hasPdf ? `${origin}/api/bills/${out.id}/pdf?download=1` : null,
      summary: { consumerId: bill.consumerId, disco: bill.disco, tariff: bill.tariff, currentBill: bill.currentBill, balance: bill.grandTotal, energy: bill.energy },
      analysis: NM.analyze(bill, {}), checks: NM.checks(bill), history: bill.history, raw: out.payload,
    };
  });
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), account: { email: user.email, createdAt: new Date(user.created_at * 1000).toISOString() }, meters, bills }, null, 2);
  return new Response(body, { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="solarbill-export-${new Date().toISOString().slice(0, 10)}.json"`, 'cache-control': 'no-store' } });
}

/* ---- admin ---- */
export const isAdmin = (env, user) => (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(user.email);

export async function adminStats(env, user) {
  if (!isAdmin(env, user)) fail(403, 'Admins only.');
  const t = now(), d = 86400;
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const [totals, byMonth, byDisco, signups, uploads, energy] = await env.DB.batch([
    q(`SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM users WHERE created_at > ?) AS users7,
              (SELECT COUNT(*) FROM users WHERE created_at > ?) AS users30,
              (SELECT COUNT(*) FROM users WHERE last_login_at > ?) AS active30,
              (SELECT COUNT(*) FROM users WHERE reminders = 1) AS reminders,
              (SELECT COUNT(*) FROM meters) AS meters,
              (SELECT COUNT(*) FROM bills) AS bills,
              (SELECT COUNT(*) FROM bills WHERE r2_key IS NOT NULL) AS pdfs,
              (SELECT COALESCE(SUM(file_size),0) FROM bills) AS bytes,
              (SELECT COUNT(*) FROM bills WHERE created_at > ?) AS bills7`, t - 7 * d, t - 30 * d, t - 30 * d, t - 7 * d),
    q(`SELECT month, COUNT(*) AS n FROM bills GROUP BY month ORDER BY month DESC LIMIT 12`),
    q(`SELECT COALESCE(disco,'Unknown') AS disco, COUNT(DISTINCT meter_id) AS meters, COUNT(*) AS bills FROM bills GROUP BY disco ORDER BY meters DESC`),
    q(`SELECT (created_at / 604800) AS wk, COUNT(*) AS n FROM users WHERE created_at > ? GROUP BY wk ORDER BY wk`, t - 84 * d),
    q(`SELECT (created_at / 86400) AS day, COUNT(*) AS n FROM bills WHERE created_at > ? GROUP BY day ORDER BY day`, t - 30 * d),
    q(`SELECT month, ROUND(AVG(imp_units)) AS imp, ROUND(AVG(exp_units)) AS exp, ROUND(AVG(net_units)) AS net, COUNT(*) AS n
       FROM bills WHERE imp_units IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 12`),
  ]);
  return json({
    totals: totals.results[0],
    billsByMonth: byMonth.results.reverse(),
    byDisco: byDisco.results,
    signupsByWeek: signups.results.map(r => ({ week: new Date(r.wk * 604800 * 1000).toISOString().slice(0, 10), n: r.n })),
    uploadsByDay: uploads.results.map(r => ({ day: new Date(r.day * 86400 * 1000).toISOString().slice(0, 10), n: r.n })),
    energyByMonth: energy.results.reverse(),
  });
}
