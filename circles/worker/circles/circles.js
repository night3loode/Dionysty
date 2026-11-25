// Dionysty: circles, stars and Starlight.
// Drop-in module for the existing Cloudflare Worker. Everything lives under /api/sq/c/*
// and in new c_* tables, so the existing app and its endpoints are untouched.
//
// Wiring (see AGENT_INSTRUCTIONS.md):
//   import { handleCircles, circlesCron } from './circles/circles.js';
//   if (path.startsWith('sq/c/')) {
//     const pid = /* the member id your existing auth already resolves */;
//     return json(await handleCircles(path.slice(5), body, { db: env.DB, env, pid, lookup, people }));
//   }
//   scheduled(event, env, ctx) { ctx.waitUntil(circlesCron({ db: env.DB, env })) }
//
// ctx.lookup(pids)  -> Promise<{ [pid]: { alias, temple } }>   (aliases only, never real names)
// ctx.people()      -> Promise<[{ pid, alias, temple }]>        (members who may be invited)

export const TEMPLES = ['artists', 'thinkers', 'healers', 'lovers', 'wanderers', 'revellers', 'builders'];
export const MODES = ['open', 'knock', 'invite'];

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const IST_OFFSET = 330 * MIN;

// Defaults. Every one can be overridden with an env var of the same name (string number).
export const DEFAULTS = {
  FOUNDER_IDLE_MS: 2 * MIN,     // DECIDED: founder inactive 2 to 3 minutes, then anyone inside can answer
  PRESENCE_GRACE_MS: 2 * MIN,   // DECIDED: leaving the app exits you after about 2 minutes
  STARLIGHT_DAILY: 5,           // OPEN
  STARLIGHT_PER_TARGET: 3,      // OPEN
  STAR_MIN_LIGHT: 10,           // OPEN
  STAR_MIN_GIVERS: 5,           // OPEN
  STAR_DECAY_PER_DAY: 2,        // OPEN
  KNOCK_TTL_MS: 10 * MIN,
  CIRCLE_CAP: 8,
  MAX_MESSAGE: 500,
  MAX_TOPIC: 80,
  MAX_NAME: 40,
};

export function config(env = {}) {
  const c = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (env[k] !== undefined && env[k] !== '' && !isNaN(+env[k])) c[k] = +env[k];
  }
  return c;
}

export function istDay(now) {
  return new Date(now + IST_OFFSET).toISOString().slice(0, 10);
}

const ok = (o = {}) => ({ ok: true, ...o });
const no = (error, o = {}) => ({ ok: false, error, ...o });

