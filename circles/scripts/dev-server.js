// Local test server: the real circles module on Node's SQLite, plus a page that loads app/circles.js.
// Run: node --no-warnings scripts/dev-server.js   then open http://localhost:8787/?as=a
// Fast clocks for manual testing: FAST=1 shrinks the 2 minute timers to 20 seconds.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeD1 } from '../tests/d1-shim.js';
import { handleCircles, circlesCron } from '../worker/circles/circles.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const db = makeD1(':memory:', [here('../migrations/0001_circles.sql')]);
const PEOPLE = { a: 'Asha', b: 'Bilal', c: 'Chandni', d: 'Dev', e: 'Esha', f: 'Farid', g: 'Gauri' };
const TEMPLE = { a: 'artists', b: 'thinkers', c: 'lovers', d: 'wanderers', e: 'revellers', f: 'healers', g: 'builders' };
const env = { CIRCLES_ON: '1', ...(process.env.FAST ? { FOUNDER_IDLE_MS: '20000', PRESENCE_GRACE_MS: '20000' } : {}) };
const lookup = async (pids) => Object.fromEntries(pids.map((p) => [p, { alias: PEOPLE[p] || p, temple: TEMPLE[p] }]));
const people = async () => Object.keys(PEOPLE).map((pid) => ({ pid, alias: PEOPLE[pid], temple: TEMPLE[pid] }));
setInterval(() => circlesCron({ db, env }), 15000);

const port = +process.env.PORT || 8787;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/sq/c/') && req.method === 'POST') {
    let raw = ''; for await (const ch of req) raw += ch;
    const body = JSON.parse(raw || '{}');
    const pid = body.login && body.login.id; // stand-in for the Worker's real auth
    const out = await handleCircles(url.pathname.slice('/api/sq/c/'.length), body, { db, env, pid, lookup, people });
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out));
  }
  // Stand-in for the live Worker's sq/v2/me, used when testing the staging Worker locally.
  if (url.pathname === '/api/sq/v2/me' && req.method === 'POST') {
    let raw = ''; for await (const ch of req) raw += ch;
    const b = JSON.parse(raw || '{}'); const id = b.login && b.login.id;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(PEOPLE[id] ? { ok: true, pid: id, alias: PEOPLE[id], temple: TEMPLE[id] } : { ok: false, error: 'Sign in' }));
  }
  if (url.pathname === '/circles.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(here('../app/circles.js'))); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Circles dev</title><style>body{margin:0;background:#0b0604;color:#f2e7d5;font-family:system-ui;min-height:100vh}
#tabbar{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);padding:14px 30px;border:1px solid #6b5034;border-radius:999px;color:#cdb490;font-size:12px}
.who{position:fixed;top:10px;left:10px;font-size:12px;color:#cdb490}</style></head><body>
<div class="who">Signed in as <b id="who"></b></div><div id="tabbar">the app's tab bar</div>
<script>var as=new URLSearchParams(location.search).get('as')||'a';var N=${JSON.stringify(PEOPLE)};
localStorage.setItem('dy_login',JSON.stringify({id:as}));document.getElementById('who').textContent=N[as]||as;
window.DY_CIRCLES={api:${JSON.stringify(process.env.CIRCLES_API || '')}||location.origin+'/api/'};</script><script src="/circles.js"></script></body></html>`);
}).listen(port, () => console.log('Circles dev server on http://localhost:' + port + '/?as=a  (people: a to g)'));
