/* Vercel serverless function: the Tabi tutor. Keeps your Anthropic key on the server.
   Environment variables (Vercel > Settings > Environment Variables):
     ANTHROPIC_API_KEY   required
     TUTOR_MODEL         optional, default claude-sonnet-5-5
     FIREBASE_API_KEY    optional, the same apiKey as firebase-config.js; lets signed-in users have a higher hourly limit */
const buckets = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr);
  if (buckets.size > 5000) for (const k of buckets.keys()) { buckets.delete(k); if (buckets.size < 2500) break; }
  return true;
}
async function uidFromToken(authHeader) {
  const key = process.env.FIREBASE_API_KEY;
  const m = /^Bearer (.+)$/.exec(authHeader || '');
  if (!key || !m) return null;
  try {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: m[1] })
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.users && d.users[0] && d.users[0].localId || null;
  } catch (e) { return null; }
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ code: 'error' });
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ code: 'error' }); } catch (e) { return res.status(403).json({ code: 'error' }); } }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ code: 'not_configured' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const msgs = body && body.messages;
  if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > 16) return res.status(400).json({ code: 'error' });
  let total = 0;
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return res.status(400).json({ code: 'error' });
    total += m.content.length;
  }
  if (total > 60000 || msgs[0].role !== 'user') return res.status(400).json({ code: 'error' });

  const uid = await uidFromToken(req.headers.authorization);
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (uid) { if (!allow('u:' + uid, 80, 3600e3)) return res.status(429).json({ code: 'rate_limited' }); }
  else if (!allow('ip:' + ip, 25, 3600e3)) return res.status(429).json({ code: 'guest_limit' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.TUTOR_MODEL || 'claude-sonnet-5-5', max_tokens: 600, messages: msgs })
    });
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ code: r.status === 429 ? 'rate_limited' : 'error' });
    const d = await r.json();
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) return res.status(502).json({ code: 'empty_completion' });
    return res.status(200).json({ text });
  } catch (e) { return res.status(502).json({ code: 'error' }); }
};
