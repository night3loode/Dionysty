import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync(':memory:');
const shim = {
  prepare(q) { const stmt = db.prepare(q); const ops = (args) => ({
      run: () => stmt.run(...args),
      first: () => stmt.get(...args),
      all: () => ({ results: stmt.all(...args) }),
    });
    const w = { bind: (...args) => ops(args) }; Object.assign(w, ops([])); return w;
  },
  async batch(stmts) { for (const s of stmts) s.run(); },
};
db.exec("CREATE TABLE people (uid TEXT PRIMARY KEY, pid TEXT, room TEXT, alias TEXT, done INTEGER, member INTEGER, points TEXT, temples TEXT, stage TEXT, since TEXT, need INTEGER, flag INTEGER, at INTEGER)");
db.exec("CREATE TABLE msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, uid TEXT, body TEXT, at INTEGER, hidden INTEGER DEFAULT 0)");
db.exec("CREATE TABLE sl_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, who TEXT, label TEXT, body TEXT)");
db.exec("CREATE TABLE dms (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT, uid TEXT, body TEXT, at INTEGER, seen INTEGER DEFAULT 0)");
db.exec("INSERT INTO people (uid, pid, alias, member, room) VALUES ('111','p1','Alice',1,'Village 1'),('222','p2','Bob',1,'Village 1')");

const bridgeCalls = [];
const bridgeStore = new Map();
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('bridge.test')) {
    const b = JSON.parse(opts.body); bridgeCalls.push(b);
    if (b.key !== 'k') return Response.json({ ok: false, error: 'denied' });
    if (b.op === 'put') { bridgeStore.set(b.id, b.b64); return Response.json({ ok: true, id: 'drv1' }); }
    if (b.op === 'get') { const v = bridgeStore.get(b.id); return Response.json(v === undefined ? { ok: false, error: 'notfound' } : { ok: true, b64: v }); }
    if (b.op === 'del') { const n = bridgeStore.delete(b.id) ? 1 : 0; return Response.json({ ok: true, deleted: n }); }
    return Response.json({ ok: false, error: 'op' });
  }
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const env = { BOT_TOKEN: 'testtok', D1: shim, DB: new MapShim(), TEAM_CHAT_ID: '', MEDIA_BRIDGE_URL: 'https://bridge.test/exec', MEDIA_KEY: 'k' };
function MapShim() { const m = new Map(); this.get = async (k) => m.get(k) ?? null; this.put = async (k, v) => m.set(k, v); this.delete = async (k) => m.delete(k); this.list = async () => ({ keys: [], list_complete: true }); }
const login = (id) => { const o = { id, first_name: 'A', auth_date: Math.floor(Date.now() / 1000) };
  const dcs = Object.keys(o).sort().map((k) => k + '=' + o[k]).join('\n');
  o.hash = crypto.createHmac('sha256', crypto.createHash('sha256').update(env.BOT_TOKEN).digest()).update(dcs).digest('hex'); return o; };
const call = async (p, body, id) => {
  const res = await (await import('/tmp/worker-media.mjs')).default.fetch(new Request('https://w/api/sq/v2/' + p, { method: 'POST', body: JSON.stringify({ ...body, login: login(id) }) }), env, {});
  return res.json();
};
const w = (await import('/tmp/worker-media.mjs')).default;
const results = []; const t = (n, ok) => results.push([ok ? 'PASS' : 'FAIL', n]);

// put + get round-trip via bridge
const put = await call('media/put', { pid: 'p2', blob: 'aGVsbG8tY2lwaGVy', once: 0 }, '111');
t('put ok', put.ok === true && put.id);
const row = db.prepare('SELECT blob, ext FROM media WHERE id = ?1').get(put.id);
t('blob external, d1 empty', row.ext === 1 && row.blob === '');
const get = await call('media/get', { id: put.id }, '222');
t('get roundtrip', get.ok === true && get.blob === 'aGVsbG8tY2lwaGVy' && get.once === false);

// once: sender sealed, receiver burns + bridge del
const put2 = await call('media/put', { pid: 'p2', blob: 'b25jZS1ibG9i', once: 1 }, '111');
const sealed = await call('media/get', { id: put2.id }, '111');
t('sender sealed', sealed.sealed === true);
const burn = await call('media/get', { id: put2.id }, '222');
t('once get ok', burn.ok === true && burn.blob === 'b25jZS1ibG9i');
t('bridge del on burn', bridgeCalls.some((c) => c.op === 'del' && c.id === 'm_' + put2.id));
const gone = await call('media/get', { id: put2.id }, '222');
t('second read gone', gone.gone === true);

// other member cannot read
const denied = await call('media/get', { id: put.id }, '111');
t('sender can read own non-once', denied.ok === true);

// bridge down -> fallback to D1 blob
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('bridge down'); };
const put3 = await call('media/put', { pid: 'p2', blob: 'ZmFsbGJhY2s=', once: 0 }, '111');
globalThis.fetch = savedFetch;
const row3 = db.prepare('SELECT blob, ext FROM media WHERE id = ?1').get(put3.id);
t('fallback stores in d1', row3.ext === 0 && row3.blob === 'ZmFsbGJhY2s=');
const get3 = await call('media/get', { id: put3.id }, '222');
t('fallback get ok', get3.blob === 'ZmFsbGJhY2s=');

// sweep: old unsaved dm with ext media -> bridge del + row delete
const old = Date.now() - 2 * 86400000;
db.prepare("INSERT INTO dms (a, b, uid, body, at) VALUES ('111','222','111',?1,?2)").run('img' + put.id, old);
db.prepare("UPDATE media SET at = ?1 WHERE id = ?2").run(old, put.id);
// ensure cutoff >= RETENTION_START: RETENTION_START constant in worker is 1795619418620 (Nov 24 2026)
await w.scheduled({}, env, {});
t('sweep bridge del', bridgeCalls.filter((c) => c.op === 'del' && c.id === 'm_' + put.id).length >= 1);
t('sweep dms row deleted', db.prepare('SELECT COUNT(*) n FROM dms WHERE id NOT IN (SELECT id FROM dm_save)').get().n === 0);

const fails = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0], r[1]);
console.log(fails.length ? `FAILURES: ${fails.length}` : 'ALL PASS');
