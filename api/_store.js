// Sold-slot store for the Hitman BTT sponsor page. Lives in Vercel Blob as sold.json.
const { put, head } = require('@vercel/blob');
const KEY = 'sold.json';
async function read() {
  try {
    const h = await head(KEY);
    const r = await fetch(h.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return { sold: {}, events: {} };
    const j = await r.json();
    return { sold: j.sold || {}, events: j.events || {}, updated: j.updated };
  } catch (e) { return { sold: {}, events: {} }; }
}
async function write(data) {
  data.updated = new Date().toISOString();
  await put(KEY, JSON.stringify(data), { access: 'public', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 0 });
  return data;
}
module.exports = { read, write };