function clean(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------- tiny D1 helpers ----------
const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const lastId = (r) => (r && r.meta && (r.meta.last_row_id ?? r.meta.lastRowId)) || 0;

// ---------- star brightness ----------
export function starLight(star, now, cfg) {
  const elapsed = Math.max(0, now - star.light_at);
  return star.light - (cfg.STAR_DECAY_PER_DAY * elapsed) / DAY;
}

// ---------- sweeping: presence, knocks, dimming ----------
export async function sweep(db, now, cfg) {
  // 1. People who left the app: remove after the grace period.
  const stale = await all(db, 'SELECT pid, circle_id FROM c_members WHERE seen_at < ?', now - cfg.PRESENCE_GRACE_MS);
  if (stale.length) {
    await run(db, 'DELETE FROM c_members WHERE seen_at < ?', now - cfg.PRESENCE_GRACE_MS);
    const ids = [...new Set(stale.map((r) => r.circle_id))];
    for (const id of ids) await disperseIfEmpty(db, id, now, cfg);
  }
  // 2. Unanswered knocks expire.
  await run(db, "UPDATE c_knocks SET status='expired' WHERE status='waiting' AND created_at < ?", now - cfg.KNOCK_TTL_MS);
  // 3. Stars that have gone fully dim disappear, with everything said in them.
  const stars = await all(db, 'SELECT id, circle_id, light, light_at FROM c_stars');
  for (const s of stars) {
    if (starLight(s, now, cfg) <= 0) await deleteStar(db, s);
  }
}

async function deleteStar(db, s) {
  await run(db, 'DELETE FROM c_messages WHERE circle_id = ?', s.circle_id);
  await run(db, 'DELETE FROM c_ever WHERE circle_id = ?', s.circle_id);
  await run(db, "DELETE FROM c_light WHERE kind='star' AND target = ?", s.id);
  await run(db, 'DELETE FROM c_stars WHERE id = ?', s.id);
}

export async function disperseIfEmpty(db, circleId, now, cfg) {
  const n = await one(db, 'SELECT COUNT(*) AS n FROM c_members WHERE circle_id = ?', circleId);
  if (n && n.n > 0) return null;
  const c = await one(db, 'SELECT * FROM c_circles WHERE id = ?', circleId);
  if (!c) return null;
  const l = await one(db, "SELECT COUNT(*) AS total, COUNT(DISTINCT giver) AS givers FROM c_light WHERE kind='circle' AND target = ?", circleId);
  const becomesStar = l && l.total >= cfg.STAR_MIN_LIGHT && l.givers >= cfg.STAR_MIN_GIVERS;
  let starId = null;
  if (becomesStar) {
    const pin = c.pinned ? await one(db, 'SELECT body FROM c_messages WHERE id = ? AND circle_id = ?', c.pinned, circleId) : null;
    const r = await run(db,
      'INSERT INTO c_stars (circle_id, name, topic, temple, line, wx, wy, light, light_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      circleId, c.name, c.topic, c.temple, pin ? pin.body : null, c.wx, c.wy, l.total, now, now);
    starId = lastId(r);
  } else {
    // Nothing kept. The conversation is gone.
    await run(db, 'DELETE FROM c_messages WHERE circle_id = ?', circleId);
    await run(db, 'DELETE FROM c_ever WHERE circle_id = ?', circleId);
  }
  await run(db, "DELETE FROM c_light WHERE kind='circle' AND target = ?", circleId);
  await run(db, 'DELETE FROM c_knocks WHERE circle_id = ?', circleId);
  await run(db, 'DELETE FROM c_invites WHERE circle_id = ?', circleId);
  await run(db, 'DELETE FROM c_circles WHERE id = ?', circleId);
  return starId;
}

// ---------- membership ----------
async function myCircleId(db, pid) {
  const m = await one(db, 'SELECT circle_id FROM c_members WHERE pid = ?', pid);
  return m ? m.circle_id : 0;
}

async function leaveCurrent(db, pid, now, cfg) {
  const cid = await myCircleId(db, pid);
  if (!cid) return;
  await run(db, 'DELETE FROM c_members WHERE pid = ?', pid);
  await disperseIfEmpty(db, cid, now, cfg);
}

async function enter(db, pid, circleId, now, cfg) {
  const cur = await myCircleId(db, pid);
  if (cur === circleId) return;
  if (cur) await leaveCurrent(db, pid, now, cfg);
  await run(db, 'INSERT INTO c_members (pid, circle_id, joined_at, seen_at) VALUES (?,?,?,?)', pid, circleId, now, now);
  await run(db, 'INSERT OR IGNORE INTO c_ever (circle_id, pid) VALUES (?,?)', circleId, pid);
  await run(db, "UPDATE c_knocks SET status='used' WHERE circle_id = ? AND pid = ? AND status='in'", circleId, pid);
  await run(db, 'DELETE FROM c_invites WHERE circle_id = ? AND to_pid = ?', circleId, pid);
}

async function founderIdle(db, c, now, cfg) {
  const f = await one(db, 'SELECT seen_at FROM c_members WHERE pid = ? AND circle_id = ?', c.founder, c.id);
  return !f || f.seen_at < now - cfg.FOUNDER_IDLE_MS;
}

async function canAnswer(db, pid, c, now, cfg) {
  if ((await myCircleId(db, pid)) !== c.id) return false;
  if (pid === c.founder) return true;
  return founderIdle(db, c, now, cfg);
}

async function lightUsedToday(db, pid, now) {
  const r = await one(db, 'SELECT COUNT(*) AS n FROM c_light WHERE giver = ? AND day = ?', pid, istDay(now));
  return r ? r.n : 0;
}

// ---------- public views ----------
function circleCard(c, count, people, mine) {
  const base = { id: c.id, kind: 'circle', name: c.name || '', topic: c.topic, temple: c.temple || '', mode: c.mode, wx: c.wx, wy: c.wy, star_id: c.star_id || 0, mine: !!mine };
  // Invite-only circles show only their name and theme to people outside.
  if (c.mode === 'invite' && !mine) return base;
  return { ...base, count, cap: c.cap, people };
}

// ---------- the handler ----------
export async function handleCircles(action, body = {}, ctx) {
  const { db, env = {}, pid } = ctx;
  const now = ctx.now ? ctx.now() : Date.now();
  const cfg = config(env);
  if (env.CIRCLES_ON !== '1') return no('Not here yet.');
  if (!pid) return no('Please sign in again.');
  if (env.CIRCLES_PIDS) {
    const allow = String(env.CIRCLES_PIDS).split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(String(pid))) return no('Not here yet.');
  }
  const lookup = ctx.lookup || (async () => ({}));
  const alias = (map, p) => (map[p] && map[p].alias) || 'someone';

  // Every request counts as presence while you are inside.
  await run(db, 'UPDATE c_members SET seen_at = ? WHERE pid = ?', now, pid);
  await sweep(db, now, cfg);

  switch (action) {
    case 'sky': {
      const circles = await all(db, 'SELECT * FROM c_circles ORDER BY id');
      const members = await all(db, 'SELECT pid, circle_id FROM c_members');
      const names = await lookup([...new Set(members.map((m) => m.pid))]);
      const mine = await myCircleId(db, pid);
      const by = {};
      members.forEach((m) => (by[m.circle_id] = by[m.circle_id] || []).push(m.pid));
      const cards = circles.map((c) => circleCard(c, (by[c.id] || []).length, (by[c.id] || []).map((p) => ({ alias: alias(names, p), me: p === pid })), c.id === mine));
      const stars = (await all(db, 'SELECT * FROM c_stars ORDER BY id')).map((s) => {
        const light = starLight(s, now, cfg);
        return { id: s.id, kind: 'star', name: s.name || '', topic: s.topic, temple: s.temple || '', line: s.line || '', wx: s.wx, wy: s.wy, light: Math.round(light * 10) / 10, glow: Math.max(0.08, Math.min(1, light / (cfg.STAR_MIN_LIGHT * 1.5))) };
      });
      return ok({ cid: mine, circles: cards, stars, ...(await myInbox(db, pid, now, cfg, lookup)) });
    }

    case 'new': {
      const topic = clean(body.topic, cfg.MAX_TOPIC);
      if (!topic) return no('Give your circle a theme.');
      const mode = MODES.includes(body.mode) ? body.mode : 'open';
      const temple = TEMPLES.includes(body.temple) ? body.temple : null;
      const name = clean(body.name, cfg.MAX_NAME) || null;
      let starId = null, wx = +body.wx || 0, wy = +body.wy || 0;
      if (body.star_id) {
        const s = await one(db, 'SELECT id, wx, wy, temple FROM c_stars WHERE id = ?', +body.star_id);
        if (!s) return no('That star has gone out.');
        starId = s.id; wx = s.wx + 40; wy = s.wy + 30;
      }
      await leaveCurrent(db, pid, now, cfg);
      const r = await run(db,
        'INSERT INTO c_circles (founder, name, topic, temple, star_id, mode, cap, wx, wy, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        pid, name, topic, temple, starId, mode, cfg.CIRCLE_CAP, wx, wy, now);
      const id = lastId(r);
      await enter(db, pid, id, now, cfg);
      return ok({ cid: id });
    }

    case 'join': {
      const c = await one(db, 'SELECT * FROM c_circles WHERE id = ?', +body.id);
      if (!c) return no('This circle has dispersed.');
      if ((await myCircleId(db, pid)) === c.id) return ok({ cid: c.id });
      const invited = await one(db, 'SELECT id FROM c_invites WHERE circle_id = ? AND to_pid = ?', c.id, pid);
      const letIn = await one(db, "SELECT id FROM c_knocks WHERE circle_id = ? AND pid = ? AND status='in'", c.id, pid);
      if (c.mode !== 'open' && !invited && !letIn) {
        return c.mode === 'knock' ? no('Knock to be let in.', { knock: true }) : no('This circle is by invitation.', { invite: true });
      }
      const n = await one(db, 'SELECT COUNT(*) AS n FROM c_members WHERE circle_id = ?', c.id);
      if (n.n >= c.cap) return no('This circle is full right now.');
      await enter(db, pid, c.id, now, cfg);
      return ok({ cid: c.id });
    }

    case 'knock': {
      const c = await one(db, 'SELECT * FROM c_circles WHERE id = ?', +body.id);
      if (!c) return no('This circle has dispersed.');
      if (c.mode === 'invite') return no('This circle is by invitation.', { invite: true });
      if (c.mode === 'open') return no('This circle is open. Just come in.', { open: true });
      if ((await myCircleId(db, pid)) === c.id) return ok({ cid: c.id });
      const w = await one(db, "SELECT id FROM c_knocks WHERE circle_id = ? AND pid = ? AND status='waiting'", c.id, pid);
      if (w) return ok({ kid: w.id });
      const r = await run(db, 'INSERT INTO c_knocks (circle_id, pid, created_at) VALUES (?,?,?)', c.id, pid, now);
      return ok({ kid: lastId(r) });
    }

    case 'answer': {
      const k = await one(db, 'SELECT * FROM c_knocks WHERE id = ?', +body.kid);
      if (!k || k.status !== 'waiting') return no('That knock has already been answered.');
      const c = await one(db, 'SELECT * FROM c_circles WHERE id = ?', k.circle_id);
      if (!c) return no('This circle has dispersed.');
      if (!(await canAnswer(db, pid, c, now, cfg))) return no('The founder answers knocks here.');
      const yes = body.yes === true || body.a === 'in';
      await run(db, 'UPDATE c_knocks SET status = ?, answered_by = ?, answered_at = ? WHERE id = ?', yes ? 'in' : 'no', pid, now, k.id);
      return ok({ status: yes ? 'in' : 'no' });
    }

    case 'invite': {
      const to = String(body.pid || '');
      if (!to || to === String(pid)) return no('Choose someone to invite.');
      const cid = await myCircleId(db, pid);
      if (!cid) return no('Step into a circle first.');
      const c = await one(db, 'SELECT * FROM c_circles WHERE id = ?', cid);
      if ((await myCircleId(db, to)) === cid) return no('They are already here.');
      if (c.mode === 'open' || pid === c.founder) {
        const have = await one(db, 'SELECT id FROM c_invites WHERE circle_id = ? AND to_pid = ?', cid, to);
        if (!have) await run(db, 'INSERT INTO c_invites (circle_id, from_pid, to_pid, created_at) VALUES (?,?,?,?)', cid, pid, to, now);
        return ok({ sent: 'invite' });
      }
      // Anyone else in a knock or invite circle: their invitation becomes a knock on the invitee's behalf.
      const w = await one(db, "SELECT id FROM c_knocks WHERE circle_id = ? AND pid = ? AND status IN ('waiting','in')", cid, to);
      if (!w) await run(db, 'INSERT INTO c_knocks (circle_id, pid, sponsor, created_at) VALUES (?,?,?,?)', cid, to, pid, now);
      return ok({ sent: 'knock' });
    }

    case 'decline': {
      await run(db, 'DELETE FROM c_invites WHERE circle_id = ? AND to_pid = ?', +body.id, pid);
      await run(db, "UPDATE c_knocks SET status='used' WHERE circle_id = ? AND pid = ? AND status='in'", +body.id, pid);
      return ok();
    }

    case 'mode': {
      const cid = await myCircleId(db, pid);
      const c = cid && (await one(db, 'SELECT * FROM c_circles WHERE id = ?', cid));
      if (!c) return no('Step into a circle first.');
      if (c.founder !== pid) return no('Only the founder can change how people come in.');
      if (!MODES.includes(body.mode)) return no('Choose open, knock or invite only.');
      await run(db, 'UPDATE c_circles SET mode = ? WHERE id = ?', body.mode, cid);
      return ok({ mode: body.mode });
    }

    case 'say': {
      const cid = await myCircleId(db, pid);
      if (!cid) return no('Step into a circle first.');
      const text = String(body.text || '').trim().slice(0, cfg.MAX_MESSAGE);
      if (!text) return no('Say something first.');
      const r = await run(db, 'INSERT INTO c_messages (circle_id, pid, body, at) VALUES (?,?,?,?)', cid, pid, text, now);
      return ok({ id: lastId(r) });
    }

    case 'pin': {
      const cid = await myCircleId(db, pid);
      const c = cid && (await one(db, 'SELECT * FROM c_circles WHERE id = ?', cid));
      if (!c) return no('Step into a circle first.');
      const m = await one(db, 'SELECT id FROM c_messages WHERE id = ? AND circle_id = ?', +body.mid, cid);
      if (!m) return no('That line is not here.');
      if (c.pinned && c.founder !== pid) return no('This circle already has its line. The founder can change it.');
      await run(db, 'UPDATE c_circles SET pinned = ? WHERE id = ?', m.id, cid);
      return ok({ pinned: m.id });
    }

    case 'leave': {
      await leaveCurrent(db, pid, now, cfg);
      return ok({ cid: 0 });
    }

    case 'light': {
      const kind = body.kind === 'star' ? 'star' : 'circle';
      const id = +body.id;
      const used = await lightUsedToday(db, pid, now);
      if (used >= cfg.STARLIGHT_DAILY) return no('Your Starlight for today is given. More tomorrow.', { left: 0 });
      const per = await one(db, 'SELECT COUNT(*) AS n FROM c_light WHERE giver = ? AND day = ? AND kind = ? AND target = ?', pid, istDay(now), kind, id);
      if (per.n >= cfg.STARLIGHT_PER_TARGET) return no('You have given this all the light you can today.');
      let light;
      if (kind === 'circle') {
        const c = await one(db, 'SELECT id FROM c_circles WHERE id = ?', id);
        if (!c) return no('This circle has dispersed.');
        const was = await one(db, 'SELECT 1 AS y FROM c_ever WHERE circle_id = ? AND pid = ?', id, pid);
        if (!was) return no('Only people who have been inside can give it light.');
        await run(db, 'INSERT INTO c_light (giver, kind, target, day, at) VALUES (?,?,?,?,?)', pid, kind, id, istDay(now), now);
        light = (await one(db, "SELECT COUNT(*) AS n FROM c_light WHERE kind='circle' AND target = ?", id)).n;
      } else {
        const s = await one(db, 'SELECT * FROM c_stars WHERE id = ?', id);
        if (!s) return no('That star has gone out.');
        light = starLight(s, now, cfg) + 1;
        await run(db, 'UPDATE c_stars SET light = ?, light_at = ? WHERE id = ?', light, now, id);
        await run(db, 'INSERT INTO c_light (giver, kind, target, day, at) VALUES (?,?,?,?,?)', pid, kind, id, istDay(now), now);
      }
      return ok({ left: cfg.STARLIGHT_DAILY - used - 1, light: Math.round(light * 10) / 10 });
    }

    case 'star': {
      const s = await one(db, 'SELECT * FROM c_stars WHERE id = ?', +body.id);
      if (!s) return no('That star has gone out.');
      const was = await one(db, 'SELECT 1 AS y FROM c_ever WHERE circle_id = ? AND pid = ?', s.circle_id, pid);
      const light = starLight(s, now, cfg);
      const out = { id: s.id, name: s.name || '', topic: s.topic, temple: s.temple || '', line: s.line || '', light: Math.round(light * 10) / 10, glow: Math.max(0.08, Math.min(1, light / (cfg.STAR_MIN_LIGHT * 1.5))), wasThere: !!was, created_at: s.created_at };
      if (was) {
        const msgs = await all(db, 'SELECT id, pid, body, at FROM c_messages WHERE circle_id = ? ORDER BY id LIMIT 400', s.circle_id);
        const names = await lookup([...new Set(msgs.map((m) => m.pid))]);
        out.lines = msgs.map((m) => ({ id: m.id, alias: alias(names, m.pid), body: m.body, at: m.at, mine: m.pid === pid }));
      }
      return ok({ star: out, left: cfg.STARLIGHT_DAILY - (await lightUsedToday(db, pid, now)) });
    }

    case 'people': {
      const list = ctx.people ? await ctx.people() : [];
      return ok({ people: list.filter((p) => String(p.pid) !== String(pid)).map((p) => ({ pid: p.pid, alias: p.alias, temple: p.temple || '' })) });
    }

    case 'state': {
      const cid = await myCircleId(db, pid);
      const inbox = await myInbox(db, pid, now, cfg, lookup);
      if (!cid) return ok({ cid: 0, ...inbox });
      const c = await one(db, 'SELECT * FROM c_circles WHERE id = ?', cid);
      const mem = await all(db, 'SELECT pid, seen_at FROM c_members WHERE circle_id = ? ORDER BY joined_at', cid);
      const after = +body.after || 0;
      const msgs = await all(db, 'SELECT id, pid, body, at FROM c_messages WHERE circle_id = ? AND id > ? ORDER BY id DESC LIMIT 150', cid, after);
      msgs.reverse();
      const answer = await canAnswer(db, pid, c, now, cfg);
      const knocks = answer ? await all(db, "SELECT id, pid, sponsor, created_at FROM c_knocks WHERE circle_id = ? AND status='waiting' ORDER BY id", cid) : [];
      const pinned = c.pinned ? await one(db, 'SELECT id, body FROM c_messages WHERE id = ?', c.pinned) : null;
      const l = await one(db, "SELECT COUNT(*) AS total, COUNT(DISTINCT giver) AS givers FROM c_light WHERE kind='circle' AND target = ?", cid);
      const mineToday = await one(db, "SELECT COUNT(*) AS n FROM c_light WHERE giver = ? AND day = ? AND kind='circle' AND target = ?", pid, istDay(now), cid);
      const pids = new Set([c.founder, ...mem.map((m) => m.pid), ...msgs.map((m) => m.pid)]);
      knocks.forEach((k) => { pids.add(k.pid); if (k.sponsor) pids.add(k.sponsor); });
      const names = await lookup([...pids]);
      return ok({
        cid,
        circle: {
          id: c.id, name: c.name || '', topic: c.topic, temple: c.temple || '', mode: c.mode, cap: c.cap,
          founder: alias(names, c.founder), iAmFounder: c.founder === pid, canAnswer: answer,
          founderIdle: await founderIdle(db, c, now, cfg), star_id: c.star_id || 0,
          light: l.total, givers: l.givers, mineToday: mineToday.n,
          needs: { light: cfg.STAR_MIN_LIGHT, givers: cfg.STAR_MIN_GIVERS },
          pinned: pinned ? { id: pinned.id, body: pinned.body } : null,
        },
        members: mem.map((m) => ({ alias: alias(names, m.pid), me: m.pid === pid, founder: m.pid === c.founder })),
        lines: msgs.map((m) => ({ id: m.id, alias: alias(names, m.pid), body: m.body, at: m.at, mine: m.pid === pid })),
        knocks: knocks.map((k) => ({ kid: k.id, alias: alias(names, k.pid), sponsor: k.sponsor ? alias(names, k.sponsor) : '', at: k.created_at })),
        ...inbox,
      });
    }

    default:
      return no('Unknown circles action.');
  }
}

// What is waiting for me: invitations, knocks I have made, today's Starlight.
async function myInbox(db, pid, now, cfg, lookup) {
  const inv = await all(db, 'SELECT i.circle_id, i.from_pid, c.name, c.topic FROM c_invites i JOIN c_circles c ON c.id = i.circle_id WHERE i.to_pid = ?', pid);
  const letIn = await all(db, "SELECT k.circle_id, k.sponsor, c.name, c.topic FROM c_knocks k JOIN c_circles c ON c.id = k.circle_id WHERE k.pid = ? AND k.status='in'", pid);
  const mine = await one(db, "SELECT id, circle_id, status FROM c_knocks WHERE pid = ? AND sponsor IS NULL AND status IN ('waiting','no','expired') ORDER BY id DESC LIMIT 1", pid);
  const names = await lookup([...new Set([...inv.map((i) => i.from_pid), ...letIn.filter((k) => k.sponsor).map((k) => k.sponsor)])]);
  const a = (p) => (names[p] && names[p].alias) || 'someone';
  const invites = [
    ...inv.map((i) => ({ id: i.circle_id, name: i.name || '', topic: i.topic, from: a(i.from_pid), how: 'invite' })),
    ...letIn.map((k) => ({ id: k.circle_id, name: k.name || '', topic: k.topic, from: k.sponsor ? a(k.sponsor) : '', how: 'let-in' })),
  ];
  return {
    invites,
    knock: mine ? { kid: mine.id, id: mine.circle_id, status: mine.status } : null,
    left: cfg.STARLIGHT_DAILY - (await lightUsedToday(db, pid, now)),
  };
}

// Cron Trigger entry point. Safe to run as often as you like.
export async function circlesCron({ db, env = {}, now }) {
  if (env.CIRCLES_ON !== '1') return;
  await sweep(db, now || Date.now(), config(env));
}
