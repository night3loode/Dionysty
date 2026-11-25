// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1-shim.js';
import { handleCircles, circlesCron, istDay } from '../worker/circles/circles.js';

const MIG = fileURLToPath(new URL('../migrations/0001_circles.sql', import.meta.url));
const MIN = 60000, DAY = 86400000;
const NAMES = { a: 'Asha', b: 'Bilal', c: 'Chandni', d: 'Dev', e: 'Esha', f: 'Farid', g: 'Gauri' };

function world(env = {}) {
  const db = makeD1(':memory:', [MIG]);
  let t = Date.UTC(2026, 10, 26, 6, 0, 0);
  const E = { CIRCLES_ON: '1', ...env };
  const lookup = async (pids) => Object.fromEntries(pids.map((p) => [p, { alias: NAMES[p] || p }]));
  const people = async () => Object.keys(NAMES).map((pid) => ({ pid, alias: NAMES[pid] }));
  const as = (pid) => (action, body = {}) => handleCircles(action, body, { db, env: E, pid, lookup, people, now: () => t });
  return { db, as, tick: (ms) => (t += ms), now: () => t, env: E, cron: () => circlesCron({ db, env: E, now: t }) };
}
const count = async (db, table, where = '1=1') => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first()).n;

test('feature flag off: nothing happens', async () => {
  const w = world({ CIRCLES_ON: '0' });
  const r = await w.as('a')('sky');
  assert.equal(r.ok, false);
});

// ---------- Phase 1 ----------
test('open circle: a second member joins with no knock', async () => {
  const w = world(); const A = w.as('a'), B = w.as('b');
  const { cid } = await A('new', { topic: 'Late films', mode: 'open' });
  const r = await B('join', { id: cid });
  assert.equal(r.ok, true);
  const s = await A('state');
  assert.equal(s.members.length, 2);
});

test('knock circle: knock, founder answers, knocker joins', async () => {
  const w = world(); const A = w.as('a'), B = w.as('b');
  const { cid } = await A('new', { topic: 'Poetry', mode: 'knock' });
  const j = await B('join', { id: cid });
  assert.equal(j.ok, false); assert.equal(j.knock, true);
  const k = await B('knock', { id: cid });
  assert.equal(k.ok, true);
  const s = await A('state');
  assert.equal(s.knocks.length, 1); assert.equal(s.knocks[0].alias, 'Bilal');
  assert.equal((await A('answer', { kid: s.knocks[0].kid, yes: true })).ok, true);
  const bs = await B('state');
  assert.equal(bs.invites[0].how, 'let-in');
  assert.equal((await B('join', { id: cid })).ok, true);
  assert.equal((await A('state')).members.length, 2);
});

test('invite circle: no knocking, direct knock refused, founder invite works', async () => {
  const w = world(); const A = w.as('a'), B = w.as('b');
  const { cid } = await A('new', { topic: 'Secret supper', mode: 'invite' });
  const k = await B('knock', { id: cid });
  assert.equal(k.ok, false); assert.equal(k.invite, true);
  assert.equal((await B('join', { id: cid })).ok, false);
  assert.equal((await A('invite', { pid: 'b' })).sent, 'invite');
  const inbox = await B('state');
  assert.equal(inbox.invites[0].from, 'Asha');
  assert.equal((await B('join', { id: cid })).ok, true);
});

test('non-founder invite in knock and invite circles becomes a sponsored knock', async () => {
  for (const mode of ['knock', 'invite']) {
    const w = world(); const A = w.as('a'), B = w.as('b'), C = w.as('c');
    const { cid } = await A('new', { topic: 'x', mode });
    await A('invite', { pid: 'b' }); await B('join', { id: cid });
    const r = await B('invite', { pid: 'c' });
    assert.equal(r.sent, 'knock');
    assert.equal((await C('join', { id: cid })).ok, false, 'nothing happens until answered');
    const s = await A('state');
    assert.equal(s.knocks[0].alias, 'Chandni'); assert.equal(s.knocks[0].sponsor, 'Bilal');
    assert.equal((await B('answer', { kid: s.knocks[0].kid, yes: true })).ok, false, 'founder is active, only founder answers');
    await A('answer', { kid: s.knocks[0].kid, yes: true });
    assert.equal((await C('join', { id: cid })).ok, true);
  }
});

