// Hitman Blind Taste Test Colorado, event backend. One Vercel function, Blob store, no framework.
// Runs with NODEJS_HELPERS=0 (raw request stream needed for the PayPal signature check).
//
//   GET  /api/sold                     sold counts per SKU (sponsor page + ticket page read this)
//   GET  /api/catalog                  SKUs, prices, caps, pools
//   POST /api/order                    the page posts buyer + lines right after PayPal captures (unconfirmed until the webhook)
//   POST /api/paypal-webhook           PayPal PAYMENT.CAPTURE.COMPLETED: verifies signature, counts stock, issues ticket codes,
//                                      pushes the order + tickets to the Google Sheet (which emails the buyer)
//   GET  /api/qr?c=CODE                SVG QR for a ticket code (used in the ticket email and on the ticket page)
//   GET  /api/ticket?c=CODE            public: is this a real code, which day, first name (scanner fallback, scorecard fallback)
//   GET  /api/orders.csv?key=ADMIN     spreadsheet feed of orders
//   GET  /api/tickets.csv?key=ADMIN    spreadsheet feed of tickets
//   POST /api/resend?key=ADMIN&capture=ID   push one capture to the Sheet again (email again)
//
// Env: BLOB_READ_WRITE_TOKEN (store), PAYPAL_WEBHOOK_ID (live), PAYPAL_WEBHOOK_ID_SANDBOX (test), ADMIN_KEY,
//      SHEET_URL (Apps Script web app /exec), SHEET_KEY (must match SHEET_KEY script property).
const crypto = require('crypto');
const { put, head } = require('@vercel/blob');

const KEY = 'sold.json';
function send(res, code, obj) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
function clean(v, n) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n || 200); }

