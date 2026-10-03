// The Reserve event backend: Hitman Blind Taste Test Colorado plus Nightmare on Bud St. One Vercel function, no framework. Its database is a hidden tab in the HBTT Google Sheet (was Vercel Blob until 2026-09-27).
// Runs with NODEJS_HELPERS=0 (raw request stream needed for the PayPal signature check).
//
//   GET  /api/sold                     sold counts per SKU (sponsor page + ticket page read this)
//   GET  /api/catalog                  SKUs, prices, caps, pools
//   POST /api/order                    the page posts buyer + lines right after PayPal captures (unconfirmed until the webhook)
//   POST /api/paypal-webhook           PayPal PAYMENT.CAPTURE.COMPLETED: verifies signature, counts stock, issues ticket codes,
//                                      pushes the order + tickets to the Google Sheet (which emails the buyer)
//   GET  /api/qr?c=CODE[&fmt=png]      QR for a ticket code, SVG by default (PNG for email clients that drop SVG)
//   GET  /api/ticket?c=CODE            public: is this a real code, which day, first name (scanner fallback, scorecard fallback)
//   GET  /api/orders.csv?key=ADMIN     spreadsheet feed of orders
//   GET  /api/tickets.csv?key=ADMIN    spreadsheet feed of tickets
//   POST /api/resend?key=ADMIN&capture=ID   push one capture to the Sheet again (email again)
//
// Events: every endpoint serves HBTT unless it gets ?event=nobs. PayPal captures and page posts are routed by SKU:
// anything carrying a NOBS- SKU lives in its own store (nobs.json) and goes to the Sheet with event 'nobs'.
//
// Env: PAYPAL_WEBHOOK_ID (live), PAYPAL_WEBHOOK_ID_SANDBOX (test), ADMIN_KEY,
//      SHEET_URL (Apps Script web app /exec, also hosts the database: store_get / store_put), SHEET_KEY (must match SHEET_KEY script property),
//      NOBS_SHEET_URL / NOBS_SHEET_KEY (the Nightmare on Bud St. Sheet script; until set, NOBS orders are kept here unsent).
const crypto = require('crypto');

const EVENTS = {
  hbtt: { key: 'sold.json', prefix: 'HBTT-', sheet: '' },
  nobs: { key: 'nobs.json', prefix: 'NOBS-', sheet: 'nobs', urlEnv: 'NOBS_SHEET_URL', keyEnv: 'NOBS_SHEET_KEY' }
};
function eventOfSkus(lines) { return Object.keys(lines || {}).some(k => k.startsWith('NOBS-')) ? 'nobs' : 'hbtt'; }
function eventParam(req) { const e = new URL(req.url, 'http://x').searchParams.get('event'); return EVENTS[e] ? e : 'hbtt'; }
function isTicketSku(k) { return k.startsWith('HBTT-TK') || k.startsWith('NOBS-TK'); }
// what a confirmed Nightmare on Bud St. buyer gets told on the receipt (never printed on the public page)
const REVEAL = { nobs: { venue: 'The Reserve', address: '1820 Blake St, Denver, CO 80202', when: 'Saturday, October 31, 2026. Doors 6 PM, party ends at midnight.' } };
function send(res, code, obj) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
function clean(v, n) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n || 200); }