test('in open circles anyone inside invites directly', async () => {
  const w = world(); const A = w.as('a'), B = w.as('b'), C = w.as('c');
  const { cid } = await A('new', { topic: 'x', mode: 'open' });
  await B('join', { id: cid });
  assert.equal((await B('invite', { pid: 'c' })).sent, 'invite');
  assert.equal((await C('state')).invites[0].from, 'Bilal');
});

test('founder idle 2 minutes: others answer; founder back: only founder', async () => {
  const w = world(); const A = w.as('a'), B = w.as('b'), C = w.as('c');
  const { cid } = await A('new', { topic: 'x', mode: 'knock' });
  await A('invite', { pid: 'b' }); await B('join', { id: cid });
  await C('knock', { id: cid });
  let s = await B('state');
  assert.equal(s.circle.canAnswer, false);
  assert.equal(s.knocks.length, 0);
  w.tick(30000); await B('state'); w.tick(30000); await B('state'); w.tick(30000); await B('state'); w.tick(35000);
  s = await B('state');
  assert.equal(s.circle.founderIdle, true); assert.equal(s.circle.canAnswer, true);
  // Founder comes back before answering (still within presence grace? A was last seen 125 s ago, grace is 120 s, so A has left).
  // Founder role does not transfer either way:
  assert.equal(s.circle.iAmFounder, false);
  const k = s.knocks[0];
  assert.equal((await B('answer', { kid: k.kid, yes: true })).ok, true);
});

test('founder active again takes answering back', async () => {
  const w = world({ PRESENCE_GRACE_MS: String(10 * MIN) });
  const A = w.as('a'), B = w.as('b'), C = w.as('c');
  const { cid } = await A('new', { topic: 'x', mode: 'knock' });
  await A('invite', { pid: 'b' }); await B('join', { id: cid });
  w.tick(3 * MIN); await B('state');
  assert.equal((await B('state')).circle.canAnswer, true);
  await A('state'); // founder active
  await C('knock', { id: cid });
  const s = await B('state');
  assert.equal(s.circle.canAnswer, false);
  assert.equal((await A('state')).circle.iAmFounder, true);
});

test('founder changes mode mid-circle; others cannot', async () => {
  const w = world(); const A = w.as('a'), B = w.as('b'), C = w.as('c');
  const { cid } = await A('new', { topic: 'x', mode: 'open' });
  await B('join', { id: cid });
  assert.equal((await B('mode', { mode: 'invite' })).ok, false);
  assert.equal((await A('mode', { mode: 'invite' })).ok, true);
  assert.equal((await C('join', { id: cid })).ok, false);
  const sky = await C('sky');
  assert.equal(sky.circles[0].mode, 'invite');
});

test('invite circle reveals only name and theme to outsiders', async () => {
  const w = world(); const A = w.as('a'), C = w.as('c');
  await A('new', { topic: 'Grief and jokes', name: 'The Back Room', mode: 'invite' });
  const sky = await C('sky');
  const card = sky.circles[0];
  assert.equal(card.name, 'The Back Room'); assert.equal(card.topic, 'Grief and jokes');
  assert.equal(card.count, undefined); assert.equal(card.people, undefined);
  assert.ok(!JSON.stringify(sky).includes('Asha'));
  assert.equal((await C('state')).cid, 0);
});

test('one circle at a time: starting a new one leaves the old', async () => {
  const w = world(); const A = w.as('a');
  const one = await A('new', { topic: 'one' });
  const two = await A('new', { topic: 'two' });
  assert.notEqual(one.cid, two.cid);
  assert.equal(await count(w.db, 'c_circles'), 1, 'the first dispersed when its only member left');
});