// ---------- catalog: every SKU the two pages sell. cap = slots. pool = SKUs that share a cap. ----------
const CATALOG = {
  // tickets
  'HBTT-TK-SAT':  { name: 'Saturday Testing Pass', price: 200, cap: 100, kind: 'ticket', day: 'Saturday', type: 'Saturday Testing Pass', max: 4 },
  'HBTT-TK-SUN':  { name: 'Sunday Testing Pass',   price: 200, cap: 100, kind: 'ticket', day: 'Sunday',   type: 'Sunday Testing Pass',   max: 4 },
  'HBTT-TK-VIP':  { name: 'Preparty VIP',          price: 100, cap: 20,  kind: 'ticket', day: 'Preparty', type: 'Preparty VIP',          max: 4 },
  'HBTT-TK-GA':   { name: 'Preparty GA',           price: 20,  cap: 150, kind: 'ticket', day: 'Preparty', type: 'Preparty GA',           max: 6 },
  // sponsorships
  'HBTT-SP-SUPPORT':    { name: 'Supporting sponsor', price: 1500, cap: 8, kind: 'sponsor' },
  'HBTT-SP-VENDOR-1D':  { name: 'Vendor table, one day', price: 1500, cap: 6, kind: 'sponsor', pool: 'VENDOR' },
  'HBTT-SP-VENDOR-2D':  { name: 'Vendor table, both days', price: 2500, cap: 6, kind: 'sponsor', pool: 'VENDOR' },
  'HBTT-SP-STATION-1D': { name: 'Tasting station sponsor, one day', price: 2000, cap: 10, kind: 'sponsor', pool: 'STATION' },
  'HBTT-SP-STATION-2D': { name: 'Tasting station sponsor, both days', price: 3500, cap: 10, kind: 'sponsor', pool: 'STATION' },
  'HBTT-SP-CASE':       { name: 'Display case sponsor', price: 2500, cap: 1, kind: 'sponsor' },
  'HBTT-SP-BLINDFOLD':  { name: 'Blindfold sponsor', price: 5000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-WRISTBAND':  { name: 'Wristband sponsor', price: 5000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-SCORECARD':  { name: 'Ticket and scorecard sponsor', price: 5000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-SHIRT':      { name: 'Shirt sponsor', price: 10000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-HOODIE':     { name: 'Hoodie sponsor', price: 10000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-MERCH':      { name: 'Exclusive merch sponsor, all five', price: 25000, cap: 1, kind: 'sponsor' },
  'HBTT-SP-PRESENT-10': { name: 'Presenting sponsor, $10,000', price: 10000, cap: 1, kind: 'sponsor', pool: 'PRESENT' },
  'HBTT-SP-PRESENT-20': { name: 'Presenting sponsor, $20,000', price: 20000, cap: 1, kind: 'sponsor', pool: 'PRESENT' },
  'HBTT-SP-PRESENT-30': { name: 'Presenting sponsor, $30,000', price: 30000, cap: 1, kind: 'sponsor', pool: 'PRESENT' },
  'HBTT-SP-ERIG':       { name: 'Exclusive e-rig sponsor', price: 25000, cap: 1, kind: 'sponsor' },
  'HBTT-SP-MAIN':       { name: 'Main sponsor, presented by', price: 40000, cap: 1, kind: 'sponsor' }
};
const POOLS = { VENDOR: 6, STATION: 10, PRESENT: 3, MERCH5: 5 };

// ---------- store ----------
async function read() {
  try {
    const h = await head(KEY);
    const r = await fetch(h.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('blob ' + r.status);
    const j = await r.json();
    return { sold: j.sold || {}, events: j.events || {}, orders: j.orders || {}, tickets: j.tickets || {}, updated: j.updated };
  } catch (e) { return { sold: {}, events: {}, orders: {}, tickets: {} }; }
}
async function write(d) {
  d.updated = new Date().toISOString();
  await put(KEY, JSON.stringify(d), { access: 'public', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 0 });
  return d;
}
function rawBody(req) { return new Promise((resolve, reject) => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); }); }

// ---------- PayPal webhook signature (PayPal's public cert, no client secret) ----------
function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
async function verify(req, body) {
  const ids = [['live', process.env.PAYPAL_WEBHOOK_ID], ['sandbox', process.env.PAYPAL_WEBHOOK_ID_SANDBOX]].filter(x => x[1]);
  if (!ids.length) return { ok: false, why: 'no webhook id configured' };
  const h = k => req.headers[k];
  let host; try { host = new URL(h('paypal-cert-url') || '').hostname; } catch (e) { return { ok: false, why: 'bad cert url' }; }
  if (!/(^|\.)paypal\.com$/.test(host)) return { ok: false, why: 'cert not from paypal' };
  const cert = await (await fetch(h('paypal-cert-url'))).text();
  const crc = crc32(body);
  for (const [env, id] of ids) {
    const v = crypto.createVerify('SHA256'); v.update([h('paypal-transmission-id'), h('paypal-transmission-time'), id, crc].join('|'));
    if (v.verify(cert, h('paypal-transmission-sig') || '', 'base64')) return { ok: true, env };
  }
  return { ok: false, why: 'signature mismatch' };
}
function parseCustom(s) { const out = {}; String(s || '').split(',').forEach(p => { const [sku, q] = p.split(':'); if (CATALOG[sku]) out[sku] = (out[sku] || 0) + (parseInt(q, 10) || 1); }); return out; }

// ---------- tickets ----------
function genCode(existing) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (;;) { let s = ''; for (let i = 0; i < 8; i++) s += a[crypto.randomInt(a.length)]; const c = 'HBTT-' + s.slice(0, 4) + '-' + s.slice(4); if (!existing[c]) return c; } }
function issueTickets(d, o) {
  // one code per pass, attendee names from the page post if present, else the buyer
  const names = o.attendees || {};
  Object.keys(o.lines || {}).forEach(sku => {
    const c = CATALOG[sku]; if (!c || c.kind !== 'ticket') return;
    const qty = o.lines[sku];
    const mine = Object.values(d.tickets).filter(t => t.captureId === o.id && t.sku === sku).sort((x, y) => x.issuedAt.localeCompare(y.issuedAt));
    mine.forEach((t, i) => { const who = (names[sku] && names[sku][i]) || o.name || t.name; t.name = clean(who, 120); t.email = o.email || o.payerEmail || t.email; t.phone = o.phone || t.phone; });
    const have = mine.length;
    for (let i = have; i < qty; i++) {
      const code = genCode(d.tickets);
      const who = (names[sku] && names[sku][i]) || o.name || '';
      d.tickets[code] = { code, sku, type: c.type, day: c.day, name: clean(who, 120), email: o.email || o.payerEmail || '', phone: o.phone || '', captureId: o.id, env: o.env || 'live', issuedAt: new Date().toISOString() };
    }
  });
  return Object.values(d.tickets).filter(t => t.captureId === o.id);
}

// ---------- Google Sheet (Apps Script) hand-off: rows + the buyer email ----------
async function pushToSheet(o, tickets) {
  const url = process.env.SHEET_URL, key = process.env.SHEET_KEY;
  if (!url || !key) return { ok: false, why: 'SHEET_URL/SHEET_KEY not set' };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'issue', key, order: o, tickets, items: Object.keys(o.lines || {}).map(k => ({ sku: k, name: (CATALOG[k] || {}).name || k, qty: o.lines[k], price: (CATALOG[k] || {}).price || 0 })) }), redirect: 'follow' });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
    return { ok: r.ok && j.ok !== false, resp: j };
  } catch (e) { return { ok: false, why: String(e.message || e) }; }
}