// ---------- catalog: every SKU the two pages sell. cap = slots. pool = SKUs that share a cap. ----------
const CATALOG = {
  // tickets
  'HBTT-TK-SAT':  { name: 'Saturday Testing Pass', price: 200, cap: 100, kind: 'ticket', day: 'Saturday', type: 'Saturday Testing Pass', max: 10 },
  'HBTT-TK-VIP':  { name: 'QCB Preparty VIP',      price: 200, cap: 20,  kind: 'ticket', day: 'Preparty', type: 'QCB Preparty VIP',          max: 4 },
  'HBTT-TK-GA':   { name: 'QCB Preparty GA',       price: 20,  cap: 150, kind: 'ticket', day: 'Preparty', type: 'QCB Preparty GA',           max: 6 },
  // sponsorships
  'HBTT-SP-SUPPORT':    { name: 'Supporting sponsor', price: 1500, cap: 8, kind: 'sponsor' },
  'HBTT-SP-VENDOR-1D':  { name: 'Vendor table', price: 1500, cap: 6, kind: 'sponsor', pool: 'VENDOR' },
  'HBTT-SP-STATION-1D': { name: 'Tasting station sponsor', price: 2000, cap: 10, kind: 'sponsor', pool: 'STATION' },
  'HBTT-SP-CASE':       { name: 'Entry display case sponsor', price: 2500, cap: 1, kind: 'sponsor' },
  'HBTT-SP-BLINDFOLD':  { name: 'Blindfold sponsor', price: 5000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-WRISTBAND':  { name: 'Wristband sponsor', price: 5000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-SCORECARD':  { name: 'Ticket and voting app sponsor', price: 5000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-SHIRT':      { name: 'Shirt sponsor', price: 10000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-HOODIE':     { name: 'Hoodie sponsor', price: 10000, cap: 1, kind: 'sponsor', pool: 'MERCH5' },
  'HBTT-SP-MERCH':      { name: 'Exclusive merch sponsor, all five', price: 25000, cap: 1, kind: 'sponsor' },
  'HBTT-SP-PRESENT-10': { name: 'Presenting sponsor, $10,000', price: 10000, cap: 1, kind: 'sponsor', pool: 'PRESENT' },
  'HBTT-SP-PRESENT-20': { name: 'Presenting sponsor, $20,000', price: 20000, cap: 1, kind: 'sponsor', pool: 'PRESENT' },
  'HBTT-SP-PRESENT-30': { name: 'Presenting sponsor, $30,000', price: 30000, cap: 1, kind: 'sponsor', pool: 'PRESENT' },
  'HBTT-SP-ERIG':       { name: 'Exclusive e-rig sponsor', price: 25000, cap: 1, kind: 'sponsor' },
  'HBTT-SP-MAIN':       { name: 'Main sponsor, presented by', price: 40000, cap: 1, kind: 'sponsor' },
  // Nightmare on Bud St. Halloween party, Sat Oct 31 2026 at The Reserve
  'NOBS-TK-GA':         { name: 'Nightmare on Bud St. Party Ticket', price: 50, cap: 150, kind: 'ticket', day: 'Halloween', type: 'Party Ticket', max: 10, event: 'nobs' }
};
const POOLS = { VENDOR: 6, STATION: 10, PRESENT: 3, MERCH5: 5 };
function catalogFor(ev, all) { const out = {}; Object.keys(CATALOG).forEach(k => { if ((CATALOG[k].event || 'hbtt') === ev && (all || !CATALOG[k].hidden)) out[k] = CATALOG[k]; }); return out; }

// ---------- sponsor invoices: the pay page looks one up by its unguessable token; names and amounts never sit in public files ----------
// Sponsor invoices live in the HBTT_INVOICES env var, never in this file (the repo is public). JSON shape:
//   { "<token>": { "id": "BTT-2026-001", "sku": "HBTT-SP-INV-001", "company": "...", "email": "...", "item": "...", "detail": "...", "amount": 10000, "issued": "2026-10-02", "due": "Due on receipt" } }
// Each one becomes a hidden catalog SKU, so a PayPal payment on the pay page records like any sponsor purchase.
let INVOICES = {};
try { INVOICES = JSON.parse(process.env.HBTT_INVOICES || '{}'); } catch (e) { console.error('HBTT_INVOICES is not valid JSON'); }
Object.values(INVOICES).forEach(v => { if (v && v.sku && !CATALOG[v.sku]) CATALOG[v.sku] = { name: v.item, price: Number(v.amount) || 0, cap: 1, kind: 'sponsor', hidden: true, invoice: v.id }; });

// ---------- store: the HBTT Sheet script keeps one JSON document per event (store_get / store_put, versioned) ----------
// Fail closed: if the Sheet cannot be reached the request fails (5xx) instead of pretending the store is empty.
// PayPal retries a failed webhook, the ticket page retries its post, so nothing is lost while the store is down.
function emptyStore() { return { sold: {}, events: {}, orders: {}, tickets: {}, entries: {}, payers: {} }; }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CACHE = {};   // per warm instance: ev -> { at, d }. Only public GETs use it.
// Apps Script answers a POST with a 302 to a one-time "echo" URL holding the script's reply. Google sometimes serves that
// echo URL before the reply is ready (404) or bounces it (302); following the bounce as a GET lands on doGet with no action,
// which answers "unknown action". So take the first redirect by hand and re-fetch the echo URL until it returns JSON.
// The POST itself is never re-sent here, so a write or an email can't happen twice.
async function scriptPost(url, bodyText) {
  const r1 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: bodyText, redirect: 'manual' });
  const echo = (r1.status >= 300 && r1.status < 400 && r1.headers && typeof r1.headers.get === 'function') ? r1.headers.get('location') : null;
  if (!echo) return { status: r1.status, text: await r1.text(), ran: r1.status === 200 };
  let last = { status: 0, text: '' };
  for (const wait of [0, 300, 700, 1500, 3000, 5000]) {
    if (wait) await sleep(wait);
    let r2; try { r2 = await fetch(echo, { redirect: 'manual' }); } catch (x) { last = { status: 0, text: String(x.message || x) }; continue; }
    const t = await r2.text();
    if (r2.status === 200) { try { JSON.parse(t); return { status: 200, text: t, ran: true }; } catch (x) {} }
    last = { status: r2.status, text: t };
  }
  return { status: last.status, text: last.text, ran: true, lost: true };
}
async function storeCall(body) {
  const url = process.env.SHEET_URL, key = process.env.SHEET_KEY;
  if (!url || !key) { const e = new Error('store: SHEET_URL/SHEET_KEY not set'); e.store = true; throw e; }
  const text = JSON.stringify(Object.assign({ key }, body)), reads = body.action === 'store_get';
  let r = null, err = null;
  for (let i = 0; i < (reads ? 3 : 1); i++) {   // a read can simply be asked again; a write is never re-sent here (mutate re-reads and re-applies)
    err = null;
    try { r = await scriptPost(url, text); } catch (x) { err = x; r = null; }
    if (r && r.status === 200) break;
    if (reads && i < 2) await sleep(500 * (i + 1));
  }
  if (!r) { const e = new Error('store: unreachable (' + ((err && err.message) || err) + ')'); e.store = true; if (!reads) e.conflict = true; throw e; }
  let j; try { j = JSON.parse(r.text); } catch (x) {
    const e = new Error('store: bad response ' + r.status); e.store = true;
    if (!reads && r.ran) e.conflict = true;   // the write may have landed: mutate re-reads and re-applies (every fn is safe to re-run)
    throw e;
  }
  if (!j.ok && !j.conflict) { const e = new Error('store: ' + (j.error || 'refused')); e.store = true; throw e; }
  return j;
}
async function read(ev, opts) {
  ev = ev || 'hbtt';
  if (opts && opts.cached && CACHE[ev] && Date.now() - CACHE[ev].at < 15000) return clone(CACHE[ev].d);
  const j = await storeCall({ action: 'store_get', name: ev });
  const d = Object.assign(emptyStore(), j.doc ? JSON.parse(j.doc) : {});
  Object.defineProperty(d, '_v', { value: j.version, writable: true, enumerable: false });
  CACHE[ev] = { at: Date.now(), d: clone(d) };
  return d;
}
async function write(d, ev) {
  ev = ev || 'hbtt';
  d.updated = new Date().toISOString();
  const j = await storeCall({ action: 'store_put', name: ev, doc: JSON.stringify(d), version: d._v });
  if (j.conflict) { const e = new Error('store: conflict'); e.conflict = true; throw e; }
  d._v = j.version; CACHE[ev] = { at: Date.now(), d: clone(d) };
  return d;
}
// read, change, write; on a version conflict re-read and re-apply. fn must only touch d (no network), it can run more than once.
async function mutate(ev, fn) {
  for (let i = 0; i < 6; i++) {
    const d = await read(ev);
    const out = fn(d);
    if (out && out.noWrite) return out;
    try { await write(d, ev); return out; }
    catch (e) { if (!e.conflict) throw e; await sleep(250 * (i + 1) + crypto.randomInt(200)); }
  }
  const e = new Error('store: busy, try again'); e.store = true; throw e;
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
const CODE_PREFIX = { 'HBTT-TK-SAT': 'SAT', 'HBTT-TK-VIP': 'VIP', 'HBTT-TK-GA': 'GA', 'NOBS-TK-GA': 'GA' };
// HBTT-SAT-XXXX / HBTT-SUN-XXXX (VIP / GA for the preparty), NOBS-GA-XXXX: 4 random chars, no 0/O/1/I, unique against every code issued
function genCode(existing, sku) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const pre = CODE_PREFIX[sku] || 'TK'; const ev = (CATALOG[sku] && CATALOG[sku].event) || 'hbtt'; for (;;) { let s = ''; for (let i = 0; i < 4; i++) s += a[crypto.randomInt(a.length)]; const c = EVENTS[ev].prefix + pre + '-' + s; if (!existing[c]) return c; } }
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
      const code = genCode(d.tickets, sku);
      const who = (names[sku] && names[sku][i]) || o.name || '';
      d.tickets[code] = { code, sku, type: c.type, day: c.day, name: clean(who, 120), email: o.email || o.payerEmail || '', phone: o.phone || '', captureId: o.id, env: o.env || 'live', issuedAt: new Date().toISOString() };
    }
  });
  return Object.values(d.tickets).filter(t => t.captureId === o.id);
}

