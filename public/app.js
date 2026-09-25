/* Solar Bill front end. Bills are parsed in the browser (engine.js); signed-in users' bills are saved to the server. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtN = (v, d = 0) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-PK', { minimumFractionDigits: d, maximumFractionDigits: d });
const rs = (v, d = 0) => v == null || isNaN(v) ? '—' : (v < 0 ? '−' : '') + 'Rs ' + fmtN(Math.abs(v), d);
const sgn = v => (v < 0 ? '−' : v > 0 ? '+' : '') + fmtN(Math.abs(v));
const pct = v => v == null ? '—' : Math.round(v * 100) + '%';
const cr = v => v == null ? '—' : v < 0 ? `Rs ${fmtN(-v)} credit` : rs(v);
const MONTHFULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const mFull = k => { if (!k) return 'This'; const [y, m] = k.split('-'); return `${MONTHFULL[+m - 1]} ${y}`; };

const state = { bills: [], sel: null, inputs: {}, meter: null, meters: [], user: null };
let globalCost = null, rateOverride = { op: null, pk: null };
const mkey = b => b.consumerId || 'unknown';
const meterBills = () => state.bills.filter(b => mkey(b) === state.meter);
const cur = () => state.bills.find(b => b.id === state.sel);
const inp = () => state.inputs[state.sel] || (state.inputs[state.sel] = { gen: null, days: 30 });
const optsFor = b => { const i = state.inputs[b.id] || {}; return { generation: i.gen, days: i.days || 30, rateOP: rateOverride.op ?? undefined, ratePK: rateOverride.pk ?? undefined }; };
const meterName = key => { const m = state.meters.find(m => m.consumerId === key); if (m && m.label) return m.label; const b = state.bills.find(b => mkey(b) === key && b.disco) || (m && { disco: m.disco }); return `${b && b.disco ? b.disco + ' ' : ''}meter ···${String(key).slice(-4)}`; };

/* ---------------- server calls ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${r.status})`), { status: r.status });
  return data;
}
function fromServer(row) {
  const p = row.payload || {};
  const b = NM.buildBill(p.text || {}, p.qrs || [], { source: 'cloud', fileName: row.fileName || p.fileName });
  b.id = row.id; b.hasPdf = row.hasPdf; b._payload = p;
  return b;
}
async function saveToServer(b) {
  const fd = new FormData();
  fd.append('payload', JSON.stringify(b._payload));
  if (b._file) fd.append('file', b._file, b._file.name);
  const r = await api('/api/bills', { method: 'POST', body: fd });
  if (r.meter && !state.meters.some(m => m.id === r.meter.id)) state.meters.push(r.meter);
  return fromServer(r.bill);
}

/* Bills added before signing in wait in this browser (IndexedDB) until the magic link brings the user back. */
const PENDING_DB = 'solarbill-pending';
function idb() { return new Promise((res, rej) => { const q = indexedDB.open(PENDING_DB, 1); q.onupgradeneeded = () => q.result.createObjectStore('bills', { autoIncrement: true }); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function stashPending(bills) {
  const db = await idb(); const tx = db.transaction('bills', 'readwrite'); const st = tx.objectStore('bills'); st.clear();
  for (const b of bills) st.add({ payload: b._payload, file: b._file || null, fileName: b._file ? b._file.name : null });
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function takePending() {
  try {
    const db = await idb(); const tx = db.transaction('bills', 'readwrite'); const st = tx.objectStore('bills');
    const all = await new Promise((res, rej) => { const q = st.getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    st.clear(); return all;
  } catch (e) { return []; }
}

/* ---------------- reading files ---------------- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
const setStatus = (msg, err) => { const s = $('#status'); s.textContent = msg || ''; s.classList.toggle('err', !!err); };
function decodeCanvas(c) { const x = c.getContext('2d', { willReadFrequently: true }); const d = x.getImageData(0, 0, c.width, c.height); const r = jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' }); return r ? r.data : null; }
function canvasFrom(src, sx, sy, sW, sH, target) {
  const s = Math.min(1, target / Math.max(sW, sH)), pad = 24, w = Math.round(sW * s), h = Math.round(sH * s);
  const c = document.createElement('canvas'); c.width = w + pad * 2; c.height = h + pad * 2;
  const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, sx, sy, sW, sH, pad, pad, w, h); return c;
}
function scanAll(src, w, h) {
  const found = new Set();
  const tryR = (sx, sy, sW, sH, ts) => { for (const t of ts) { const v = decodeCanvas(canvasFrom(src, sx, sy, sW, sH, t)); if (v) { found.add(v); return; } } };
  tryR(0, 0, w, h, [1400, 900]);
  for (const n of [2, 3]) {
    const tw = Math.min(w, w / n * 1.5), th = Math.min(h, h / n * 1.5);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) tryR(Math.max(0, Math.min(w - tw, i * w / n - tw / 6)), Math.max(0, Math.min(h - th, j * h / n - th / 6)), tw, th, [1000, 700]);
    if (found.size >= 2) break;
  }
  return [...found];
}
async function bitmapOf(o) {
  if (o.bitmap) return o.bitmap; if (!o.data) return null;
  const c = document.createElement('canvas'); c.width = o.width; c.height = o.height; const x = c.getContext('2d'); const id = x.createImageData(o.width, o.height); const px = o.width * o.height;
  if (o.kind === 3) id.data.set(o.data.subarray(0, px * 4));
  else if (o.kind === 2) for (let i = 0; i < px; i++) { id.data[i*4] = o.data[i*3]; id.data[i*4+1] = o.data[i*3+1]; id.data[i*4+2] = o.data[i*3+2]; id.data[i*4+3] = 255; }
  else if (o.kind === 1) { const rb = (o.width + 7) >> 3; for (let y = 0; y < o.height; y++) for (let xx = 0; xx < o.width; xx++) { const v = ((o.data[y*rb + (xx>>3)] >> (7 - (xx & 7))) & 1) ? 255 : 0, i = y*o.width + xx; id.data[i*4] = id.data[i*4+1] = id.data[i*4+2] = v; id.data[i*4+3] = 255; } }
  else return null;
  x.putImageData(id, 0, 0); return c;
}
async function readPdf(file) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const items = tc.items.map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5] }));
  const qrs = new Set();
  for (let p = 1; p <= Math.min(doc.numPages, 2); p++) {
    const pg = p === 1 ? page : await doc.getPage(p); const ops = await pg.getOperatorList();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== pdfjsLib.OPS.paintImageXObject) continue;
      const o = await new Promise(r => { try { pg.objs.get(ops.argsArray[i][0], r); } catch (e) { r(null); } });
      if (!o || !o.width) continue; const ar = o.width / o.height; if (ar < 0.8 || ar > 1.25) continue;
      const bmp = await bitmapOf(o); if (!bmp) continue;
      for (const t of [900, 1300, 1800]) { const v = decodeCanvas(canvasFrom(bmp, 0, 0, o.width, o.height, t)); if (v) { qrs.add(v); break; } }
    }
  }
  if (qrs.size < 2) { const vp = page.getViewport({ scale: 3 }); const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height); await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; scanAll(c, c.width, c.height).forEach(v => qrs.add(v)); }
  const text = NM.parseText(items);
  const b = NM.buildBill(text, [...qrs], { source: 'pdf', fileName: file.name });
  b._payload = { text, qrs: [...qrs], fileName: file.name }; b._file = file;
  return b;
}
async function readImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const qrs = scanAll(img, img.naturalWidth, img.naturalHeight);
    const b = NM.buildBill({}, qrs, { source: 'image', fileName: file.name }); b._payload = { text: {}, qrs, fileName: file.name }; return b;
  } finally { URL.revokeObjectURL(url); }
}
function addBill(b) {
  if (!b.qrNet && !b.energy && !b.history.length) throw new Error('no-data');
  state.bills = state.bills.filter(x => x.source !== 'sample' && x.id !== b.id && !(x.month && x.month === b.month && mkey(x) === mkey(b)));
  state.bills.push(b); state.bills.sort((a, c) => (a.month || '').localeCompare(c.month || ''));
  state.sel = b.id; state.meter = mkey(b);
}
async function ingest(b) {
  if (state.user) { if (!b.consumerId || !b.month) throw new Error('This bill has no consumer ID or month we can read, so it can’t be saved.'); b = await saveToServer(b); }
  addBill(b);
}
async function handleFiles(files) {
  files = [...files].filter(f => /pdf|image/.test(f.type) || /\.pdf$/i.test(f.name)); if (!files.length) return;
  let ok = 0; const bad = [];
  for (const [i, f] of files.entries()) {
    setStatus(`${state.user ? 'Reading and saving' : 'Reading'} ${f.name} (${i + 1} of ${files.length})…`);
    try { await ingest(/pdf/i.test(f.type) || /\.pdf$/i.test(f.name) ? await readPdf(f) : await readImage(f)); ok++; }
    catch (e) { console.warn(e); bad.push(`${f.name}${e.status ? ` (${e.message})` : ''}`); }
  }
  setStatus(bad.length ? `Added ${ok} bill${ok === 1 ? '' : 's'}. Couldn’t read ${bad.join(', ')}. For photos, crop close to the QR codes and try again.`
    : state.user ? `Saved ${ok} bill${ok === 1 ? '' : 's'} to your account.` : '', bad.length && !ok);
  render();
}
const veil = $('#veil'); let dragN = 0;
const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragN++; veil.hidden = false; });
addEventListener('dragend', () => { dragN = 0; veil.hidden = true; });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; e.preventDefault(); if (--dragN <= 0) { dragN = 0; veil.hidden = true; } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); dragN = 0; veil.hidden = true; handleFiles(e.dataTransfer.files); });
$('#file').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
document.addEventListener('paste', e => {
  if (e.target.closest && e.target.closest('input,textarea')) return;
  const files = [...(e.clipboardData?.files || [])]; if (files.length) return handleFiles(files);
  const t = e.clipboardData?.getData('text'); if (t && t.length > 20) addFromText(t);
});
async function addFromText(t) {
  const qrs = t.split(/\n\s*\n(?=0002|BILL-MONTH)/).map(s => s.trim()).filter(Boolean);
  const b = NM.buildBill({}, qrs, { source: 'paste', fileName: 'Pasted QR text' }); b._payload = { text: {}, qrs, fileName: 'Pasted QR text' };
  try { await ingest(b); setStatus(''); render(); } catch (e) { setStatus(e.status ? e.message : 'That text doesn’t look like a bill QR code. It should start with “BILL-MONTH:”.', true); }
}

/* ---------------- sign in ---------------- */
const dlg = $('#signin');
function openSignin() {
  $('#si-form').hidden = false; $('#si-sent').hidden = true; $('#si-err').textContent = '';
  const n = state.bills.filter(b => b.source !== 'sample' && b._payload).length;
  $('#si-keep').hidden = !n; $('#si-keep').textContent = n ? `The ${n} bill${n > 1 ? 's' : ''} you added will be saved to your account when you sign in on this device.` : '';
  dlg.showModal(); setTimeout(() => $('#si-email').focus(), 30);
}
$('#si-close').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
$('#si-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#si-email').value.trim(), btn = $('#si-go');
  btn.disabled = true; btn.textContent = 'Sending…'; $('#si-err').textContent = '';
  try {
    const guest = state.bills.filter(b => b.source !== 'sample' && b._payload);
    if (guest.length) await stashPending(guest).catch(() => {});
    const r = await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email }) });
    $('#si-form').hidden = true; $('#si-sent').hidden = false; $('#si-to').textContent = email;
    $('#si-dev').innerHTML = r.devLink ? `Dev mode: <a href="${esc(r.devLink)}">open the sign-in link</a>` : '';
  } catch (err) { $('#si-err').textContent = err.message; }
  btn.disabled = false; btn.textContent = 'Email me a sign-in link';
});
document.addEventListener('click', e => { if (e.target.closest('[data-signin]')) { e.preventDefault(); openSignin(); } });