// ---------- handlers ----------
async function sold(req, res) { cors(res); const d = await read(); send(res, 200, { sold: d.sold, updated: d.updated || null }); }
function catalog(req, res) { cors(res); send(res, 200, { catalog: CATALOG, pools: POOLS }); }

async function order(req, res) {
  cors(res);
  if (req.method === 'GET') {  // the buyer's receipt: tickets for a capture id (the buyer holds the id, PayPal shows it)
    const c = clean(new URL(req.url, 'http://x').searchParams.get('c'), 40); const d = await read(); const o = d.orders[c];
    if (!o) return send(res, 404, { ok: false });
    const t = Object.values(d.tickets).filter(x => x.captureId === c).map(x => ({ code: x.code, name: x.name, day: x.day, type: x.type }));
    return send(res, 200, { ok: true, confirmed: !!o.confirmed, env: o.env || 'live', tickets: t, emailed: !!o.sheetOk });
  }
  let b; try { b = JSON.parse((await rawBody(req)).toString('utf8')); } catch (e) { return send(res, 400, { ok: false }); }
  const id = clean(b.captureId, 40); if (!id) return send(res, 400, { ok: false, why: 'no capture id' });
  const d = await read();
  const o = d.orders[id] || { id, at: new Date().toISOString(), confirmed: false, env: 'live' };
  o.source = o.source === 'webhook' ? 'both' : 'page';
  o.paypalOrderId = clean(b.paypalOrderId, 40) || o.paypalOrderId || '';
  o.kind = clean(b.kind, 12) || o.kind || '';
  o.company = clean(b.company, 120); o.name = clean(b.name, 120); o.email = clean(b.email, 160); o.phone = clean(b.phone, 40); o.instagram = clean(b.instagram, 60); o.notes = clean(b.notes, 500);
  o.lines = (b.lines && typeof b.lines === 'object') ? b.lines : (o.lines || {});
  if (b.attendees && typeof b.attendees === 'object') { o.attendees = {}; Object.keys(b.attendees).forEach(k => { if (CATALOG[k]) o.attendees[k] = [].concat(b.attendees[k]).slice(0, 10).map(x => clean(x, 120)); }); }
  o.total = clean(b.total, 20); o.payerEmail = clean(b.payerEmail, 160);
  if (b.sandbox === true) o.env = 'sandbox';
  d.orders[id] = o;
  // if the webhook already confirmed this capture (it can arrive first), finish the job now
  let sheet = null;
  if (o.confirmed) {
    const t = issueTickets(d, o);
    if (!o.sheetOk) { sheet = await pushToSheet(o, t); o.sheetOk = !!sheet.ok; o.sheetAt = new Date().toISOString(); }
  }
  await write(d);
  send(res, 200, { ok: true, confirmed: !!o.confirmed, sheet });
}

async function webhook(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  const body = await rawBody(req);
  const v = await verify(req, body);
  if (!v.ok) { console.warn('rejected webhook:', v.why); return send(res, 400, { ok: false, why: v.why }); }
  let ev; try { ev = JSON.parse(body.toString('utf8')); } catch (e) { return send(res, 400, { ok: false }); }
  const r = ev.resource || {};
  if (ev.event_type !== 'PAYMENT.CAPTURE.COMPLETED' || r.status !== 'COMPLETED') return send(res, 200, { ok: true, ignored: ev.event_type });
  const skus = parseCustom(r.custom_id);
  const d = await read();
  if (d.events[r.id]) return send(res, 200, { ok: true, dup: true });
  d.events[r.id] = { at: r.create_time || new Date().toISOString(), amount: r.amount && r.amount.value, skus, env: v.env };
  if (v.env === 'live') Object.keys(skus).forEach(k => { d.sold[k] = (d.sold[k] || 0) + skus[k]; });
  const o = d.orders[r.id] || { id: r.id, at: r.create_time || new Date().toISOString(), source: 'webhook', lines: skus };
  o.confirmed = true; o.env = v.env; o.amount = r.amount && r.amount.value;
  o.paypalOrderId = (r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.order_id) || o.paypalOrderId || '';
  if (!o.lines || !Object.keys(o.lines).length) o.lines = skus;
  d.orders[r.id] = o;
  const tickets = issueTickets(d, o);
  // push to the Sheet only once the page has told us who bought (name/email). If the page post has not landed yet, /api/order finishes it.
  let sheet = null;
  if ((o.email || o.payerEmail) && !o.sheetOk) { sheet = await pushToSheet(o, tickets); o.sheetOk = !!sheet.ok; o.sheetAt = new Date().toISOString(); }
  await write(d);
  send(res, 200, { ok: true, env: v.env, sold: d.sold, tickets: tickets.length, sheet });
}

