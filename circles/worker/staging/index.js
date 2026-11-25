// Dionysty circles: STAGING Worker for the lab.
// A separate Worker with its own D1 database, so the lab can test circles without
// changing the live bot Worker or the live database.
//
// Who you are: it forwards your sign-in (Telegram initData or the dy_login object) to the
// live Worker's existing read-only endpoint sq/v2/me and uses the pid and alias it returns.
// It never writes to the live backend.
import { handleCircles, circlesCron } from '../circles/circles.js';

const CACHE = new Map(); // sign-in -> { pid, alias, temple, at } for 10 minutes per isolate
const TTL = 10 * 60 * 1000;

function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = !allowed.length || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (o, h) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json', ...h } });

async function key(body) {
  const raw = body.initData || JSON.stringify(body.login || null);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function whoAmI(env, body) {
  if (!body.initData && !body.login) return null;
  const k = await key(body);
  const hit = CACHE.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const r = await fetch(env.MAIN_API + 'sq/v2/me', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body.initData ? { initData: body.initData } : { login: body.login }),
  });
  const me = await r.json().catch(() => null);
  if (!me || !me.ok || !me.pid) return null;
  const v = { pid: String(me.pid), alias: me.alias || 'someone', temple: me.temple || '', at: Date.now() };
  CACHE.set(k, v);
  return v;
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/sq/c/')) return json({ ok: false, error: 'Not here.' }, h);
    let body = {};
    try { body = await req.json(); } catch (e) {}
    const me = await whoAmI(env, body);
    if (!me) return json({ ok: false, error: 'Please sign in again.' }, h);
    const db = env.DB;
    // Remember aliases of people who use circles, so others can see and invite them.
    await db.prepare('INSERT INTO c_people (pid, alias, temple, seen_at) VALUES (?,?,?,?) ON CONFLICT(pid) DO UPDATE SET alias=excluded.alias, temple=excluded.temple, seen_at=excluded.seen_at')
      .bind(me.pid, me.alias, me.temple, Date.now()).run();
    const lookup = async (pids) => {
      if (!pids.length) return {};
      const rows = (await db.prepare(`SELECT pid, alias, temple FROM c_people WHERE pid IN (${pids.map(() => '?').join(',')})`).bind(...pids).all()).results || [];
      return Object.fromEntries(rows.map((r) => [r.pid, { alias: r.alias, temple: r.temple }]));
    };
    const people = async () => ((await db.prepare('SELECT pid, alias, temple FROM c_people WHERE seen_at > ? ORDER BY alias').bind(Date.now() - 30 * 86400000).all()).results || []);
    const out = await handleCircles(url.pathname.slice('/api/sq/c/'.length), body, { db, env, pid: me.pid, lookup, people });
    return json(out, h);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(circlesCron({ db: env.DB, env }));
  },
};
