// Runs with NODEJS_HELPERS=0 (raw request stream needed for the PayPal signature check).
// Hitman BTT inventory: /api/sold (GET) and /api/paypal-webhook (POST). Single file so it deploys from a flat upload.
// Sold-slot store for the Hitman BTT sponsor page. Lives in Vercel Blob as sold.json.
const { put, head } = require('@vercel/blob');
const KEY = 'sold.json';
function send(res, code, obj) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }
async function read() {
  try {
    const h = await head(KEY);
    const r = await fetch(h.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return { sold: {}, events: {} };
    const j = await r.json();
    return { sold: j.sold || {}, events: j.events || {}, orders: j.orders || {}, updated: j.updated };
  } catch (e) { return { sold: {}, events: {}, orders: {} }; }
}
async function write(data) {
  data.updated = new Date().toISOString();
  await put(KEY, JSON.stringify(data), { access: 'public', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 0 });
  return data;
}

// POST /api/paypal-webhook  <- PayPal webhook (PAYMENT.CAPTURE.COMPLETED). Verifies PayPal's signature with
// PayPal's public cert (no client secret needed), then records the SKUs from custom_id ("SKU:qty,SKU:qty").
const crypto = require('crypto');

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function verify(req, body) {
  const id = process.env.PAYPAL_WEBHOOK_ID;
  if (!id) return { ok: false, why: 'PAYPAL_WEBHOOK_ID not set' };
  const h = k => req.headers[k];
  const certUrl = h('paypal-cert-url') || '';
  let host; try { host = new URL(certUrl).hostname; } catch (e) { return { ok: false, why: 'bad cert url' }; }
  if (!/(^|\.)paypal\.com$/.test(host)) return { ok: false, why: 'cert not from paypal' };
  const cert = await (await fetch(certUrl)).text();
  const msg = [h('paypal-transmission-id'), h('paypal-transmission-time'), id, crc32(body)].join('|');
  const v = crypto.createVerify('SHA256'); v.update(msg);
  const ok = v.verify(cert, h('paypal-transmission-sig') || '', 'base64');
  return { ok, why: ok ? '' : 'signature mismatch' };
}
function parseCustom(s) {
  const out = {};
  String(s || '').split(',').forEach(p => { const [sku, q] = p.split(':'); if (/^HBTT-SP-/.test(sku)) out[sku] = (out[sku] || 0) + (parseInt(q, 10) || 1); });
  return out;
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
  d.events[r.id] = { at: r.create_time || new Date().toISOString(), amount: r.amount && r.amount.value, skus };
  d.orders = d.orders || {};
  var o = d.orders[r.id] || { id: r.id, at: r.create_time || new Date().toISOString(), source: 'webhook', lines: skus };
  o.confirmed = true; o.amount = r.amount && r.amount.value; o.paypalOrderId = (r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.order_id) || o.paypalOrderId || '';
  d.orders[r.id] = o;
  Object.keys(skus).forEach(k => { d.sold[k] = (d.sold[k] || 0) + skus[k]; });
  await write(d);
  send(res, 200, { ok: true, sold: d.sold });
}

function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
function clean(v, n) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n || 200); }
// POST /api/order  <- the page, right after PayPal capture. Records who bought what. The PayPal webhook flips confirmed=true.
async function order(req, res) {
  cors(res);
  const body = await rawBody(req);
  let b; try { b = JSON.parse(body.toString('utf8')); } catch (e) { return send(res, 400, { ok: false }); }
  const id = clean(b.captureId, 40); if (!id) return send(res, 400, { ok: false, why: 'no capture id' });
  const d = await read(); d.orders = d.orders || {};
  const o = d.orders[id] || { id, at: new Date().toISOString(), confirmed: false };
  o.source = o.source === 'webhook' ? 'both' : 'page';
  o.paypalOrderId = clean(b.paypalOrderId, 40) || o.paypalOrderId || '';
  o.company = clean(b.company, 120); o.name = clean(b.name, 120); o.email = clean(b.email, 160); o.phone = clean(b.phone, 40); o.instagram = clean(b.instagram, 60); o.notes = clean(b.notes, 500);
  o.lines = (b.lines && typeof b.lines === 'object') ? b.lines : (o.lines || {});
  o.total = clean(b.total, 20); o.payerEmail = clean(b.payerEmail, 160);
  d.orders[id] = o;
  await write(d);
  send(res, 200, { ok: true });
}
function csvCell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
// GET /api/orders.csv?key=ADMIN_KEY  -> spreadsheet feed (Google Sheets: =IMPORTDATA("...orders.csv?key=..."))
async function ordersCsv(req, res) {
  const want = process.env.ADMIN_KEY; const q = new URL(req.url, 'http://x').searchParams;
  if (!want || q.get('key') !== want) { res.statusCode = 403; res.setHeader('Content-Type', 'text/plain'); return res.end('forbidden'); }
  const d = await read(); const os = Object.values(d.orders || {}).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const head = ['date', 'company', 'contact', 'email', 'phone', 'instagram', 'items', 'total_usd', 'paypal_capture_id', 'paypal_order_id', 'confirmed_by_paypal', 'notes'];
  const lines = os.map(o => [o.at, o.company, o.name, o.email || o.payerEmail, o.phone, o.instagram, Object.keys(o.lines || {}).map(k => k + (o.lines[k] > 1 ? ' x' + o.lines[k] : '')).join('; '), o.total || o.amount, o.id, o.paypalOrderId, o.confirmed ? 'yes' : 'pending', o.notes].map(csvCell).join(','));
  res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.end([head.join(',')].concat(lines).join('\n') + '\n');
}
async function sold(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = await read();
  send(res, 200, { sold: d.sold, updated: d.updated || null });
}
module.exports = async (req, res) => {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; return res.end(); }
  if (path === '/api/sold') return sold(req, res);
  if (path === '/api/order') return order(req, res);
  if (path === '/api/orders.csv') return ordersCsv(req, res);
  if (path === '/api/paypal-webhook') return webhook(req, res);
  res.statusCode = 200; res.setHeader('Content-Type', 'text/plain');
  res.end('hitman-btt-inventory: /api/sold, /api/paypal-webhook, /api/order, /api/orders.csv');
};
