// A small stand-in for Cloudflare D1 on top of Node's built-in SQLite (node:sqlite, Node 22.13+).
// Used by the tests and the local test server. Production uses the real D1 binding.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeD1(file = ':memory:', migrations = []) {
  const db = new DatabaseSync(file);
  for (const m of migrations) db.exec(readFileSync(m, 'utf8'));
  const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async (col) => { const r = db.prepare(sql).get(...norm(args)); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => ({ results: db.prepare(sql).all(...norm(args)).map((r) => ({ ...r })) }),
    run: async () => { const r = db.prepare(sql).run(...norm(args)); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), exec: async (sql) => db.exec(sql), _raw: db };
}