// ---------- Google Sheet (Apps Script) hand-off: rows + the buyer email ----------
// push an order to its Sheet, then make sure the store says it went (skipped when the Sheet script already marked it)
async function finish(ev, o, t) {
  const sheet = await pushToSheet(o, t, ev);
  if (sheet.ok && !(sheet.resp && sheet.resp.storeMarked)) await mutate(ev, d => { const x = d.orders[o.id]; if (!x) return { noWrite: true }; x.sheetOk = true; x.sheetAt = new Date().toISOString(); });
  return sheet;
}
async function pushToSheet(o, tickets, ev) {
  const E = EVENTS[ev || 'hbtt'];
  // an event with its own Sheet never falls back to the HBTT one (that script would email an HBTT ticket)
  const url = E.urlEnv ? process.env[E.urlEnv] : process.env.SHEET_URL, key = E.keyEnv ? process.env[E.keyEnv] : process.env.SHEET_KEY;
  if (!url || !key) return { ok: false, why: (E.urlEnv || 'SHEET_URL') + '/' + (E.keyEnv || 'SHEET_KEY') + ' not set' };
  const payload = { action: 'issue', key, order: o, tickets, items: Object.keys(o.lines || {}).map(k => ({ sku: k, name: (CATALOG[k] || {}).name || k, qty: o.lines[k], price: (CATALOG[k] || {}).price || 0 })) };
  if (E.sheet) payload.event = E.sheet;
  if (!E.urlEnv) payload.store = ev || 'hbtt';   // same script as the store: it flips sheetOk itself
  try {
    const r = await scriptPost(url, JSON.stringify(payload));
    let j = {}; try { j = JSON.parse(r.text); } catch (e) { j = { raw: String(r.text).slice(0, 200) }; }
    return { ok: r.status === 200 && j.ok !== false, resp: j };
  } catch (e) { return { ok: false, why: String(e.message || e) }; }
}

