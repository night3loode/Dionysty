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
// photos can only go to someone you're bonded or talking with
db.exec("CREATE TABLE bonds (a TEXT, b TEXT, status TEXT, at INTEGER, PRIMARY KEY (a, b))");
db.exec("CREATE TABLE blocks (a TEXT, b TEXT, at INTEGER, PRIMARY KEY (a, b))");
db.exec("CREATE TABLE talks (a TEXT, b TEXT, at INTEGER, PRIMARY KEY (a, b))");
db.exec("INSERT INTO people (uid, pid, alias, member, room) VALUES ('333','p3','Cat',1,'Village 1')");
db.exec("INSERT INTO bonds (a, b, status, at) VALUES ('111','222','bonded',0)");

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
  const res = await (await import('/tmp/worker-media-test.mjs')).default.fetch(new Request('https://w/api/sq/v2/' + p, { method: 'POST', body: JSON.stringify({ ...body, login: login(id) }) }), env, {});
  return res.json();
};
const w = (await import('/tmp/worker-media-test.mjs')).default;
const results = []; const t = (n, ok) => results.push([ok ? 'PASS' : 'FAIL', n]);

// put + get round-trip via bridge
const put = await call('media/put', { pid: 'p2', blob: 'aGVsbG8tY2lwaGVy', once: 0 }, '111');
t('put ok', put.ok === true && put.id);
const row = db.prepare('SELECT blob, ext FROM media WHERE id = ?1').get(put.id);
t('blob external, d1 empty', row.ext === 1 && row.blob === '');
const get = await call('media/get', { id: put.id }, '222');
t('get roundtrip', get.ok === true && get.blob === 'aGVsbG8tY2lwaGVy' && get.once === false);

// only plain base64 (optionally a data:image/video URL) is accepted, and only to a bond or talk
const evil = await call('media/put', { pid: 'p2', blob: 'x" onerror="alert(1)', once: 0 }, '111');
t('script-like blob refused', evil.ok === false);
const dataUrl = await call('media/put', { pid: 'p2', blob: 'data:image/jpeg;base64,/9j/4AAQ', once: 0 }, '111');
t('data:image URL accepted', dataUrl.ok === true);
const stranger = await call('media/put', { pid: 'p3', blob: 'aGVsbG8=', once: 0 }, '111');
t('no bond or talk refused', stranger.ok === false);

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
db.prepare("INSERT INTO dms (a, b, uid, body, at) VALUES ('111','222','111',?1,?2)").run('mx:' + put.id, old);
db.prepare("UPDATE media SET at = ?1 WHERE id = ?2").run(old, put.id);
// the sweep only deletes once now - 24h >= RETENTION_START (1795619418620 = 25 Nov 2026 15:10 UTC),
// so run it with the clock moved past the grace period, or the test depends on the day it runs
const realNow = Date.now; Date.now = () => 1795619418620 + 2 * 86400000 + 3600000;
try { await w.scheduled({}, env, {}); } finally { Date.now = realNow; }
t('sweep bridge del', bridgeCalls.filter((c) => c.op === 'del' && c.id === 'm_' + put.id).length >= 1);
t('sweep dms row deleted', db.prepare('SELECT COUNT(*) n FROM dms WHERE id NOT IN (SELECT id FROM dm_save)').get().n === 0);

// bridge error (not notfound) -> 502 not gone
bridgeStore.set('m_errcase', 'x');
db.prepare("INSERT INTO media (id, a, b, uid, blob, once, at, ext) VALUES ('errcase','111','222','111','',0,?1,1)").run(Date.now());
bridgeCalls.push = new Proxy(bridgeCalls.push, {});
const origGet = bridgeStore.get.bind(bridgeStore);
bridgeStore.get = (k) => { throw new Error('boom'); };
const errRes = await call('media/get', { id: 'errcase' }, '222');
bridgeStore.get = origGet;
console.log('ERRRES', JSON.stringify(errRes)); t('bridge error -> 502 not gone', errRes.ok === false && !errRes.gone);


// --- durable purge queue: failed bridge deletes must persist until confirmed ---