function renderAccountBar() {
  const box = $('#acct');
  box.innerHTML = state.user
    ? `<a class="btn" href="/account" title="${esc(state.user.email)}"><span class="avatar" aria-hidden="true">${esc(state.user.email[0].toUpperCase())}</span>My bills</a>${state.user.isAdmin ? '<a class="btn" href="/admin">Admin</a>' : ''}`
    : `<button class="btn" type="button" data-signin>Sign in</button>`;
}

/* tooltip */
const tip = $('#tip');
function showTip(el, x, y) { tip.innerHTML = el.getAttribute('data-tip'); tip.classList.add('on'); const r = tip.getBoundingClientRect(); let L = x + 14, T = y + 14; if (L + r.width > innerWidth - 8) L = x - r.width - 14; if (T + r.height > innerHeight - 8) T = y - r.height - 14; tip.style.left = Math.max(8, L) + 'px'; tip.style.top = Math.max(8, T) + 'px'; }
document.addEventListener('pointermove', e => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el, e.clientX, e.clientY); else tip.classList.remove('on'); });
document.addEventListener('focusin', e => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); } });
document.addEventListener('focusout', () => tip.classList.remove('on'));
addEventListener('scroll', () => tip.classList.remove('on'), { passive: true });

/* ---------------- icons ---------------- */
const ICON = {
  sun: (s = 40, c = 'var(--day)') => `<svg width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="8" fill="${c}"/>${[0,45,90,135,180,225,270,315].map(a => `<line x1="20" y1="4" x2="20" y2="9" stroke="${c}" stroke-width="3" stroke-linecap="round" transform="rotate(${a} 20 20)"/>`).join('')}</svg>`,
  moon: (s = 40, c = 'var(--eve)') => `<svg width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true"><path d="M26 30a12 12 0 0 1-9.6-19.2A12 12 0 1 0 29.2 26 12 12 0 0 1 26 30z" fill="${c}"/><circle cx="30" cy="11" r="1.6" fill="${c}"/><circle cx="34" cy="17" r="1.1" fill="${c}"/></svg>`,
  bolt: (s = 20, c = '#fff') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
};