// ---------- handlers ----------
async function sold(req, res) {
  cors(res); const d = await read(eventParam(req), { cached: true });
  res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=15, stale-while-revalidate=60');
  res.end(JSON.stringify({ sold: d.sold, updated: d.updated || null }));
}
function catalog(req, res) { cors(res); const ev = eventParam(req); send(res, 200, { catalog: catalogFor(ev), pools: ev === 'hbtt' ? POOLS : {} }); }

async function order(req, res) {
  cors(res);
  if (req.method === 'GET') {  // the buyer's receipt: tickets for a capture id (the buyer holds the id, PayPal shows it)
    const q = new URL(req.url, 'http://x').searchParams;
    const c = clean(q.get('c'), 40); let ev = eventParam(req); let d = await read(ev); let o = d.orders[c];
    if (!o && !q.get('event')) { const d2 = await read('nobs'); if (d2.orders[c]) { ev = 'nobs'; d = d2; o = d2.orders[c]; } }
    if (!o) return send(res, 404, { ok: false });
    const t = Object.values(d.tickets).filter(x => x.captureId === c).map(x => ({ code: x.code, name: x.name, day: x.day, type: x.type }));
    const out = { ok: true, confirmed: !!o.confirmed, env: o.env || 'live', tickets: t, emailed: !!o.sheetOk, named: !!(o.name && (o.email || o.payerEmail)) };
    if (REVEAL[ev] && o.confirmed) out.venue = REVEAL[ev];
    return send(res, 200, out);
  }
  let b; try { b = JSON.parse((await rawBody(req)).toString('utf8')); } catch (e) { return send(res, 400, { ok: false }); }
  const id = clean(b.captureId, 40); if (!id) return send(res, 400, { ok: false, why: 'no capture id' });
  const ev = eventOfSkus(b.lines);
  const r = await mutate(ev, d => {
    const o = d.orders[id] || { id, at: new Date().toISOString(), confirmed: false, env: 'live' };
    o.source = o.source === 'webhook' || o.source === 'both' ? 'both' : 'page';
    o.paypalOrderId = clean(b.paypalOrderId, 40) || o.paypalOrderId || '';
    o.kind = clean(b.kind, 12) || o.kind || '';
    o.company = clean(b.company, 120); o.name = clean(b.name, 120); o.email = clean(b.email, 160); o.phone = clean(b.phone, 40); o.instagram = clean(b.instagram, 60); o.notes = clean(b.notes, 500);
    o.lines = (b.lines && typeof b.lines === 'object') ? b.lines : (o.lines || {});
    if (b.attendees && typeof b.attendees === 'object') { o.attendees = {}; Object.keys(b.attendees).forEach(k => { if (CATALOG[k]) o.attendees[k] = [].concat(b.attendees[k]).slice(0, 10).map(x => clean(x, 120)); }); }
    o.total = clean(b.total, 20); o.subtotal = clean(b.subtotal, 20); o.tax = clean(b.tax, 20); o.taxRate = clean(b.taxRate, 10); o.agreedAt = clean(b.agreedAt, 40); o.termsVersion = clean(b.termsVersion, 20); o.payerEmail = clean(b.payerEmail, 160); o.payerName = clean(b.payerName, 120); o.payerId = clean(b.payerId, 40);
    if (b.sandbox === true) o.env = 'sandbox';
    d.orders[id] = o;
    // if the webhook already confirmed this capture (it can arrive first), issue now; the email goes out below
    const t = o.confirmed ? issueTickets(d, o) : [];
    return { o: clone(o), t: clone(t) };
  });
  let sheet = null;
  if (r.o.confirmed && !r.o.sheetOk) sheet = await finish(ev, r.o, r.t);
  send(res, 200, { ok: true, confirmed: !!r.o.confirmed, sheet });
}

