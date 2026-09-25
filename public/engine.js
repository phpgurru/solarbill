/* Solar Bill engine: bill parsing + analysis. Pure JS, no DOM.
   Shared by the browser (window.NM) and the Worker (globalThis.NM). */
const NM = (() => {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const num = s => { if (s == null) return null; const t = String(s).replace(/,/g,'').trim(); if (t === '' || isNaN(+t)) return null; return +t; };
  const monthKey = (mon, yr) => { const m = MONTHS.indexOf(String(mon).slice(0,3).toUpperCase()); if (m < 0) return null; let y = +yr; if (y < 100) y += 2000; return `${y}-${String(m+1).padStart(2,'0')}`; };
  const monthLabel = key => { if (!key) return '—'; const [y,m] = key.split('-'); return `${MONTH_NAMES[+m-1]} ${y}`; };
  const monthShort = key => { const [y,m] = key.split('-'); return `${MONTH_NAMES[+m-1]} ’${y.slice(2)}`; };
  const addMonths = (key, n) => { let [y,m] = key.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2,'0')}`; };
  const signedCR = s => { if (s == null) return null; const t = String(s).trim(); const cr = /CR$/i.test(t); const v = num(t.replace(/CR$/i,'')); return v == null ? null : (cr ? -v : v); };

  /* ---------- EMVCo payment QR (Raast / 1LINK style) ---------- */
  const BANKS = { ALFH:'Bank Alfalah', HABB:'HBL', MUCB:'MCB Bank', UNIL:'United Bank (UBL)', NBPA:'National Bank of Pakistan', BAHL:'Bank AL Habib', MEZN:'Meezan Bank', ABPA:'Allied Bank', ASCM:'Askari Bank', FAYS:'Faysal Bank', SCBL:'Standard Chartered', BKIP:'BankIslami', JSBL:'JS Bank', SONE:'Soneri Bank', MPBL:'Habib Metropolitan Bank' };
  function crc16(str) { let crc = 0xFFFF; for (let i = 0; i < str.length; i++) { crc ^= str.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF; } return crc.toString(16).toUpperCase().padStart(4,'0'); }
  function tlv(s) { const out = []; let i = 0; while (i + 4 <= s.length) { const tag = s.slice(i,i+2), len = parseInt(s.slice(i+2,i+4),10); if (isNaN(len)) return null; const val = s.slice(i+4, i+4+len); if (val.length !== len) return null; out.push({tag, len, val}); i += 4 + len; } return i === s.length ? out : null; }
  const EMV_NAMES = { '00':'Format version', '01':'Initiation method', '52':'Merchant category code', '53':'Currency', '54':'Amount', '58':'Country', '59':'Merchant name', '60':'Merchant city', '62':'Additional data', '63':'CRC checksum' };
  function parsePaymentQR(raw) {
    if (!/^000201/.test(raw)) return null;
    const top = tlv(raw); if (!top) return null;
    const r = { raw, rows: [], fields: {} };
    for (const t of top) {
      r.fields[t.tag] = t.val;
      const tg = +t.tag;
      if ((tg >= 26 && tg <= 51) || t.tag === '62') {
        const sub = tlv(t.val) || [];
        r.rows.push({ tag: t.tag, name: t.tag === '62' ? 'Additional data' : 'Merchant account', val: '' });
        for (const s of sub) {
          let name = 'Sub-field ' + s.tag;
          if (t.tag !== '62') { if (s.tag === '00') name = 'Account / GUID'; if (/^[A-Z]{4}PK[A-Z0-9]{2}/.test(s.val)) { name = 'Bank (SWIFT/BIC)'; r.bic = s.val; r.bank = BANKS[s.val.slice(0,4)] || s.val; } if (/^PK\d{2}[A-Z]{4}/.test(s.val)) { name = 'IBAN'; r.iban = s.val; } }
          else { if (s.tag === '01') { name = 'Bill number / consumer ID'; r.billNo = s.val; } if (s.tag === '05') { name = 'Reference label'; r.refLabel = s.val; } if (s.tag === '07') { name = 'Terminal label'; } }
          r.rows.push({ tag: t.tag + '.' + s.tag, name, val: s.val, sub: true });
        }
      } else {
        let val = t.val;
        if (t.tag === '01') val += t.val === '11' ? ' (static)' : t.val === '12' ? ' (dynamic)' : '';
        if (t.tag === '53') val += t.val === '586' ? ' (PKR)' : '';
        r.rows.push({ tag: t.tag, name: EMV_NAMES[t.tag] || 'Field ' + t.tag, val });
      }
    }
    r.amount = num(r.fields['54']); r.merchant = r.fields['59'] || null; r.city = r.fields['60'] || null;
    r.initiation = r.fields['01'] === '12' ? 'dynamic' : 'static';
    const body = raw.slice(0, raw.length - 4); r.crcGiven = raw.slice(-4).toUpperCase(); r.crcCalc = crc16(body); r.crcOk = r.crcGiven === r.crcCalc;
    // Reference label in PITC bills: 14-digit ref + MMYY bill month + DDMMYY due date
    if (r.refLabel && /^\d{24}$/.test(r.refLabel)) { r.refFromQR = r.refLabel.slice(0,14); r.billMonthMMYY = r.refLabel.slice(14,18); const d = r.refLabel.slice(18); r.dueFromQR = `${d.slice(0,2)}-${d.slice(2,4)}-20${d.slice(4,6)}`; }
    return r;
  }

  /* ---------- Net-metering detail QR (PITC plain text) ---------- */
  function parseNetQR(raw) {
    if (!/NET[- ]METERING|IMP-OP|BILL-MONTH|EXP-OP/i.test(raw)) return null;
    const r = { raw, sections: [], kv: {}, calc: [] };
    let cur = { name: 'Header', rows: [] }; r.sections.push(cur);
    for (let line of raw.split(/\r?\n/)) {
      line = line.trim(); if (!line) continue;
      const h = line.match(/^=+\s*(.*?)\s*=+$/);
      if (h) { cur = { name: h[1], rows: [] }; r.sections.push(cur); continue; }
      const c = line.match(/^(-?[\d.]+)\s*[xX*]\s*(-?[\d.]+)$/);
      if (c) { r.calc.push({ rate: +c[1], units: +c[2] }); cur.rows.push([`${c[1]} × ${c[2]}`, (+c[1] * +c[2]).toFixed(2)]); continue; }
      const parts = line.split(/,\s*(?=[A-Z][A-Z0-9 ()\-]*:)/);
      for (const p of parts) { const m = p.match(/^([^:]+):\s*(.*)$/); if (m) { const k = m[1].trim().toUpperCase(); r.kv[k] = m[2].trim(); cur.rows.push([m[1].trim(), m[2].trim()]); } else cur.rows.push([p, '']); }
    }
    const g = k => r.kv[k] != null ? r.kv[k] : null, n = k => num(g(k));
    const find = re => { const k = Object.keys(r.kv).find(k => re.test(k)); return k ? num(r.kv[k]) : null; };
    const bm = (g('BILL-MONTH') || '').match(/([A-Za-z]{3})[A-Za-z]*[\s-]+(\d{2,4})/); r.month = bm ? monthKey(bm[1], bm[2]) : null;
    Object.assign(r, {
      consumerId: g('CUST-ID'), refNo: g('REF-NO'), division: g('DIV-NAME'), connDate: g('CONN-DATE'), commDate: g('COMM-DATE'),
      dgCapacity: n('DG-CAPACITY'), expMdi: n('EXP-MDI'), edRate: n('ED-RATE'), billedUnits: n('BILLED UNITS'),
      coe: n('COE'), fix: n('FIX-CHRG'), ed: n('E-DUTY'), gst: n('GST'), mco: g('MCO'),
      impOP: find(/^IMP-OP/), impPK: find(/^IMP-PK/), expOP: find(/^EXP-OP/), expPK: find(/^EXP-PK/),
      netOP: find(/^NET-OP/), netPK: find(/^NET-PK/),
      remPresOP: find(/^REMAINING-PRESENT-OP/), remPrevOP: find(/^REMAINING-PREVIOUS-OP/),
      remPresPK: find(/^REMAINING-PRESENT-PK/), remPrevPK: find(/^REMAINING-PREVIOUS-PK/),
    });
    const mc = (g('MONTH COUNT') || '').match(/(\d+)\s*\/\s*(\d+)/); r.monthCount = mc ? { i: +mc[1], n: +mc[2] } : null;
    // Known extra charge keys (other DISCOs / other months may carry these)
    r.extras = {}; for (const k of ['TV-FEE','PTV-FEE','FPA','QTA','F-P-A','INC-TAX','IT','EXTRA-TAX','FURTHER-TAX','RETAIL-TAX','SUBSIDY','FC-SUR','NJ-SUR','INSTALLMENT']) if (r.kv[k] != null) r.extras[k] = num(r.kv[k]);
    return r;
  }

  /* ---------- Text layer of the PDF (values only; labels are part of the background image) ---------- */
  function parseText(items) {
    const toks = items.filter(t => t.s && t.s.trim()).map(t => ({ s: t.s.trim(), x: t.x, y: t.y }));
    toks.sort((a,b) => b.y - a.y || a.x - b.x);
    const rows = []; for (const t of toks) { const r = rows.find(r => Math.abs(r.y - t.y) <= 2.5); if (r) r.t.push(t); else rows.push({ y: t.y, t: [t] }); }
    rows.forEach(r => r.t.sort((a,b) => a.x - b.x)); rows.sort((a,b) => b.y - a.y);
    const out = { meter: [], history: [] };
    const all = rows.flatMap(r => r.t);
    const first = re => { const t = all.find(t => re.test(t.s)); return t ? t.s : null; };
    const bm = first(/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{4}$/i);
    if (bm) { const m = bm.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/); out.month = monthKey(m[1], m[2]); }
    out.refNo = first(/^\d{2}\s\d{5}\s\d{7}[A-Z]?$/);
    // Payment barcode line: "SEP 26 - 10361328 - 16 11511 0258402U - 0 - 28 SEP 26 - 0 - 01 Oct 26 - 6"
    const bc = first(/^[A-Z]{3}\s\d{2}\s-\s\d+\s-\s/i);
    if (bc) { const p = bc.split(/\s+-\s+/); out.consumerId = p[1]; out.dueDate = p[4] || null; out.barcode = bc; }
    const dates = all.filter(t => /^\d{1,2}\s[A-Z]{3}\s\d{2}$/i.test(t.s)).map(t => t.s);
    if (dates.length >= 2) { out.readingDate = dates[0]; out.issueDate = dates[1]; }
    if (!out.dueDate && dates[2]) out.dueDate = dates[2];
    if (!out.consumerId) { const c = all.find(t => /^\d{7,10}$/.test(t.s)); if (c) out.consumerId = c.s; }
    out.tariff = first(/^[A-E]-?\d[A-Za-z0-9()\-]*$/);
    const cat = first(/^(DOMESTIC|COMMERCIAL|INDUSTRIAL|AGRICULTURAL|GENERAL SERVICES|BULK)$/i); if (cat) out.category = cat;
    const nameRow = rows.find(r => r.t.some(t => /\s[SDWsdw]\/[Oo]\s/.test(t.s)));
    if (nameRow) { out.name = nameRow.t.map(t => t.s).join(' '); const i = rows.indexOf(nameRow); const next = rows[i+1]; if (next && next.t.length <= 2 && /[A-Za-z]{3}/.test(next.t[0].s)) out.address = next.t.map(t => t.s).join(' '); }
    const conn = first(/^"[^"]+"$/); if (conn) out.connection = conn.replace(/"/g,'');
    const mno = rows.find(r => r.t.some(t => /^"/.test(t.s))); if (mno) { const t = mno.t.find(t => !/^"/.test(t.s)); if (t) out.meterNo = t.s; }
    // Sanctioned load / MDI: last small integer on the ref and consumer-id rows
    const refRow = rows.find(r => r.t.some(t => t.s === out.refNo)); if (refRow) { const l = refRow.t[refRow.t.length-1]; if (/^\d{1,3}(\.\d+)?$/.test(l.s)) out.sanctionedLoad = +l.s; }
    const idRow = rows.find(r => r.t[0] && r.t[0].s === out.consumerId && r !== refRow); if (idRow) { const l = idRow.t[idRow.t.length-1]; if (/^\d{1,3}(\.\d+)?$/.test(l.s)) out.mdi = +l.s; }
    // Meter register rows: MF, previous, present, units  with (present-previous)*MF = units
    for (const r of rows) {
      const v = r.t.filter(t => t.x < 420).map(t => num(t.s));
      if (v.length === 4 && v.every(x => x != null)) { const [mf, prev, pres, units] = v; if (Math.abs((pres - prev) * mf - units) < 0.51 || (pres < prev && units > 0)) out.meter.push({ mf, prev, pres, units }); }
    }
    // Money block: 2-decimal values in the left charges column
    const money = rows.map(r => ({ r, t: r.t.find(t => /^-?[\d,]+\.\d{2}$/.test(t.s) && t.x < 300) })).filter(o => o.t);
    if (money.length >= 3) {
      const vals = money.map(o => num(o.t.s));
      out.totalCharges = vals[0]; out.currentBill = vals[vals.length-1]; out.taxes = vals[vals.length-2]; out.netCharges = vals[vals.length-3];
      if (vals.length >= 5) out.subsidy = vals[1];
      const ar = money[0].r.t.find(t => t.x > 300 && /^-?[\d,]+(\.\d+)?$/.test(t.s)); if (ar) out.arrears = num(ar.s);
      const ci = rows.indexOf(money[money.length-1].r); const gt = rows[ci+1] && rows[ci+1].t.find(t => /^-?[\d,]+(\.\d+)?(CR)?$/i.test(t.s) && t.x < 300);
      if (gt) out.grandTotal = signedCR(gt.s);
    }
    // Bill history: MON-YY  units  bill  [payment]
    for (const r of rows) {
      let cur = null;
      for (const t of r.t) {
        const m = t.s.match(/^([A-Z]{3})-(\d{2})$/i);
        if (m && MONTHS.includes(m[1].toUpperCase())) { cur = { month: monthKey(m[1], m[2]), vals: [] }; out.history.push(cur); continue; }
        if (cur && /^-?[\d,]+(\.\d+)?$/.test(t.s)) cur.vals.push(num(t.s));
      }
    }
    out.history = out.history.filter(h => h.month && h.vals.length >= 1).map(h => ({ month: h.month, units: h.vals[0], balance: h.vals.length > 1 ? h.vals[1] : null, payment: h.vals.length > 2 ? h.vals[2] : null }));
    out.history.sort((a,b) => a.month.localeCompare(b.month));
    return out;
  }

  /* ---------- Assemble a bill from text + QR strings ---------- */
  function buildBill(text, qrStrings, meta) {
    const b = Object.assign({ id: Math.random().toString(36).slice(2), meter: [], history: [] }, meta || {}, text || {});
    b.qrs = qrStrings || [];
    for (const q of b.qrs) { const p = parsePaymentQR(q); if (p) { b.qrPay = p; continue; } const n = parseNetQR(q); if (n) { b.qrNet = n; continue; } (b.qrOther = b.qrOther || []).push(q); }
    const n = b.qrNet;
    if (n) { b.month = b.month || n.month; b.consumerId = b.consumerId || n.consumerId; b.refNo = b.refNo || n.refNo; }
    if (b.qrPay && b.qrPay.merchant) b.disco = b.qrPay.merchant;
    b.energy = energyOf(b);
    return b;
  }

  function energyOf(b) {
    const n = b.qrNet, e = { source: null };
    if (n && n.impOP != null) { Object.assign(e, { impOP: n.impOP, impPK: n.impPK ?? 0, expOP: n.expOP ?? 0, expPK: n.expPK ?? 0, source: 'qr' }); }
    else if (b.meter && b.meter.length === 4) { const u = b.meter.map(m => m.units); Object.assign(e, { impOP: u[0], impPK: u[1], expOP: u[2], expPK: u[3], source: 'meter' }); }
    else return null;
    e.netOP = n && n.netOP != null ? n.netOP : e.impOP - e.expOP;
    e.netPK = n && n.netPK != null ? n.netPK : e.impPK - e.expPK;
    e.imp = e.impOP + e.impPK; e.exp = e.expOP + e.expPK; e.net = e.netOP + e.netPK;
    // Rates: match calculation lines to the net values
    let rOP = null, rPK = null;
    if (n && n.calc.length) {
      const c = n.calc.slice();
      const take = u => { const i = c.findIndex(x => x.units === u); return i >= 0 ? c.splice(i,1)[0].rate : null; };
      if (e.netOP !== e.netPK) { rOP = take(e.netOP); rPK = take(e.netPK); }
      if ((rOP == null || rPK == null) && n.calc.length >= 2) { const rs = n.calc.map(x => x.rate).sort((a,b) => a-b); rOP = rOP ?? rs[0]; rPK = rPK ?? rs[rs.length-1]; }
      // settlement bills may list quarter totals instead of month nets
      if (rOP == null || rPK == null) { const rs = n.calc.map(x => x.rate).sort((a,b) => a-b); rOP = rOP ?? rs[0]; rPK = rPK ?? rs[rs.length-1]; }
    }
    e.rateOP = rOP; e.ratePK = rPK;
    return e;
  }

  /* ---------- Analysis ---------- */
  const approx = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
  function taxRates(b, opts) {
    const n = b.qrNet || {};
    const ed = n.edRate != null ? n.edRate / 100 : (n.ed != null && n.coe ? n.ed / n.coe : 0.015);
    let gst = 0.18;
    if (n.gst != null && n.coe != null) { const base = n.coe + (n.fix || 0) + (n.ed || 0); if (base > 0) { const g = n.gst / base; if (g > 0.1 && g < 0.3) gst = g; } }
    return { ed, gst, mult: (1 + ed) * (1 + gst) };
  }

  function settlementModel(b) {
    const n = b.qrNet, e = b.energy; if (!n || !e || e.rateOP == null || n.coe == null) return null;
    const pOP = n.remPrevOP || 0, pPK = n.remPrevPK || 0;
    const cands = [
      { key: 'quarter', label: 'this month’s net units plus the units carried forward from earlier months of the cycle', op: e.netOP + pOP, pk: e.netPK + pPK },
      { key: 'month', label: 'this month’s net units only', op: e.netOP, pk: e.netPK },
    ];
    for (const c of cands) { c.coe = e.rateOP * c.op + e.ratePK * c.pk; c.diff = n.coe - c.coe; }
    cands.sort((a,b) => Math.abs(a.diff) - Math.abs(b.diff));
    const best = cands[0]; best.match = Math.abs(best.diff) <= Math.max(2, Math.abs(n.coe) * 0.002);
    return best;
  }

  function checks(b) {
    const out = [], n = b.qrNet, e = b.energy, add = (label, status, detail) => out.push({ label, status, detail });
    const fmt = v => v == null ? '—' : Number(v).toLocaleString('en-PK', { maximumFractionDigits: 2 });
    // Meter arithmetic
    if (b.meter.length) {
      const bad = b.meter.filter(m => Math.abs((m.pres - m.prev) * m.mf - m.units) > 0.5);
      add('Meter readings add up', bad.length ? 'fail' : 'pass', bad.length ? `${bad.length} register(s) where present − previous ≠ units` : `All ${b.meter.length} registers: present − previous = units billed`);
    }
    if (n && b.meter.length === 4 && n.impOP != null) {
      const q = [n.impOP, n.impPK, n.expOP, n.expPK], m = b.meter.map(x => x.units), ok = q.every((v,i) => v === m[i]);
      add('QR units match printed meter units', ok ? 'pass' : 'fail', ok ? `Import ${q[0]} / ${q[1]}, export ${q[2]} / ${q[3]} kWh on both` : `QR ${q.join(', ')} vs printed ${m.join(', ')}`);
    }
    if (n && e && n.netOP != null) {
      const ok = n.netOP === e.impOP - e.expOP && n.netPK === e.impPK - e.expPK;
      add('Net units = import − export', ok ? 'pass' : 'fail', `Off-peak ${e.impOP} − ${e.expOP} = ${e.impOP - e.expOP}; peak ${e.impPK} − ${e.expPK} = ${e.impPK - e.expPK}`);
    }
    if (n && n.billedUnits != null && e) add('Billed units = off-peak net + peak net', n.billedUnits === e.netOP + e.netPK ? 'pass' : 'warn', `${e.netOP} + ${e.netPK} = ${e.netOP + e.netPK}; bill says ${n.billedUnits}`);
    const s = settlementModel(b);
    if (s) add('Cost of energy recomputes from rates', s.match ? 'pass' : 'warn', s.match
      ? `Rs ${fmt(e.rateOP)} × ${s.op} + Rs ${fmt(e.ratePK)} × ${s.pk} = Rs ${fmt(s.coe)} (bill: Rs ${fmt(n.coe)}). Matches ${s.label}.`
      : `Closest rule (${s.label}) gives Rs ${fmt(s.coe)} but the bill says Rs ${fmt(n.coe)}: Rs ${fmt(s.diff)} unexplained. Could be a fuel or quarterly adjustment.`);
    if (n && n.ed != null && n.coe != null && n.edRate != null) { const exp = n.coe * n.edRate / 100; add(`Electricity duty = ${n.edRate}% of energy cost`, approx(exp, n.ed, 1) ? 'pass' : 'warn', `${n.edRate}% × Rs ${fmt(n.coe)} = Rs ${fmt(exp)}; bill: Rs ${fmt(n.ed)}`); }
    if (n && n.gst != null && n.coe != null) { const base = n.coe + (n.fix || 0) + (n.ed || 0), exp = base * 0.18; add('GST = 18% of (energy + fixed charge + duty)', approx(exp, n.gst, 2) ? 'pass' : 'warn', `18% × Rs ${fmt(base)} = Rs ${fmt(exp)}; bill: Rs ${fmt(n.gst)}${approx(exp, n.gst, 2) ? '' : ` (implied ${(n.gst / base * 100).toFixed(2)}%)`}`); }
    if (n && b.totalCharges != null && n.coe != null) add('Printed total charges = energy + fixed charge', approx(n.coe + (n.fix||0), b.totalCharges, 1) ? 'pass' : 'warn', `Rs ${fmt(n.coe)} + Rs ${fmt(n.fix||0)} = Rs ${fmt(n.coe + (n.fix||0))}; printed Rs ${fmt(b.totalCharges)}`);
    if (n && b.taxes != null && n.ed != null && n.gst != null) add('Printed taxes = duty + GST', approx(n.ed + n.gst, b.taxes, 1) ? 'pass' : 'warn', `Rs ${fmt(n.ed)} + Rs ${fmt(n.gst)} = Rs ${fmt(n.ed + n.gst)}; printed Rs ${fmt(b.taxes)}`);
    if (b.currentBill != null && b.netCharges != null && b.taxes != null) add('Current bill = charges + taxes', approx(b.netCharges + b.taxes, b.currentBill, 1) ? 'pass' : 'warn', `Rs ${fmt(b.netCharges)} + Rs ${fmt(b.taxes)} = Rs ${fmt(b.netCharges + b.taxes)}; printed Rs ${fmt(b.currentBill)}`);
    if (b.currentBill != null && b.arrears != null && b.grandTotal != null) add('Grand total = arrears + current bill', approx(b.arrears + b.currentBill, b.grandTotal, 1) ? 'pass' : 'warn', `${fmt(b.arrears)} + ${fmt(b.currentBill)} = ${fmt(b.arrears + b.currentBill)}; printed ${b.grandTotal < 0 ? fmt(-b.grandTotal) + ' CR' : fmt(b.grandTotal)}`);
    if (b.history.length && b.arrears != null) { const last = b.history[b.history.length-1]; if (last.balance != null) add('Arrears carried from last month’s balance', approx(last.balance, b.arrears, 1) ? 'pass' : 'warn', `${monthLabel(last.month)} balance ${fmt(last.balance)}; arrears on this bill ${fmt(b.arrears)}`); }
    if (b.qrPay) {
      add('Payment QR checksum valid', b.qrPay.crcOk ? 'pass' : 'fail', `CRC ${b.qrPay.crcGiven} ${b.qrPay.crcOk ? 'matches' : '≠ computed ' + b.qrPay.crcCalc}`);
      const ids = [b.qrPay.billNo === b.consumerId, !b.qrPay.refFromQR || !b.refNo || b.refNo.replace(/\D/g,'').startsWith(b.qrPay.refFromQR)];
      if (b.consumerId) add('Payment QR belongs to this bill', ids.every(Boolean) ? 'pass' : 'fail', ids.every(Boolean) ? `Consumer ID ${b.qrPay.billNo} and reference number match` : `QR carries consumer ${b.qrPay.billNo} / ref ${b.qrPay.refFromQR}`);
      if (b.grandTotal != null && b.grandTotal > 0 && b.qrPay.amount != null && b.qrPay.amount > 0) add('Payment QR amount matches amount due', approx(b.qrPay.amount, b.grandTotal, 1) ? 'pass' : 'warn', `QR Rs ${fmt(b.qrPay.amount)}; bill Rs ${fmt(b.grandTotal)}`);
    }
    return out;
  }

  function analyze(b, opts) {
    opts = opts || {};
    const e = b.energy, n = b.qrNet || {}, tx = taxRates(b), A = { tx };
    if (!e) return A;
    const rOP = opts.rateOP ?? e.rateOP, rPK = opts.ratePK ?? e.ratePK; A.rOP = rOP; A.rPK = rPK;
    const days = opts.days || 30, gen = opts.generation;
    A.days = days;
    A.peakShareImp = e.imp ? e.impPK / e.imp : 0;
    A.offpeakShareExp = e.exp ? e.expOP / e.exp : 0;
    if (rOP != null && rPK != null) {
      A.ratio = rPK / rOP;
      A.costImpOP = e.impOP * rOP; A.costImpPK = e.impPK * rPK; A.peakShareCost = (A.costImpOP + A.costImpPK) ? A.costImpPK / (A.costImpOP + A.costImpPK) : 0;
      A.creditExp = e.expOP * rOP + e.expPK * rPK;
      A.energyMonth = e.netOP * rOP + e.netPK * rPK;              // this month's contribution (before tax)
      A.timingPremium = Math.max(0, e.netPK) * (rPK - rOP);          // extra paid because the net import landed in peak hours
      A.unitsNet = e.net;
      // Savings vs no solar: fixed charge is the same either way, so it cancels
      const self = gen != null && gen > 0 ? Math.max(0, gen - e.exp) : 0;
      A.selfUse = gen != null && gen > 0 ? gen - e.exp : null;
      A.noSolarEnergy = (e.impOP + self) * rOP + e.impPK * rPK;
      A.savings = (A.noSolarEnergy - A.energyMonth) * tx.mult;
      A.savingsLowerBound = ((e.impOP) * rOP + e.impPK * rPK - A.energyMonth) * tx.mult;
      A.noSolarBill = A.noSolarEnergy * tx.mult + (n.fix || 0) * (1 + tx.gst);
      A.withSolarMonth = A.energyMonth * tx.mult + (n.fix || 0) * (1 + tx.gst);
      A.shiftMax = Math.max(0, Math.round(e.impPK / days * 10) / 10);
      A.shiftValuePerKwh = (rPK - rOP) * tx.mult;
    }
    if (gen != null && gen > 0) {
      A.gen = gen; A.consumption = e.imp + Math.max(0, gen - e.exp);
      A.selfSufficiency = A.consumption ? Math.max(0, gen - e.exp) / A.consumption : 0;
      A.selfConsumptionRatio = Math.max(0, gen - e.exp) / gen;
      if (n.dgCapacity) A.yieldPerKwp = gen / n.dgCapacity / days;
    }
    if (n.dgCapacity) A.exportYield = e.exp / n.dgCapacity / days;
    A.settlement = settlementModel(b);
    if (n.monthCount) A.cycle = n.monthCount;
    if (A.settlement && n.monthCount && n.monthCount.i === n.monthCount.n) {
      const s = A.settlement; A.quarter = { op: s.op, pk: s.pk, net: s.op + s.pk, coe: n.coe };
    }
    return A;
  }

  // Merge several bills into a month-indexed timeline
  function timeline(bills) {
    const map = {};
    const put = (k, o) => { map[k] = Object.assign(map[k] || { month: k }, o); };
    // oldest bills first so newer history overwrites
    for (const b of bills.slice().sort((a,b) => (a.month||'').localeCompare(b.month||''))) {
      for (const h of b.history) put(h.month, { units: h.units, balance: h.balance });
      if (b.month) {
        const o = { hasBill: true };
        if (b.energy) Object.assign(o, { units: b.energy.net, impOP: b.energy.impOP, impPK: b.energy.impPK, expOP: b.energy.expOP, expPK: b.energy.expPK });
        if (b.grandTotal != null) o.balance = b.grandTotal;
        if (b.qrNet && b.qrNet.monthCount) o.cycle = b.qrNet.monthCount;
        put(b.month, o);
      }
    }
    const keys = Object.keys(map).sort();
    if (!keys.length) return [];
    const out = []; for (let k = keys[0]; k <= keys[keys.length-1]; k = addMonths(k, 1)) out.push(map[k] || { month: k });
    for (let i = 1; i < out.length; i++) if (out[i].balance != null && out[i-1].balance != null) out[i].delta = out[i].balance - out[i-1].balance;
    return out;
  }

  return { parseText, parsePaymentQR, parseNetQR, buildBill, analyze, checks, timeline, monthLabel, monthShort, addMonths, num, crc16 };
})();
globalThis.NM = NM;
