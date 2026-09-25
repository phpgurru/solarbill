/* Admin stats: counts only, no personal data. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = v => v == null ? '—' : Number(v).toLocaleString('en-PK', { maximumFractionDigits: 0 });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const size = b => b > 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

// Tooltip
const tip = $('#tip');
document.addEventListener('pointermove', e => { const el = e.target.closest && e.target.closest('[data-tip]'); if (!el) return tip.classList.remove('on'); tip.innerHTML = el.dataset.tip; tip.classList.add('on'); tip.style.left = Math.min(innerWidth - 200, e.clientX + 14) + 'px'; tip.style.top = e.clientY + 14 + 'px'; });

function bars(rows, key, val, color, fmtLabel) {
  const W = 640, H = 200, L = 36, B = 24, T = 10, max = Math.max(1, ...rows.map(r => r[val]));
  const step = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / step) * step;
  const bw = (W - L) / Math.max(rows.length, 1), w = Math.max(4, Math.min(34, bw * .6));
  let g = '';
  for (const f of [0, .5, 1]) { const y = T + (1 - f) * (H - T - B); g += `<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--gridline)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(top * f)}</text>`; }
  rows.forEach((r, i) => {
    const h = r[val] / top * (H - T - B), x = L + bw * i + (bw - w) / 2;
    g += `<rect x="${x}" y="${H - B - h}" width="${w}" height="${Math.max(0, h)}" rx="3" fill="${color}" data-tip="<b>${esc(fmtLabel(r[key]))}</b><br>${fmt(r[val])}"/>`;
    if (rows.length <= 12 || i % 2 === rows.length % 2) g += `<text x="${x + w / 2}" y="${H - 7}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(fmtLabel(r[key]))}</text>`;
  });
  return rows.length ? `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" style="display:block;overflow:visible">${g}</svg>` : '<p class="ink2">No data yet.</p>';
}

(async () => {
  const r = await fetch('/api/admin/stats', { credentials: 'same-origin' });
  if (!r.ok) { $('#root').innerHTML = `<div class="card"><h2>${r.status === 401 ? 'Please sign in' : 'Admins only'}</h2><p class="lede">${r.status === 401 ? 'Sign in with an admin email to see this page.' : 'Your email isn’t on the admin list (ADMIN_EMAILS).'}</p><div class="body"><a class="btn" href="/?signin=1">Sign in</a></div></div>`; return; }
  const d = await r.json(), t = d.totals;
  const kpi = (v, l, s) => `<div class="kpi"><span class="eyebrow">${l}</span><span class="v">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
  const ml = k => { const [y, m] = k.split('-'); return `${MON[+m - 1]} ’${y.slice(2)}`; };
  $('#root').innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Solar Bill</div><h1>Admin</h1></div><span class="ink2">Updated ${new Date().toLocaleString()}</span></div>
    <div class="kpis">
      ${kpi(fmt(t.users), 'Users', `+${fmt(t.users7)} this week · +${fmt(t.users30)} in 30 days`)}
      ${kpi(fmt(t.active30), 'Active 30 days', `${t.users ? Math.round(t.active30 / t.users * 100) : 0}% of users`)}
      ${kpi(fmt(t.meters), 'Meters', `${t.users ? (t.meters / t.users).toFixed(1) : 0} per user`)}
      ${kpi(fmt(t.bills), 'Bills', `+${fmt(t.bills7)} this week`)}
      ${kpi(size(t.bytes), 'PDF storage', `${fmt(t.pdfs)} PDFs in R2`)}
      ${kpi(fmt(t.reminders), 'Reminders on', `${t.users ? Math.round(t.reminders / t.users * 100) : 0}% of users`)}
    </div>
    <section class="card"><h2>Bills by bill month</h2><div class="body">${bars(d.billsByMonth, 'month', 'n', 'var(--grid-c)', ml)}</div></section>
    <section class="card"><h2>Uploads, last 30 days</h2><div class="body">${bars(d.uploadsByDay, 'day', 'n', 'var(--sun-c)', k => k.slice(5))}</div></section>
    <section class="card"><h2>Sign-ups per week</h2><div class="body">${bars(d.signupsByWeek, 'week', 'n', 'var(--eve)', k => k.slice(5))}</div></section>
    <section class="card"><h2>By DISCO</h2><div class="body tbl"><table><tr><th>DISCO</th><th>Meters</th><th>Bills</th></tr>${d.byDisco.map(x => `<tr><td>${esc(x.disco)}</td><td class="num">${fmt(x.meters)}</td><td class="num">${fmt(x.bills)}</td></tr>`).join('') || '<tr><td colspan="3">No bills yet</td></tr>'}</table></div></section>
    <section class="card"><h2>Average meter, by month</h2><p class="lede">Average units per bill across all users.</p><div class="body tbl"><table><tr><th>Month</th><th>Taken from grid</th><th>Sent back</th><th>Net</th><th>Bills</th></tr>${d.energyByMonth.map(x => `<tr><td>${ml(x.month)}</td><td class="num">${fmt(x.imp)}</td><td class="num">${fmt(x.exp)}</td><td class="num">${fmt(x.net)}</td><td class="num">${fmt(x.n)}</td></tr>`).join('') || '<tr><td colspan="5">No data yet</td></tr>'}</table></div></section>`;
})();