async function webhook(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  const body = await rawBody(req);
  const v = await verify(req, body);
  if (!v.ok) { console.warn('rejected webhook:', v.why); return send(res, 400, { ok: false, why: v.why }); }
  let ev; try { ev = JSON.parse(body.toString('utf8')); } catch (e) { return send(res, 400, { ok: false }); }
  const r = ev.resource || {};
  if (/^CHECKOUT\.ORDER\.(APPROVED|COMPLETED)$/.test(ev.event_type) && r.id) {
    // the order event carries the payer; keep it so a capture that arrives without the page post still gets a name + email
    const py = r.payer || {}; const pu = (r.purchase_units && r.purchase_units[0]) || {};
    const caps = ((pu.payments && pu.payments.captures) || []).map(c => c.id).filter(Boolean);
    const info = { email: clean(py.email_address, 160), name: clean([py.name && py.name.given_name, py.name && py.name.surname].filter(Boolean).join(' '), 120), payerId: clean(py.payer_id, 40), captures: caps, skus: parseCustom(pu.custom_id), at: new Date().toISOString() };
    if (!info.email && !info.name) return send(res, 200, { ok: true, ignored: ev.event_type, why: 'no payer' });
    const evO = eventOfSkus(info.skus);
    const out = await mutate(evO, d0 => {
      d0.payers = d0.payers || {}; d0.payers[r.id] = info;
      let fixed = 0; const todo = [];
      Object.values(d0.orders).forEach(o => {
        if (o.paypalOrderId !== r.id && caps.indexOf(o.id) < 0) return;
        if (!o.payerEmail) o.payerEmail = info.email; if (!o.payerName) o.payerName = info.name; if (!o.payerId) o.payerId = info.payerId;
        if (!o.name) o.name = info.name; if (!o.email) o.email = info.email; fixed++;
        if (o.confirmed && !o.sheetOk && (o.email || o.payerEmail)) todo.push({ o: clone(o), t: clone(issueTickets(d0, o)) });
      });
      return { fixed, todo };
    });
    const fin = [];
    for (const x of out.todo) { await finish(evO, x.o, x.t); fin.push(x.o.id); }
    return send(res, 200, { ok: true, payer: true, fixed: out.fixed, finished: fin });
  }
  if (ev.event_type !== 'PAYMENT.CAPTURE.COMPLETED' || r.status !== 'COMPLETED') { console.log('ignored webhook', ev.event_type); return send(res, 200, { ok: true, ignored: ev.event_type }); }
  const skus = parseCustom(r.custom_id);
  const evC = eventOfSkus(skus);
  const out = await mutate(evC, d => {
    if (d.events[r.id]) { const o0 = d.orders[r.id]; return (o0 && o0.confirmed && !o0.sheetOk && (o0.email || o0.payerEmail)) ? { dup: true, o: clone(o0), t: clone(issueTickets(d, o0)) } : { dup: true, noWrite: true }; }
    d.events[r.id] = { at: r.create_time || new Date().toISOString(), amount: r.amount && r.amount.value, skus, env: v.env };
    if (v.env === 'live') Object.keys(skus).forEach(k => { d.sold[k] = (d.sold[k] || 0) + skus[k]; });
    const o = d.orders[r.id] || { id: r.id, at: r.create_time || new Date().toISOString(), source: 'webhook', lines: skus };
    if (o.source === 'page') o.source = 'both';
    o.confirmed = true; o.env = v.env; o.amount = r.amount && r.amount.value; o.currency = (r.amount && r.amount.currency_code) || 'USD'; o.capturedAt = r.create_time || o.capturedAt || '';
    const brk = r.seller_receivable_breakdown || {}; o.gross = brk.gross_amount && brk.gross_amount.value; o.fee = brk.paypal_fee && brk.paypal_fee.value; o.net = brk.net_amount && brk.net_amount.value; o.paypalStatus = r.status;
    o.paypalOrderId = (r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.order_id) || o.paypalOrderId || '';
    if (!o.lines || !Object.keys(o.lines).length) o.lines = skus;
    const known = (d.payers || {})[o.paypalOrderId];
    if (known) { if (!o.payerEmail) o.payerEmail = known.email; if (!o.payerName) o.payerName = known.name; if (!o.payerId) o.payerId = known.payerId; if (!o.name) o.name = known.name; if (!o.email) o.email = known.email; }
    d.orders[r.id] = o;
    return { o: clone(o), t: clone(issueTickets(d, o)), sold: clone(d.sold) };
  });
  if (out.dup && !out.o) return send(res, 200, { ok: true, dup: true });
  // email only once the page (or the order event) has told us who bought; otherwise /api/order or the order event finishes it
  let sheet = null;
  if ((out.o.email || out.o.payerEmail) && !out.o.sheetOk) sheet = await finish(evC, out.o, out.t);
  send(res, 200, { ok: true, env: v.env, sold: out.sold, tickets: out.t.length, sheet });
}