async function qr(req, res) {
  const c = clean(new URL(req.url, 'http://x').searchParams.get('c'), 40);
  if (!/^HBTT-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) { res.statusCode = 400; return res.end('bad code'); }
  const QR = require('qrcode');
  const svg = await QR.toString(c, { type: 'svg', margin: 1, width: 320, errorCorrectionLevel: 'M', color: { dark: '#17120D', light: '#FFFFFF' } });
  res.statusCode = 200; res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); res.end(svg);
}
async function ticket(req, res) {
  cors(res);
  const c = clean(new URL(req.url, 'http://x').searchParams.get('c'), 40).toUpperCase();
  const d = await read(); const t = d.tickets[c];
  if (!t) return send(res, 404, { ok: false, error: 'No ticket with that code.' });
  send(res, 200, { ok: true, code: t.code, day: t.day, type: t.type, name: t.name, env: t.env });
}
function csvCell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function admin(req, res) { const want = process.env.ADMIN_KEY; const q = new URL(req.url, 'http://x').searchParams; if (!want || q.get('key') !== want) { res.statusCode = 403; res.setHeader('Content-Type', 'text/plain'); res.end('forbidden'); return null; } return q; }
async function ordersCsv(req, res) {
  if (!admin(req, res)) return;
  const d = await read(); const os = Object.values(d.orders).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const headRow = ['date', 'env', 'kind', 'company', 'contact', 'email', 'phone', 'instagram', 'items', 'total_usd', 'paypal_capture_id', 'paypal_order_id', 'confirmed_by_paypal', 'sheet', 'notes'];
  const lines = os.map(o => [o.at, o.env || 'live', o.kind || (Object.keys(o.lines || {}).some(k => k.startsWith('HBTT-TK')) ? 'ticket' : 'sponsor'), o.company, o.name, o.email || o.payerEmail, o.phone, o.instagram, Object.keys(o.lines || {}).map(k => k + (o.lines[k] > 1 ? ' x' + o.lines[k] : '')).join('; '), o.total || o.amount, o.id, o.paypalOrderId, o.confirmed ? 'yes' : 'pending', o.sheetOk ? 'sent' : '', o.notes].map(csvCell).join(','));
  res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end([headRow.join(',')].concat(lines).join('\n') + '\n');
}
async function ticketsCsv(req, res) {
  if (!admin(req, res)) return;
  const d = await read(); const ts = Object.values(d.tickets).sort((a, b) => String(a.issuedAt).localeCompare(String(b.issuedAt)));
  const headRow = ['code', 'day', 'type', 'name', 'email', 'phone', 'env', 'paypal_capture_id', 'issued'];
  res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.end([headRow.join(',')].concat(ts.map(t => [t.code, t.day, t.type, t.name, t.email, t.phone, t.env, t.captureId, t.issuedAt].map(csvCell).join(','))).join('\n') + '\n');
}
async function resend(req, res) {
  const q = admin(req, res); if (!q) return;
  const id = clean(q.get('capture'), 40); const d = await read(); const o = d.orders[id];
  if (!o) return send(res, 404, { ok: false, why: 'no such capture' });
  const t = issueTickets(d, o); const sheet = await pushToSheet(o, t); o.sheetOk = !!sheet.ok; o.sheetAt = new Date().toISOString();
  await write(d); send(res, 200, { ok: true, sheet, tickets: t.map(x => x.code) });
}

module.exports = async (req, res) => {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; return res.end(); }
  try {
    if (path === '/api/sold') return await sold(req, res);
    if (path === '/api/catalog') return catalog(req, res);
    if (path === '/api/order') return await order(req, res);
    if (path === '/api/paypal-webhook') return await webhook(req, res);
    if (path === '/api/qr') return await qr(req, res);
    if (path === '/api/ticket') return await ticket(req, res);
    if (path === '/api/orders.csv') return await ordersCsv(req, res);
    if (path === '/api/tickets.csv') return await ticketsCsv(req, res);
    if (path === '/api/resend') return await resend(req, res);
  } catch (e) { console.error(e); return send(res, 500, { ok: false, why: String(e.message || e) }); }
  res.statusCode = 200; res.setHeader('Content-Type', 'text/plain');
  res.end('hitman-btt backend: /api/sold /api/catalog /api/order /api/paypal-webhook /api/qr /api/ticket /api/orders.csv /api/tickets.csv /api/resend');
};