/* ---------------- render ---------------- */
function render() { renderAccountBar(); renderChips(); renderSave(); renderMain(); }
function renderChips() {
  const bar = $('#chips');
  const keys = [...new Set(state.bills.map(mkey))];
  if (!keys.includes(state.meter)) state.meter = keys[keys.length - 1] || null;
  const meterRow = keys.length > 1 ? `<div class="meters" role="group" aria-label="Meters">${keys.map(k => `<button type="button" class="mchip" aria-pressed="${k === state.meter}" data-meter="${esc(k)}">${esc(meterName(k))}</button>`).join('')}</div>` : '';
  const mb = meterBills();
  const canRemove = !state.user;
  bar.innerHTML = meterRow + `<div class="chips-row">${mb.map(b => `<span class="chip" role="button" tabindex="0" aria-pressed="${b.id === state.sel}" data-id="${b.id}">${esc(NM.monthLabel(b.month))}${b.source === 'sample' ? ' <span class="tag">Sample</span>' : ''}${canRemove ? `<button class="x" type="button" aria-label="Remove ${esc(NM.monthLabel(b.month))}" data-rm="${b.id}">×</button>` : ''}</span>`).join('')}</div>`;
  bar.querySelectorAll('.mchip').forEach(c => c.addEventListener('click', () => { state.meter = c.dataset.meter; const mb2 = meterBills(); state.sel = mb2.length ? mb2[mb2.length - 1].id : null; render(); }));
  bar.querySelectorAll('.chip').forEach(c => {
    const pick = () => { state.sel = c.dataset.id; render(); };
    c.addEventListener('click', e => { if (!e.target.closest('.x')) pick(); });
    c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
  bar.querySelectorAll('[data-rm]').forEach(x => x.addEventListener('click', () => { state.bills = state.bills.filter(b => b.id !== x.dataset.rm); if (state.sel === x.dataset.rm) { const mb2 = meterBills(); state.sel = mb2.length ? mb2[mb2.length - 1].id : (state.bills[0] || {}).id; } render(); }));
}
function renderSave() {
  const box = $('#save');
  if (state.user) { box.hidden = true; return; }
  const n = state.bills.filter(b => b.source !== 'sample').length;
  box.hidden = false;
  box.innerHTML = `<span class="save-ic" aria-hidden="true">${ICON.sun(26, '#fff')}</span>
    <div><b>${n ? `Keep ${n === 1 ? 'this bill' : `these ${n} bills`} and add one every month` : 'Track your solar every month'}</b>
    <span>${n ? 'Sign in with your email to save them. Next month, add the new bill and watch your credit, exports and savings build up.' : 'Sign in with your email to save your bills, see month-by-month trends, and get a reminder when your new bill is out.'}</span></div>
    <button class="btn primary" type="button" data-signin>${n ? 'Save my bills' : 'Sign in'}</button>`;
}

function renderMain() {
  const m = $('#main'), b = cur();
  if (!b) { m.innerHTML = `<div class="card"><h2>Add a bill to begin</h2><p class="lede">Tap “Add bill PDFs” and choose your net-metering web bill. LESCO, IESCO, FESCO, GEPCO, MEPCO, PESCO and HESCO bills share the same layout.</p></div>`; return; }
  const A = NM.analyze(b, optsFor(b)), checks = NM.checks(b), tl = NM.timeline(meterBills());
  m.innerHTML = [hero(b, A), dayEvening(b, A, tl), moneyCard(b, A), savingsCard(b, A), takeaways(b, A, tl), trends(b, tl), experts(b, A, checks)].filter(Boolean).join('');
  bind(b, A); drawCharts(tl);
}

/* HERO: energy-flow illustration */
function hero(b, A) {
  const e = b.energy, n = b.qrNet || {}, bal = b.grandTotal;
  const meta = [state.meters.find(m => m.consumerId === b.consumerId && m.label)?.label, b.disco, n.dgCapacity && `${fmtN(n.dgCapacity, 1).replace(/\.0$/, '')} kW solar`, b.tariff && `Tariff ${b.tariff}`, b.source === 'sample' ? 'Sample bill, add yours above' : b.fileName].filter(Boolean);
  const headline = bal == null ? `${mFull(b.month)} at a glance` : bal < 0
    ? `<span class="ok">${rs(-bal)} in credit.</span> Nothing to pay this month.`
    : `<span class="due">${rs(bal)} to pay</span>${b.dueDate ? ` by ${esc(b.dueDate)}` : ''}.`;
  let sub = '';
  if (e) sub = e.net > 0 ? `In ${mFull(b.month)} you took ${fmtN(e.net)} kWh more from the grid than your panels sent back, mostly in the evening.` : `In ${mFull(b.month)} your panels sent ${fmtN(-e.net)} kWh more to the grid than you used from it.`;
  if (!e) return `<section class="card hero"><div class="head"><div class="meta">${meta.map(x => `<span>${esc(x)}</span>`).join('')}</div><h1>${headline}</h1></div><div style="padding:24px"><div class="empty">This bill has no unit data we can read.</div></div></section>`;
  const gen = A.gen, self = A.selfUse != null && A.selfUse > 0 ? A.selfUse : null;
  const w = v => Math.max(5, Math.min(22, 4 + Math.sqrt(v) * 0.55));
  const svg = `<svg class="flow" viewBox="0 0 760 360" role="img" aria-label="Energy flow: ${fmtN(e.exp)} kWh sent to the grid, ${fmtN(e.imp)} kWh taken from the grid">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--sky1)"/><stop offset="1" stop-color="var(--sky2)"/></linearGradient>
      <marker id="arS" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--sun-c)"/></marker>
      <marker id="arG" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--grid-c)"/></marker>
    </defs>
    <rect x="0" y="0" width="760" height="360" fill="url(#sky)"/>
    <rect x="0" y="318" width="760" height="42" fill="var(--ground)"/>
    <!-- sun -->
    <g class="rays">${[0,30,60,90,120,150,180,210,240,270,300,330].map(a => `<line x1="96" y1="30" x2="96" y2="42" stroke="var(--day)" stroke-width="4" stroke-linecap="round" transform="rotate(${a} 96 78)"/>`).join('')}</g>
    <circle cx="96" cy="78" r="26" fill="var(--day)"/>
    <path d="M122 96 L250 150" stroke="var(--day)" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round" opacity=".8"/>
    <path d="M110 110 L228 176" stroke="var(--day)" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round" opacity=".6"/>
    ${gen ? `<text class="fx" x="96" y="142" text-anchor="middle" font-size="17" font-weight="700" fill="var(--day-ink)">${fmtN(gen)} kWh made</text>` : ''}
    <!-- house -->
    <polygon points="200,200 320,112 440,200" fill="var(--roof)"/>
    <g transform="translate(222 150) skewY(-36)">${[0,1,2,3].map(i => `<rect x="${i*21}" y="30" width="18" height="30" rx="2" fill="var(--panel)"/>`).join('')}</g>
    <rect x="218" y="196" width="204" height="122" rx="6" fill="var(--house)" stroke="var(--house-line)" stroke-width="2"/>
    <rect x="248" y="222" width="46" height="38" rx="4" fill="var(--sky1)" stroke="var(--house-line)" stroke-width="2"/>
    <rect x="346" y="244" width="44" height="74" rx="4" fill="var(--sunk)" stroke="var(--house-line)" stroke-width="2"/>
    <text class="fs" x="272" y="296" text-anchor="middle" font-size="16" font-weight="800" fill="var(--ink-2)">HOME</text>
    ${self ? `<text class="fx" x="320" y="96" text-anchor="middle" font-size="16" font-weight="700" fill="var(--day-ink)">${fmtN(self)} kWh used at home</text>` : ''}
    <!-- pylon -->
    <g stroke="var(--ink-2)" stroke-width="3" stroke-linecap="round" fill="none" opacity=".85">
      <path d="M640 318 L660 96 L680 318"/><path d="M646 250 L674 250 M650 200 L670 200 M654 150 L666 150"/>
      <path d="M646 250 L670 200 L654 150 M674 250 L650 200 L666 150"/>
      <path d="M618 118 L702 118 M626 160 L694 160"/><path d="M660 96 L660 118"/>
    </g>
    <path d="M702 118 Q 735 128 760 122 M694 160 Q 730 172 760 166" stroke="var(--ink-2)" stroke-width="1.5" fill="none" opacity=".5"/>
    <text class="fs" x="660" y="346" text-anchor="middle" font-size="16" font-weight="800" fill="var(--ink-2)">GRID</text>
    <!-- export: roof to grid -->
    <path id="pE" d="M404 170 C 480 92, 560 84, 616 116" fill="none" stroke="var(--sun-c)" stroke-width="${w(e.exp)}" stroke-linecap="round" opacity=".28"/>
    <path d="M404 170 C 480 92, 560 84, 616 116" fill="none" stroke="var(--sun-c)" stroke-width="${w(e.exp) * .55}" stroke-linecap="round" stroke-dasharray="2 14" class="flowdots"/>
    <path d="M590 104 L616 116" stroke="var(--sun-c)" stroke-width="3" marker-end="url(#arS)" fill="none"/>
    <text class="fs" x="510" y="52" text-anchor="middle" font-size="16" font-weight="700" fill="var(--ink-2)">Sent to grid</text>
    <text class="fb" x="510" y="86" text-anchor="middle" font-size="30" font-weight="900" fill="var(--sun-c)">${fmtN(e.exp)} kWh</text>
    <!-- import: grid to house -->
    <path d="M636 268 C 580 300, 500 300, 426 272" fill="none" stroke="var(--grid-c)" stroke-width="${w(e.imp)}" stroke-linecap="round" opacity=".28"/>
    <path d="M636 268 C 580 300, 500 300, 426 272" fill="none" stroke="var(--grid-c)" stroke-width="${w(e.imp) * .55}" stroke-linecap="round" stroke-dasharray="2 14" class="flowdots"/>
    <path d="M450 283 L426 272" stroke="var(--grid-c)" stroke-width="3" marker-end="url(#arG)" fill="none"/>
    <text class="fs" x="532" y="226" text-anchor="middle" font-size="16" font-weight="700" fill="var(--ink-2)">Taken from grid</text>
    <text class="fb" x="532" y="264" text-anchor="middle" font-size="30" font-weight="900" fill="var(--grid-c)">${fmtN(e.imp)} kWh</text>
  </svg>`;
  const tot = Math.max(1, e.imp);
  return `<section class="card hero" aria-labelledby="h-hero">
    <div class="head"><div class="meta">${meta.map(x => `<span>${esc(x)}</span>`).join('')}</div><h1 id="h-hero">${headline}</h1><p class="sub">${sub}</p></div>
    ${svg}
    <div class="trio">
      <div><span class="k"><i class="dot" style="background:var(--grid-c)"></i>Taken from grid</span><span class="v num">${fmtN(e.imp)}<small>kWh</small></span>
        <div class="split" aria-hidden="true"><span style="flex:${e.impOP};background:var(--day)"></span><span style="flex:${e.impPK};background:var(--eve)"></span></div>
        <span class="s">${fmtN(e.impOP)} daytime · ${fmtN(e.impPK)} evening</span></div>
      <div><span class="k"><i class="dot" style="background:var(--sun-c)"></i>Sent to grid</span><span class="v num">${fmtN(e.exp)}<small>kWh</small></span>
        <div class="split" aria-hidden="true"><span style="flex:${e.expOP};background:var(--day)"></span><span style="flex:${Math.max(e.expPK, 0)};background:var(--eve)"></span></div>
        <span class="s">${fmtN(e.expOP)} daytime · ${fmtN(e.expPK)} evening</span></div>
      <div><span class="k"><i class="dot" style="background:${e.net > 0 ? 'var(--grid-c)' : 'var(--sun-c)'}"></i>${e.net > 0 ? 'Net taken from grid' : 'Net sent to grid'}</span><span class="v num">${fmtN(Math.abs(e.net))}<small>kWh</small></span>
        <span class="s">${e.net > 0 ? `You sent back ${pct(e.exp / tot)} of what you took` : `You sent back ${fmtN(e.exp / tot, 1)}× what you took`}</span></div>
    </div>
  </section>`;
}

/* DAY vs EVENING */
function bandCard(kind, imp, exp, rate) {
  const net = imp - exp, max = Math.max(imp, exp, 1), day = kind === 'day';
  const bar = (v, cls, lbl) => { const p = v / max * 100; return `<div class="bar-row"><span class="lbl">${lbl}</span><div class="track" data-tip="<b>${lbl}</b><br>${fmtN(v)} kWh" tabindex="0">${p >= 14 ? `<div class="fill ${cls}" style="width:${p}%">${fmtN(v)}</div>` : `<div class="fill ${cls}" style="width:${Math.max(p, 1)}%;display:inline-block;vertical-align:top"></div><span style="position:absolute;left:calc(${Math.max(p, 1)}% + 6px);top:3px;font-weight:700;font-size:.82rem">${fmtN(v)}</span>`}</div></div>`; };
  const verdict = net <= 0
    ? `<div class="verdict"><span class="ic" style="background:var(--sun-c)">✓</span><span><b>${fmtN(-net)} kWh extra</b> sent to the grid. You earn credit for it${rate != null ? ` at Rs ${fmtN(rate, 2)}/unit` : ''}.</span></div>`
    : `<div class="verdict"><span class="ic" style="background:var(--grid-c)">${ICON.bolt(15)}</span><span><b>${fmtN(net)} kWh bought</b> from the grid${rate != null ? ` at Rs ${fmtN(rate, 2)}/unit` : ''}.</span></div>`;
  return `<div class="band ${kind}">
    <div class="t">${day ? ICON.sun(42) : ICON.moon(42)}<div><h3>${day ? 'Daytime' : 'Evening'}</h3><small>${day ? 'Off-peak hours · most of the day' : 'Peak hours · after sunset'}</small></div>
      ${rate != null ? `<div class="rate" style="color:${day ? 'var(--day-ink)' : 'var(--eve-ink)'}">Rs ${fmtN(rate, 2)}<small>per unit</small></div>` : ''}</div>
    <div class="bars">${bar(imp, 'in', 'Took')}${bar(exp, 'sent', 'Sent back')}</div>
    ${verdict}
  </div>`;
}
function dayEvening(b, A, tl) {
  const e = b.energy; if (!e) return '';
  const hasRates = A.rOP != null && A.rPK != null;
  let trap = '';
  if (hasRates) {
    const ratio = A.ratio, full = Math.floor(ratio), part = ratio - full;
    const cells = Array.from({ length: full }, () => `<span class="cell day">${ICON.sun(22, '#fff')}</span>`).join('') + (part > .05 ? `<span class="cell day" style="width:${Math.round(34 * part)}px;overflow:hidden;justify-content:start"></span>` : '');
    const i = inp(), shift = i.shift ?? Math.min(3, A.shiftMax);
    trap = `<div class="trap">
      <div><h3>The evening trap</h3>
        <div class="eq" role="img" aria-label="1 evening unit costs as much as ${fmtN(ratio, 2)} daytime units">
          <div class="tok"><div class="tokrow"><span class="cell eve">${ICON.moon(24, '#fff')}</span></div>1 evening unit</div>
          <span class="sym">=</span>
          <div class="tok"><div class="tokrow">${cells}</div>${fmtN(ratio, 2)} daytime units</div>
        </div>
        <p style="margin-top:10px">Solar only produces in daytime hours, when each unit is worth Rs ${fmtN(A.rOP, 2)}. Evening units cost Rs ${fmtN(A.rPK, 2)}, so your panels need to send back almost double to cover what you use after sunset.</p></div>
      <div class="whatif"><label for="shift">What if you moved <span id="shiftv">${fmtN(shift, 1)}</span> units a day from evening to daytime?</label>
        <input id="shift" type="range" min="0" max="${Math.max(1, A.shiftMax)}" step="0.5" value="${shift}">
        <div class="big" id="shiftsave">${rs(shift * A.days * A.shiftValuePerKwh)} <small>saved each month</small></div>
        <p class="note" style="margin-top:4px">Run the AC, water pump, iron or washing machine while the sun is out, or add a battery. You use about ${fmtN(e.impPK / A.days, 1)} evening units a day now.</p></div>
    </div>`;
  }
  // settlement cycle
  let cycle = '';
  const mc = b.qrNet && b.qrNet.monthCount;
  if (A.quarter && mc) {
    const months = Array.from({ length: mc.n }, (_, k) => NM.addMonths(b.month, k - (mc.n - 1)));
    const vals = months.map(m => { const t = tl.find(x => x.month === m); return t && t.units != null ? t.units : null; });
    cycle = `<div class="cycle">
      <div><h3>Why there’s a charge when you sent back more</h3><p>Every ${mc.n} months the bill is settled. Over ${months.map(m => MONTHFULL[+m.split('-')[1] - 1]).join(', ').replace(/, ([^,]*)$/, ' and $1')} you sent back <b>${fmtN(Math.max(0, -A.quarter.net))} kWh more</b> than you took, yet the energy charge is <b>${rs(A.quarter.coe)}</b>. The daytime surplus is worth less than the evening units it has to cover.</p></div>
      <div class="chart" id="c-cycle" data-months='${JSON.stringify(months)}' data-vals='${JSON.stringify(vals)}' data-op="${A.quarter.op}" data-pk="${A.quarter.pk}"></div>
    </div>`;
  }
  return `<section class="card" aria-labelledby="h-de"><h2 id="h-de">Daytime vs evening</h2>
    <p class="lede">The meter counts daytime and evening separately, and prices them differently.</p>
    <div class="body"><div class="de">${bandCard('day', e.impOP, e.expOP, A.rOP)}${bandCard('eve', e.impPK, e.expPK, A.rPK)}</div>${trap}${cycle}</div></section>`;
}

/* MONEY */
function donut(parts, total, size = 168) {
  const r = 62, c = 2 * Math.PI * r, sum = parts.reduce((s, p) => s + Math.max(0, p.v), 0) || 1; let off = 0;
  const gap = 3;
  const segs = parts.map(p => { const len = Math.max(0, p.v) / sum * c; const s = `<circle cx="80" cy="80" r="${r}" fill="none" stroke="${p.c}" stroke-width="22" stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 80 80)" data-tip="<b>${p.l}</b><br>${rs(p.v)} (${pct(p.v / sum)})" tabindex="0"/>`; off += len; return s; }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 160 160" role="img" aria-label="Bill breakdown">${segs}<text x="80" y="76" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted)" style="letter-spacing:.06em">THIS BILL</text><text x="80" y="97" text-anchor="middle" font-size="19" font-weight="900" fill="var(--ink)">${rs(total)}</text></svg>`;
}
function moneyCard(b, A) {
  const n = b.qrNet || {};
  const cb = b.currentBill ?? (n.coe != null ? n.coe + (n.fix || 0) + (n.ed || 0) + (n.gst || 0) : null);
  if (cb == null) return '';
  const parts = [];
  if (n.coe != null) { parts.push({ l: 'Electricity used', v: n.coe, c: 'var(--grid-c)' }); parts.push({ l: 'Fixed monthly charge', v: n.fix || 0, c: 'var(--eve)' }); parts.push({ l: 'Taxes (GST + duty)', v: (n.gst || 0) + (n.ed || 0), c: 'var(--day)' }); }
  else if (b.netCharges != null && b.taxes != null) { parts.push({ l: 'Charges', v: b.netCharges, c: 'var(--grid-c)' }); parts.push({ l: 'Taxes', v: b.taxes, c: 'var(--day)' }); }
  const bal = b.grandTotal;
  let wallet = '';
  if (bal != null && bal < 0) {
    const months = -bal / cb, whole = Math.floor(months), frac = months - whole, show = Math.min(whole, 18);
    wallet = `<div class="panel wallet"><span class="eyebrow">Your credit with ${esc(b.disco || 'the DISCO')}</span>
      <div class="amt num">${rs(-bal)}</div>
      <p class="ink2" style="font-size:.92rem">Enough to cover about <b style="color:var(--ink)">${fmtN(months, 1)} bills</b> the size of this one.</p>
      <div class="months" aria-hidden="true">${Array.from({ length: show }, () => '<i></i>').join('')}${frac > .05 && whole < 18 ? `<i style="--f:${Math.round(frac * 100)}%"></i>` : ''}</div>
      <p class="note">${b.arrears != null ? `It was ${rs(-b.arrears)} last month; this bill’s ${rs(cb)} was taken from it.` : ''}</p></div>`;
  } else if (bal != null) {
    wallet = `<div class="panel"><span class="eyebrow">Amount to pay</span><div class="amt num" style="font-size:2.2rem;font-weight:900;color:var(--bad-ink)">${rs(bal)}</div><p class="ink2">${b.dueDate ? `Due ${esc(b.dueDate)}.` : ''}</p></div>`;
  }
  return `<section class="card" aria-labelledby="h-money"><h2 id="h-money">Where the money goes</h2><p class="lede">This month’s bill, and the credit it was paid from.</p>
    <div class="body money">
      <div class="panel"><span class="eyebrow">This month’s bill</span>
        <div class="donutwrap">${donut(parts, cb)}<div class="leg">${parts.map(p => `<div><i class="dot" style="background:${p.c}"></i>${p.l}<b>${rs(p.v)}</b></div>`).join('')}</div></div>
      </div>
      ${wallet}
    </div></section>`;
}

/* SAVINGS */
function savingsCard(b, A) {
  const e = b.energy; if (!e || A.rOP == null) return '';
  const hasGen = A.gen != null;
  const save = hasGen ? A.savings : A.savingsLowerBound;
  const max = Math.max(A.noSolarBill, A.withSolarMonth, 1);
  const i = inp();
  const avg = (() => { const s = meterBills().filter(x => x.energy).map(x => NM.analyze(x, optsFor(x)).savings).filter(v => v != null); return s.length ? { v: s.reduce((a, c) => a + c, 0) / s.length, n: s.length } : null; })();
  const payback = globalCost && avg && avg.v > 0 ? globalCost / (avg.v * 12) : null;
  const solarSplit = hasGen && A.selfUse >= 0 ? `<div class="solarsplit"><span class="eyebrow">Where your ${fmtN(A.gen)} kWh of solar went</span>
      <div class="stack"><span style="flex:${A.selfUse};background:var(--day)" data-tip="<b>Used at home</b><br>${fmtN(A.selfUse)} kWh">${A.selfUse / A.gen > .15 ? `Home ${pct(A.selfUse / A.gen)}` : ''}</span><span style="flex:${e.exp};background:var(--sun-c)" data-tip="<b>Sent to grid</b><br>${fmtN(e.exp)} kWh">${e.exp / A.gen > .15 ? `Grid ${pct(e.exp / A.gen)}` : ''}</span></div>
      <p class="note">Solar covered <b style="color:var(--ink)">${pct(A.selfSufficiency)}</b> of the ${fmtN(A.consumption)} kWh your home used.${A.yieldPerKwp != null ? ` Panels made ${fmtN(A.yieldPerKwp, 1)} kWh per kW per day.` : ''}</p></div>`
    : hasGen ? `<p class="note" style="color:var(--bad-ink)">The generation you entered is lower than what was sent to the grid (${fmtN(e.exp)} kWh). Check that it covers the same dates as the bill.</p>` : '';
  return `<section class="card" aria-labelledby="h-sav"><h2 id="h-sav">What solar saved you</h2><p class="lede">${mFull(b.month)}, compared with the same house and tariff without panels.</p>
    <div class="body" style="display:flex;flex-direction:column;gap:18px">
      <div><span class="eyebrow">${hasGen ? 'Saved this month' : 'Saved this month, at least'}</span><div class="save-big num">${rs(save)}</div></div>
      <div class="compare">
        <div class="cmp"><div class="row1"><span>Without solar</span><span class="num">${rs(A.noSolarBill)}</span></div><div class="trk"><div class="fl" style="width:${A.noSolarBill / max * 100}%;background:var(--grid-c)"></div></div></div>
        <div class="cmp"><div class="row1"><span>With solar</span><span class="num">${rs(A.withSolarMonth)}</span></div><div class="trk"><div class="fl" style="width:${Math.max(0, A.withSolarMonth) / max * 100}%;background:var(--sun-c)"></div></div></div>
      </div>
      ${solarSplit}
      <div><span class="eyebrow">Make it more accurate</span>
        <div class="inputs" style="margin-top:8px">
          <div class="field"><label for="gen">Solar made this month (kWh)</label><input id="gen" type="number" min="0" step="1" inputmode="numeric" placeholder="From inverter app" value="${i.gen ?? ''}"><small>Adds the solar you used directly</small></div>
          <div class="field"><label for="days">Days on this bill</label><input id="days" type="number" min="1" max="62" step="1" value="${i.days ?? 30}"></div>
          <div class="field"><label for="cost">System cost (Rs)</label><input id="cost" type="number" min="0" step="1000" inputmode="numeric" placeholder="For payback" value="${globalCost ?? ''}"><small>${payback != null ? `<b style="color:var(--good-ink)">Pays back in ≈ ${fmtN(payback, 1)} years</b> (from ${avg.n} bill${avg.n > 1 ? 's' : ''})` : 'Estimates payback time'}</small></div>
        </div></div>
      <p class="note">${hasGen ? '' : 'Without your inverter reading, this counts only the grid units you avoided paying for. '}Includes GST and electricity duty. Fixed charges are the same either way; fuel and quarterly adjustments aren’t included.</p>
    </div></section>`;
}

/* TAKEAWAYS */
function takeaways(b, A, tl) {
  const e = b.energy, n = b.qrNet || {}; if (!e) return '';
  const L = [];
  const box = (bg, fg, ic) => `<span class="ti" style="background:${bg};color:${fg}">${ic}</span>`;
  if (e.exp > 0) L.push([box('var(--day-soft)', 'var(--day)', ICON.sun(22)), `<b>${A.offpeakShareExp >= .995 ? `${fmtN(e.expOP)} of ${fmtN(e.exp)}` : pct(A.offpeakShareExp)}</b> units you sent back went out in daytime, at the lower rate.`]);
  if (A.peakShareCost != null) L.push([box('var(--eve-soft)', 'var(--eve)', ICON.moon(22)), `Evening is <b>${pct(A.peakShareImp)} of what you take</b> from the grid but <b>${pct(A.peakShareCost)} of what it costs</b>.`]);
  const hist = tl.filter(t => t.units != null);
  if (hist.length >= 6) { const x = hist.filter(t => t.units < 0).length; L.push([box('var(--sun-soft)', 'var(--sun-c)', '<b>✓</b>'), `You sent back more than you took in <b>${x} of the last ${hist.length} months</b>.`]); }
  const h = tl.filter(t => t.balance != null);
  if (h.length >= 2 && b.grandTotal < 0) { const chg = h[0].balance - h[h.length - 1].balance; L.push([box('var(--sun-soft)', 'var(--good-ink)', '<b>Rs</b>'), `Your credit ${chg >= 0 ? 'grew' : 'fell'} by <b>${rs(Math.abs(chg))}</b> since ${NM.monthLabel(h[0].month)}.`]); }
  if (A.exportYield != null && A.yieldPerKwp == null) L.push([box('var(--grid-soft)', 'var(--grid-c)', ICON.bolt(18, 'currentColor')), `Your ${fmtN(n.dgCapacity, 1)} kW panels sent at least <b>${fmtN(A.exportYield, 1)} units per kW a day</b> to the grid.`]);
  if (!L.length) return '';
  return `<section class="card" aria-labelledby="h-take"><h2 id="h-take">Quick takeaways</h2><div class="body"><ul class="takes">${L.slice(0, 4).map(([i, t]) => `<li>${i}<p>${t}</p></li>`).join('')}</ul></div></section>`;
}

/* TRENDS */
function trends(b, tl) {
  if (tl.length < 2) return '';
  const withIE = tl.filter(t => t.impOP != null);
  const last = tl.filter(t => t.balance != null).pop();
  return `<section class="card" aria-labelledby="h-tr"><h2 id="h-tr">Your last ${tl.length} months</h2><p class="lede">From the history printed on ${meterBills().length > 1 ? 'your bills' : 'this bill'}.</p>
    <div class="body">
      <div class="sub"><h3>Sent back more, or took more?</h3><div class="legend"><span><i class="dot" style="background:var(--sun-c)"></i>Sent back more (below the line)</span><span><i class="dot" style="background:var(--grid-c)"></i>Took more from grid</span><span><svg width="10" height="10" aria-hidden="true"><path d="M5 0 10 5 5 10 0 5z" fill="var(--ink-2)"/></svg>Bill settled</span></div><div class="chart" id="c-net"></div></div>
      <div class="sub"><h3>Your credit over time${last ? ` · <span style="color:var(--good-ink)">${cr(last.balance)} now</span>` : ''}</h3><div class="legend"><span>Rises when you earn credit, dips when a bill is paid from it.</span></div><div class="chart" id="c-bal"></div></div>
      ${withIE.length >= 2 ? `<div class="sub"><h3>Daytime and evening, month by month</h3><div class="legend"><span><i class="dot" style="background:var(--day)"></i>Daytime</span><span><i class="dot" style="background:var(--eve)"></i>Evening</span><span>Taken above the line, sent back below</span></div><div class="chart" id="c-ie"></div></div>` : ''}
    </div></section>`;
}

/* EXPERTS */
const digits = v => `<span class="dg" aria-label="${v}">${String(v).padStart(5, '0').split('').map(d => `<i>${d}</i>`).join('')}</span>`;
function experts(b, A, checks) {
  const p = b.qrPay, n = b.qrNet, e = b.energy;
  const fails = checks.filter(c => c.status !== 'pass').length;
  const ic = { pass: '✓', warn: '!', fail: '✕' };
  const names = ['Daytime taken', 'Evening taken', 'Daytime sent back', 'Evening sent back'];
  const regs = b.meter.length === 4 ? `<div><h3>Meter readings</h3><div class="regs">${b.meter.map((m, i) => `<div class="reg"><div class="h"><b>${names[i]}</b><span>Register ${i + 1}${m.mf !== 1 ? ` · MF ${m.mf}` : ''}</span></div><div class="digits">${digits(m.prev)}→${digits(m.pres)}<span class="u">${fmtN(m.units)} kWh</span></div></div>`).join('')}</div></div>` : '';
  const pay = p ? `<div><h3>Payment QR</h3><p class="note" style="margin-bottom:8px">EMVCo code for Raast or bank-app payment to ${esc(p.merchant || '—')} via ${esc(p.bank || 'bank')}. Checksum ${p.crcOk ? 'valid' : '<b style="color:var(--bad-ink)">invalid</b>'}.${p.refFromQR ? ` Reference label = ref ${p.refFromQR} + month ${p.billMonthMMYY} + due ${p.dueFromQR}.` : ''}</p>
    <div class="tbl"><table><tr><th>Tag</th><th>Field</th><th>Value</th></tr>${p.rows.map(r => `<tr><td class="m">${r.tag}</td><td class="${r.sub ? 'sub' : ''}">${esc(r.name)}</td><td class="m">${esc(r.val)}</td></tr>`).join('')}</table></div></div>` : '';
  const net = n ? `<div><h3>Net-metering QR</h3><p class="note" style="margin-bottom:8px">Plain-text detail: time-band split, rates, carried-forward units, system size.</p>
    <div class="tbl"><table>${n.sections.filter(s => s.rows.length).map(s => `<tr class="sec"><td colspan="2">${esc(s.name)}</td></tr>${s.rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="m">${esc(v)}</td></tr>`).join('')}`).join('')}</table></div></div>` : '';
  return `<details class="expert" id="experts"><summary>For experts <small>${checks.length ? (fails ? `${fails} check${fails > 1 ? 's' : ''} to review` : `bill check: all ${checks.length} pass`) : ''} · QR data · meter readings · rates</small><svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
    <div class="xbody">
      ${checks.length ? `<div><h3>Bill check</h3><ul class="checks">${checks.map(c => `<li><span class="ic ${c.status}" aria-label="${c.status}">${ic[c.status]}</span><div><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div></li>`).join('')}</ul></div>` : ''}
      ${regs}
      <div><h3>Tariff rates</h3><div class="inputs" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <div class="field"><label for="rop">Daytime (off-peak) Rs/unit</label><input id="rop" type="number" step="0.01" min="0" placeholder="${e && e.rateOP != null ? e.rateOP : 'Rs/kWh'}" value="${rateOverride.op ?? ''}"></div>
        <div class="field"><label for="rpk">Evening (peak) Rs/unit</label><input id="rpk" type="number" step="0.01" min="0" placeholder="${e && e.ratePK != null ? e.ratePK : 'Rs/kWh'}" value="${rateOverride.pk ?? ''}"></div>
      </div><p class="note" style="margin-top:6px">${e && e.rateOP != null ? 'Filled from the bill’s QR code. Type new rates to try another tariff.' : 'This bill has no rate data; enter rates to see money figures.'}</p></div>
      ${p || n ? `<div class="qrgrid">${pay}${net}</div>` : ''}
      ${b.qrs.length ? `<div><h3>Raw QR text</h3>${b.qrs.map((q, i) => `<pre class="raw" id="raw${i}">${esc(q)}</pre><div class="row" style="margin:6px 0 10px"><button class="btn" type="button" data-copy="raw${i}">Copy</button></div>`).join('')}</div>` : ''}
      <div><h3>Add a bill from QR text</h3><p class="note" style="margin-bottom:6px">Scanned the net-metering QR with your phone? Paste its text here.</p><textarea id="qrtext" aria-label="QR code text" placeholder="BILL-MONTH: Sep 2026"></textarea><div class="row" style="margin-top:8px"><button class="btn" id="qradd" type="button">Add bill</button><button class="btn" id="copyjson" type="button">Copy all data as JSON</button></div></div>
    </div></details>`;
}

/* bindings */
let expertsOpen = false;
function bind(b, A) {
  const s = $('#shift'); if (s) s.addEventListener('input', () => { const v = +s.value; inp().shift = v; $('#shiftv').textContent = fmtN(v, 1); $('#shiftsave').innerHTML = `${rs(v * A.days * A.shiftValuePerKwh)} <small>saved each month</small>`; });
  const rerender = (id) => { const y = scrollY; renderMain(); const el = document.getElementById(id); if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; } scrollTo(0, y); };
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('input', () => { fn(el.value); rerender(id); }); };
  on('gen', v => inp().gen = v === '' ? null : +v);
  on('days', v => { if (+v > 0) inp().days = +v; });
  on('cost', v => globalCost = v === '' ? null : +v);
  on('rop', v => rateOverride.op = v === '' ? null : +v);
  on('rpk', v => rateOverride.pk = v === '' ? null : +v);
  const ex = $('#experts'); if (ex) { ex.open = expertsOpen; ex.addEventListener('toggle', () => expertsOpen = ex.open); }
  const qa = $('#qradd'); if (qa) qa.addEventListener('click', () => { const t = $('#qrtext').value.trim(); if (t) addFromText(t); });
  document.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.copy);
    try { await navigator.clipboard.writeText(el.textContent); btn.textContent = 'Copied'; } catch (e) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); btn.textContent = 'Selected, press Ctrl+C'; }
    setTimeout(() => btn.textContent = 'Copy', 1800);
  }));
  const cj = $('#copyjson'); if (cj) cj.addEventListener('click', async () => {
    const txt = JSON.stringify(state.bills.map(({ qrs, id, ...x }) => ({ ...x, analysis: NM.analyze(x, optsFor(x)), checks: NM.checks(x) })), null, 2);
    try { await navigator.clipboard.writeText(txt); cj.textContent = 'Copied'; } catch (e) { const t = $('#qrtext'); t.value = txt; t.select(); cj.textContent = 'Selected in the box, press Ctrl+C'; }
    setTimeout(() => cj.textContent = 'Copy all data as JSON', 2200);
  });
}