async function invoice(req, res) {
  cors(res);
  const inv = INVOICES[clean(new URL(req.url, 'http://x').searchParams.get('i'), 40)];
  if (!inv) return send(res, 404, { ok: false, error: 'No invoice at this link. Email kyle@reservethereserve.com.' });
  const d = await read('hbtt');
  const paid = Object.values(d.orders).find(o => o.confirmed && (o.env || 'live') === 'live' && o.lines && o.lines[inv.sku]);
  send(res, 200, Object.assign({ ok: true, paid: !!paid, paidAt: paid ? (paid.capturedAt || paid.at) : '' }, inv));
}
async function qr(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const u = String(q.get('u') || '');
  const c = u ? u : clean(q.get('c'), 40);
  if (u ? !/^https:\/\/reservethereserve\.com\/blindtastetest\/pay\/\?i=[A-Za-z0-9]{8,24}$/.test(u) : !/^(HBTT|NOBS)-[A-Z0-9]{2,4}-[A-Z0-9]{4}$/.test(c)) { res.statusCode = 400; return res.end('bad code'); }
  const QR = require('qrcode');
  const opts = { margin: 1, errorCorrectionLevel: 'M', color: { dark: '#17120D', light: '#FFFFFF' } };
  res.statusCode = 200; res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (q.get('fmt') === 'png') { const png = await QR.toBuffer(c, Object.assign({ type: 'png', width: 480 }, opts)); res.setHeader('Content-Type', 'image/png'); return res.end(png); }
  const svg = await QR.toString(c, Object.assign({ type: 'svg', width: 320 }, opts));
  res.setHeader('Content-Type', 'image/svg+xml'); res.end(svg);
}
async function ticket(req, res) {
  cors(res);
  const c = clean(new URL(req.url, 'http://x').searchParams.get('c'), 40).toUpperCase();
  const d = await read(c.startsWith('NOBS-') ? 'nobs' : 'hbtt', { cached: true }); const t = d.tickets[c];
  if (!t) return send(res, 404, { ok: false, error: 'No ticket with that code.' });
  send(res, 200, { ok: true, code: t.code, day: t.day, type: t.type, name: t.name, env: t.env });
}
function csvCell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function admin(req, res) { const want = process.env.ADMIN_KEY; const q = new URL(req.url, 'http://x').searchParams; if (!want || q.get('key') !== want) { res.statusCode = 403; res.setHeader('Content-Type', 'text/plain'); res.end('forbidden'); return null; } return q; }
async function ordersCsv(req, res) {
  if (!admin(req, res)) return;
  const d = await read(eventParam(req)); const os = Object.values(d.orders).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const headRow = ['date', 'env', 'kind', 'company', 'contact', 'email', 'phone', 'instagram', 'items', 'total_usd', 'paypal_capture_id', 'paypal_order_id', 'confirmed_by_paypal', 'sheet', 'notes', 'payer_email', 'payer_name', 'payer_id', 'paid_amount', 'currency', 'paypal_fee', 'net', 'captured_at', 'attendees', 'subtotal', 'tax', 'agreed_at', 'terms_version'];
  const lines = os.map(o => [o.at, o.env || 'live', o.kind || (Object.keys(o.lines || {}).some(isTicketSku) ? 'ticket' : 'sponsor'), o.company, o.name, o.email || o.payerEmail, o.phone, o.instagram, Object.keys(o.lines || {}).map(k => k + (o.lines[k] > 1 ? ' x' + o.lines[k] : '')).join('; '), o.total || o.amount, o.id, o.paypalOrderId, o.confirmed ? 'yes' : 'pending', o.sheetOk ? 'sent' : '', o.notes, o.payerEmail, o.payerName, o.payerId, o.amount, o.currency, o.fee, o.net, o.capturedAt, Object.keys(o.attendees || {}).map(k => o.attendees[k].join(', ')).join('; '), o.subtotal, o.tax, o.agreedAt, o.termsVersion].map(csvCell).join(','));
  res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end([headRow.join(',')].concat(lines).join('\n') + '\n');
}
async function ticketsCsv(req, res) {
  if (!admin(req, res)) return;
  const d = await read(eventParam(req)); const ts = Object.values(d.tickets).sort((a, b) => String(a.issuedAt).localeCompare(String(b.issuedAt)));
  const headRow = ['code', 'day', 'type', 'name', 'email', 'phone', 'env', 'paypal_capture_id', 'issued'];
  res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.end([headRow.join(',')].concat(ts.map(t => [t.code, t.day, t.type, t.name, t.email, t.phone, t.env, t.captureId, t.issuedAt].map(csvCell).join(','))).join('\n') + '\n');
}
async function resend(req, res) {
  const q = admin(req, res); if (!q) return;
  const ev = eventParam(req);
  const id = clean(q.get('capture'), 40);
  const r = await mutate(ev, d => { const o = d.orders[id]; if (!o) return { none: true, noWrite: true }; return { o: clone(o), t: clone(issueTickets(d, o)) }; });
  if (r.none) return send(res, 404, { ok: false, why: 'no such capture' });
  const sheet = await finish(ev, r.o, r.t); send(res, 200, { ok: true, sheet, tickets: r.t.map(x => x.code) });
}