// ---------- Phase 2 ----------
test('presence: within grace you stay; past grace you are removed and the empty circle disperses', async () => {
  const w = world(); const A = w.as('a'), B = w.as('b');
  const { cid } = await A('new', { topic: 'x' });
  await A('say', { text: 'hello' });
  await B('sky');
  w.tick(60000);
  assert.equal((await A('state')).cid, cid, 'back after 60 s, still inside');
  w.tick(119000); await B('sky');
  assert.equal(await count(w.db, 'c_members'), 1);
  w.tick(2000); await B('sky');
  assert.equal(await count(w.db, 'c_members'), 0);
  assert.equal(await count(w.db, 'c_circles'), 0);
  assert.equal(await count(w.db, 'c_messages'), 0, 'messages deleted');
});

test('cron sweeps without any request', async () => {
  const w = world(); const A = w.as('a');
  await A('new', { topic: 'x' });
  w.tick(3 * MIN); await w.cron();
  assert.equal(await count(w.db, 'c_circles'), 0);
});

test('leaving: last one out ends the circle', async () => {
  const w = world(); const A = w.as('a'), B = w.as('b');
  const { cid } = await A('new', { topic: 'x' });
  await B('join', { id: cid });
  await A('leave');
  assert.equal(await count(w.db, 'c_circles'), 1);
  await B('leave');
  assert.equal(await count(w.db, 'c_circles'), 0);
});

// ---------- Phase 3 ----------
async function litCircle(w, givers, each) {
  const ps = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].slice(0, Math.max(givers, 1));
  const A = w.as('a');
  const { cid } = await A('new', { topic: 'What would you pick', name: 'Years', mode: 'open', temple: 'thinkers' });
  for (const p of ps.slice(1)) await w.as(p)('join', { id: cid });
  const { id: mid } = await A('say', { text: 'I would pick the year my parents met' });
  await A('pin', { mid });
  for (const p of ps.slice(0, givers)) for (let i = 0; i < each; i++) await w.as(p)('light', { kind: 'circle', id: cid });
  return { cid, ps };
}

test('Starlight: 5 a day, 6th refused, resets at midnight IST', async () => {
  const w = world(); const A = w.as('a');
  const { cid } = await A('new', { topic: 'x' });
  const B = w.as('b'); const c2 = (await B('new', { topic: 'y' })).cid;
  await A('join', { id: c2 }); await A('leave');
  // A has been in circle c2 (ever) but c2 still has B. Give 3 to c2 and 2 more
  for (let i = 0; i < 3; i++) assert.equal((await A('light', { kind: 'circle', id: c2 })).ok, true);
  assert.equal((await A('light', { kind: 'circle', id: c2 })).ok, false, 'per-target limit 3');
  const s = await B('light', { kind: 'circle', id: c2 }); assert.equal(s.ok, true);
  // make a star to spend the rest on
  const wday = istDay(w.now());
  await w.db.prepare("INSERT INTO c_stars (circle_id,topic,light,light_at,created_at) VALUES (99,'old',5,?,?)").bind(w.now(), w.now()).run();
  assert.equal((await A('light', { kind: 'star', id: 1 })).ok, true);
  const fifth = await A('light', { kind: 'star', id: 1 });
  assert.equal(fifth.ok, true); assert.equal(fifth.left, 0);
  assert.equal((await A('light', { kind: 'star', id: 1 })).ok, false, 'sixth refused');
  // Midnight IST is 18:30 UTC. Current time is 06:00 UTC.
  w.tick(12.5 * 60 * MIN + 1000);
  assert.notEqual(istDay(w.now()), wday);
  assert.equal((await A('light', { kind: 'star', id: 1 })).ok, true, 'new day, new light');
  void cid;
});