/* ---------------- charts ---------------- */
function niceScale(min, max, ticks = 4) { const span = max - min || 1, raw = span / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw))); const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= ticks) || 10 * mag; return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step }; }
const short = v => { const a = Math.abs(v); return (v < 0 ? '−' : '') + (a >= 1000 ? (a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : fmtN(a)); };
function settleMonths(tl) {
  const src = meterBills().find(b => b.qrNet && b.qrNet.monthCount && b.month); if (!src) return new Set();
  const { i, n } = src.qrNet.monthCount, end = NM.addMonths(src.month, n - i), s = new Set();
  for (const t of tl) { const [y1, m1] = t.month.split('-').map(Number), [y2, m2] = end.split('-').map(Number); const d = (y1 - y2) * 12 + (m1 - m2); if (((d % n) + n) % n === 0) s.add(t.month); }
  return s;
}
const frame = (el, H, L = 46) => ({ W: Math.max(280, Math.round(el.clientWidth)), H, L, R: 8, T: 12, B: 26 });
function axisY(f, sc, y, fmt) { let g = ''; for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) { const yy = y(v); g += `<line x1="${f.L}" x2="${f.W - f.R}" y1="${yy}" y2="${yy}" stroke="var(--gridline)"/><text x="${f.L - 6}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`; } return g; }
function roundBar(cx, bw, y0, y1) { const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0)), r = Math.min(4, bw / 2, h), x0 = cx - bw / 2, x1 = cx + bw / 2; return y1 <= y0 ? `M${x0},${y0} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${y0} Z` : `M${x0},${y0} V${top + h - r} Q${x0},${top + h} ${x0 + r},${top + h} H${x1 - r} Q${x1},${top + h} ${x1},${top + h - r} V${y0} Z`; }
const showLab = (tl, i, f) => { const bw = (f.W - f.L - f.R) / tl.length; const every = bw >= 34 ? 1 : bw >= 17 ? 2 : 3; return (tl.length - 1 - i) % every === 0; };
const mLab = k => NM.monthShort(k).split(' ')[0];
function drawNet(tl) {
  const el = $('#c-net'); if (!el) return; const f = frame(el, 220), sm = settleMonths(tl);
  const d = tl.filter(t => t.units != null); if (!d.length) return;
  const sc = niceScale(Math.min(0, ...d.map(t => t.units)), Math.max(0, ...d.map(t => t.units)));
  const y = v => f.T + (sc.hi - v) / (sc.hi - sc.lo) * (f.H - f.T - f.B), bw = (f.W - f.L - f.R) / tl.length, barW = Math.max(5, Math.min(30, bw * .62));
  let g = axisY(f, sc, y, short);
  tl.forEach((t, i) => {
    const cx = f.L + bw * i + bw / 2;
    if (t.units != null) g += `<path d="${roundBar(cx, barW, y(0), y(t.units))}" fill="${t.units < 0 ? 'var(--sun-c)' : 'var(--grid-c)'}"/>`;
    if (showLab(tl, i, f)) g += `<text x="${cx}" y="${f.H - 7}" text-anchor="middle">${mLab(t.month)}</text>`;
    if (sm.has(t.month)) g += `<path d="M${cx} ${f.H - 27} l4 4 -4 4 -4 -4z" fill="var(--ink-2)"/>`;
    g += `<rect x="${f.L + bw * i}" y="${f.T}" width="${bw}" height="${f.H - f.T - f.B}" fill="transparent" tabindex="0" data-tip="<b>${NM.monthLabel(t.month)}</b><br>${t.units == null ? 'No data' : t.units < 0 ? `Sent back ${fmtN(-t.units)} kWh more` : `Took ${fmtN(t.units)} kWh more`}${sm.has(t.month) ? '<br>Bill settled this month' : ''}"/>`;
  });
  g += `<line x1="${f.L}" x2="${f.W - f.R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1.5"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" width="${f.W}" height="${f.H}" role="img" aria-label="Net units per month">${g}</svg>`;
}
function drawBal(tl) {
  const el = $('#c-bal'); if (!el) return;
  const d = tl.map((t, i) => ({ ...t, i })).filter(t => t.balance != null); if (d.length < 2) { el.innerHTML = '<div class="empty">Not enough history yet.</div>'; return; }
  const f = frame(el, 210), vals = d.map(t => -t.balance), sc = niceScale(Math.min(0, ...vals), Math.max(...vals));
  const bw = (f.W - f.L - f.R) / tl.length, x = i => f.L + bw * i + bw / 2, y = v => f.T + (sc.hi - v) / (sc.hi - sc.lo) * (f.H - f.T - f.B);
  let g = axisY(f, sc, y, short);
  const line = d.map((t, k) => `${k ? 'L' : 'M'}${x(t.i).toFixed(1)},${y(-t.balance).toFixed(1)}`).join(' ');
  g += `<defs><linearGradient id="balg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--sun-c)" stop-opacity=".32"/><stop offset="1" stop-color="var(--sun-c)" stop-opacity=".02"/></linearGradient></defs>`;
  g += `<path d="${line} L${x(d[d.length - 1].i)},${y(Math.max(0, sc.lo))} L${x(d[0].i)},${y(Math.max(0, sc.lo))} Z" fill="url(#balg)"/><path d="${line}" fill="none" stroke="var(--sun-c)" stroke-width="2.5" stroke-linejoin="round"/>`;
  d.forEach((t, k) => { const last = k === d.length - 1; g += `<circle cx="${x(t.i)}" cy="${y(-t.balance)}" r="${last ? 6 : 3.5}" fill="${last ? 'var(--sun-c)' : 'var(--surface)'}" stroke="var(--sun-c)" stroke-width="2"/>`; });
  tl.forEach((t, i) => { if (showLab(tl, i, f)) g += `<text x="${x(i)}" y="${f.H - 7}" text-anchor="middle">${mLab(t.month)}</text>`;
    if (t.balance != null) g += `<rect x="${f.L + bw * i}" y="${f.T}" width="${bw}" height="${f.H - f.T - f.B}" fill="transparent" tabindex="0" data-tip="<b>${NM.monthLabel(t.month)}</b><br>${t.balance < 0 ? `Credit ${rs(-t.balance)}` : `Owed ${rs(t.balance)}`}${t.delta != null ? `<br>${t.delta > 0 ? `Bill of ${rs(t.delta)} paid from credit` : `Earned ${rs(-t.delta)} credit`}` : ''}"/>`; });
  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" width="${f.W}" height="${f.H}" role="img" aria-label="Credit balance over time">${g}</svg>`;
}
function drawIE(tl) {
  const el = $('#c-ie'); if (!el) return; const d = tl.map((t, i) => ({ ...t, i })).filter(t => t.impOP != null); const f = frame(el, 240);
  const sc = niceScale(-Math.max(...d.map(t => t.expOP + t.expPK)), Math.max(...d.map(t => t.impOP + t.impPK)));
  const y = v => f.T + (sc.hi - v) / (sc.hi - sc.lo) * (f.H - f.T - f.B), bw = (f.W - f.L - f.R) / tl.length, barW = Math.max(5, Math.min(28, bw * .6));
  let g = axisY(f, sc, y, short);
  const seg = (cx, a, b2, col) => { const t = Math.min(y(a), y(b2)), h = Math.abs(y(a) - y(b2)); return h < .5 ? '' : `<rect x="${cx - barW / 2}" y="${t}" width="${barW}" height="${Math.max(0, h - 2)}" rx="3" fill="${col}"/>`; };
  d.forEach(t => { const cx = f.L + bw * t.i + bw / 2;
    g += seg(cx, 0, t.impOP, 'var(--day)') + seg(cx, t.impOP, t.impOP + t.impPK, 'var(--eve)') + seg(cx, 0, -t.expOP, 'var(--day)') + seg(cx, -t.expOP, -(t.expOP + t.expPK), 'var(--eve)');
    g += `<rect x="${f.L + bw * t.i}" y="${f.T}" width="${bw}" height="${f.H - f.T - f.B}" fill="transparent" tabindex="0" data-tip="<b>${NM.monthLabel(t.month)}</b><br>Took ${fmtN(t.impOP)} day + ${fmtN(t.impPK)} evening<br>Sent ${fmtN(t.expOP)} day + ${fmtN(t.expPK)} evening"/>`; });
  tl.forEach((t, i) => { if (showLab(tl, i, f)) g += `<text x="${f.L + bw * i + bw / 2}" y="${f.H - 7}" text-anchor="middle">${mLab(t.month)}</text>`; });
  g += `<line x1="${f.L}" x2="${f.W - f.R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1.5"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" width="${f.W}" height="${f.H}" role="img" aria-label="Daytime and evening by month">${g}</svg>`;
}
function drawCycle() {
  const el = $('#c-cycle'); if (!el) return;
  const months = JSON.parse(el.dataset.months), vals = JSON.parse(el.dataset.vals), op = +el.dataset.op, pk = +el.dataset.pk;
  const f = frame(el, 190, 40), cols = months.length + 1;
  const all = [...vals.filter(v => v != null), op, pk, op + pk, 0];
  const sc = niceScale(Math.min(...all), Math.max(...all));
  const y = v => f.T + (sc.hi - v) / (sc.hi - sc.lo) * (f.H - f.T - f.B), bw = (f.W - f.L - f.R) / (cols + .4), barW = Math.max(14, Math.min(40, bw * .55));
  let g = axisY(f, sc, y, short);
  months.forEach((m, i) => { const cx = f.L + bw * i + bw / 2, v = vals[i];
    if (v != null) g += `<path d="${roundBar(cx, barW, y(0), y(v))}" fill="${v < 0 ? 'var(--sun-c)' : 'var(--grid-c)'}" data-tip="<b>${NM.monthLabel(m)}</b><br>${v < 0 ? `Sent back ${fmtN(-v)} more` : `Took ${fmtN(v)} more`}" tabindex="0"/><text x="${cx}" y="${v < 0 ? y(v) + 14 : y(v) - 5}" text-anchor="middle" style="fill:var(--ink);font-weight:700">${sgn(v)}</text>`;
    g += `<text x="${cx}" y="${f.H - 7}" text-anchor="middle">${mLab(m)}</text>`; });
  const cx = f.L + bw * months.length + bw * .7, half = barW * .48;
  g += `<line x1="${cx - bw * .55}" x2="${cx - bw * .55}" y1="${f.T}" y2="${f.H - f.B}" stroke="var(--line-2)" stroke-dasharray="3 4"/>`;
  g += `<path d="${roundBar(cx - half / 2 - 1, half, y(0), y(op))}" fill="var(--day)" data-tip="<b>Daytime, all ${months.length} months</b><br>${sgn(op)} kWh" tabindex="0"/><path d="${roundBar(cx + half / 2 + 1, half, y(0), y(pk))}" fill="var(--eve)" data-tip="<b>Evening, all ${months.length} months</b><br>${sgn(pk)} kWh" tabindex="0"/>`;
  g += `<text x="${cx - half / 2 - 1}" y="${op < 0 ? y(op) + 14 : y(op) - 5}" text-anchor="middle" style="fill:var(--ink);font-weight:700;font-size:11px">${sgn(op)}</text><text x="${cx + half / 2 + 1}" y="${pk < 0 ? y(pk) + 14 : y(pk) - 5}" text-anchor="middle" style="fill:var(--ink);font-weight:700;font-size:11px">${sgn(pk)}</text>`;
  g += `<text x="${cx}" y="${f.H - 7}" text-anchor="middle" style="font-weight:700">Settled</text>`;
  g += `<line x1="${f.L}" x2="${f.W - f.R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1.5"/>`;
  el.innerHTML = `<div class="legend" style="margin:0 0 4px"><span><i class="dot" style="background:var(--day)"></i>Daytime</span><span><i class="dot" style="background:var(--eve)"></i>Evening</span></div><svg viewBox="0 0 ${f.W} ${f.H}" width="${f.W}" height="${f.H}" role="img" aria-label="Units per month in this settlement cycle, then settled daytime and evening totals">${g}</svg>`;
}
let lastTl = [];
function drawCharts(tl) { lastTl = tl; drawNet(tl); drawBal(tl); drawIE(tl); drawCycle(); }
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => drawCharts(lastTl), 120); });