// 1) burn-once with bridge del failing: content never re-served, blob id queued
const put4 = await call('media/put', { pid: 'p2', blob: 'cHVyZ2Utb25jZQ==', once: 1 }, '111');
const origDel = bridgeStore.delete.bind(bridgeStore);
bridgeStore.delete = () => { throw new Error('del boom'); };
const burn4 = await call('media/get', { id: put4.id }, '222');
t('burn served despite del failure', burn4.ok === true && burn4.blob === 'cHVyZ2Utb25jZQ==');
const gone4 = await call('media/get', { id: put4.id }, '222');
t('burned not re-exposed while retry pending', gone4.gone === true && !gone4.blob);
const pq1 = db.prepare('SELECT id, tries FROM mpurge WHERE id = ?1').get(put4.id);
t('failed del queued in mpurge', !!pq1 && pq1.tries === 0);
bridgeCalls.length = 0;
await w.scheduled({}, env, {}); // retry while bridge still broken
const pq2 = db.prepare('SELECT tries FROM mpurge WHERE id = ?1').get(put4.id);
t('retry keeps id, tries incremented', !!pq2 && pq2.tries === 1);
bridgeStore.delete = origDel; // bridge recovers
await w.scheduled({}, env, {});
t('retry physically deletes blob', bridgeCalls.some((c) => c.op === 'del' && c.id === 'm_' + put4.id) && !bridgeStore.has('m_' + put4.id));
t('mpurge row cleared after confirm', !db.prepare('SELECT id FROM mpurge WHERE id = ?1').get(put4.id));

// 2) dm/del with bridge del failing: media row gone from D1, blob id queued
const put5 = await call('media/put', { pid: 'p2', blob: 'ZG1kZWwtcGF5bG9hZA==', once: 0 }, '111');
db.prepare("INSERT INTO dms (a, b, uid, body, at) VALUES ('111','222','111',?1,?2)").run('mx:' + put5.id, Date.now());
const dmsRow = db.prepare("SELECT id FROM dms WHERE body = ?1").get('mx:' + put5.id);
bridgeStore.delete = () => { throw new Error('del boom'); };
const delRes = await call('dm/del', { id: dmsRow.id }, '111');
t('dm/del ok despite bridge failure', delRes.ok === true);
t('dm/del removed media row', !db.prepare('SELECT id FROM media WHERE id = ?1').get(put5.id));
t('dm/del queued purge', !!db.prepare('SELECT id FROM mpurge WHERE id = ?1').get(put5.id));
bridgeStore.delete = origDel;
await w.scheduled({}, env, {});
t('dm/del purge completed on retry', !bridgeStore.has('m_' + put5.id) && !db.prepare('SELECT id FROM mpurge WHERE id = ?1').get(put5.id));

// 3) sweep with bridge del failing: rows deleted, blob id queued, retried to confirm
// the 24h DM rule only runs once now - 24h is past RETENTION_START, so pin the clock after the grace period (otherwise this test depends on the day it runs)
const realNow6 = Date.now; Date.now = () => 1795619418620 + 2 * 86400000 + 3600000;
const put6 = await call('media/put', { pid: 'p2', blob: 'c3dlZXAtcGF5bG9hZA==', once: 0 }, '111');
db.prepare("INSERT INTO dms (a, b, uid, body, at) VALUES ('111','222','111',?1,?2)").run('mx:' + put6.id, Date.now());
const old6 = Date.now() - 2 * 86400000;
db.prepare("UPDATE dms SET at = ?1 WHERE body = ?2").run(old6, 'mx:' + put6.id);
db.prepare("UPDATE media SET at = ?1 WHERE id = ?2").run(old6, put6.id);
bridgeStore.delete = () => { throw new Error('del boom'); };
await w.scheduled({}, env, {});
t('sweep removed media row despite bridge failure', !db.prepare('SELECT id FROM media WHERE id = ?1').get(put6.id));
t('sweep queued purge', !!db.prepare('SELECT id FROM mpurge WHERE id = ?1').get(put6.id));
bridgeStore.delete = origDel;
await w.scheduled({}, env, {});
t('sweep purge completed on retry', !bridgeStore.has('m_' + put6.id) && !db.prepare('SELECT id FROM mpurge WHERE id = ?1').get(put6.id));
Date.now = realNow6;

// 4) notfound counts as physically gone: no mpurge row
const put7 = await call('media/put', { pid: 'p2', blob: 'Z29uZS1hbHJlYWR5', once: 1 }, '111');
bridgeStore.delete('m_' + put7.id); // someone already deleted it
const burn7 = await call('media/get', { id: put7.id }, '222');
t('burn after external delete ok', burn7.ok === true);
t('notfound not queued', !db.prepare('SELECT id FROM mpurge WHERE id = ?1').get(put7.id));


// 5) purge sweep bounded per run: only 50 oldest processed per cron cycle
for (let i = 0; i < 60; i++) db.prepare("INSERT INTO mpurge (id, at, tries) VALUES (?1, ?2, 0)").run('bulk' + i, Date.now() - 100000 + i);
await w.scheduled({}, env, {});
const remaining = db.prepare("SELECT COUNT(*) n FROM mpurge WHERE id LIKE 'bulk%'").get().n;
t('purge sweep bounded to 50 per run', remaining === 10);

const fails = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0], r[1]);
console.log(fails.length ? `FAILURES: ${fails.length}` : 'ALL PASS');