// GET /api/complete?key=ADMIN&capture=ID&name=..&email=..[&phone=..]  fill in a buyer the page never told us about, issue named tickets, push to the Sheet (emails them)
async function complete(req, res) {
  const q = admin(req, res); if (!q) return;
  const ev = eventParam(req);
  const id = clean(q.get('capture'), 40);
  const name = clean(q.get('name'), 120), email = clean(q.get('email'), 160), phone = clean(q.get('phone'), 40);
  const r = await mutate(ev, d => {
    const o = d.orders[id]; if (!o) return { why: 'no such capture', code: 404, noWrite: true };
    if (name) o.name = name; if (email) o.email = email; if (phone) o.phone = phone;
    if (!o.kind) o.kind = Object.keys(o.lines || {}).some(isTicketSku) ? 'ticket' : 'sponsor';
    if (!(o.email || o.payerEmail)) return { why: 'no email to send to', code: 400, noWrite: true };
    o.attendees = o.attendees || {}; Object.keys(o.lines || {}).forEach(k => { if (CATALOG[k] && CATALOG[k].kind === 'ticket' && !(o.attendees[k] && o.attendees[k].length)) o.attendees[k] = Array(o.lines[k]).fill(o.name || o.payerName || ''); });
    return { o: clone(o), t: clone(issueTickets(d, o)) };
  });
  if (r.why) return send(res, r.code, { ok: false, why: r.why });
  const sheet = await finish(ev, r.o, r.t);
  send(res, 200, { ok: true, sheet, name: r.o.name, email: r.o.email || r.o.payerEmail, tickets: r.t.map(x => ({ code: x.code, name: x.name, day: x.day })) });
}
// POST /api/enter   licensed dispensary entry form (reservethereserve.com/blindtastetest/enter): stores it, hands it to the Sheet (which emails us + the brand)
async function enter(req, res) {
  cors(res);
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  let b; try { b = JSON.parse((await rawBody(req)).toString('utf8')); } catch (e) { return send(res, 400, { ok: false, why: 'bad body' }); }
  const e = { company: clean(b.company, 120), license: clean(b.license, 60), rep: clean(b.rep, 120), phone: clean(b.phone, 40), email: clean(b.email, 160), instagram: clean(b.instagram, 60), strain: clean(b.strain, 120), method: clean(b.method, 20), notes: clean(b.notes, 1000), agreed: b.agreed === true, env: b.test === true ? 'test' : 'live', at: new Date().toISOString() };
  if (!e.company || !e.license || !e.rep || !e.phone || !/.+@.+\..+/.test(e.email) || !e.strain || !/^Live r(e|o)sin$/.test(e.method) || !e.agreed) return send(res, 400, { ok: false, why: 'missing fields' });
  e.id = 'E' + Date.now().toString(36).toUpperCase() + crypto.randomInt(1000).toString().padStart(3, '0');
  await mutate('hbtt', d => { d.entries = d.entries || {}; d.entries[e.id] = e; });
  let sheet = { ok: false, why: 'SHEET_URL/SHEET_KEY not set' };
  const url = process.env.SHEET_URL, key = process.env.SHEET_KEY;
  if (url && key) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'entry', key, entry: e, store: 'hbtt' }), redirect: 'follow' }); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (x) { j = { raw: t.slice(0, 120) }; } sheet = { ok: r.ok && j.ok !== false, resp: j }; }
    catch (x) { sheet = { ok: false, why: String(x.message || x) }; }
  }
  if (sheet.ok && !(sheet.resp && sheet.resp.storeMarked)) await mutate('hbtt', d => { const x = d.entries && d.entries[e.id]; if (!x) return { noWrite: true }; x.sheetOk = true; x.sheetAt = new Date().toISOString(); });
  send(res, 200, { ok: true, id: e.id, sheet: sheet.ok });
}
async function entriesCsv(req, res) {
  if (!admin(req, res)) return;
  const d = await read(); const es = Object.values(d.entries || {}).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const headRow = ['submitted', 'env', 'company', 'license', 'representative', 'phone', 'email', 'instagram', 'strain', 'method', 'notes', 'sheet', 'id'];
  res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.end([headRow.join(',')].concat(es.map(e => [e.at, e.env, e.company, e.license, e.rep, e.phone, e.email, e.instagram, e.strain, e.method, e.notes, e.sheetOk ? 'sent' : '', e.id].map(csvCell).join(','))).join('\n') + '\n');
}
// GET /api/dash?key=ADMIN   everything the ops dashboard needs in one call
async function dash(req, res) {
  if (!admin(req, res)) return;
  const ev = eventParam(req);
  const d = await read(ev);
  const orders = Object.values(d.orders).map(o => ({ id: o.id, at: o.at, capturedAt: o.capturedAt || '', env: o.env || 'live', kind: o.kind || (Object.keys(o.lines || {}).some(isTicketSku) ? 'ticket' : 'sponsor'), source: o.source || '', confirmed: !!o.confirmed, company: o.company || '', name: o.name || o.payerName || '', email: o.email || o.payerEmail || '', phone: o.phone || '', instagram: o.instagram || '', lines: o.lines || {}, total: o.total || o.amount || '', subtotal: o.subtotal || '', tax: o.tax || '', gross: o.gross || '', fee: o.fee || '', net: o.net || '', paypalOrderId: o.paypalOrderId || '', sheetOk: !!o.sheetOk, sheetAt: o.sheetAt || '', notes: o.notes || '' }));
  const tickets = Object.values(d.tickets).map(t => ({ code: t.code, sku: t.sku, day: t.day, type: t.type, name: t.name, email: t.email, env: t.env, captureId: t.captureId, issuedAt: t.issuedAt }));
  const entries = Object.values(d.entries || {}).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  send(res, 200, { ok: true, updated: d.updated || null, sold: d.sold, catalog: catalogFor(ev, true), invoices: Object.values(INVOICES), pools: ev === 'hbtt' ? POOLS : {}, orders, tickets, entries });
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
    if (path === '/api/invoice') return await invoice(req, res);
    if (path === '/api/ticket') return await ticket(req, res);
    if (path === '/api/orders.csv') return await ordersCsv(req, res);
    if (path === '/api/tickets.csv') return await ticketsCsv(req, res);
    if (path === '/api/resend') return await resend(req, res);
    if (path === '/api/complete') return await complete(req, res);
    if (path === '/api/enter') return await enter(req, res);
    if (path === '/api/entries.csv') return await entriesCsv(req, res);
    if (path === '/api/dash') return await dash(req, res);
  } catch (e) { console.error(e); if (!res.headersSent) return send(res, e.store ? 503 : 500, { ok: false, why: String(e.message || e) }); }
  res.statusCode = 200; res.setHeader('Content-Type', 'text/plain');
  res.end('hitman-btt backend: /api/sold /api/catalog /api/order /api/paypal-webhook /api/qr /api/ticket /api/orders.csv /api/tickets.csv /api/resend /api/complete /api/dash');
};