(async function boot() {
  if (!window.pdfjsLib || !window.jsQR) setStatus('The PDF reader didn’t load. Reload the page; pasting QR text (under “For experts”) still works.', true);
  try {
    const me = await api('/api/me');
    if (me.user) {
      state.user = me.user; state.meters = me.meters || [];
      const data = await api('/api/bills');
      state.meters = data.meters;
      state.bills = data.bills.map(fromServer).sort((a, c) => (a.month || '').localeCompare(c.month || ''));
      const pending = await takePending();
      if (pending.length) {
        let n = 0;
        for (const p of pending) {
          try { const b = NM.buildBill(p.payload.text || {}, p.payload.qrs || [], { source: 'pdf', fileName: p.payload.fileName }); b._payload = p.payload; if (p.file) b._file = new File([p.file], p.fileName || 'bill.pdf', { type: 'application/pdf' }); await ingest(b); n++; } catch (e) { console.warn(e); }
        }
        if (n) setStatus(`Welcome! We saved the ${n} bill${n > 1 ? 's' : ''} you added before signing in.`);
      } else if (new URLSearchParams(location.search).has('welcome')) setStatus(`Signed in as ${me.user.email}.`);
      if (location.search) history.replaceState(null, '', '/');
      const last = state.bills[state.bills.length - 1];
      if (last) { state.sel = last.id; state.meter = mkey(last); }
    }
  } catch (e) { console.warn('Account check failed', e); }
  if (!state.bills.length && !state.user) {
    try { const S = await (await fetch('/sample.json')).json(); const b = NM.buildBill(S.text, S.qrs, { source: 'sample', fileName: 'Sample' }); b.id = 'sample'; state.bills = [b]; state.sel = b.id; state.meter = mkey(b); } catch (e) {}
  }
  if (new URLSearchParams(location.search).has('signin') && !state.user) { history.replaceState(null, '', '/'); openSignin(); }
  render();
})();
