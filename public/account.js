/* Account page: meters, bills, reminders, export, delete. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = v => v == null ? '—' : Number(v).toLocaleString('en-PK', { maximumFractionDigits: 0 });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mlabel = k => { const [y, m] = k.split('-'); return `${MON[+m - 1]} ${y}`; };
const size = b => b == null ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
const status = (msg, err) => { const s = $('#status'); s.textContent = msg || ''; s.classList.toggle('err', !!err); };

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data;
}

let me, data;
async function load() {
  me = await api('/api/me');
  if (!me.user) {
    $('#root').innerHTML = `<div class="card"><h2>You’re not signed in</h2><p class="lede">Sign in with Google to see your saved bills.</p><div class="body"><a class="btn primary big" href="/app?signin=1">Sign in</a></div></div>`;
    return;
  }
  data = await api('/api/bills');
  render();
}

function billSummary(b) {
  // Summary numbers straight from the stored payload, without the full engine
  const q = (b.payload.qrs || []).find(s => /IMP-OP/.test(s)) || '';
  const g = k => { const m = q.match(new RegExp(k + '[^:]*:\\s*(-?[\\d.]+)')); return m ? +m[1] : null; };
  const imp = (g('IMP-OP') ?? 0) + (g('IMP-PK') ?? 0), exp = (g('EXP-OP') ?? 0) + (g('EXP-PK') ?? 0);
  return q ? `${fmt(imp)} kWh taken · ${fmt(exp)} kWh sent back` : 'No net-metering QR data';
}

function render() {
  const u = me.user;
  const byMeter = data.meters.map(m => ({ m, bills: data.bills.filter(b => b.meterId === m.id).sort((a, c) => c.month.localeCompare(a.month)) }));
  $('#root').innerHTML = `
    <div class="page-head"><div><div class="eyebrow">My account</div><h1>${esc(u.email)}</h1></div>
      <button class="btn" id="logout" type="button">Sign out</button></div>

    <section class="card"><h2>Monthly reminder</h2>
      <p class="lede">One email a month, a couple of days after your bill is usually issued, only if you haven’t added it yet.</p>
      <div class="body"><label class="switch"><input type="checkbox" id="rem" ${u.reminders ? 'checked' : ''}><span>Email me when my new bill should be out</span></label></div></section>

    ${byMeter.length ? byMeter.map(({ m, bills }) => `
    <section class="card"><div class="page-head"><div>
        <div class="eyebrow">${esc(m.disco || 'Meter')} · Consumer ID ${esc(m.consumerId)}${m.refNo ? ` · Ref ${esc(m.refNo)}` : ''}</div>
        <h2 style="margin-top:4px">${esc(m.label || `Meter ···${m.consumerId.slice(-4)}`)}</h2></div>
        <div class="acts row"><input class="inline-input" id="lbl-${m.id}" value="${esc(m.label || '')}" placeholder="Name it, e.g. Home" maxlength="40" aria-label="Meter name"><button class="btn sm" data-rename="${m.id}" type="button">Save name</button></div></div>
      <div class="body list">${bills.length ? bills.map(b => `
        <div class="item"><div class="grow"><b>${mlabel(b.month)}</b><small>${esc(billSummary(b))}${b.fileSize ? ` · PDF ${size(b.fileSize)}` : ''}</small></div>
          <div class="acts">${b.hasPdf ? `<a class="btn sm" href="/api/bills/${b.id}/pdf" target="_blank" rel="noopener">View PDF</a><a class="btn sm" href="/api/bills/${b.id}/pdf?download=1">Download</a>` : ''}
          <button class="btn sm danger" type="button" data-delbill="${b.id}" data-label="${mlabel(b.month)}">Delete</button></div></div>`).join('') : '<p class="ink2">No bills for this meter yet.</p>'}
      </div>
      <div class="row" style="margin-top:12px"><button class="btn sm danger" type="button" data-delmeter="${m.id}" data-label="${esc(m.label || m.consumerId)}">Remove this meter and its ${bills.length} bill${bills.length === 1 ? '' : 's'}</button></div>
    </section>`).join('') : `<section class="card"><h2>No bills yet</h2><p class="lede">Add your first bill PDF on the main page. It’s filed under its consumer ID automatically.</p><div class="body"><a class="btn primary" href="/app">Add a bill</a></div></section>`}

    <section class="card"><h2>Your data</h2>
      <p class="lede">${me.billCount} bill${me.billCount === 1 ? '' : 's'} saved${me.storageBytes ? `, ${size(me.storageBytes)} of PDFs` : ''}. Download everything as a JSON file with the figures, analysis and links to each PDF.</p>
      <div class="body row"><a class="btn" href="/api/export">Download my data</a></div>
      <div class="body dz"><b>Delete my account</b><p class="ink2" style="font-size:.9rem">This permanently deletes every bill, PDF and meter, and signs you out. Type your email to confirm.</p>
        <div class="row"><input class="inline-input" id="confirm" type="email" placeholder="${esc(u.email)}" aria-label="Type your email to confirm"><button class="btn danger" id="delacct" type="button">Delete everything</button></div></div>
    </section>`;
  bind();
}

function confirmStep(btn, label, action) {
  // Two-step button instead of a browser confirm() dialog
  if (btn.dataset.armed) return action();
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 4000);
}

function bind() {
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };
  $('#rem').onchange = async e => { try { await api('/api/me', { method: 'PATCH', body: JSON.stringify({ reminders: e.target.checked }) }); status(e.target.checked ? 'Reminders on.' : 'Reminders off.'); } catch (err) { status(err.message, true); } };
  document.querySelectorAll('[data-rename]').forEach(b => b.onclick = async () => {
    const id = b.dataset.rename; try { await api(`/api/meters/${id}`, { method: 'PATCH', body: JSON.stringify({ label: $(`#lbl-${id}`).value }) }); status('Name saved.'); await load(); } catch (err) { status(err.message, true); }
  });
  document.querySelectorAll('[data-delbill]').forEach(b => b.onclick = () => confirmStep(b, 'Tap again to delete', async () => {
    try { await api(`/api/bills/${b.dataset.delbill}`, { method: 'DELETE' }); status(`Deleted the ${b.dataset.label} bill.`); await load(); } catch (err) { status(err.message, true); }
  }));
  document.querySelectorAll('[data-delmeter]').forEach(b => b.onclick = () => confirmStep(b, 'Tap again to remove the meter and all its bills', async () => {
    try { await api(`/api/meters/${b.dataset.delmeter}`, { method: 'DELETE' }); status('Meter removed.'); await load(); } catch (err) { status(err.message, true); }
  }));
  $('#delacct').onclick = async () => {
    try { await api('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: $('#confirm').value }) }); location.href = '/'; } catch (err) { status(err.message, true); }
  };
}

load().catch(e => status(e.message, true));
