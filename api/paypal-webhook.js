// POST /api/paypal-webhook  <- PayPal webhook (PAYMENT.CAPTURE.COMPLETED). Verifies PayPal's signature with
// PayPal's public cert (no client secret needed), then records the SKUs from custom_id ("SKU:qty,SKU:qty").
const crypto = require('crypto');
const { read, write } = require('./_store');
module.exports.config = { api: { bodyParser: false } };

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
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const body = await rawBody(req);
  const v = await verify(req, body);
  if (!v.ok) { console.warn('rejected webhook:', v.why); return res.status(400).json({ ok: false, why: v.why }); }
  let ev; try { ev = JSON.parse(body.toString('utf8')); } catch (e) { return res.status(400).json({ ok: false }); }
  const r = ev.resource || {};
  if (ev.event_type !== 'PAYMENT.CAPTURE.COMPLETED' || r.status !== 'COMPLETED') return res.status(200).json({ ok: true, ignored: ev.event_type });
  const skus = parseCustom(r.custom_id);
  const d = await read();
  if (d.events[r.id]) return res.status(200).json({ ok: true, dup: true });
  d.events[r.id] = { at: r.create_time || new Date().toISOString(), amount: r.amount && r.amount.value, skus };
  Object.keys(skus).forEach(k => { d.sold[k] = (d.sold[k] || 0) + skus[k]; });
  await write(d);
  res.status(200).json({ ok: true, sold: d.sold });
};