test('only people who were inside can light a circle', async () => {
  const w = world(); const A = w.as('a'), Z = w.as('g');
  const { cid } = await A('new', { topic: 'x' });
  assert.equal((await Z('light', { kind: 'circle', id: cid })).ok, false);
});

test('circle with 10 light from 5 givers becomes a star on dispersal', async () => {
  const w = world();
  const { ps } = await litCircle(w, 5, 2);
  for (const p of ps) await w.as(p)('leave');
  const sky = await w.as('g')('sky');
  assert.equal(sky.stars.length, 1);
  const st = sky.stars[0];
  assert.equal(st.name, 'Years'); assert.equal(st.temple, 'thinkers');
  assert.equal(st.line, 'I would pick the year my parents met');
  assert.equal(st.light, 10);
  assert.ok(!JSON.stringify(sky).match(/Asha|Bilal|Chandni/), 'never who was there');
});

test('below threshold the circle vanishes', async () => {
  const w = world();
  const { ps } = await litCircle(w, 4, 3); // 12 light but only 4 givers
  for (const p of ps) await w.as(p)('leave');
  assert.equal((await w.as('g')('sky')).stars.length, 0);
  assert.equal(await count(w.db, 'c_messages'), 0);
});

test('only former members read a star’s messages', async () => {
  const w = world();
  const { ps } = await litCircle(w, 5, 2);
  for (const p of ps) await w.as(p)('leave');
  const inside = await w.as('b')('star', { id: 1 });
  assert.equal(inside.star.wasThere, true); assert.equal(inside.star.lines.length, 1);
  const outside = await w.as('g')('star', { id: 1 });
  assert.equal(outside.star.wasThere, false); assert.equal(outside.star.lines, undefined);
});

test('no response exposes Starlight per person', async () => {
  const w = world();
  const { cid } = await litCircle(w, 5, 1);
  const all = JSON.stringify([await w.as('a')('state'), await w.as('a')('sky'), await w.as('a')('people')]);
  assert.ok(!/giver"|givenBy|byPerson/.test(all));
  void cid;
});

test('anyone can start a circle around a star', async () => {
  const w = world();
  const { ps } = await litCircle(w, 5, 2);
  for (const p of ps) await w.as(p)('leave');
  const r = await w.as('g')('new', { topic: 'back to the years', star_id: 1 });
  assert.equal(r.ok, true);
  const sky = await w.as('g')('sky');
  assert.equal(sky.circles[0].star_id, 1);
});

// ---------- Phase 4 ----------
test('stars dim over time, Starlight raises them, at zero everything is deleted', async () => {
  const w = world();
  const { ps } = await litCircle(w, 5, 2);
  for (const p of ps) await w.as(p)('leave');
  w.tick(DAY);
  let s = (await w.as('g')('sky')).stars[0];
  assert.equal(s.light, 8);
  const r = await w.as('g')('light', { kind: 'star', id: 1 });
  assert.equal(r.light, 9);
  w.tick(4.6 * DAY); await w.cron();
  assert.equal((await w.as('g')('sky')).stars.length, 0);
  assert.equal(await count(w.db, 'c_stars'), 0);
  assert.equal(await count(w.db, 'c_messages'), 0);
  assert.equal(await count(w.db, 'c_ever'), 0);
  assert.equal(await count(w.db, 'c_light', "kind='star'"), 0);
});

// ---------- Phase 5 ----------
test('temple rooms: circles carry their temple; unknown temples are ignored', async () => {
  const w = world();
  await w.as('a')('new', { topic: 'x', temple: 'artists' });
  await w.as('b')('new', { topic: 'y', temple: 'not-a-temple' });
  const sky = await w.as('c')('sky');
  assert.deepEqual(sky.circles.map((c) => c.temple), ['artists', '']);
});

test('allowlist limits who can use circles', async () => {
  const w = world({ CIRCLES_PIDS: 'a,b' });
  assert.equal((await w.as('a')('sky')).ok, true);
  assert.equal((await w.as('c')('sky')).ok, false);
});
