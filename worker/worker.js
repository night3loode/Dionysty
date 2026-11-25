// DIONYSTY · Telegram intake bot (@DionystyLabBot)
// Runs as a Cloudflare Worker on the DIONYSTY account. Nothing runs on a laptop.
//
// Worker settings → Bindings / Variables:
//   DB              KV namespace binding
//   BOT_TOKEN       Secret  — from BotFather. Paste it only here.
//   WEBHOOK_SECRET  Secret  — 30+ chars, letters/numbers/_/- only
//   TEAM_CHAT_ID    Text    — the private team group's id (send /chatid in that group)
//   CALL_TIMES      Text    — optional: call start times in IST, e.g. "23:00,23:10,23:20"
//   CALL_HOURS      Text    — optional fallback: whole hours, e.g. "11,14,17,19,21" (default)
//   CALL_LINK       Text    — optional: a fixed video-call link sent with each booking
//   CALL_MINUTES    Text    — optional: call length shown to applicants (default 30)
//   SHEET_URL       Text    — optional: Village Ledger web-app URL; every change is pushed there
//   FOUNDER_IDS     Text    — optional: Telegram user ids allowed to make founder decisions
//                             (comma-separated). Empty = anyone in the team group.
//   VOUCH_FOR       Text    — who needs a member's vouch: gender_mode pairs, e.g.
//                             "man_alone,man_friend" (default), or "all".
//                             genders: woman, man, nb · modes: alone, partner, friend
//   VOTE_HOURS      Text    — how long a vote stays open (default 72)
//   INVITE_CHAT_ID  Text    — the members' group (Dionysty Invitations). The bot must be an admin there
//                             with “Invite users via link”. Admitted members get a personal join link;
//                             the bot approves join requests only from admitted members.
//   MEMBER_PHOTOS   Text    — "on" lets members send photos to each other (blurred, can't be forwarded or
//                             saved, only once both have replied to each other). Default off.
//   DEFAULT_ROOM    Text    — the Room new applicants join when no member vouched (default "Village 1")
//
// Cron trigger (Worker → Settings → Triggers): "*/5 * * * *" — sends vote reminders and closes votes.
//
// Admissions (see project doc 10): a person gets in when more yes than no votes are cast by the
// Room's members, with more than half the Room voting. A tie, or too few votes, goes to the founder.
// A member's vouch is their yes vote. Members never expire; applicants expire after RETENTION_DAYS.
//
// Stores per applicant, and nothing else: alias, Telegram handle, Reddit handle (optional),
// temples (tapped choices), personal code, who invited them (code), call time if booked,
// stage, first-contact date, plus the Telegram user id needed to reply. Records expire after
// RETENTION_DAYS without activity.

const RETENTION_DAYS = 180;
const REPLY_WINDOW = 'within two days';
const SITE = 'https://dionysty.pages.dev';
const TTL = RETENTION_DAYS * 86400;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const IST_MS = 330 * 60 * 1000; // UTC+05:30
const BOOK_DAYS = 7; // how many days ahead applicants can pick
const MIN_NOTICE_H = 6; // earliest bookable slot, hours from now
const CODE_LEN = 6; // new codes; older 4-character codes keep working
const MAX_CODE_TRIES = 5; // wrong codes before code entry pauses
const CODE_LOCK_H = 24;
const SIT_OUT_VOTES = 3; // votes a member sits out after a 1st or 2nd breach by someone they vouched for
const BREACHES_TO_SUSPEND = 3;

const GENDERS = { woman: 'a woman', man: 'a man', nb: 'non-binary' };
const MODES = { alone: 'on my own', partner: 'with a partner', friend: 'with a friend' };
const comingLabel = (r) =>
  r.gender && r.mode ? `${GENDERS[r.gender].replace(/^a /, '')}, ${MODES[r.mode]}`.replace(/^./, (c) => c.toUpperCase()) : '—';
const vouchDial = (env) => String(env.VOUCH_FOR || 'man_alone,man_friend').split(',').map((x) => x.trim()).filter(Boolean);
const vouchRequired = (env, r) => { const d = vouchDial(env); return d.includes('all') || d.includes(`${r.gender}_${r.mode}`); };
const needsVouch = (env, r) => vouchRequired(env, r) && r.vouch !== 'yes';
const roomOf = (env, r) => (r.member && r.member.room) || r.room || env.DEFAULT_ROOM || 'Village 1';
const voteHours = (env) => parseInt(env.VOTE_HOURS, 10) || 72;

// The seven temples: what you're here for. Never a yes to anything.
const TEMPLES = {
  artists: ['The Artists', 'make, perform or show work'],
  thinkers: ['The Thinkers', 'ideas, books, long arguments'],
  healers: ['The Healers', 'care, presence, holding space'],
  lovers: ['The Lovers', 'connection, romance, maybe love'],
  wanderers: ['The Wanderers', 'trips, adventures, the unfamiliar'],
  revellers: ['The Revellers', 'music, dance, celebration'],
  builders: ['The Builders', 'shaping the culture and its traditions'],
  unsure: ['Not sure yet', ''],
};

// What each temple helps keep alive: "Meet ___ people."
const QUALITY = { artists: 'creative', thinkers: 'smart', healers: 'kind', lovers: 'loving', wanderers: 'fun', revellers: 'sexy', builders: 'bold' };
const meetLabel = (k) => (QUALITY[k] ? `Meet ${QUALITY[k]} people · ${TEMPLES[k][0]}` : TEMPLES[k][0]);
const templesOf = (r) => (r.temples && r.temples.length ? r.temples : r.temple ? [r.temple] : []);
const templeNames = (keys) => (keys && keys.length ? keys.map((k) => (TEMPLES[k] ? TEMPLES[k][0] : k)).join(', ') : '—');

const TEXT = {
  welcome:
    'Welcome to DIONYSTY.\n\n' +
    'We are a small, adults-only private members’ club in Delhi NCR, fifty members at most. ' +
    'This is the quiet front door: a few short questions, then someone from the team continues the conversation with you here.\n\n' +
    'First: are you 18 or older?',
  agePrompt: 'Just tap one: are you 18 or older?',
  under18:
    'Thank you for being honest. DIONYSTY is for adults only, so we can’t continue. Nothing from this conversation has been kept.',
  askAlias:
    'What should we call you?\n\n' +
    'An alias is perfect. Please don’t send your real name, photos or anything personal — we don’t need them.',
  aliasBad: 'An alias of up to 40 characters, please.',
  askGender: (a) =>
    `Good to meet you, ${a}.\n\n` +
    'A quick one that helps us keep evenings balanced. Are you…\n\n' +
    'We never ask about sexuality, and you never need to share it.',
  askMode: 'And how would you come?',
  askWith: (mode) =>
    `Has your ${mode === 'partner' ? 'partner' : 'friend'} already said hello here? If so, send their personal code and we’ll link you. ` +
    'If not, tap Skip — they can enter yours when they do.',
  withBad: 'I don’t recognise that code. Check it and send it again, or tap Skip.',
  withOk: (a) => `Linked: you’re coming with ${a}.`,
  codeLocked: 'Too many codes that didn’t match, so code entry is paused for a day. Tap Skip to carry on.',
  askTemple: () =>
    'Who do you want to meet here?\n\n' +
    Object.keys(TEMPLES)
      .filter((k) => TEMPLES[k][1])
      .map((k) => `• ${meetLabel(k)} — ${TEMPLES[k][1]}`)
      .join('\n') +
    '\n\nEach is one of our seven temples, a quality we gather to keep alive. Tap every one that fits, as many as you like, then Done. You can change them any time, and they are never a yes to anything.',
  changeTemple: 'Who do you want to meet now? Tap every one that fits, then Done.',
  pickOne: 'Pick at least one — or Not sure yet.',
  askWhy:
    'What brought you to DIONYSTY? A line or two is plenty — no need to share anything intimate, just what drew you.',
  askWant: 'And what would you love to do, make or find here?',
  tooLong: 'A little shorter, please — up to 500 characters.',
  askInvite: (required) =>
    required
      ? 'For now, men join DIONYSTY through a member who vouches for them. If a member knows you, send their code here.\n\n' +
        'No code yet? Tap Skip — you can send one any time with /code.'
      : 'Did a member give you their code? Send it here, or tap Skip.',
  inviteBad: 'I don’t recognise that code. Check it and send it again, or tap Skip.',
  inviteNotMember: 'That code isn’t a member’s, so it can’t be a vouch. Check it, or tap Skip.',
  vouchAsked: (who) => `Thank you. We’ve asked ${who} to confirm they vouch for you.`,
  vouchYes: (who) => `${who} has vouched for you.`,
  vouchNo: 'We couldn’t confirm that vouch. If you know another member, send their code with /code.',
  codeUsage: 'Send it like this: /code DNY-ABC123',
  alreadyVouched: (who) => `${who} has already vouched for you.`,
  askReddit:
    'Did you find us on Reddit? If so, your Reddit handle helps us connect the conversation. Entirely optional.',
  done: (r) =>
    `Thank you, ${r.alias}. That’s all we need.\n\n` +
    `Your personal code is ${r.code}. Keep it: it’s how we recognise you at your first evening, without needing your name.\n\n` +
    'Coming with a partner or a friend? Each person says hello here themselves — adults only, one person each — and enters your code.\n\n' +
    (r.vouchNeeded ? 'Remember: we can take your application further once a member vouches for you (/code).\n\n' : '') +
    'How it works: the members decide who joins. After a conversation with us, the members of your Room vote. ' +
    'They see your alias, temples, your two answers, how you’re coming and who vouched — never your Telegram account or messages.\n\n' +
    `Someone from the team will write to you here personally, ${REPLY_WINDOW}. Anything you send here reaches them directly.\n\n` +
    '/privacy shows what we hold, /temple changes your temples, /forget deletes everything.',
  welcomeBack: (a) =>
    `Welcome back${a ? ', ' + a : ''}. You’re already in touch with the team — just write here and it reaches them.`,
  textOnly: 'Text only here, please. We don’t collect photos, voice notes or files.',
  forgotten: 'Done. Everything we held about you has been deleted. If you ever want to return, just type /start.',
  notYet: 'Type /start first and we’ll get you set up.',
  myCode: (c, member) =>
    member
      ? `Your code is ${c}. Give it to someone you’d vouch for; they send it here, and we’ll always ask you to confirm first. ` +
        'Your vouch counts as your yes vote, and if they later break the Charter it counts against your vote.'
      : `Your personal code is ${c}. Share it with a partner or friend you’d like to bring; they enter it when they say hello here.`,
  memberHome: (r) =>
    `Welcome back, ${r.alias}. You’re a member of ${r.member.room}.\n\n` +
    '• /members — who’s in your village, and write to anyone privately\n' +
    '• Reply to any message from a member to answer them\n' +
    '• /team — write to the team\n' +
    '• /rules — the house rules for messages\n' +
    '• /report — report something that happened, here or anywhere else\n' +
    '• /mycode — your code, for someone you’d vouch for',
  nowTeam: 'You’re now writing to the team. Anything you send here reaches them.',
  nowTalking: (a) =>
    `You’re now writing to ${a}. They’ll see your alias, never your Telegram account.\n\n` +
    'The house rules apply (/rules): nothing illegal, nothing without consent, and anything can be reported. Type /team to go back to writing to the team.',
  villageHello: (a, room) =>
    `🎉 New in ${room}: ${a.alias}\n\n` +
    `Temples: ${templeNames(templesOf(a))}\n` +
    `Coming: ${comingLabel(a)}${a.withAlias ? ' (' + a.withAlias + ')' : ''}\n` +
    `Would love to: ${a.want || '—'}\n\n` +
    'Say hello? They’ll see your alias only.',
  welcomeNote: (from, room) => `👋 ${from} welcomes you to ${room}.`,
  fromMember: (alias, text) => `💬 ${alias}:\n\n${text}`,
  photoFrom: (alias) => `📷 ${alias}`,
  waitReply: (a) => `${a} hasn’t replied yet. You can write again once they do.`,
  cantDeliver: 'Couldn’t deliver that one.',
  blocked: (a) => `Blocked. You won’t receive anything more from ${a}. They aren’t told.`,
  reported: 'Thank you. The team has the message and the reason, and will look at it. You won’t be named to them.',
  reportWhy: 'What did this message breach? Pick the closest.',
  houseRules:
    'Before you write to members, the house rules for messages:\n\n' +
    '• Nothing illegal under Indian law — ever.\n' +
    '• Nothing involving anyone under 18, in any form.\n' +
    '• Consent first: no explicit messages or photos unless the other person has clearly asked for them. A no, or no reply, means stop.\n' +
    '• Discretion: never share another member’s messages, photos, alias or anything that could identify them.\n' +
    '• No pressure, no money, no selling or promotion.\n' +
    '• The Charter applies here exactly as it does in person.\n\n' +
    'Every message can be reported to the team, with the reason. You see each other’s aliases only, but the club knows who is behind every alias, and a breach can mean losing your membership.',
  rulesOk: 'I agree',
  reportWho:
    'Reporting something — here, after swapping handles, at an evening, anywhere.\n\n' +
    'Who is it about? (People who’ve written to you are listed; otherwise pick “Someone else” and name them in your description.)',
  reportReason: 'What did they breach? Pick the closest.',
  reportDescribe:
    'Tell us what happened, in your own words. You can send several messages and screenshots. ' +
    'When you’re done, tap Send report.\n\n' +
    'The team will see that this report is from you, so they can follow up with you here. The person you report is never told who reported them.',
  reportAdded: (n) => `Added (${n}). Send more, or tap Send report.`,
  reportEmpty: 'Add a few words about what happened first.',
  reportSent:
    'Thank you. Your report is with the team. They may write to you here to follow up.\n\n' +
    'If you’re in danger right now, call 112.',
  reportCancelled: 'Report cancelled. Nothing was sent.',
  swapNeedChat: (a) => `You can swap handles once you and ${a} have both written to each other here.`,
  swapAsked: (a) => `Asked ${a}. If they say yes, you’ll each get the other’s Telegram handle.`,
  swapAsk: (a) =>
    `🤝 ${a} would like to swap Telegram handles, so you can talk directly.\n\n` +
    'If you say yes, each of you sees the other’s real Telegram account. That can’t be undone.',
  swapNo: (a) => `${a} would rather keep talking here for now.`,
  swapDone: (a, how) =>
    `🤝 You and ${a} have swapped handles. ${a} is ${how}.\n\n` +
    'From here it’s a conversation between the two of you, on your own judgement, outside the club. ' +
    'The Charter still applies to how members treat each other — and discretion means their account stays with you.',
  swapAlready: (a, how) => `You and ${a} already swapped handles: ${how}.`,
  rulesAgain: 'Thank you. Now send your message again.',
  photosOff: 'Members can’t send photos to each other yet. Text only for now.',
  photosNeedMutual: (a) => `Photos open up once you and ${a} have both written to each other.`,
  photoOnlyCompressed: 'Send it as a photo, not a file, so no hidden details (like location) travel with it.',
  joinGroup: 'Your place in the members’ group, Dionysty Invitations. The link is yours alone: it only lets in admitted members, so it won’t work for anyone you forward it to.',
  admitted: (room) =>
    `Welcome to DIONYSTY. You’re in — a member of ${room}.\n\n` +
    `From now on your voice counts: when someone new applies to ${room}, you’ll get a private message here to vote on them. ` +
    'Your code (/mycode) is now one you can give someone you’d vouch for; we’ll always ask you to confirm first.\n\n' +
    'Your village gets a short hello with your alias, temples and what you’d love to do, so expect some welcomes. ' +
    'Members write to each other through me by alias only — your Telegram account is never shown. /members shows who’s in.\n\n' +
    'The team will be in touch about your first evening.',
  vouchQ: (a, room) =>
    `🤝 Vouch request · ${room}\n\n` +
    `${a.alias} says you gave them your code.\n` +
    `Coming: ${comingLabel(a)}\n` +
    `Temples: ${templeNames(templesOf(a))}\n\n` +
    'Do you vouch for them? Your vouch counts as your yes vote. If they later break the Charter, it counts against your vote ' +
    `(sit out ${SIT_OUT_VOTES} votes; a third time, you lose your vote until the council reinstates it).`,
  voteQ: (a, room, closes, n) =>
    `🗳 New vote · ${room}\n\n` +
    `${a.alias}\n` +
    `Coming: ${comingLabel(a)}${a.withAlias ? ' (' + a.withAlias + ')' : ''}\n` +
    `Temples: ${templeNames(templesOf(a))}\n` +
    `Brought them: ${a.why || '—'}\n` +
    `Wants to: ${a.want || '—'}\n` +
    `Vouched by: ${a.vouchedBy || '—'}\n\n` +
    `${n} member${n === 1 ? '' : 's'} can vote. They get in with more yes than no, and more than half of you voting. ` +
    `Closes ${closes} (India time). Only totals are shown to the team, never who voted how.`,
  voteNoted: (v) => `Noted: ${v === 'y' ? 'yes' : 'no'}. Thank you.`,
  voteReminder: (a, closes) => `Reminder: your vote on ${a} closes ${closes} (India time). Scroll up to vote.`,
  voteClosed: 'This vote has already closed.',
  templeNow: (n) => `Your temples are now: ${n}.`,
  callInvite: (mins) =>
    `We’d love to talk. It’s a short call, about ${mins} minutes, and a conversation both ways, not an interview.\n\n` +
    'Pick a day that suits you (times are India time):',
  callNotOffered: 'Calls are arranged once we’ve chatted a little. Just write here and the team will pick it up.',
  pickTime: (d) => `${d} — pick a time (India time):`,
  noTimes: 'No free times left that day. Pick another:',
  slotGone: 'Someone just took that time. Pick another:',
  booked: (when, link) =>
    `Booked: ${when} (India time).\n\n` +
    (link ? `Your call link: ${link}\n\n` : 'We’ll send the call link here before then.\n\n') +
    'Need a different time? Type /book. Can’t make it at all? Just tell us here.',
  charter:
    `The Charter is on our site: ${SITE}\n\n` +
    'In short: adults only, then Consent, Respect, Discretion, Reciprocity, Openness, Accountability and Autonomy. ' +
    'Your temples say what you’re here for; they are never consent to anything. You can step back or leave at any point, without explanation.',
  privacy: (r) =>
    r && r.alias
      ? 'We hold only this:\n' +
        `• Alias: ${r.alias}\n` +
        `• Coming: ${comingLabel(r)}\n` +
        `• Coming with: ${r.withAlias || '—'}\n` +
        `• Vouched by: ${r.vouchedBy || '—'}\n` +
        `• Room: ${roomOf({}, r)}${r.member ? ' (member)' : ''}\n` +
        `• Telegram: ${r.tg || '—'}\n` +
        `• Reddit: ${r.reddit || '—'}\n` +
        `• Temples: ${templeNames(templesOf(r))}\n` +
        `• What brought you: ${r.why || '—'}\n` +
        `• What you’d like to do: ${r.want || '—'}\n` +
        `• Your code: ${r.code || '—'}\n` +
        `• Invited by: ${r.invitedBy || '—'}\n` +
        `• Call: ${r.call ? slotLabel(r.call) : '—'}\n` +
        `• Stage: ${r.stage}\n\n` +
        'Plus the messages you send here, so the team can follow the conversation. No real name, ID, photos, sexuality or health details, ever.\n\n' +
        (r.member ? 'Messages between members go through the bot by alias. We don’t keep their text — only who wrote to whom, so replies reach the right person — unless someone reports a message to the team.\n\n' : '') +
        'If your application goes to a vote, members of your Room see your alias, temples, your two answers, how you’re coming and who vouched — never your Telegram account or messages.\n\n' +
        '/forget deletes all of it.'
      : 'We hold nothing about you.',
  teamHelp:
    'Team commands\n\n' +
    'Reply to an applicant card or message:\n' +
    '• plain text → sent to them from the bot\n' +
    '• /call → lets them pick a day and time for a call\n' +
    '• /stage <name> → update their stage (e.g. /stage Admitted)\n' +
    '• /flag <reason> → escalate them in the Ledger; /unflag clears it\n' +
    '• /remove → delete their record\n' +
    '• /vote → open the Room’s vote on them (72 hours)\n' +
    '• /room <name> → move them to another Room (e.g. /room Village 2)\n' +
    '• /admit, /decline → founder decides directly\n' +
    '• /breach → they broke the Charter: counts against whoever vouched for them\n' +
    '• /reinstate → founder restores a suspended member’s vote\n' +
    '• /invite → send a member a fresh link to Dionysty Invitations\n\n' +
    'Anywhere in this group:\n' +
    '• /members → members by Room, and open votes\n' +
    '• /calls → upcoming booked calls\n' +
    '• /export → CSV in the Founder’s Ledger columns',
};

// ---------- entry ----------

const dyMain = {
  async fetch(req, env, ctx) {
    env = { ...env, __ctx: ctx };
    const url = new URL(req.url);
    if (url.pathname === '/setup') return setup(url, env);
    if (url.pathname.startsWith('/api/')) return api(req, url, env);
    if (req.method !== 'POST') return new Response('DIONYSTY');
    if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
      return new Response('forbidden', { status: 403 });
    try {
      await route(await req.json(), env);
    } catch (e) {
      console.log('error', e && e.stack);
    }
    return new Response('ok');
  },
  // Hourly cron: reminders halfway through a vote, and closing votes at their deadline.
  async scheduled(event, env, ctx) {
    env = { ...env, __ctx: ctx };
    try { await callReminders(env); } catch (e) { console.log('callReminders', e && e.message); }
    await sweepVotes(env);
    try { await sweepExpiry(env); } catch (e) { console.log('sweepExpiry', e && e.message); }
  },
};
/* retention: space 7d, starlove 90d, unsaved DMs and their media 24h from creation */
/* activation cutoff, set to the feature go-live timestamp at deploy: pre-existing DMs/media get a fresh 24h grace from activation before the unsaved-24h rule applies; space keeps its pre-existing 7d rule; starlove sweeps only post-activation records */
const RETENTION_START = 1795619418620;
async function sweepExpiry(env) {
  const now = Date.now(), D = 86400000;
  const batch = [
    env.D1.prepare('DELETE FROM msgs WHERE at < ?1').bind(now - 7 * D),
    env.D1.prepare('DELETE FROM sl_msgs WHERE at < ?1 AND at >= ?2').bind(now - 90 * D, RETENTION_START),
  ];
  const cutoff = now - D;
  if (cutoff >= RETENTION_START) {
    const extIds = (await env.D1.prepare("SELECT id FROM media WHERE ext = 1 AND (id IN (SELECT body FROM dms WHERE at < ?1 AND id NOT IN (SELECT id FROM dm_save)) OR id IN (SELECT substr(body, 4) FROM dms WHERE at < ?1 AND id NOT IN (SELECT id FROM dm_save)))").bind(cutoff).all()).results || [];
    for (const x of extIds) await mediaDrop(env, x.id);
    batch.push(env.D1.prepare("DELETE FROM media WHERE id IN (SELECT body FROM dms WHERE at < ?1 AND id NOT IN (SELECT id FROM dm_save)) OR id IN (SELECT substr(body, 4) FROM dms WHERE at < ?2 AND id NOT IN (SELECT id FROM dm_save))").bind(cutoff, cutoff));
    batch.push(env.D1.prepare('DELETE FROM dms WHERE at < ?1 AND id NOT IN (SELECT id FROM dm_save)').bind(cutoff));
    batch.push(env.D1.prepare('DELETE FROM dm_save WHERE id NOT IN (SELECT id FROM dms)'));
    batch.push(env.D1.prepare('DELETE FROM dmx WHERE id NOT IN (SELECT id FROM dms)'));
  }
  await env.D1.batch(batch);
  try { await mediaPurgeSweep(env); } catch (e) { console.log('mediaPurgeSweep', e && e.message); }
};

// One-time: open /setup in a browser after deploying (re-run after changing secrets).
async function setup(url, env) {
  try { await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'DIONYSTY', web_app: { url: APP_URL } } }); } catch (e) {}
  // No key needed: this only re-points the webhook at this same Worker.
  const webhook = await tg(env, 'setWebhook', {
    url: `${url.origin}/`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'chat_join_request'],
    drop_pending_updates: false,
  });
  const commands = await tg(env, 'setMyCommands', {
    scope: { type: 'all_private_chats' },
    commands: [
      { command: 'start', description: 'Begin, or pick up where you left off' },
      { command: 'temple', description: 'Change your temples' },
      { command: 'book', description: 'Pick or change your call time' },
      { command: 'mycode', description: 'Your personal code' },
      { command: 'code', description: 'Send a member’s code so they can vouch for you' },
      { command: 'members', description: 'Members: who’s in your village, write to them' },
      { command: 'team', description: 'Members: write to the team' },
      { command: 'rules', description: 'Members: house rules for messages' },
      { command: 'report', description: 'Members: report a breach, in or outside the bot' },
      { command: 'privacy', description: 'See exactly what we hold about you' },
      { command: 'forget', description: 'Delete everything we hold about you' },
      { command: 'charter', description: 'Read the Charter' },
    ],
  });
  return Response.json({ webhook, commands });
}

async function route(u, env) {
  if (u.callback_query) return onButton(u.callback_query, env);
  if (u.chat_join_request) return onJoinRequest(u.chat_join_request, env);
  const m = u.message;
  if (!m || !m.from) return;
  const cmd = command(m.text);
  if (m.chat.type !== 'private') {
    if (cmd === '/chatid') return say(env, m.chat.id, `This chat's id: ${m.chat.id}`);
    if (String(m.chat.id) === String(env.TEAM_CHAT_ID)) return onTeam(m, cmd, env);
    return; // ignore any other group
  }
  return onPrivate(m, cmd, env);
}

// ---------- applicant side ----------

async function onPrivate(m, cmd, env) {
  const id = m.from.id;
  let r = await getRec(env, id);

  if (cmd === '/forget') {
    if (r) {
      if (r.member) await roomRemove(env, r.member.room, id);
      await dropVote(env, id);
      await delRec(env, id, r);
      if (r.code) await sheet(env, 'delete', { code: r.code });
      if (r.alias) await team(env, `🗑 ${label(r)} used /forget. Bot record deleted — their Ledger row and messages were removed; delete their messages in this group too.`);
    }
    return say(env, id, TEXT.forgotten);
  }
  if (cmd === '/privacy') return say(env, id, TEXT.privacy(r));
  if (cmd === '/charter') return say(env, id, TEXT.charter);
  if (cmd === '/mycode') return say(env, id, r && r.code ? TEXT.myCode(r.code, !!r.member) : TEXT.notYet);
  if (cmd === '/code') {
    if (!r || r.step !== 'chatting') return say(env, id, TEXT.notYet);
    if (r.member) return say(env, id, 'You’re already a member.');
    if (r.vouch === 'yes') return say(env, id, TEXT.alreadyVouched(r.vouchedBy));
    const t = m.text.split(/\s+/).slice(1).join('');
    if (!t) return say(env, id, TEXT.codeUsage);
    return vouchCode(env, id, r, t);
  }
  if (cmd === '/temple') {
    if (!r || r.step !== 'chatting') return say(env, id, TEXT.notYet);
    r.tsel = templesOf(r).slice();
    await putRec(env, id, r);
    return say(env, id, TEXT.changeTemple, templeButtons(r.tsel));
  }
  if (cmd === '/book') {
    if (!r || r.step !== 'chatting') return say(env, id, TEXT.notYet);
    if (!r.callOffered) return say(env, id, TEXT.callNotOffered);
    return say(env, id, TEXT.callInvite(callMins(env)), await dayButtons(env));
  }

  if (r && r.step === 'chatting') {
    if (cmd === '/start') return say(env, id, r.member ? TEXT.memberHome(r) : TEXT.welcomeBack(r.alias));
    if (r.member) {
      if (cmd === '/team') {
        delete r.talkTo;
        await putRec(env, id, r);
        return say(env, id, TEXT.nowTeam);
      }
      if (cmd === '/members') return memberDirectory(env, id, r);
      if (cmd === '/rules') return say(env, id, TEXT.houseRules);
      if (cmd === '/report') return startReport(env, id, r);
      if (r.report && r.report.step === 'describe' && !cmd) return addToReport(env, id, r, m);
      const peer = await peerFor(env, id, r, m);
      if (peer) return relayToMember(env, id, r, peer, m);
    }
    if (!m.text) return say(env, id, TEXT.textOnly);
    if (cmd) return;
    r.tg = handleOf(m.from);
    r.lastIn = new Date().toISOString();
    r.lastMsg = m.text.slice(0, 300);
    r.msgs = (r.msgs || 0) + 1;
    const autoFlag = flagFor(m.text);
    if (autoFlag && !r.flag) r.flag = autoFlag;
    await putRec(env, id, r);
    const sent = await team(env, `${autoFlag ? '⚠️ ' + autoFlag + '\n' : ''}💬 ${label(r)}:\n\n${m.text.slice(0, 3800)}`);
    if (sent && sent.ok) await link(env, sent.result.message_id, id);
    await sheet(env, 'message', { p: personRow(r), m: { at: r.lastIn, code: r.code, alias: r.alias, from: 'Them', text: m.text.slice(0, 2000) } });
    return;
  }

  if (!r || cmd === '/start') {
    r = { step: 'age', stage: 'Intro', tg: handleOf(m.from), first: today() };
    await putRec(env, id, r);
    return say(env, id, TEXT.welcome, [[{ text: '✦ Begin with Starlove', web_app: { url: APP_URL } }]].concat(ageButtons()));
  }

  if (!m.text || cmd) return reprompt(env, id, r);
  const t = m.text.trim();

  if (r.step === 'alias') {
    if (!t || t.length > 40) return say(env, id, TEXT.aliasBad);
    r.alias = t;
    r.step = 'gender';
    await putRec(env, id, r);
    return say(env, id, TEXT.askGender(t), genderButtons());
  }
  if (r.step === 'with') {
    const hit = await codeLookup(env, id, r, t, TEXT.withBad, 'with|skip');
    if (!hit) return;
    linkWith(r, hit);
    const other = hit.rec;
    if (!other.withId) {
      other.withId = String(id);
      other.withAlias = r.alias;
      await putRec(env, hit.uid, other);
      await sheetPerson(env, other);
    }
    return toTemples(env, id, r, TEXT.withOk(other.alias));
  }
  if (r.step === 'why' || r.step === 'want') {
    if (!t) return reprompt(env, id, r);
    if (t.length > 500) return say(env, id, TEXT.tooLong);
    if (r.step === 'why') {
      r.why = t;
      r.step = 'want';
      await putRec(env, id, r);
      return say(env, id, TEXT.askWant, [[btn('Skip', 'want|skip')]]);
    }
    r.want = t;
    return toInvite(env, id, r);
  }
  if (r.step === 'invite') {
    const ok = await vouchCode(env, id, r, t);
    if (!ok) return;
    r.step = 'reddit';
    await putRec(env, id, r);
    return say(env, id, TEXT.askReddit, [[btn('Skip', 'reddit|skip')]]);
  }
  if (r.step === 'reddit') {
    const h = t.replace(/^\/?u\//i, '').replace(/^@/, '').slice(0, 40);
    if (h) r.reddit = 'u/' + h;
    return finish(env, id, r);
  }
  return reprompt(env, id, r);
}

async function onButton(q, env) {
  const id = q.from.id;
  const [kind, val] = String(q.data || '').split('|');
  const r = await getRec(env, id);
  const ack = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) });
  const setKb = (kb) =>
    q.message &&
    tg(env, 'editMessageReplyMarkup', {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: kb },
    });

  // Votes and vouch confirmations (members, in private) and founder decisions (team group).
  if (kind === 'v') return onVoteButton(env, q, ack, setKb);
  if (['wel', 'dm', 'blk', 'rep', 'ublk', 'rok'].includes(kind)) return onMemberButton(env, q, kind, val, ack, setKb);
  if (['sw', 'swy', 'swn'].includes(kind)) return onSwapButton(env, q, kind, val, ack, setKb);
  if (['rpw', 'rpr', 'rps', 'rpx'].includes(kind)) return onReportFlow(env, q, kind, val, ack, setKb);
  if (kind === 'rc') return onReportReason(env, q, ack, setKb);
  if (kind === 'vb') return onVouchButton(env, q, ack, setKb);
  if (kind === 'fd') return onFounderButton(env, q, ack, setKb);

  if (!r) {
    await ack();
    await setKb([]);
    return say(env, id, 'Let’s start again — type /start.');
  }

  // Temples: toggle in place, then Done.
  if (kind === 't' && (r.step === 'temple' || r.step === 'chatting') && Array.isArray(r.tsel)) {
    if (val === 'done') {
      if (!r.tsel.length) return ack(TEXT.pickOne);
      await ack();
      await setKb([]);
      const before = templeNames(templesOf(r));
      r.temples = r.tsel;
      delete r.tsel;
      delete r.temple;
      if (r.step === 'temple') {
        r.step = 'why';
        await putRec(env, id, r);
        return say(env, id, TEXT.askWhy, [[btn('Skip', 'why|skip')]]);
      }
      await putRec(env, id, r);
      await sheetPerson(env, r);
      await team(env, `🏛 ${label(r)} changed temples: ${before} → ${templeNames(r.temples)}`);
      return say(env, id, TEXT.templeNow(templeNames(r.temples)));
    }
    if (!TEMPLES[val]) return ack();
    if (val === 'unsure') r.tsel = r.tsel.includes('unsure') ? [] : ['unsure'];
    else {
      r.tsel = r.tsel.filter((k) => k !== 'unsure');
      r.tsel = r.tsel.includes(val) ? r.tsel.filter((k) => k !== val) : [...r.tsel, val];
    }
    await putRec(env, id, r);
    await ack();
    return setKb(templeButtons(r.tsel));
  }

  // Call booking: day, then time.
  if (kind === 'day' && r.step === 'chatting' && r.callOffered) {
    await ack();
    const kb = await timeButtons(env, val);
    await setKb([]);
    if (!kb) return say(env, id, TEXT.noTimes, await dayButtons(env));
    return say(env, id, TEXT.pickTime(dayLabel(val)), kb);
  }
  if (kind === 'days' && r.step === 'chatting' && r.callOffered) {
    await ack();
    await setKb([]);
    return say(env, id, TEXT.callInvite(callMins(env)), await dayButtons(env));
  }
  if (kind === 'slot' && r.step === 'chatting' && r.callOffered) {
    const holder = await env.DB.get(`s:${val}`);
    if ((holder && holder !== String(id)) || !slotOpen(val)) {
      await ack();
      await setKb([]);
      return say(env, id, TEXT.slotGone, await dayButtons(env));
    }
    await ack();
    await setKb([]);
    const previous = r.call;
    if (previous && previous !== val) await env.DB.delete(`s:${previous}`);
    await env.DB.put(`s:${val}`, String(id), { expirationTtl: Math.max(120, Math.round((slotUtc(val) - Date.now()) / 1000) + 86400) });
    r.call = val;
    r.stage = 'Call booked';
    await putRec(env, id, r);
    await sheetPerson(env, r);
    await say(env, id, TEXT.booked(slotLabel(val), env.CALL_LINK));
    const note = previous && previous !== val ? ` (moved from ${slotLabel(previous)})` : '';
    const sent = await team(env, `📅 ${label(r)} booked a call: ${slotLabel(val)} IST${note}`);
    if (sent && sent.ok) await link(env, sent.result.message_id, id);
    return;
  }

  // Single-tap steps
  await ack();
  await setKb([]);
  if (kind === 'age' && r.step === 'age') {
    if (val === 'no') {
      await delRec(env, id, r);
      return say(env, id, TEXT.under18);
    }
    r.step = 'alias';
    await putRec(env, id, r);
    return say(env, id, TEXT.askAlias);
  }
  if (kind === 'g' && r.step === 'gender' && GENDERS[val]) {
    r.gender = val;
    r.step = 'mode';
    await putRec(env, id, r);
    return say(env, id, TEXT.askMode, modeButtons());
  }
  if (kind === 'mode' && r.step === 'mode' && MODES[val]) {
    r.mode = val;
    if (val === 'alone') return toTemples(env, id, r);
    r.step = 'with';
    await putRec(env, id, r);
    return say(env, id, TEXT.askWith(val), [[btn('Skip', 'with|skip')]]);
  }
  if (kind === 'with' && r.step === 'with') return toTemples(env, id, r);
  if (kind === 'why' && r.step === 'why') {
    r.step = 'want';
    await putRec(env, id, r);
    return say(env, id, TEXT.askWant, [[btn('Skip', 'want|skip')]]);
  }
  if (kind === 'want' && r.step === 'want') return toInvite(env, id, r);
  if (kind === 'invite' && r.step === 'invite') {
    r.step = 'reddit';
    await putRec(env, id, r);
    return say(env, id, TEXT.askReddit, [[btn('Skip', 'reddit|skip')]]);
  }
  if (kind === 'reddit' && r.step === 'reddit') return finish(env, id, r);
}

async function finish(env, id, r) {
  r.code = await newCode(env, id);
  r.step = 'chatting';
  r.lastIn = new Date().toISOString();
  r.msgs = 0;
  r.room = roomOf(env, r);
  r.vouchNeeded = needsVouch(env, r);
  const autoFlag = flagFor(`${r.why || ''} ${r.want || ''}`);
  if (autoFlag) r.flag = autoFlag;
  await putRec(env, id, r);
  await say(env, id, TEXT.done(r));
  const card = await teamKb(
    env,
    '🚪 New introduction\n\n' +
      `${r.alias}\n` +
      (r.flag ? `⚠️ ${r.flag}\n` : '') +
      `Coming: ${comingLabel(r)}${r.withAlias ? ' (' + r.withAlias + ')' : ''}\n` +
      `Vouch: ${vouchStatus(env, r)}\n` +
      `Room: ${r.room}\n` +
      `Temples: ${templeNames(templesOf(r))}\n` +
      `Brought them: ${r.why || '—'}\n` +
      `Wants to: ${r.want || '—'}\n` +
      `Code: ${r.code}\n` +
      `Telegram: ${r.tg || 'no username — reply here to reach them'}\n` +
      `Reddit: ${r.reddit || '—'}\n` +
      `First contact: ${r.first}\n\n` +
      'Reply to this message to write to them, or reply /call to book a call or /vote to open the Room vote. /help for commands.', [[btn('✓ Admit', 'fd|a|' + id), btn('✖ Decline', 'fd|d|' + id)]]
  );
  if (card && card.ok) await link(env, card.result.message_id, id);
  await sheetPerson(env, r);
}

const vouchStatus = (env, r) =>
  r.vouch === 'yes'
    ? `vouched by ${r.vouchedBy}`
    : r.vouch === 'pending'
      ? `waiting for ${r.vouchAsked} to confirm`
      : vouchRequired(env, r)
        ? 'NEEDED — not yet vouched'
        : 'not needed';

// ---------- codes: partner/friend links and vouches ----------

// Looks up a code with the wrong-guess limit. Returns { uid, rec } or null (after replying).
async function codeLookup(env, id, r, t, badText, skipData) {
  const skip = [[btn('Skip', skipData)]];
  if (r.codeLock && Date.now() < r.codeLock) {
    await say(env, id, TEXT.codeLocked, skip);
    return null;
  }
  const code = t.toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^DNY(?!-)/, 'DNY-');
  const uid = /^DNY-[A-Z0-9]{4,8}$/.test(code) ? await env.DB.get(`c:${code}`) : null;
  const rec = uid && uid !== String(id) ? await getRec(env, uid) : null;
  if (!rec) {
    r.codeFails = (r.codeFails || 0) + 1;
    if (r.codeFails >= MAX_CODE_TRIES) {
      r.codeLock = Date.now() + CODE_LOCK_H * 3600 * 1000;
      r.codeFails = 0;
      await putRec(env, id, r);
      await say(env, id, TEXT.codeLocked, skip);
      return null;
    }
    await putRec(env, id, r);
    await say(env, id, badText, skip);
    return null;
  }
  r.codeFails = 0;
  return { uid, rec, code };
}

function linkWith(r, hit) {
  r.withId = hit.uid;
  r.withAlias = hit.rec.alias;
}

// A member's code asks that member to confirm a vouch. Returns true when the code was accepted.
async function vouchCode(env, id, r, t) {
  const hit = await codeLookup(env, id, r, t, TEXT.inviteBad, 'invite|skip');
  if (!hit) return false;
  if (!hit.rec.member) {
    await putRec(env, id, r);
    await say(env, id, TEXT.inviteNotMember, [[btn('Skip', 'invite|skip')]]);
    return false;
  }
  r.vouch = 'pending';
  r.vouchAsked = hit.rec.alias;
  r.vouchFromId = hit.uid;
  await putRec(env, id, r);
  await say(env, hit.uid, TEXT.vouchQ(r, roomOf(env, hit.rec)), [[btn('Yes, I vouch', `vb|y|${id}`), btn('I don’t know them', `vb|n|${id}`)]]);
  await say(env, id, TEXT.vouchAsked(hit.rec.alias));
  if (r.code) await sheetPerson(env, r);
  return true;
}

async function onVouchButton(env, q, ack, setKb) {
  const [, val, aid] = q.data.split('|');
  const member = await getRec(env, q.from.id);
  const a = await getRec(env, aid);
  await ack();
  await setKb([]);
  if (!member || !member.member) return say(env, q.from.id, 'Only members can vouch.');
  if (!a || a.vouchFromId !== String(q.from.id) || a.vouch !== 'pending') return say(env, q.from.id, 'That request is no longer open.');
  if (val === 'y') {
    a.vouch = 'yes';
    a.vouchedBy = `${member.alias} (${member.code})`;
    a.voucherId = String(q.from.id);
    a.room = member.member.room;
    a.vouchNeeded = false;
    await putRec(env, aid, a);
    await say(env, q.from.id, `Thank you. Your vouch for ${a.alias} is recorded as your yes vote.`);
    await say(env, aid, TEXT.vouchYes(member.alias));
    if (a.code) {
      const sent = await team(env, `🤝 ${member.alias} vouched for ${label(a)} (${a.room}).`);
      if (sent && sent.ok) await link(env, sent.result.message_id, aid);
    }
  } else {
    a.vouch = 'declined';
    await putRec(env, aid, a);
    await say(env, q.from.id, 'Understood. Nothing is shared with them beyond “we couldn’t confirm that vouch”.');
    await say(env, aid, TEXT.vouchNo);
    if (a.code) {
      const sent = await team(env, `🚫 ${member.alias} did not confirm a vouch for ${label(a)}.`);
      if (sent && sent.ok) await link(env, sent.result.message_id, aid);
    }
  }
  if (a.code) await sheetPerson(env, a);
}

// ---------- member-to-member relay (aliases only) ----------
// The bot never shows a member's Telegram account to another member. It stores no member-to-member
// message text: only which bot message came from whom (so replies route), who has written to whom,
// and blocks. A reported message is copied to the team, and only then.

const RELAY_TTL = 30 * 86400;
// What a member can report a message for. group: Charter principle, house rule, or safety.
const REPORT_REASONS = {
  consent: ['Consent', 'Charter'],
  respect: ['Respect', 'Charter'],
  discretion: ['Discretion', 'Charter'],
  reciprocity: ['Reciprocity', 'Charter'],
  openness: ['Openness', 'Charter'],
  account: ['Accountability', 'Charter'],
  autonomy: ['Autonomy', 'Charter'],
  pressure: ['Pressure or pushing', 'Rule'],
  unwanted: ['Unwanted sexual content', 'Rule'],
  identity: ['Shared someone’s identity or photos', 'Rule'],
  money: ['Money, selling or promotion', 'Rule'],
  illegal: ['Something illegal', 'Rule'],
  minor: ['Possible under-18', 'Safety'],
  unsafe: ['I feel unsafe or threatened', 'Safety'],
  other: ['Something else', 'Other'],
};
function reportKeyboard(from, msgId) {
  const b = (k) => btn(REPORT_REASONS[k][0], `rc|${k}|${msgId}|${from}`);
  return [
    [btn('— The Charter —', `rc|noop|${msgId}|${from}`)],
    [b('consent'), b('respect')],
    [b('discretion'), b('reciprocity')],
    [b('openness'), b('account'), b('autonomy')],
    [btn('— House rules —', `rc|noop|${msgId}|${from}`)],
    [b('pressure'), b('unwanted')],
    [b('identity'), b('money')],
    [b('illegal'), b('other')],
    [btn('— Safety —', `rc|noop|${msgId}|${from}`)],
    [b('minor'), b('unsafe')],
    [btn('Cancel', `rc|cancel|${msgId}|${from}`)],
  ];
}
const mapKey = (to, msgId) => `x:${to}:${msgId}`;
const okKey = (a, b) => `ok:${a}:${b}`; // b has written to a (a may receive photos / more from b)
const pendKey = (a, b) => `pend:${a}:${b}`; // a wrote to b, waiting for b's reply
const blkKey = (a, b) => `blk:${a}:${b}`; // a blocked b

async function peerFor(env, id, r, m) {
  // A reply goes to whoever sent that message; a reply to anything else (e.g. the team) goes to the team.
  if (m.reply_to_message) return (await env.DB.get(mapKey(id, m.reply_to_message.message_id))) || null;
  if (command(m.text)) return null;
  return r.talkTo || null;
}

const relayButtons = (from) => [
  [btn('↩️ Reply', `dm|${from}`), btn('🚫 Block', `blk|${from}`), btn('⚑ Report', `rep|${from}`)],
  [btn('🤝 Swap Telegram handles', `sw|${from}`)],
];

async function relayToMember(env, id, r, peerId, m) {
  const p = await getRec(env, peerId);
  if (!p || !p.member) {
    delete r.talkTo;
    await putRec(env, id, r);
    return say(env, id, TEXT.cantDeliver + ' They’re no longer a member. /team to write to the team.');
  }
  if (!r.rulesOk) return say(env, id, TEXT.houseRules, [[btn(TEXT.rulesOk, `rok|${peerId}|again`)]]);
  if (await env.DB.get(blkKey(peerId, id))) return say(env, id, TEXT.cantDeliver);
  const theyWrote = await env.DB.get(okKey(id, peerId)); // peer has written to me before
  const iWrote = await env.DB.get(okKey(peerId, id));
  const media = m.photo || m.document || m.video || m.animation || m.voice || m.video_note || m.sticker;
  if (media) {
    if (String(env.MEMBER_PHOTOS || '').toLowerCase() !== 'on') return say(env, id, TEXT.photosOff);
    if (!m.photo) return say(env, id, m.document ? TEXT.photoOnlyCompressed : TEXT.photosOff);
    if (!theyWrote || !iWrote) return say(env, id, TEXT.photosNeedMutual(p.alias));
  }
  if (!theyWrote && (await env.DB.get(pendKey(id, peerId)))) return say(env, id, TEXT.waitReply(p.alias));
  let res;
  if (media) {
    const best = m.photo[m.photo.length - 1];
    res = await tg(env, 'sendPhoto', {
      chat_id: peerId,
      photo: best.file_id,
      caption: TEXT.photoFrom(r.alias) + (m.caption ? `\n\n${m.caption.slice(0, 900)}` : ''),
      has_spoiler: true,
      protect_content: true,
      reply_markup: { inline_keyboard: relayButtons(id) },
    });
  } else if (m.text) {
    res = await tg(env, 'sendMessage', {
      chat_id: peerId,
      text: TEXT.fromMember(r.alias, m.text.slice(0, 3800)),
      protect_content: true,
      reply_markup: { inline_keyboard: relayButtons(id) },
    });
  } else return say(env, id, TEXT.cantDeliver);
  if (!res || !res.ok) return say(env, id, TEXT.cantDeliver);
  await env.DB.put(mapKey(peerId, res.result.message_id), String(id), { expirationTtl: RELAY_TTL });
  await env.DB.put(okKey(peerId, id), '1'); // I have now written to peer
  if (theyWrote) await env.DB.delete(pendKey(peerId, id));
  if (!theyWrote) await env.DB.put(pendKey(id, peerId), '1', { expirationTtl: RELAY_TTL });
  else await env.DB.delete(pendKey(id, peerId));
  // A reply to someone who wrote first clears their wait.
  await env.DB.delete(pendKey(peerId, id));
}

async function announceToVillage(env, aid, a, room) {
  for (const uid of await roomList(env, room)) {
    if (uid === String(aid)) continue;
    await say(env, uid, TEXT.villageHello(a, room), [[btn('👋 Welcome them', `wel|${aid}`), btn('💬 Write to them', `dm|${aid}`)]]);
  }
}

async function memberDirectory(env, id, r) {
  const rows = [];
  for (const uid of await roomList(env, r.member.room)) {
    if (uid === String(id)) continue;
    const m = await getRec(env, uid);
    if (m && m.member) rows.push([btn(`💬 ${m.alias} · ${templeNames(templesOf(m)).replace(/The /g, '')}`.slice(0, 60), `dm|${uid}`)]);
  }
  if (!rows.length) return say(env, id, `You’re the only member of ${r.member.room} so far.`);
  return say(env, id, `${r.member.room} — ${rows.length + 1} members. Tap someone to write to them privately (they see your alias only):`, rows);
}

async function onMemberButton(env, q, kind, peerId, ack, setKb) {
  const id = String(q.from.id);
  const r = await getRec(env, id);
  if (!r || !r.member) return ack('Members only.');
  const p = await getRec(env, peerId);
  if (kind === 'blk') {
    await env.DB.put(blkKey(id, peerId), '1');
    await ack();
    return say(env, id, TEXT.blocked(p ? p.alias : 'them'), [[btn('Undo', `ublk|${peerId}`)]]);
  }
  if (kind === 'ublk') {
    await env.DB.delete(blkKey(id, peerId));
    await ack('Unblocked.');
    return setKb([]);
  }
  if (kind === 'rep') {
    await ack();
    if (!q.message) return;
    // Keep a copy of the reported message until the reason is picked (relayed messages can't be copied later).
    const ph = q.message.photo;
    const snap = { text: q.message.text || '', caption: q.message.caption || '', photo: ph ? ph[ph.length - 1].file_id : '' };
    await env.DB.put(`rq:${id}:${q.message.message_id}`, JSON.stringify(snap), { expirationTtl: 86400 });
    return say(env, id, TEXT.reportWhy, reportKeyboard(peerId, q.message.message_id));
  }
  if (kind === 'rok') {
    r.rulesOk = new Date().toISOString();
    if (p && p.member && peerId !== id) r.talkTo = peerId;
    await putRec(env, id, r);
    await ack();
    await setKb([]);
    if (!p || !p.member) return;
    return say(env, id, String(q.data).endsWith('|again') ? TEXT.rulesAgain : TEXT.nowTalking(p.alias));
  }
  if (!p || !p.member) {
    await ack();
    return say(env, id, 'They’re no longer a member.');
  }
  if (peerId === id) return ack();
  if (kind === 'wel') {
    await ack('Welcome sent.');
    await setKb([[btn('💬 Write to them', `dm|${peerId}`)]]);
    if (await env.DB.get(blkKey(peerId, id))) return;
    const res = await tg(env, 'sendMessage', { chat_id: peerId, text: TEXT.welcomeNote(r.alias, p.member.room), reply_markup: { inline_keyboard: relayButtons(id) } });
    if (res && res.ok) {
      await env.DB.put(mapKey(peerId, res.result.message_id), id, { expirationTtl: RELAY_TTL });
      await env.DB.put(okKey(peerId, id), '1');
    }
    return;
  }
  if (kind === 'dm') {
    if (!r.rulesOk) {
      await ack();
      return say(env, id, TEXT.houseRules, [[btn(TEXT.rulesOk, `rok|${peerId}`)]]);
    }
    r.talkTo = peerId;
    await putRec(env, id, r);
    await ack();
    return say(env, id, TEXT.nowTalking(p.alias));
  }
}

async function onReportReason(env, q, ack, setKb) {
  const [, code, msgId, from] = String(q.data).split('|');
  const id = String(q.from.id);
  if (code === 'noop') return ack();
  if (code === 'cancel') {
    await env.DB.delete(`rq:${id}:${msgId}`);
    await ack('Cancelled.');
    return setKb([]);
  }
  const why = REPORT_REASONS[code];
  const snap = JSON.parse((await env.DB.get(`rq:${id}:${msgId}`)) || 'null');
  if (!why || !snap) {
    await ack('That report expired — tap ⚑ Report on the message again.');
    return setKb([]);
  }
  await env.DB.delete(`rq:${id}:${msgId}`);
  await ack();
  await setKb([]);
  const p = await getRec(env, from);
  const head =
    `${why[1] === 'Safety' ? '🚨' : '⚑'} Report — ${why[1] === 'Other' ? '' : why[1] + ': '}${why[0]}\n` +
    `About: ${p ? label(p) : 'a former member'}${p && p.member ? ' (' + p.member.room + ')' : ''}\n` +
    'The reporter isn’t named. Their message is below; reply /breach, /flag or /remove to it if needed.';
  const sent = await team(env, head);
  if (sent && sent.ok && p) await link(env, sent.result.message_id, from);
  const copy = snap.photo
    ? await tg(env, 'sendPhoto', { chat_id: env.TEAM_CHAT_ID, photo: snap.photo, caption: snap.caption.slice(0, 1000), has_spoiler: true })
    : await say(env, env.TEAM_CHAT_ID, snap.text || '(no text)');
  if (copy && copy.ok && p) await link(env, copy.result.message_id, from);
  if (p) {
    const flag = code === 'minor' ? 'Check: possible under-18' : code === 'unsafe' ? 'Check: safety concern' : `Reported: ${why[0]}`;
    if (!p.flag || why[1] === 'Safety') p.flag = flag;
    p.reports = (p.reports || 0) + 1;
    await putRec(env, from, p);
    await sheetPerson(env, p);
  }
  return say(env, id, TEXT.reported);
}

// ---------- /report: a breach anywhere (in the bot, after a handle swap, in person) ----------
// Unlike ⚑ on a message, this names the reporter to the team so they can follow up.

async function startReport(env, id, r) {
  const people = [];
  const page = await env.DB.list({ prefix: `ok:${id}:` });
  for (const k of page.keys.slice(0, 20)) {
    const uid = k.name.split(':')[2];
    const p = await getRec(env, uid);
    if (p && p.alias) people.push([btn(p.alias, `rpw|${uid}`)]);
  }
  people.push([btn('Someone else', 'rpw|none')]);
  people.push([btn('Cancel', 'rpx|')]);
  r.report = { step: 'who', text: [], photos: [] };
  await putRec(env, id, r);
  return say(env, id, TEXT.reportWho, people);
}

function reasonKeyboard() {
  const b = (k) => btn(REPORT_REASONS[k][0], `rpr|${k}`);
  return [
    [btn('— The Charter —', 'rpr|noop')],
    [b('consent'), b('respect')],
    [b('discretion'), b('reciprocity')],
    [b('openness'), b('account'), b('autonomy')],
    [btn('— House rules —', 'rpr|noop')],
    [b('pressure'), b('unwanted')],
    [b('identity'), b('money')],
    [b('illegal'), b('other')],
    [btn('— Safety —', 'rpr|noop')],
    [b('minor'), b('unsafe')],
    [btn('Cancel', 'rpx|')],
  ];
}

async function onReportFlow(env, q, kind, val, ack, setKb) {
  const id = String(q.from.id);
  const r = await getRec(env, id);
  if (!r || !r.member) return ack('Members only.');
  if (kind === 'rpx') {
    delete r.report;
    await putRec(env, id, r);
    await ack();
    await setKb([]);
    return say(env, id, TEXT.reportCancelled);
  }
  if (!r.report) {
    await ack('Start again with /report.');
    return setKb([]);
  }
  if (kind === 'rpw' && r.report.step === 'who') {
    r.report.about = val === 'none' ? '' : val;
    r.report.step = 'reason';
    await putRec(env, id, r);
    await ack();
    await setKb([]);
    return say(env, id, TEXT.reportReason, reasonKeyboard());
  }
  if (kind === 'rpr' && r.report.step === 'reason') {
    if (val === 'noop' || !REPORT_REASONS[val]) return ack();
    r.report.reason = val;
    r.report.step = 'describe';
    await putRec(env, id, r);
    await ack();
    await setKb([]);
    return say(env, id, TEXT.reportDescribe, [[btn('Send report', 'rps|'), btn('Cancel', 'rpx|')]]);
  }
  if (kind === 'rps' && r.report.step === 'describe') {
    if (!r.report.text.length && !r.report.photos.length) return ack(TEXT.reportEmpty);
    await ack();
    await setKb([]);
    return sendReport(env, id, r);
  }
  return ack();
}

async function addToReport(env, id, r, m) {
  if (m.photo && r.report.photos.length < 10) r.report.photos.push(m.photo[m.photo.length - 1].file_id);
  const t = m.text || m.caption;
  if (t) r.report.text.push(t.slice(0, 2000));
  if (!m.photo && !t) return say(env, id, 'Text or screenshots only, please.');
  await putRec(env, id, r);
  return say(env, id, TEXT.reportAdded(r.report.text.length + r.report.photos.length), [[btn('Send report', 'rps|'), btn('Cancel', 'rpx|')]]);
}

async function sendReport(env, id, r) {
  const rep = r.report;
  const why = REPORT_REASONS[rep.reason] || ['Something else', 'Other'];
  const p = rep.about ? await getRec(env, rep.about) : null;
  const swapped = rep.about ? !!(await env.DB.get(swapDoneKey(id, rep.about))) : false;
  const safety = why[1] === 'Safety';
  const head =
    `${safety ? '🚨' : '⚑'} /report — ${why[1] === 'Other' ? '' : why[1] + ': '}${why[0]}\n` +
    `About: ${p ? label(p) + (p.member ? ' (' + p.member.room + ')' : '') : 'someone they name below'}\n` +
    (rep.about ? `Swapped handles with the reporter: ${swapped ? 'yes — this may have happened outside the bot' : 'no'}\n` : '') +
    `From: ${label(r)}${r.member ? ' (' + r.member.room + ')' : ''} — reply to this message to write to the reporter.\n\n` +
    rep.text.join('\n\n').slice(0, 3000);
  const sent = await team(env, head);
  if (sent && sent.ok) await link(env, sent.result.message_id, id);
  for (const ph of rep.photos) {
    const res = await tg(env, 'sendPhoto', { chat_id: env.TEAM_CHAT_ID, photo: ph, caption: `Screenshot from ${r.alias}’s report`, has_spoiler: true });
    if (res && res.ok) await link(env, res.result.message_id, id);
  }
  if (p) {
    const card = await team(env, `↳ Reported member: ${label(p)}. Reply here for /flag, /breach or /remove.`);
    if (card && card.ok) await link(env, card.result.message_id, rep.about);
    const flag = rep.reason === 'minor' ? 'Check: possible under-18' : rep.reason === 'unsafe' ? 'Check: safety concern' : `Reported: ${why[0]}`;
    if (!p.flag || safety) p.flag = flag;
    p.reports = (p.reports || 0) + 1;
    await putRec(env, rep.about, p);
    await sheetPerson(env, p);
  }
  delete r.report;
  await putRec(env, id, r);
  return say(env, id, TEXT.reportSent);
}

// ---------- swapping Telegram handles (both must agree) ----------
// After this the two talk directly; the club's systems are no longer in the middle.
const swapReqKey = (a, b) => `swr:${a}:${b}`; // a asked b
const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const swapDoneKey = (a, b) => `swd:${[String(a), String(b)].sort().join(':')}`;
const handleLink = (uid, r) =>
  r && r.tg ? r.tg : `<a href="tg://user?id=${uid}">${esc(r && r.alias ? r.alias : 'their profile')} (tap to open)</a>`;

async function onSwapButton(env, q, kind, peerId, ack, setKb) {
  const id = String(q.from.id);
  const r = await getRec(env, id);
  const p = await getRec(env, peerId);
  if (!r || !r.member) return ack('Members only.');
  if (!p || !p.member || peerId === id) {
    await ack();
    return say(env, id, 'They’re no longer a member.');
  }
  if (await env.DB.get(swapDoneKey(id, peerId))) {
    await ack();
    return tg(env, 'sendMessage', { chat_id: id, text: TEXT.swapAlready(esc(p.alias), handleLink(peerId, p)), parse_mode: 'HTML' });
  }
  if (kind === 'swn') {
    await ack();
    await setKb([]);
    await env.DB.delete(swapReqKey(peerId, id));
    return say(env, peerId, TEXT.swapNo(r.alias));
  }
  if (kind === 'swy') {
    if (!(await env.DB.get(swapReqKey(peerId, id)))) {
      await ack('That request has expired.');
      return setKb([]);
    }
    await ack();
    await setKb([]);
    return doSwap(env, id, r, peerId, p);
  }
  // kind === 'sw': ask, or complete if they already asked me
  const mutual = (await env.DB.get(okKey(id, peerId))) && (await env.DB.get(okKey(peerId, id)));
  if (!mutual) {
    await ack();
    return say(env, id, TEXT.swapNeedChat(p.alias));
  }
  if (await env.DB.get(blkKey(peerId, id))) {
    await ack();
    return say(env, id, TEXT.cantDeliver);
  }
  if (await env.DB.get(swapReqKey(peerId, id))) {
    await ack();
    return doSwap(env, id, r, peerId, p);
  }
  await env.DB.put(swapReqKey(id, peerId), '1', { expirationTtl: 7 * 86400 });
  await ack();
  await say(env, peerId, TEXT.swapAsk(r.alias), [[btn('Yes, swap handles', `swy|${id}`), btn('Not now', `swn|${id}`)]]);
  return say(env, id, TEXT.swapAsked(p.alias));
}

async function doSwap(env, id, r, peerId, p) {
  await env.DB.delete(swapReqKey(id, peerId));
  await env.DB.delete(swapReqKey(peerId, id));
  await env.DB.put(swapDoneKey(id, peerId), new Date().toISOString());
  await tg(env, 'sendMessage', { chat_id: id, text: TEXT.swapDone(esc(p.alias), handleLink(peerId, p)), parse_mode: 'HTML' });
  await tg(env, 'sendMessage', { chat_id: peerId, text: TEXT.swapDone(esc(r.alias), handleLink(id, r)), parse_mode: 'HTML' });
}

// ---------- members, Rooms and votes ----------

const roomKey = (room) => `room:${room}`;
const roomList = async (env, room) => JSON.parse((await env.DB.get(roomKey(room))) || '[]');
async function roomAdd(env, room, uid) {
  const l = await roomList(env, room);
  if (!l.includes(String(uid))) l.push(String(uid));
  await env.DB.put(roomKey(room), JSON.stringify(l));
  await roomsIndex(env, room);
}
async function roomRemove(env, room, uid) {
  const l = (await roomList(env, room)).filter((x) => x !== String(uid));
  await env.DB.put(roomKey(room), JSON.stringify(l));
}
async function roomsIndex(env, room) {
  const all = JSON.parse((await env.DB.get('rooms')) || '[]');
  if (!all.includes(room)) {
    all.push(room);
    await env.DB.put('rooms', JSON.stringify(all));
  }
  return all;
}

const istLabel = (ms) => {
  const x = new Date(ms + IST_MS);
  const hm = `${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
  return `${DOW[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}, ${timeLabel(hm)}`;
};
const voteKey = (aid) => `v:${aid}`;
const getVote = async (env, aid) => JSON.parse((await env.DB.get(voteKey(aid))) || 'null');
const putVote = (env, aid, v) => env.DB.put(voteKey(aid), JSON.stringify(v), { expirationTtl: TTL });
const openList = async (env) => JSON.parse((await env.DB.get('votes:open')) || '[]');
async function setOpen(env, aid, on) {
  let l = (await openList(env)).filter((x) => x !== String(aid));
  if (on) l.push(String(aid));
  await env.DB.put('votes:open', JSON.stringify(l));
}
const need = (n) => Math.floor(n / 2) + 1; // more than half
const tally = (v) => `${v.yes.length} yes, ${v.no.length} no of ${v.electorate.length}`;
const voteLine = (v) =>
  v.status === 'open'
    ? `Open: ${tally(v)} · closes ${istLabel(v.deadline)}`
    : `${v.status === 'admitted' ? 'Admitted' : v.status === 'declined' ? 'Declined' : 'Founder to decide'} (${tally(v)}${v.how ? ' · ' + v.how : ''})`;

async function openVote(env, chat, aid, a) {
  if (a.member) return say(env, chat, `${a.alias} is already a member.`);
  const existing = await getVote(env, aid);
  if (existing && existing.status === 'open') return say(env, chat, `A vote on ${a.alias} is already open (${tally(existing)}).`);
  if (needsVouch(env, a))
    return say(env, chat, `${a.alias} needs a member’s vouch before the Room can vote (${vouchStatus(env, a)}). A founder can still decide directly with /admit or /decline.`);
  const room = roomOf(env, a);
  const electorate = [];
  for (const uid of await roomList(env, room)) {
    if (uid === String(aid)) continue;
    const m = await getRec(env, uid);
    if (!m || !m.member || m.member.suspended) continue;
    if (m.member.sitOut > 0) {
      m.member.sitOut -= 1;
      await putRec(env, uid, m);
      continue;
    }
    electorate.push(uid);
  }
  if (!electorate.length) {
    a.stage = 'Founder to decide';
    await putRec(env, aid, a);
    await sheetPerson(env, a);
    return say(env, chat, `No one in ${room} can vote yet, so this is the founder’s call: reply /admit or /decline to ${a.alias}’s card.`);
  }
  const now = Date.now();
  const v = { aid: String(aid), room, opened: now, deadline: now + voteHours(env) * 3600 * 1000, electorate, yes: [], no: [], status: 'open', reminded: false };
  if (a.voucherId && electorate.includes(a.voucherId)) v.yes.push(a.voucherId);
  await putVote(env, aid, v);
  await setOpen(env, aid, true);
  a.stage = 'Voting';
  a.voteLine = voteLine(v);
  await putRec(env, aid, a);
  await sheetPerson(env, a);
  let reached = 0;
  for (const uid of electorate) {
    if (v.yes.includes(uid)) {
      await say(env, uid, `🗳 ${a.alias}’s vote in ${room} is open. Your vouch already counts as your yes. Closes ${istLabel(v.deadline)} (India time).`);
      reached++;
      continue;
    }
    const sent = await say(env, uid, TEXT.voteQ(a, room, istLabel(v.deadline), electorate.length), [[btn('Yes', `v|y|${aid}`), btn('No', `v|n|${aid}`)]]);
    if (sent && sent.ok) reached++;
  }
  await say(env, chat, `🗳 Vote opened on ${a.alias} in ${room}: ${electorate.length} voter${electorate.length === 1 ? '' : 's'} (${reached} reached), closes ${istLabel(v.deadline)} IST.${v.yes.length ? ' Their voucher’s yes is counted.' : ''}`);
  return settle(env, v, a, false);
}

async function onVoteButton(env, q, ack, setKb) {
  const [, val, aid] = q.data.split('|');
  const uid = String(q.from.id);
  const v = await getVote(env, aid);
  if (!v || v.status !== 'open') {
    await ack(TEXT.voteClosed);
    return setKb([]);
  }
  if (!v.electorate.includes(uid)) return ack('You’re not a voter on this one.');
  if (v.yes.includes(uid) || v.no.includes(uid)) {
    await ack('You’ve already voted.');
    return setKb([]);
  }
  (val === 'y' ? v.yes : v.no).push(uid);
  await putVote(env, aid, v);
  await ack(TEXT.voteNoted(val));
  await setKb([]);
  await say(env, uid, TEXT.voteNoted(val));
  const a = await getRec(env, aid);
  if (!a) return dropVote(env, aid);
  a.voteLine = voteLine(v);
  await putRec(env, aid, a);
  await sheetPerson(env, a);
  return settle(env, v, a, false);
}

// Decide early when the result can no longer change; otherwise at the deadline.
async function settle(env, v, a, atDeadline) {
  const n = v.electorate.length;
  const cast = v.yes.length + v.no.length;
  if (v.yes.length >= need(n)) return closeVote(env, v, a, 'admitted');
  if (v.no.length >= need(n)) return closeVote(env, v, a, 'declined');
  if (!atDeadline && cast < n) return;
  if (cast < need(n)) return closeVote(env, v, a, 'founder', `too few votes (${cast} of ${n}; ${need(n)} needed)`);
  if (v.yes.length > v.no.length) return closeVote(env, v, a, 'admitted');
  if (v.no.length > v.yes.length) return closeVote(env, v, a, 'declined');
  return closeVote(env, v, a, 'founder', 'a tie');
}

async function closeVote(env, v, a, result, why) {
  v.status = result;
  v.closed = Date.now();
  if (why) v.how = why;
  await putVote(env, v.aid, v);
  await setOpen(env, v.aid, false);
  a.voteLine = voteLine(v);
  if (result === 'admitted') return admit(env, v.aid, a, `Room vote: ${tally(v)}`);
  if (result === 'declined') return decline(env, v.aid, a, `Room vote: ${tally(v)}`);
  a.stage = 'Founder to decide';
  await putRec(env, v.aid, a);
  await sheetPerson(env, a);
  const sent = await say(env, env.TEAM_CHAT_ID, `⚖️ The vote on ${label(a)} in ${v.room} ended in ${why} (${tally(v)}). Founder’s call:`, [
    [btn('Admit', `fd|a|${v.aid}`), btn('Decline', `fd|d|${v.aid}`)],
  ]);
  if (sent && sent.ok) await link(env, sent.result.message_id, v.aid);
}

async function admit(env, aid, a, how) {
  const room = roomOf(env, a);
  a.member = { room, since: new Date().toISOString(), breaches: 0, sitOut: 0, suspended: false };
  a.stage = 'Admitted';
  a.vouchNeeded = false;
  await putRec(env, aid, a);
  await roomAdd(env, room, aid);
  await sheetPerson(env, a);
  await say(env, aid, TEXT.admitted(room));
  await say(env, aid, 'Hey love, we have news. The members said yes.\n\nWelcome home, ' + (a.alias || 'love') + '. You are one of us now, and your Sigil is ready to be lit.', [[{ text: '✦ Light my Sigil', web_app: { url: APP_URL + '#lit' } }]]);
  const inv = await inviteLink(env, aid, a);
  if (inv) await say(env, aid, TEXT.joinGroup, [[{ text: 'Join Dionysty Invitations', url: inv }]]);
  else if (env.INVITE_CHAT_ID) await team(env, `⚠️ Couldn’t create a group link for ${label(a)} — add them to Dionysty Invitations by hand (is the bot still an admin there?).`);
  const n = (await roomList(env, room)).length;
  await announceToVillage(env, aid, a, room);
  const sent = await team(env, `✅ ${label(a)} is in: ${room} now has ${n} member${n === 1 ? '' : 's'}. (${how})`);
  if (sent && sent.ok) await link(env, sent.result.message_id, aid);
}

// A personal join-request link: forwarding it lets no one else in, because the bot approves
// requests only from admitted members.
async function inviteLink(env, aid, a) {
  if (!env.INVITE_CHAT_ID) return null;
  const res = await tg(env, 'createChatInviteLink', {
    chat_id: env.INVITE_CHAT_ID,
    name: String(a.alias || 'member').slice(0, 32),
    creates_join_request: true,
    expire_date: Math.floor(Date.now() / 1000) + 30 * 86400,
  });
  return res && res.ok ? res.result.invite_link : null;
}

async function onJoinRequest(q, env) {
  if (!env.INVITE_CHAT_ID || String(q.chat.id) !== String(env.INVITE_CHAT_ID)) return;
  const r = await getRec(env, q.from.id);
  const ok = !!(r && r.member);
  await tg(env, ok ? 'approveChatJoinRequest' : 'declineChatJoinRequest', { chat_id: q.chat.id, user_id: q.from.id });
  if (ok) {
    r.inGroup = true;
    await putRec(env, q.from.id, r);
    const sent = await team(env, `🚪 ${label(r)} joined Dionysty Invitations.`);
    if (sent && sent.ok) await link(env, sent.result.message_id, q.from.id);
  } else await team(env, `🛑 Declined a request to join Dionysty Invitations from someone who isn’t an admitted member (${q.from.username ? '@' + q.from.username : 'no username'}).`);
}

async function decline(env, aid, a, how) {
  a.stage = 'Declined';
  await putRec(env, aid, a);
  await sheetPerson(env, a);
  const sent = await team(env, `✖️ ${label(a)} was not admitted (${how}). They haven’t been told: reply to this message to write to them.`);
  if (sent && sent.ok) await link(env, sent.result.message_id, aid);
}

const isFounder = (env, uid) => {
  const ids = String(env.FOUNDER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return !ids.length || ids.includes(String(uid));
};

async function founderDecide(env, aid, a, yes, who) {
  const v = await getVote(env, aid);
  if (v && v.status !== 'admitted' && v.status !== 'declined') {
    v.status = yes ? 'admitted' : 'declined';
    v.how = `founder decided${v.how ? ' after ' + v.how : ''}`;
    v.closed = Date.now();
    await putVote(env, aid, v);
    await setOpen(env, aid, false);
    a.voteLine = voteLine(v);
  } else if (!v) a.voteLine = `${yes ? 'Admitted' : 'Declined'} by founder`;
  return yes ? admit(env, aid, a, `founder’s decision, ${who}`) : decline(env, aid, a, `founder’s decision, ${who}`);
}

async function onFounderButton(env, q, ack, setKb) {
  const [, val, aid] = q.data.split('|');
  if (!isFounder(env, q.from.id)) return ack('Only a founder can decide this.');
  const a = await getRec(env, aid);
  await ack();
  await setKb([]);
  if (!a) return team(env, 'That person’s record no longer exists.');
  if (a.member || a.stage === 'Declined') return team(env, `${a.alias} has already been decided.`);
  return founderDecide(env, aid, a, val === 'a', q.from.first_name || 'founder');
}

async function dropVote(env, aid) {
  await env.DB.delete(voteKey(aid));
  await setOpen(env, aid, false);
}

async function sweepVotes(env) {
  const now = Date.now();
  for (const aid of await openList(env)) {
    const v = await getVote(env, aid);
    const a = await getRec(env, aid);
    if (!v || v.status !== 'open' || !a) {
      await setOpen(env, aid, false);
      continue;
    }
    if (now >= v.deadline) {
      await settle(env, v, a, true);
      continue;
    }
    if (!v.reminded && now >= v.opened + (v.deadline - v.opened) / 2) {
      for (const uid of v.electorate)
        if (!v.yes.includes(uid) && !v.no.includes(uid)) await say(env, uid, TEXT.voteReminder(a.alias, istLabel(v.deadline)));
      v.reminded = true;
      await putVote(env, aid, v);
    }
  }
}

// A vouched person broke the Charter: 1st and 2nd time the voucher sits out votes; 3rd time, suspended.
async function breach(env, chat, aid, a) {
  if (!a.voucherId) return say(env, chat, `${a.alias} had no confirmed vouch, so no member is affected. Handle the breach itself under the Charter.`);
  const m = await getRec(env, a.voucherId);
  if (!m || !m.member) return say(env, chat, 'Their voucher is no longer a member.');
  m.member.breaches = (m.member.breaches || 0) + 1;
  let note;
  if (m.member.breaches >= BREACHES_TO_SUSPEND) {
    m.member.suspended = true;
    note = `This is the ${m.member.breaches}${m.member.breaches === 3 ? 'rd' : 'th'} time: ${m.alias} loses their vote until the council reinstates it (/reinstate on their card).`;
  } else {
    m.member.sitOut = (m.member.sitOut || 0) + SIT_OUT_VOTES;
    note = `Breach ${m.member.breaches} of ${BREACHES_TO_SUSPEND}: ${m.alias} sits out the next ${SIT_OUT_VOTES} votes.`;
  }
  await putRec(env, a.voucherId, m);
  await sheetPerson(env, m);
  a.breach = (a.breach || 0) + 1;
  a.flag = a.flag || `Charter breach ${a.breach}`;
  await putRec(env, aid, a);
  await sheetPerson(env, a);
  const sent = await say(env, chat, `📕 Charter breach recorded for ${a.alias} (vouched by ${m.alias}). ${note}`);
  if (sent && sent.ok) await link(env, sent.result.message_id, a.voucherId);
}

async function listMembers(env, chat) {
  const rooms = JSON.parse((await env.DB.get('rooms')) || '[]');
  const lines = [];
  for (const room of rooms) {
    const ids = await roomList(env, room);
    const names = [];
    for (const uid of ids) {
      const m = await getRec(env, uid);
      if (m) names.push(`${m.alias}${m.member && m.member.suspended ? ' (vote suspended)' : m.member && m.member.sitOut ? ` (sits out ${m.member.sitOut})` : ''}`);
    }
    lines.push(`${room} — ${names.length} of 50\n${names.map((x) => '• ' + x).join('\n') || '• (no one yet)'}`);
  }
  const open = [];
  for (const aid of await openList(env)) {
    const v = await getVote(env, aid);
    const a = await getRec(env, aid);
    if (v && a) open.push(`• ${a.alias} (${v.room}): ${tally(v)}, closes ${istLabel(v.deadline)}`);
  }
  return say(env, chat, (lines.join('\n\n') || 'No members yet. Reply /admit to someone’s card to admit the first.') + (open.length ? `\n\nOpen votes:\n${open.join('\n')}` : ''));
}

async function toTemples(env, id, r, note) {
  r.step = 'temple';
  r.tsel = [];
  await putRec(env, id, r);
  if (note) await say(env, id, note);
  return say(env, id, TEXT.askTemple(), templeButtons(r.tsel));
}

async function toInvite(env, id, r) {
  r.step = 'invite';
  await putRec(env, id, r);
  return say(env, id, TEXT.askInvite(vouchRequired(env, r)), [[btn('Skip', 'invite|skip')]]);
}

function reprompt(env, id, r) {
  if (r.step === 'age') return say(env, id, TEXT.agePrompt, ageButtons());
  if (r.step === 'alias') return say(env, id, TEXT.askAlias);
  if (r.step === 'gender') return say(env, id, TEXT.askGender(r.alias), genderButtons());
  if (r.step === 'mode') return say(env, id, TEXT.askMode, modeButtons());
  if (r.step === 'with') return say(env, id, TEXT.askWith(r.mode), [[btn('Skip', 'with|skip')]]);
  if (r.step === 'temple') return say(env, id, TEXT.askTemple(), templeButtons(r.tsel || []));
  if (r.step === 'why') return say(env, id, TEXT.askWhy, [[btn('Skip', 'why|skip')]]);
  if (r.step === 'want') return say(env, id, TEXT.askWant, [[btn('Skip', 'want|skip')]]);
  if (r.step === 'invite') return say(env, id, TEXT.askInvite(vouchRequired(env, r)), [[btn('Skip', 'invite|skip')]]);
  if (r.step === 'reddit') return say(env, id, TEXT.askReddit, [[btn('Skip', 'reddit|skip')]]);
}

// ---------- team side ----------

async function onTeam(m, cmd, env) {
  const chat = m.chat.id;
  if (cmd === '/export') return exportCsv(env);
  if (cmd === '/help') return say(env, chat, TEXT.teamHelp);
  if (cmd === '/calls') return listCalls(env, chat);
  if (cmd === '/members') return listMembers(env, chat);

  const ref = m.reply_to_message;
  if (!ref) return;
  const uid = await env.DB.get(`m:${ref.message_id}`);
  if (!uid) {
    if (cmd) return say(env, chat, 'I can’t link that to an applicant. Reply to one of my cards or relayed messages.');
    return;
  }
  const r = await getRec(env, uid);
  if (!r) return say(env, chat, 'That record no longer exists (deleted or expired).');

  if (cmd === '/vote') return openVote(env, chat, uid, r);
  if (cmd === '/admit' || cmd === '/decline' || cmd === '/reinstate') {
    if (!isFounder(env, m.from.id)) return say(env, chat, 'Only a founder can do that.');
    if (cmd === '/reinstate') {
      if (!r.member) return say(env, chat, `${r.alias} isn’t a member.`);
      r.member.suspended = false;
      r.member.breaches = 0;
      r.member.sitOut = 0;
      await putRec(env, uid, r);
      await sheetPerson(env, r);
      return say(env, chat, `${r.alias}’s vote is restored (breach count reset).`);
    }
    if (r.step !== 'chatting') return say(env, chat, `${r.alias} hasn’t finished saying hello yet.`);
    if (r.member) return say(env, chat, `${r.alias} is already a member of ${r.member.room}.`);
    return founderDecide(env, uid, r, cmd === '/admit', m.from.first_name || 'founder');
  }
  if (cmd === '/room') {
    const room = m.text.split(/\s+/).slice(1).join(' ').trim().slice(0, 40);
    if (!room) return say(env, chat, 'Usage: reply with /room Village 2');
    if (r.member) {
      await roomRemove(env, r.member.room, uid);
      r.member.room = room;
      await roomAdd(env, room, uid);
    } else await roomsIndex(env, room);
    r.room = room;
    await putRec(env, uid, r);
    await sheetPerson(env, r);
    return say(env, chat, `${r.alias} → ${room}${r.member ? ' (moved fully, with their vote)' : ''}.`);
  }
  if (cmd === '/breach') return breach(env, chat, uid, r);
  if (cmd === '/invite') {
    if (!r.member) return say(env, chat, `${r.alias} isn’t a member yet.`);
    const inv = await inviteLink(env, uid, r);
    if (!inv) return say(env, chat, 'Couldn’t create a link — check INVITE_CHAT_ID and that the bot is an admin of Dionysty Invitations.');
    await say(env, uid, TEXT.joinGroup, [[{ text: 'Join Dionysty Invitations', url: inv }]]);
    return say(env, chat, `Sent ${r.alias} a fresh link to Dionysty Invitations.`);
  }
  if (cmd === '/remove') {
    if (r.member && env.INVITE_CHAT_ID) {
      await tg(env, 'banChatMember', { chat_id: env.INVITE_CHAT_ID, user_id: uid });
      await tg(env, 'unbanChatMember', { chat_id: env.INVITE_CHAT_ID, user_id: uid, only_if_banned: true });
    }
    if (r.member) await roomRemove(env, r.member.room, uid);
    await dropVote(env, uid);
    await delRec(env, uid, r);
    if (r.code) await sheet(env, 'delete', { code: r.code });
    return say(env, chat, `Deleted ${label(r)} from the bot and the Village Ledger.`);
  }
  if (cmd === '/flag') {
    const why = m.text.split(/\s+/).slice(1).join(' ').trim().slice(0, 120) || 'Flagged by team';
    r.flag = why;
    await putRec(env, uid, r);
    await sheetPerson(env, r);
    return say(env, chat, `⚠️ Flagged ${label(r)}: ${why}`);
  }
  if (cmd === '/unflag') {
    delete r.flag;
    await putRec(env, uid, r);
    await sheetPerson(env, r);
    return say(env, chat, `Flag cleared for ${label(r)}.`);
  }
  if (cmd === '/stage') {
    const s = m.text.split(/\s+/).slice(1).join(' ').trim().slice(0, 30);
    if (!s) return say(env, chat, 'Usage: reply with /stage Admitted');
    r.stage = s;
    await putRec(env, uid, r);
    await sheetPerson(env, r);
    return say(env, chat, `${label(r)} → ${s}`);
  }
  if (cmd === '/call') {
    const sent = await say(env, uid, TEXT.callInvite(callMins(env)), await dayButtons(env));
    if (!sent.ok) return say(env, chat, `Couldn’t deliver to ${label(r)}.`);
    r.callOffered = true;
    r.stage = 'Call offered';
    r.lastOut = new Date().toISOString();
    await putRec(env, uid, r);
    await sheetPerson(env, r);
    return say(env, chat, `Sent ${label(r)} the day and time picker. You’ll see their booking here.`);
  }
  if (cmd) return;
  if (!m.text) return say(env, chat, 'Text only, please — applicants were promised no photos or files.');

  const sent = await say(env, uid, m.text);
  if (!sent.ok) return say(env, chat, `Couldn’t deliver to ${label(r)} (they may have blocked the bot).`);
  r.lastOut = new Date().toISOString();
  await putRec(env, uid, r);
  await sheet(env, 'message', { p: personRow(r), m: { at: r.lastOut, code: r.code, alias: r.alias, from: 'Team', text: m.text.slice(0, 2000) } });
}

async function listCalls(env, chat) {
  const rows = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 's:', cursor });
    for (const k of page.keys) {
      const slot = k.name.slice(2);
      if (slotUtc(slot) < Date.now() - 3600 * 1000) continue;
      const uid = await env.DB.get(k.name);
      const r = uid && (await getRec(env, uid));
      if (r) rows.push([slot, `• ${slotLabel(slot)} — ${label(r)}`]);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return say(env, chat, rows.length ? 'Upcoming calls (IST):\n' + rows.map((x) => x[1]).join('\n') : 'No upcoming calls booked.');
}

async function exportCsv(env) {
  const rows = [[
    'Name (alias)', 'Stage', 'Next action', 'Follow-up due', 'Reddit handle', 'Contact', 'Drawn to',
    'First contact', 'Call date', 'Decision', 'Email OK?', 'Telegram OK?', 'Charter', 'Notes (minimal)', 'Delete by',
  ]];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 'u:', cursor });
    for (const k of page.keys) {
      const r = await getRec(env, k.name.slice(2));
      if (!r || r.step !== 'chatting') continue;
      const notes = `Code ${r.code || '—'}${r.invitedBy ? '; invited by ' + r.invitedBy : ''}`;
      rows.push([
        r.alias, r.stage, '', '', r.reddit || '', r.tg || 'via bot', templeNames(templesOf(r)),
        r.first, r.call ? slotLabel(r.call) + ' IST' : '', '', '', '', '', notes, addDays(r.seen || r.first, RETENTION_DAYS),
      ]);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const csv = rows.map((row) => row.map(cell).join(',')).join('\n');
  const fd = new FormData();
  fd.append('chat_id', String(env.TEAM_CHAT_ID));
  fd.append('document', new Blob([csv], { type: 'text/csv' }), `dionysty-intake-${today()}.csv`);
  fd.append('caption', `${rows.length - 1} applicant(s). Import into the Founder’s Ledger, then delete this file from the chat.`);
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
}

// ---------- call slots (India time) ----------

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// CALL_TIMES ("23:00,23:10,...") wins; else CALL_HOURS ("11,14"); returns ["HH:MM", ...]
const timesOf = (env) =>
  String(env.CALL_TIMES || env.CALL_HOURS || '11,14,17,19,21')
    .split(',')
    .map((x) => x.trim().split(':'))
    .map(([h, m]) => [parseInt(h, 10), parseInt(m || '0', 10)])
    .filter(([h, m]) => h >= 0 && h <= 23 && m >= 0 && m <= 59)
    .map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
const pad = (n) => String(n).padStart(2, '0');
const callMins = (env) => parseInt(env.CALL_MINUTES, 10) || 30;
// slot key: "YYYY-MM-DDTHH:MM" in IST
const slotUtc = (s) =>
  Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +(s.slice(14, 16) || 0)) - IST_MS;
const slotOpen = (s) => slotUtc(s) >= Date.now() + MIN_NOTICE_H * 3600 * 1000;
const timeLabel = (hm) => { const h = +hm.slice(0, 2); return `${h % 12 || 12}:${hm.slice(3, 5) || '00'} ${h < 12 ? 'am' : 'pm'}`; };
function dayLabel(d) {
  const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  return `${DOW[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`;
}
const slotLabel = (s) => `${dayLabel(s.slice(0, 10))}, ${timeLabel(s.slice(11, 16))}`;

async function freeTimes(env, day) {
  const out = [];
  for (const hm of timesOf(env)) {
    const s = `${day}T${hm}`;
    if (slotOpen(s) && !(await env.DB.get(`s:${s}`))) out.push(hm);
  }
  return out;
}

async function dayButtons(env) {
  const nowIst = new Date(Date.now() + IST_MS);
  const days = [];
  for (let i = 0; i <= BOOK_DAYS && days.length < BOOK_DAYS; i++) {
    const x = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate() + i));
    const d = `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
    if ((await freeTimes(env, d)).length) days.push(d);
  }
  const rows = [];
  for (let i = 0; i < days.length; i += 2) rows.push(days.slice(i, i + 2).map((d) => btn(dayLabel(d), 'day|' + d)));
  return rows.length ? rows : [[btn('No times free this week — tell us here', 'days|')]];
}

async function timeButtons(env, day) {
  const hms = await freeTimes(env, day);
  if (!hms.length) return null;
  const rows = [];
  for (let i = 0; i < hms.length; i += 3) rows.push(hms.slice(i, i + 3).map((hm) => btn(timeLabel(hm), `slot|${day}T${hm}`)));
  rows.push([btn('← Other days', 'days|')]);
  return rows;
}

// ---------- helpers ----------

async function tg(env, method, body) {
  if (body && String(body.chat_id || '').startsWith('bot:')) return { ok: false, description: 'lab bot' };
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const say = (env, chat_id, text, buttons) =>
  tg(env, 'sendMessage', {
    chat_id,
    text,
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });

const team = (env, text) => (env.TEAM_CHAT_ID ? say(env, env.TEAM_CHAT_ID, text) : null);
const btn = (text, data) => ({ text, callback_data: data });
const ageButtons = () => [[btn('Yes, I’m 18+', 'age|yes'), btn('No', 'age|no')]];
const genderButtons = () => [[btn('A woman', 'g|woman'), btn('A man', 'g|man')], [btn('Non-binary', 'g|nb')]];
const modeButtons = () => [[btn('On my own', 'mode|alone')], [btn('With a partner', 'mode|partner'), btn('With a friend', 'mode|friend')]];
const templeButtons = (sel) => {
  const keys = Object.keys(TEMPLES);
  const rows = [];
  for (const k of keys) rows.push([btn((sel.includes(k) ? '✓ ' : '') + meetLabel(k), 't|' + k)]);
  rows.push([btn(sel.length ? `Done (${sel.length})` : 'Done', 't|done')]);
  return rows;
};

async function newCode(env, id) {
  // Rejection sampling: only bytes below 248 (= 31 × 8) are used, so every character is equally likely.
  const limit = 256 - (256 % CODE_CHARS.length);
  for (let i = 0; i < 10; i++) {
    let code = 'DNY-';
    while (code.length < 4 + CODE_LEN) {
      for (const b of crypto.getRandomValues(new Uint8Array(16))) {
        if (b < limit && code.length < 4 + CODE_LEN) code += CODE_CHARS[b % CODE_CHARS.length];
      }
    }
    if (!(await env.DB.get(`c:${code}`))) {
      await env.DB.put(`c:${code}`, String(id), { expirationTtl: TTL });
      return code;
    }
  }
  throw new Error('could not allocate code');
}

const command = (t) => (t && t.startsWith('/') ? t.split(/\s+/)[0].split('@')[0].toLowerCase() : null);
const handleOf = (u) => (u.username ? '@' + u.username : null);
const label = (r) => `${r.alias || 'unnamed'}${r.tg ? ' (' + r.tg + ')' : ''}`;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};

// ---------- Village Ledger (Google Sheet) ----------

const needsReply = (r) => !!r.lastIn && (!r.lastOut || r.lastIn > r.lastOut);
const personRow = (r) => ({
  code: r.code,
  alias: r.alias,
  needsReply: needsReply(r) ? 'Yes' : '',
  waitingSince: needsReply(r) ? r.lastIn : '',
  stage: r.stage,
  coming: comingLabel(r),
  with: r.withAlias || '',
  temples: templeNames(templesOf(r)),
  why: r.why || '',
  want: r.want || '',
  latest: r.lastMsg || '',
  messages: r.msgs || 0,
  flag: r.flag || '',
  vouchedBy: r.vouch === 'yes' ? r.vouchedBy : r.vouch === 'pending' ? `Waiting for ${r.vouchAsked}` : r.invitedBy || '',
  needsVouch: !r.member && r.vouchNeeded && r.vouch !== 'yes' ? 'Yes' : '',
  vote: r.voteLine || '',
  room: r.member ? r.member.room : r.room || '',
  memberSince: r.member ? r.member.since : '',
  memberNote: r.member ? (r.member.suspended ? 'Vote suspended' : r.member.sitOut ? `Sits out ${r.member.sitOut} votes` : r.member.breaches ? `${r.member.breaches} breach(es) by people they vouched for` : '') : '',
  call: r.call ? new Date(slotUtc(r.call)).toISOString() : '',
  telegram: r.tg || 'via bot',
  reddit: r.reddit || '',
  firstContact: r.first || '',
  lastActive: new Date().toISOString(),
  deleteBy: r.member ? '' : addDays(today(), RETENTION_DAYS),
});
async function sheet(env, op, payload) {
  if (!env.SHEET_URL) return;
  const job = fetch(env.SHEET_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...payload }),
    redirect: 'follow',
  }).catch((e) => console.log('sheet error', e && e.message));
  if (env.__ctx && env.__ctx.waitUntil) env.__ctx.waitUntil(job);
  else await job;
}
const sheetPerson = (env, r) => (r.code ? sheet(env, 'upsert', { p: personRow(r) }) : null);
// Safeguarding: raise a flag for the team to look at; never acts on the person by itself.
function flagFor(text) {
  const s = String(text || '').toLowerCase();
  if (/\b(1[0-7])\s*(yo|y\/o|yrs?|years?)\b|\b(i'?m|i am|age)\s*(1[0-7])\b|\bunder\s*18\b|\bminor\b|\bschool\s*student\b|\bclass\s*(9|10|11|12)\b/.test(s))
    return 'Check: possible under-18';
  if (/\b(unsafe|harass\w*|assault\w*|abuse\w*|threat\w*|blackmail\w*|stalk\w*|police|scared|forced|drugg?ed|spiked|non-?consensual)\b/.test(s))
    return 'Check: safety concern';
  return '';
}

const getRec = async (env, id) => JSON.parse((await env.DB.get(`u:${id}`)) || 'null');
// Members never expire; applicants expire after RETENTION_DAYS without activity.
const putRec = async (env, id, r) => {
  const opt = r.member ? {} : { expirationTtl: TTL };
  await env.DB.put(`u:${id}`, JSON.stringify({ ...r, seen: today() }), opt);
  if (r.code) await env.DB.put(`c:${r.code}`, String(id), opt);
  if (env.D1) await sqSync(env, id, r);
};
const delRec = async (env, id, r) => {
  await env.DB.delete(`u:${id}`);
  if (env.D1) await sqDel(env, id);
  if (r && r.code) await env.DB.delete(`c:${r.code}`);
  if (r && r.call) await env.DB.delete(`s:${r.call}`);
};
const link = (env, teamMsgId, userId) => env.DB.put(`m:${teamMsgId}`, String(userId), { expirationTtl: TTL });

// Call reminders (added 14 Nov 2026). Runs on the */5 cron.
// 22:00 IST: tonight's list to Dionysty Team. ~15 min before: applicant DM with the Meet link.
// ~10 min before: ping in Dionysty Team. Each sent once (rem:* keys expire after 2 days).
async function callReminders(env) {
  const now = Date.now();
  const nowIst = new Date(now + IST_MS);
  const day = nowIst.toISOString().slice(0, 10);
  const link = env.CALL_LINK || '';
  const once = async (key) => {
    if (await env.DB.get(key)) return false;
    await env.DB.put(key, '1', { expirationTtl: 172800 });
    return true;
  };
  if (nowIst.getUTCHours() === 22 && (await once(`rem:d:${day}`))) {
    const lines = [];
    for (const hm of timesOf(env)) {
      const s = `${day}T${hm}`;
      if (slotUtc(s) < now) continue;
      const uid = await env.DB.get(`s:${s}`);
      if (!uid) continue;
      const r = await getRec(env, uid);
      lines.push(`• ${timeLabel(hm)} · ${r ? label(r) : 'unknown'}`);
    }
    if (lines.length) await team(env, `📋 Tonight's verification calls (IST):\n${lines.join('\n')}${link ? '\n\nMeet: ' + link : ''}`);
  }
  for (const d of [day, addDays(day, 1)]) {
    for (const hm of timesOf(env)) {
      const s = `${d}T${hm}`;
      const mins = (slotUtc(s) - now) / 60000;
      if (mins <= 0 || mins > 16) continue;
      const uid = await env.DB.get(`s:${s}`);
      if (!uid) continue;
      const r = await getRec(env, uid);
      if (await once(`rem:a:${s}`))
        await say(env, uid, `Reminder: your DIONYSTY call is at ${timeLabel(hm)} IST, in about ${Math.round(mins)} minutes.${link ? '\nJoin here: ' + link : ''}\nIf you can't make it, send /book to pick another time.`);
      if (mins <= 11 && (await once(`rem:t:${s}`)))
        await team(env, `📞 ${r ? label(r) : 'Call'} in ${Math.round(mins)} min (${timeLabel(hm)} IST)${link ? '\n' + link : ''}`);
    }
  }
}


// ===== Web app API: registration Mini App (added 14 Nov 2026) =====
// The app at APP_URL opens inside Telegram; it proves who the person is with Telegram's signed initData,
// and reads/writes the same u:<id> records as the chat, so admissions, votes and welcomes are unchanged.
const APP_URL = 'https://dionysty.pages.dev/app/';
const SIGIL_ORDER = ['artists', 'revellers', 'lovers', 'healers', 'wanderers', 'thinkers', 'builders'];
const SIGIL_BUDGET = 10;
const SIGIL_MAX = 5;

function apiCors(req) {
  const o = req.headers.get('Origin') || '';
  const ok = /^https:\/\/([a-z0-9-]+\.)?dionysty\.pages\.dev$/.test(o);
  return { 'Access-Control-Allow-Origin': ok ? o : 'https://dionysty.pages.dev', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
}
function apiJson(req, body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, apiCors(req)) });
}
async function tgWebAppUser(env, initData) {
  if (!initData || typeof initData !== 'string') return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const pairs = [];
  for (const kv of p.entries()) pairs.push(kv);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dcs = pairs.map((x) => x[0] + '=' + x[1]).join('\n');
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(env.BOT_TOKEN));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k2, enc.encode(dcs)));
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get('auth_date') || 0);
  if (!(age < 86400)) return null;
  try { return JSON.parse(p.get('user') || 'null'); } catch (e) { return null; }
}
async function tgLoginUser(env, login) { if (!login || typeof login !== 'object' || !login.hash || !login.id) return null; const keys = Object.keys(login).filter((k) => k !== 'hash' && login[k] !== undefined && login[k] !== null && login[k] !== '').sort(); const dcs = keys.map((k) => k + '=' + login[k]).join(String.fromCharCode(10)); const enc = new TextEncoder(); const secret = await crypto.subtle.digest('SHA-256', enc.encode(env.BOT_TOKEN)); const hk = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hk, enc.encode(dcs))); const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join(''); if (hex !== String(login.hash)) return null; if (!(Date.now() / 1000 - Number(login.auth_date || 0) < 2592000)) return null; return { id: Number(login.id), first_name: login.first_name || '', last_name: login.last_name || '', username: login.username || '' }; } function cleanPoints(input) {
  const out = {};
  let total = 0;
  for (const k of SIGIL_ORDER) {
    let n = Math.floor(Number(input && input[k]) || 0);
    if (n < 0) n = 0;
    if (n > SIGIL_MAX) return null;
    out[k] = n;
    total += n;
  }
  if (total > SIGIL_BUDGET) return null;
  return out;
}
function templesFromPoints(pts) {
  const ks = SIGIL_ORDER.filter((k) => pts[k] > 0).sort((a, b) => pts[b] - pts[a]);
  return ks.length ? ks : ['unsure'];
}
async function recByCode(env, code) {
  const c = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!c) return null;
  const uid = await env.DB.get('c:' + c);
  if (!uid) return null;
  const rec = await getRec(env, uid);
  return rec ? { uid: uid, rec: rec } : null;
}
function apiView(r) {
  if (!r) return { exists: false };
  return { exists: true, alias: r.alias || '', code: r.code || '', member: !!r.member, done: !!r.code, points: r.points || null,
    temples: templesOf(r), stage: r.stage || '', call: r.call || '', callOffered: !!r.callOffered,
    room: r.member ? r.member.room || '' : '', since: r.member ? r.member.since || '' : '' };
}
async function api(req, url, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: apiCors(req) });
  if (req.method !== 'POST') return apiJson(req, { ok: false, error: 'method' }, 405);
  let body = {};
  try { body = await req.json(); } catch (e) { return apiJson(req, { ok: false, error: 'bad json' }, 400); }
  const user = (await tgWebAppUser(env, body.initData)) || (await tgLoginUser(env, body.login));
  if (!user || !user.id) return apiJson(req, { ok: false, error: 'auth' }, 401);
  const id = String(user.id);
  let r = await getRec(env, id);
  const path = url.pathname;
  const bad = (field, error) => apiJson(req, { ok: false, field: field, error: error }, 400);
  if (path === '/api/me') { const v = apiView(r); v.team = await isTeam(env, id); return apiJson(req, { ok: true, me: v }); }
  const extra = await api2(req, url, env, body, user, id, r);
  if (extra) return extra;
  if (path === '/api/sigil') {
    if (!r || !r.code) return bad('', 'Say hello first.');
    if (body.points) {
      const pts = cleanPoints(body.points);
      if (!pts) return bad('points', 'Up to 10 points, at most 5 in one temple.');
      r.points = pts;
      r.temples = templesFromPoints(pts);
    }
    if (typeof body.alias === 'string') {
      const a = body.alias.trim();
      if (!a || a.length > 40) return bad('alias', 'Choose a name of up to 40 characters.');
      r.alias = a;
    }
    await putRec(env, id, r);
    await sheetPerson(env, r);
    return apiJson(req, { ok: true, me: apiView(r) });
  }
  if (path === '/api/register') {
    if (r && r.code) return apiJson(req, { ok: true, me: apiView(r), already: true });
    if (body.adult !== true) return bad('adult', 'DIONYSTY is for adults (18+) only.');
    const alias = String(body.alias || '').trim();
    if (!alias || alias.length > 40) return bad('alias', 'Choose a name of up to 40 characters.');
    if (['woman', 'man', 'nb'].indexOf(body.gender) < 0) return bad('gender', 'Please choose one.');
    if (['alone', 'partner', 'friend'].indexOf(body.mode) < 0) return bad('mode', 'Please choose one.');
    const pts = cleanPoints(body.points);
    if (!pts) return bad('points', 'Up to 10 points, at most 5 in one temple.');
    const why = String(body.why || '').trim();
    const want = String(body.want || '').trim();
    if (why.length > 500 || want.length > 500) return bad('why', 'Keep each answer under 500 characters.');
    let withHit = null;
    let inviteHit = null;
    if (body.mode !== 'alone' && body.withCode) {
      withHit = await recByCode(env, body.withCode);
      if (!withHit || withHit.uid === id) return bad('withCode', 'We couldn’t find that code. Check it, or leave it empty.');
    }
    if (body.invite) {
      inviteHit = await recByCode(env, body.invite);
      if (!inviteHit || inviteHit.uid === id) return bad('invite', 'We couldn’t find that code. Check it, or leave it empty.');
      if (!inviteHit.rec.member) return bad('invite', 'That code isn’t a member’s yet. Ask a member for theirs, or leave it empty.');
    }
    r = Object.assign({ stage: 'Intro', first: today() }, r || {});
    if (user.username) r.tg = '@' + user.username;
    r.alias = alias;
    r.gender = body.gender;
    r.mode = body.mode;
    r.points = pts;
    r.temples = templesFromPoints(pts);
    if (why) r.why = why;
    if (want) r.want = want;
    const reddit = String(body.reddit || '').trim().slice(0, 60);
    if (reddit) r.reddit = reddit;
    r.via = 'app';
    if (withHit) {
      linkWith(r, withHit);
      const other = withHit.rec;
      if (!other.withId) {
        other.withId = id;
        other.withAlias = r.alias;
        await putRec(env, withHit.uid, other);
        await sheetPerson(env, other);
      }
    }
    if (inviteHit) {
      r.vouch = 'pending';
      r.vouchAsked = inviteHit.rec.alias;
      r.vouchFromId = inviteHit.uid;
    }
    await finish(env, id, r);
    if (inviteHit) {
      await say(env, inviteHit.uid, TEXT.vouchQ(r, roomOf(env, inviteHit.rec)), [[btn('Yes, I vouch', 'vb|y|' + id), btn('I don’t know them', 'vb|n|' + id)]]);
      await say(env, id, TEXT.vouchAsked(inviteHit.rec.alias));
    }
    return apiJson(req, { ok: true, me: apiView(await getRec(env, id)) });
  }
  return apiJson(req, { ok: false, error: 'not found' }, 404);
}


// ===== Phase 2: admission moment, member pass, door check (added 14 Nov 2026) =====
// Door passes rotate every 30 s: DY1-<code>-<window>-<signature>. Only people in the Dionysty Team chat can check them.
const PASS_STEP_MS = 30000;
async function passSig(env, code, w) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode('door:' + env.BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(code + ':' + w)));
  return Array.from(sig.slice(0, 6)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function makePass(env, code) {
  const w = Math.floor(Date.now() / PASS_STEP_MS);
  return { token: 'DY1-' + code + '-' + w.toString(36) + '-' + (await passSig(env, code, w)), validFor: Math.round(((w + 1) * PASS_STEP_MS - Date.now()) / 1000) };
}
async function readPass(env, token) {
  const m = /^DY1-([A-Z0-9]+)-([a-z0-9]+)-([0-9a-f]{12})$/.exec(String(token || '').trim());
  if (!m) return { ok: false, reason: 'Not a DIONYSTY pass.' };
  const w = parseInt(m[2], 36);
  const now = Math.floor(Date.now() / PASS_STEP_MS);
  if (!(w === now || w === now - 1 || w === now - 2)) return { ok: false, reason: 'This pass has expired. Ask them to open it again (screenshots don’t work).' };
  if ((await passSig(env, m[1], w)) !== m[3]) return { ok: false, reason: 'This pass isn’t genuine.' };
  return { ok: true, code: m[1] };
}
async function isTeam(env, userId) {
  if (!env.TEAM_CHAT_ID) return false;
  try {
    const res = await tg(env, 'getChatMember', { chat_id: env.TEAM_CHAT_ID, user_id: Number(userId) });
    const st = res && res.ok && res.result && res.result.status;
    return st === 'creator' || st === 'administrator' || st === 'member' || (st === 'restricted' && res.result.is_member);
  } catch (e) { return false; }
}
const teamKb = (env, text, kb) => (env.TEAM_CHAT_ID ? say(env, env.TEAM_CHAT_ID, text, kb) : null); async function villageView(env, id, r) { const room = r ? roomOf(env, r) : (env.DEFAULT_ROOM || 'Village 1'); const people = []; let cursor; do { const page = await env.DB.list({ prefix: 'u:', cursor }); for (const k of page.keys) { const uid = k.name.slice(2); const p = await getRec(env, uid); if (!p || !p.code || p.stage === 'Declined' || roomOf(env, p) !== room) continue; people.push({ alias: p.alias || '', code: p.code, member: !!p.member, points: p.points || null, temples: templesOf(p), me: uid === String(id), since: p.member ? p.member.since || '' : '' }); } cursor = page.list_complete ? null : page.cursor; } while (cursor); people.sort((a, b) => (b.member - a.member) || String(a.alias).localeCompare(String(b.alias))); return { room: room, people: people.slice(0, 200) }; } async function api2(req, url, env, body, user, id, r) {
  if (url.pathname.startsWith('/api/sq/') || url.pathname === '/api/village') return sqApi(req, url.pathname === '/api/village' ? '/api/sq/village' : url.pathname, env, body, user, id, r);
  const path = url.pathname; if (path === '/api/village') return apiJson(req, Object.assign({ ok: true }, await villageView(env, id, r)));
  if (path === '/api/pass') {
    if (!r || !r.member || !r.code) return apiJson(req, { ok: false, error: 'Door passes are for members.' }, 403);
    return apiJson(req, Object.assign({ ok: true }, await makePass(env, r.code)));
  }
  if (path === '/api/door') {
    if (!(await isTeam(env, id))) return apiJson(req, { ok: false, error: 'Only the DIONYSTY team can check passes.' }, 403);
    const p = await readPass(env, body.token);
    if (!p.ok) return apiJson(req, { ok: true, valid: false, reason: p.reason });
    const hit = await recByCode(env, p.code);
    if (!hit || !hit.rec.member) return apiJson(req, { ok: true, valid: false, reason: 'Not a current member.' });
    const m = hit.rec;
    return apiJson(req, { ok: true, valid: true, alias: m.alias || '', code: m.code, points: m.points || null, temples: templesOf(m),
      room: m.member.room || '', since: m.member.since || '', suspended: !!m.member.suspended });
  }
  return null;
}

/* ===== Village Square, bonds and the waitlist (added 18 Nov 2026). D1 binding: D1. BOND_TARGET (default 3) = bonds with members that carry an applicant in. ===== */
let SQ_READY = false;
const SQ_BASE = 'https://dionysty.pages.dev/app/';
const SQ_APP = SQ_BASE + '#go';
const sqTarget = (env) => Math.max(1, Math.floor(Number(env.BOND_TARGET) || 3));
const sqParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
async function sqPid(env, uid) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode('pid:' + env.BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(String(uid))));
  return Array.from(s.slice(0, 6)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sqSync(env, id, r) {
  if (!env.D1 || !r) return;
  try {
    const pid = await sqPid(env, id);
    await env.D1.prepare('INSERT INTO people (uid, pid, room, alias, done, member, points, temples, stage, since, need, flag, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) ON CONFLICT (uid) DO UPDATE SET pid = ?2, room = ?3, alias = ?4, done = ?5, member = ?6, points = ?7, temples = ?8, stage = ?9, since = ?10, need = ?11, flag = ?12, at = ?13')
      .bind(String(id), pid, roomOf(env, r), r.alias || '', r.code ? 1 : 0, r.member && !r.member.suspended ? 1 : 0, JSON.stringify(r.points || null), JSON.stringify(templesOf(r)), r.stage || '', r.member ? r.member.since || '' : '', !r.member && needsVouch(env, r) ? 1 : 0, r.flag ? 1 : 0, Date.now()).run();
  } catch (e) {}
}
async function sqDel(env, id) {
  if (!env.D1) return;
  try {
    await adReady(env);
    await env.D1.batch([env.D1.prepare('DELETE FROM people WHERE uid = ?1').bind(String(id)), env.D1.prepare('DELETE FROM bonds WHERE a = ?1 OR b = ?1').bind(String(id)), env.D1.prepare('DELETE FROM msgs WHERE uid = ?1').bind(String(id)), env.D1.prepare('DELETE FROM vouches WHERE aid = ?1 OR vid = ?1').bind(String(id))]);
  } catch (e) {}
}
async function sqReady(env) {
  if (SQ_READY) return;
  await env.D1.batch([
    env.D1.prepare('CREATE TABLE IF NOT EXISTS people (uid TEXT PRIMARY KEY, pid TEXT, room TEXT, alias TEXT, done INTEGER, member INTEGER, points TEXT, temples TEXT, stage TEXT, since TEXT, need INTEGER, flag INTEGER, at INTEGER)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS people_room ON people (room)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS people_pid ON people (pid)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, uid TEXT, body TEXT, at INTEGER, hidden INTEGER DEFAULT 0)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS msgs_room ON msgs (room, id)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS bonds (a TEXT, b TEXT, status TEXT, at INTEGER, PRIMARY KEY (a, b))'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS bonds_b ON bonds (b)'),
  ]);
  const c = await env.D1.prepare('SELECT COUNT(*) AS n FROM people').first();
  if (!c || !c.n) {
    let cursor;
    do {
      const page = await env.DB.list({ prefix: 'u:', cursor });
      for (const k of page.keys) {
        const uid = k.name.slice(2);
        const p = await getRec(env, uid);
        if (p) await sqSync(env, uid, p);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  SQ_READY = true;
}
async function sqMemberBonds(env, uid) {
  const x = await env.D1.prepare("SELECT COUNT(*) AS n FROM bonds b JOIN people p ON p.uid = (CASE WHEN b.a = ?1 THEN b.b ELSE b.a END) WHERE (b.a = ?1 OR b.b = ?1) AND b.status = 'bonded' AND p.member = 1").bind(String(uid)).first();
  return x ? x.n : 0;
}
async function sqMaybeAdmit(env, uid) {
  const a = await getRec(env, uid);
  if (!a || a.member || !a.code || a.stage === 'Declined' || a.step !== 'chatting') return;
  if (a.flag) return;
  return vMaybeReady(env, uid);
}
async function sqApi(req, path, env, body, user, id, r) {
  if (!env.D1) return apiJson(req, { ok: false, error: 'The Square isn’t open yet.' }, 503);
  await sqReady(env);
  if (!r || !r.code) return apiJson(req, { ok: false, error: 'Say hello first.' }, 403);
  if (r.stage === 'Declined') return apiJson(req, { ok: false, error: 'The Square isn’t open to you.' }, 403);
  const me = String(id);
  const room = roomOf(env, r);
  const D1 = env.D1;
  const now = Date.now();
  if (path === '/api/sq/city' || path === '/api/sq/vouch' || path === '/api/sq/map') return vApi(req, path, env, body, me, r, room, now);
  if (path.startsWith('/api/sq/duty/')) return duApi(req, path, env, body, me, r, room, now);
  if (env.LAB) await lbPulse(env, now);
  if (path.startsWith('/api/sq/fly/')) return flApi(req, path, env, body, me, r, room, now);
  if (path === '/api/sq/sky') return skyApi(req, env, me, r, room, now);
  if (path.startsWith('/api/sq/pg/')) return pgApi(req, path, env, body, me, r, room, now);
  if (path.startsWith('/api/sq/lab/')) return lbApi(req, path, env, body, me, r, room, now);
  if (path.startsWith('/api/sq/ad/')) return adApi(req, path, env, body, me, r, room, now);
  if (path === '/api/sq/village') {
    await sqSync(env, me, r);
    if (!r.member) await sqMaybeAdmit(env, me);
    await adReady(env);
    const view = String(body.room || room).slice(0, 60);
    const own = view === room;
    const vcfg = await adCfg(env);
    const vmemo = new Map();
    const core = await adCore(env, me);
    await hReady(env);
    const metRows = new Map(((await D1.prepare('SELECT a, b, secs FROM together WHERE a = ?1 OR b = ?1').bind(me).all()).results || []).map((x) => [x.a === me ? x.b : x.a, x.secs]));
    const myW = core ? vcfg.core : r.member && !r.member.suspended ? await vWeight(env, me, 'member', vcfg, vmemo) : 0;
    const rows = (await D1.prepare("SELECT uid, pid, alias, member, points, temples, stage, since, need FROM people WHERE room = ?1 AND done = 1 AND stage != 'Declined' ORDER BY member DESC, alias COLLATE NOCASE").bind(view).all()).results || [];
    const bonds = (await D1.prepare('SELECT a, b, status FROM bonds WHERE a = ?1 OR b = ?1 OR status = ?2').bind(me, 'bonded').all()).results || [];
    const memberSet = new Set(rows.filter((x) => x.member).map((x) => x.uid));
    const target = sqTarget(env);
    const people = [];
    for (const x of rows) {
      let bond = 'none';
      let mb = 0;
      for (const b of bonds) {
        if (b.status === 'bonded' && (b.a === x.uid || b.b === x.uid)) { const other = b.a === x.uid ? b.b : b.a; if (memberSet.has(other)) mb++; }
        if ((b.a === me && b.b === x.uid) || (b.b === me && b.a === x.uid)) bond = b.status === 'bonded' ? 'bonded' : b.a === me ? 'sent' : 'received';
      }
      const p = { met: metRows.has(x.uid) || core, mins: Math.round((metRows.get(x.uid) || 0) / 60), pid: x.pid, alias: x.alias, member: !!x.member, points: sqParse(x.points), temples: sqParse(x.temples) || [], since: x.since || '', me: x.uid === me, bond: bond };
      if (!x.member) {
        p.bonds = mb;
        p.needVouch = !!x.need;
        const vt = await vTally(env, x.uid, vcfg, vmemo);
        p.vouch = { pts: vt.pts, ready: vt.ready, by: vt.by.map((b) => b.alias), mine: vt.by.some((b) => b.vid === me), can: !p.me && myW > 0 && (own || core) };
        if (x.stage === 'Voting') {
          const v = await getVote(env, x.uid);
          if (v && v.status === 'open') p.vote = { closes: istLabel(v.deadline), canVote: v.electorate.includes(me) && !v.yes.includes(me) && !v.no.includes(me), voted: v.yes.includes(me) || v.no.includes(me) };
        }
      }
      people.push(p);
    }
    const founder = isFounder(env, me) && (await isTeam(env, me));
    return apiJson(req, { ok: true, room: view, own: own, home: room, target: target, founder: founder, people: people, vready: vcfg.ready, myWeight: myW, core: core });
  }
  if (path === '/api/sq/msgs') {
    if (!r.member && !(await adCore(env, me))) return apiJson(req, { ok: false, error: 'The village chat opens once you are let in.' }, 403);
    const after = Math.max(0, Math.floor(Number(body.after) || 0));
    const rows = (await D1.prepare('SELECT m.id, m.uid, m.body, m.at, p.pid, p.alias, p.member FROM msgs m JOIN people p ON p.uid = m.uid WHERE m.room = ?1 AND m.id > ?2 AND m.hidden = 0 AND m.at > ?3 ORDER BY m.id DESC LIMIT 80').bind(room, after, now - 7 * 86400000).all()).results || [];
    rows.reverse();
    return apiJson(req, { ok: true, msgs: rows.map((m) => ({ id: m.id, pid: m.pid, alias: m.alias, member: !!m.member, body: m.body, at: m.at, mine: m.uid === me })) });
  }
  if (path === '/api/sq/say') {
    if (!r.member && !(await adCore(env, me))) return apiJson(req, { ok: false, error: 'The village chat opens once you are let in.' }, 403);
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) return apiJson(req, { ok: false, error: 'Say something first.' }, 400);
    const last = await D1.prepare('SELECT at FROM msgs WHERE uid = ?1 ORDER BY id DESC LIMIT 1').bind(me).first();
    if (last && now - last.at < 3000) return apiJson(req, { ok: false, error: 'A breath between messages, love.' }, 429);
    await sqSync(env, me, r);
    const res = await D1.prepare('INSERT INTO msgs (room, uid, body, at) VALUES (?1, ?2, ?3, ?4)').bind(room, me, text, now).run();
    if (Math.random() < 0.05) await D1.prepare('DELETE FROM msgs WHERE at < ?1').bind(now - 7 * 86400000).run();
    return apiJson(req, { ok: true, id: res.meta ? res.meta.last_row_id : 0 });
  }
  if (path === '/api/sq/hide' || path === '/api/sq/report') {
    const mid = Math.floor(Number(body.id) || 0);
    const m = await D1.prepare('SELECT m.id, m.uid, m.body, m.room, p.alias FROM msgs m LEFT JOIN people p ON p.uid = m.uid WHERE m.id = ?1').bind(mid).first();
    if (!m || m.room !== room) return apiJson(req, { ok: false, error: 'That message is gone.' }, 404);
    if (path === '/api/sq/hide') {
      if (!(isFounder(env, me) && (await isTeam(env, me)))) return apiJson(req, { ok: false, error: 'Only a founder can hide messages.' }, 403);
      await D1.prepare('UPDATE msgs SET hidden = 1 WHERE id = ?1').bind(mid).run();
      return apiJson(req, { ok: true });
    }
    const sent = await team(env, '🚩 Square report (' + room + ')\n\n' + (m.alias || 'someone') + ' wrote: “' + m.body + '”\n\nReported by ' + label(r) + '. A founder can hide it from the Square in the app. Reply to this message to write to the person who wrote it.');
    if (sent && sent.ok) await link(env, sent.result.message_id, m.uid);
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/bond') {
    const t = await D1.prepare('SELECT uid, alias, room FROM people WHERE pid = ?1').bind(String(body.pid || '')).first();
    if (!t || (t.room !== room && !(await pgIntroduced(env, me, t.uid)))) return apiJson(req, { ok: false, error: 'They’re not in your Village.' }, 404);
    if (t.uid === me) return apiJson(req, { ok: false, error: 'That’s you, love.' }, 400);
    const theirs = await D1.prepare('SELECT status FROM bonds WHERE a = ?1 AND b = ?2').bind(t.uid, me).first();
    const mine = await D1.prepare('SELECT status FROM bonds WHERE a = ?1 AND b = ?2').bind(me, t.uid).first();
    if ((theirs && theirs.status === 'bonded') || (mine && mine.status === 'bonded')) return apiJson(req, { ok: true, bond: 'bonded' });
    if (theirs) {
      await D1.batch([D1.prepare("UPDATE bonds SET status = 'bonded', at = ?3 WHERE a = ?1 AND b = ?2").bind(t.uid, me, now), D1.prepare('DELETE FROM bonds WHERE a = ?1 AND b = ?2').bind(me, t.uid)]);
      const open = [[{ text: 'Open the Village', url: SQ_APP + '#go' }]];
      await say(env, t.uid, '✦ You and ' + (r.alias || 'someone') + ' are bonded now.', open);
      await say(env, me, '✦ You and ' + (t.alias || 'someone') + ' are bonded now.', open);
      await sqMaybeAdmit(env, t.uid);
      await sqMaybeAdmit(env, me);
      return apiJson(req, { ok: true, bond: 'bonded' });
    }
    if (mine) return apiJson(req, { ok: true, bond: 'sent' });
    await hReady(env);
    const met = await D1.prepare('SELECT secs FROM together WHERE a = ?1 AND b = ?2').bind(me < t.uid ? me : t.uid, me < t.uid ? t.uid : me).first();
    if (!met && !(await adCore(env, me))) return apiJson(req, { ok: false, error: 'You haven’t met yet. Share a circle first, then you can bond.' }, 400);
    const today = await D1.prepare('SELECT COUNT(*) AS n FROM bonds WHERE a = ?1 AND at > ?2').bind(me, now - 86400000).first();
    if (today && today.n >= 15) return apiJson(req, { ok: false, error: 'That’s plenty of bonds for one day. Try again tomorrow.' }, 429);
    await D1.prepare("INSERT INTO bonds (a, b, status, at) VALUES (?1, ?2, 'pending', ?3)").bind(me, t.uid, now).run();
    await say(env, t.uid, '✦ ' + (r.alias || 'Someone') + ' would like to bond with you in the Village.', [[{ text: 'See their Sigil', url: SQ_APP + '#go' }]]);
    return apiJson(req, { ok: true, bond: 'sent' });
  }
  if (path === '/api/sq/vote') {
    const t = await D1.prepare('SELECT uid FROM people WHERE pid = ?1').bind(String(body.pid || '')).first();
    if (!t) return apiJson(req, { ok: false, error: 'They’re not in your Village.' }, 404);
    const v = await getVote(env, t.uid);
    if (!v || v.status !== 'open') return apiJson(req, { ok: false, error: 'This vote has closed.' }, 400);
    if (!v.electorate.includes(me)) return apiJson(req, { ok: false, error: 'You’re not a voter on this one.' }, 403);
    if (v.yes.includes(me) || v.no.includes(me)) return apiJson(req, { ok: true, voted: true });
    (body.v === 'y' ? v.yes : v.no).push(me);
    await putVote(env, t.uid, v);
    const a = await getRec(env, t.uid);
    if (!a) { await dropVote(env, t.uid); return apiJson(req, { ok: true, voted: true }); }
    a.voteLine = voteLine(v);
    await putRec(env, t.uid, a);
    await sheetPerson(env, a);
    await settle(env, v, a, false);
    return apiJson(req, { ok: true, voted: true });
  }
  if (path.startsWith('/api/sq/h/')) return hApi(req, path, env, body, me, r, room, now);
  return apiJson(req, { ok: false, error: 'not found' }, 404);
}

/* ===== The House: the Six Vibes and their circles (added 18 Nov 2026, per project doc 16). Uses the same D1 binding. ===== */
const HV = {
  foyer: { name: 'The Foyer', cap: 5, hush: false },
  salon: { name: 'The Salon', cap: 5, hush: true },
  cards: { name: 'The Card Room', cap: 5, hush: true },
  snug: { name: 'The Snug', cap: 3, hush: true, quiet: true },
  floor: { name: 'The Floor', party: true },
  supper: { name: 'The Supper Table', party: true },
};
const H_SEEDS = {
  foyer: ['First time here?', 'How did you find us?'],
  salon: ['A book that changed your mind', 'The best night you never planned', 'What Delhi gets wrong about itself', 'A song that sounds like a person'],
  cards: ['If you could live one year in any decade, which?', 'What is a small thing you are oddly good at?', 'Which smell takes you straight home?', 'What would you teach for free?', 'What was the last thing you changed your mind about?', 'Who in history would you want at this party?', 'What is your most useless talent?'],
  snug: ['What are you looking forward to right now?', 'When did you last feel completely yourself?', 'What do people often get wrong about you?', 'What would a perfect ordinary day look like?'],
};
const hQotn = () => { const d = Math.floor((Date.now() + 19800000) / 86400000); return H_SEEDS.cards[d % H_SEEDS.cards.length]; };
let H_READY = false;
async function hReady(env) {
  if (H_READY) return;
  await env.D1.batch([
    env.D1.prepare('CREATE TABLE IF NOT EXISTS circles (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, vibe TEXT, topic TEXT, hushed INTEGER, cap INTEGER, welcome INTEGER DEFAULT 0, at INTEGER, last INTEGER)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS circles_room ON circles (room, vibe)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS seats (cid INTEGER, uid TEXT, at INTEGER, PRIMARY KEY (cid, uid))'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS seats_uid ON seats (uid)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY AUTOINCREMENT, cid INTEGER, uid TEXT, body TEXT, at INTEGER)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS lines_cid ON lines (cid, id)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS knocks (id INTEGER PRIMARY KEY AUTOINCREMENT, cid INTEGER, uid TEXT, status TEXT, at INTEGER)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS knocks_cid ON knocks (cid)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS presence (uid TEXT PRIMARY KEY, room TEXT, vibe TEXT, near INTEGER, seen INTEGER, since INTEGER)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS departs (cid INTEGER, uid TEXT, at INTEGER)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS dms (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT, uid TEXT, body TEXT, at INTEGER, seen INTEGER DEFAULT 0)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS dms_pair ON dms (a, b, id)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS dmnote (to_uid TEXT, from_uid TEXT, at INTEGER, PRIMARY KEY (to_uid, from_uid))'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS prefs (uid TEXT PRIMARY KEY, quiet INTEGER)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS cnotes (cid INTEGER, body TEXT, at INTEGER)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS together (a TEXT, b TEXT, secs REAL, last INTEGER, PRIMARY KEY (a, b))'),
  ]);
  H_READY = true;
}
const hHushed = (c, n) => c.welcome ? false : c.hushed === 1 ? true : c.hushed === 0 ? false : n === 2;
const hFirstWords = (s) => { const w = String(s || '').split(' ').filter(Boolean); return w.length <= 2 ? w.join(' ') : w.slice(0, 2).join(' ') + '…'; };
async function hLeaveAll(env, me, now) {
  const D1 = env.D1;
  const mine = (await D1.prepare('SELECT cid FROM seats WHERE uid = ?1').bind(me).all()).results || [];
  for (const s of mine) await D1.prepare('INSERT INTO departs (cid, uid, at) VALUES (?1, ?2, ?3)').bind(s.cid, me, now).run();
  await D1.prepare('DELETE FROM seats WHERE uid = ?1').bind(me).run();
}
const hQuiet = async (env, uid) => { try { const p = await env.D1.prepare('SELECT quiet FROM prefs WHERE uid = ?1').bind(String(uid)).first(); return !!(p && p.quiet); } catch (e) { return false; } };
async function hSuggest(env, room, me, now) {
  const D1 = env.D1;
  const cs = (await D1.prepare("SELECT c.id, c.vibe, c.topic, c.hushed, c.cap, c.welcome, COUNT(s.uid) AS n FROM circles c LEFT JOIN seats s ON s.cid = c.id WHERE c.room = ?1 AND c.vibe IN ('foyer','salon','cards','snug') GROUP BY c.id").bind(room).all()).results || [];
  const open = cs.filter((c) => c.n > 0 && c.n < c.cap && !hHushed(c, c.n));
  if (!open.length) return null;
  const friends = new Set(((await D1.prepare("SELECT CASE WHEN a = ?1 THEN b ELSE a END AS o FROM bonds WHERE (a = ?1 OR b = ?1) AND status = 'bonded'").bind(me).all()).results || []).map((x) => x.o));
  const mine = await D1.prepare('SELECT temples FROM people WHERE uid = ?1').bind(me).first();
  const myT = new Set(sqParse(mine && mine.temples) || []);
  let best = null, bestScore = -1, bestNames = [];
  for (const c of open) {
    const ss = (await D1.prepare('SELECT s.uid, p.alias, p.temples FROM seats s JOIN people p ON p.uid = s.uid WHERE s.cid = ?1').bind(c.id).all()).results || [];
    const others = ss.filter((x) => x.uid !== me);
    if (!others.length) continue;
    const known = others.filter((x) => friends.has(x.uid)).length;
    const ts = new Set();
    others.forEach((x) => (sqParse(x.temples) || []).forEach((t) => ts.add(t)));
    let fresh = 0;
    ts.forEach((t) => { if (!myT.has(t)) fresh++; });
    const score = (known > 0 && known < others.length ? 4 : known > 0 ? 2 : 0) + Math.min(fresh, 3) + Math.min(others.length, 3) * 0.5 - (c.welcome ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = c; bestNames = others.slice().sort((a, b) => (friends.has(b.uid) ? 1 : 0) - (friends.has(a.uid) ? 1 : 0)).slice(0, 2).map((x) => x.alias); }
  }
  if (!best) return null;
  const who = bestNames.join(' and ');
  return { cid: best.id, vibe: best.vibe, text: HV[best.vibe].name + ' has a seat open' + (who ? ' with ' + who : '') + ', talking about “' + best.topic + '”.' };
}
async function hApi(req, path, env, body, me, r, room, now) {
  const D1 = env.D1;
  await hReady(env);
  const vibeOf = (v) => (HV[v] ? v : 'foyer');
  const myCid = async () => { const s = await D1.prepare('SELECT cid FROM seats WHERE uid = ?1').bind(me).first(); return s ? s.cid : 0; };
  const circleOf = async (id) => (id ? await D1.prepare('SELECT * FROM circles WHERE id = ?1 AND (room = ?2 OR id IN (SELECT o.cid FROM owned o WHERE NOT EXISTS (SELECT 1 FROM villages v WHERE (o.wx - v.cx) * (o.wx - v.cx) + (o.wy - v.cy) * (o.wy - v.cy) < v.R * v.R AND v.name != ?2)))').bind(Math.floor(Number(id) || 0), room).first() : null);
  const countOf = async (id) => { const x = await D1.prepare('SELECT COUNT(*) AS n FROM seats WHERE cid = ?1').bind(id).first(); return x ? x.n : 0; };
  const seatMe = async (c) => { await hLeaveAll(env, me, now); await D1.prepare('INSERT OR REPLACE INTO seats (cid, uid, at) VALUES (?1, ?2, ?3)').bind(c.id, me, now).run(); await D1.prepare('UPDATE presence SET vibe = ?2, near = ?3, since = ?4 WHERE uid = ?1').bind(me, c.vibe, c.id, now).run(); };
  if (path === '/api/sq/h/state') {
    const all = body.vibe === 'all';
    const vibe = all ? 'all' : vibeOf(body.vibe);
    const near = Math.floor(Number(body.near) || 0);
    const pres = await D1.prepare('SELECT since, vibe, seen FROM presence WHERE uid = ?1').bind(me).first();
    const cid0 = await myCid();
    if (cid0 && pres && pres.seen) {
      const dt = Math.min(15, Math.max(0, (now - pres.seen) / 1000));
      const others = dt > 0 ? (await D1.prepare('SELECT uid FROM seats WHERE cid = ?1 AND uid != ?2').bind(cid0, me).all()).results || [] : [];
      if (others.length) await D1.batch(others.map((o) => { const x = me < o.uid ? me : o.uid, y = me < o.uid ? o.uid : me; return D1.prepare('INSERT INTO together (a, b, secs, last) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (a, b) DO UPDATE SET secs = secs + ?3, last = ?4').bind(x, y, dt / 2, now); }));
    }
    const myBonds = new Set(((await D1.prepare("SELECT CASE WHEN a = ?1 THEN b ELSE a END AS u FROM bonds WHERE (a = ?1 OR b = ?1) AND status = 'bonded'").bind(me).all()).results || []).map((x) => x.u));
    const iCore = await adCore(env, me);
    const since = cid0 ? now : pres && pres.since ? pres.since : now;
    await D1.prepare('INSERT INTO presence (uid, room, vibe, near, seen, since) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (uid) DO UPDATE SET room = ?2, vibe = ?3, near = ?4, seen = ?5, since = ?6').bind(me, room, vibe, near, now, since).run();
    if (Math.random() < 0.25) {
      await D1.batch([
        D1.prepare('DELETE FROM seats WHERE uid IN (SELECT uid FROM presence WHERE seen < ?1)').bind(now - 90000),
        D1.prepare('DELETE FROM circles WHERE welcome = 0 AND id NOT IN (SELECT cid FROM owned) AND at < ?1 AND id NOT IN (SELECT cid FROM seats)').bind(now - 60000),
        D1.prepare('DELETE FROM lines WHERE 0 AND ?1 = ?1').bind(now - 86400000),
        D1.prepare('DELETE FROM knocks WHERE at < ?1').bind(now - 3600000),
        D1.prepare('DELETE FROM departs WHERE at < ?1').bind(now - 600000),
        D1.prepare('DELETE FROM cnotes WHERE at < ?1').bind(now - 600000),
      ]);
    }
    if (!all && vibe === 'foyer') {
      const w = await D1.prepare("SELECT id FROM circles WHERE room = ?1 AND vibe = 'foyer' AND welcome = 1").bind(room).first();
      if (!w) await D1.prepare("INSERT INTO circles (room, vibe, topic, hushed, cap, welcome, at, last) VALUES (?1, 'foyer', 'Welcome to the House', 0, 5, 1, ?2, ?2)").bind(room, now).run();
    }
    const cid = await myCid();
    const counts = (await D1.prepare('SELECT vibe, COUNT(*) AS n FROM presence WHERE room = ?1 AND seen > ?2 GROUP BY vibe').bind(room, now - 30000).all()).results || [];
    const vibes = Object.keys(HV).map((k) => ({ key: k, n: (counts.find((x) => x.vibe === k) || { n: 0 }).n }));
    const here = await D1.prepare('SELECT COUNT(*) AS n FROM presence WHERE room = ?1 AND seen > ?2').bind(room, now - 30000).first();
    const unread = await D1.prepare('SELECT COUNT(*) AS n FROM dms WHERE (a = ?1 OR b = ?1) AND uid != ?1 AND seen = 0').bind(me).first();
    const out = { ok: true, vibe: vibe, vibes: vibes, here: here ? here.n : 0, unread: unread ? unread.n : 0, cid: cid, circles: [], qotn: hQotn(), seeds: all ? H_SEEDS.salon.concat(H_SEEDS.cards.slice(0, 3)) : H_SEEDS[vibe] || [] };
    if (all || !HV[vibe].party) {
      const cs = (await (all ? D1.prepare('SELECT * FROM circles c WHERE (c.room = ?1 OR c.id = ?2) AND (EXISTS (SELECT 1 FROM seats s WHERE s.cid = c.id) OR c.id = ?2) ORDER BY (c.id = ?2) DESC, c.last DESC LIMIT 30').bind(room, cid) : D1.prepare('SELECT * FROM circles WHERE room = ?1 AND vibe = ?2 ORDER BY welcome DESC, last DESC LIMIT 12').bind(room, vibe)).all()).results || [];
      for (const c of cs) {
        const seats = (await D1.prepare('SELECT s.uid, p.pid, p.alias, p.member, p.points FROM seats s JOIN people p ON p.uid = s.uid WHERE s.cid = ?1 ORDER BY s.at').bind(c.id).all()).results || [];
        if (!seats.length && !c.welcome && now - c.at > 60000) continue;
        const inside = c.id === cid;
        const hushed = hHushed(c, seats.length);
        const lis = (await D1.prepare('SELECT p.pid, p.alias FROM presence x JOIN people p ON p.uid = x.uid WHERE x.near = ?1 AND x.seen > ?2 AND x.uid NOT IN (SELECT uid FROM seats WHERE cid = ?1)').bind(c.id, now - 15000).all()).results || [];
        const o = { id: c.id, topic: hushed && !inside ? hFirstWords(c.topic) : c.topic, hushed: hushed, cap: c.cap, welcome: !!c.welcome, splits: !hushed && c.cap >= 4 && seats.length >= c.cap, inside: inside, known: seats.filter((s) => myBonds.has(s.uid)).length, intro: !inside && !c.welcome && !iCore && seats.length > 0 && !seats.some((s) => myBonds.has(s.uid)), seats: seats.map((s) => ({ pid: s.pid, alias: s.alias, member: !!s.member, points: sqParse(s.points), me: s.uid === me })), listeners: lis.map((x) => ({ pid: x.pid, alias: x.alias })), lines: [] };
        if (inside || (!hushed && c.id === near)) {
          const ls = (await D1.prepare('SELECT l.id, l.uid, l.body, l.at, p.alias, p.pid, p.member FROM lines l JOIN people p ON p.uid = l.uid WHERE l.cid = ?1 ORDER BY l.id DESC LIMIT ?2').bind(c.id, inside ? 40 : 2).all()).results || [];
          ls.reverse();
          o.lines = ls.map((l) => ({ id: l.id, alias: l.alias, pid: l.pid, member: !!l.member, body: l.body, at: l.at, mine: l.uid === me }));
        } else if (!hushed) {
          const l = await D1.prepare('SELECT l.body, p.alias FROM lines l JOIN people p ON p.uid = l.uid WHERE l.cid = ?1 ORDER BY l.id DESC LIMIT 1').bind(c.id).first();
          if (l) o.lines = [{ alias: l.alias, body: hFirstWords(l.body), far: true }];
        }
        if (inside) {
          o.knocks = ((await D1.prepare("SELECT k.id, p.pid, p.alias FROM knocks k JOIN people p ON p.uid = k.uid WHERE k.cid = ?1 AND k.status = 'waiting' AND k.at > ?2").bind(c.id, now - 60000).all()).results || []).map((k) => ({ kid: k.id, pid: k.pid, alias: k.alias }));
          const nt = await D1.prepare('SELECT body FROM cnotes WHERE cid = ?1 AND at > ?2 ORDER BY at DESC LIMIT 1').bind(c.id, now - 180000).first();
          if (nt) o.note = nt.body;
          o.departs = ((await D1.prepare('SELECT DISTINCT p.pid, p.alias FROM departs d JOIN people p ON p.uid = d.uid WHERE d.cid = ?1 AND d.at > ?2 AND d.uid != ?3').bind(c.id, now - 120000, me).all()).results || []).map((d) => ({ pid: d.pid, alias: d.alias }));
        }
        out.circles.push(o);
      }
    }
    const k = await D1.prepare('SELECT k.id, k.cid, k.status, k.at, c.topic, c.vibe FROM knocks k JOIN circles c ON c.id = k.cid WHERE k.uid = ?1 ORDER BY k.id DESC LIMIT 1').bind(me).first();
    if (k && k.status === 'waiting' && now - k.at > 60000) { await D1.prepare("UPDATE knocks SET status = 'faded' WHERE id = ?1").bind(k.id).run(); k.status = 'faded'; }
    if (k && k.status === 'waiting') out.knock = { cid: k.cid, status: 'waiting' };
    if (k && k.status === 'invited' && now - k.at < 3600000) out.knock = { cid: k.cid, status: 'invited', vibe: k.vibe, text: 'The circle on “' + k.topic + '” has opened again. You’re invited back first.' };
    if (!cid && ((k && k.status === 'faded' && now - k.at < 180000) || now - since > 180000)) {
      const s = await hSuggest(env, room, me, now);
      if (s) out.suggest = s;
    }
    return apiJson(req, out);
  }
  if (path === '/api/sq/h/new') {
    const vibe = body.vibe === 'all' ? 'salon' : vibeOf(body.vibe);
    if (HV[vibe].party) return apiJson(req, { ok: false, error: HV[vibe].name + ' opens on party nights.' }, 400);
    const topic = String(body.topic || '').replace(/\s+/g, ' ').trim().slice(0, 80) || (vibe === 'cards' ? hQotn() : (H_SEEDS[vibe] || ['Hello'])[0]);
    const cap = Math.min(8, Math.max(2, Math.floor(Number(body.cap) || HV[vibe].cap)));
    const hushed = body.mode === 'knock' ? 1 : body.mode === 'open' ? 0 : HV[vibe].quiet ? 1 : null;
    const res = await D1.prepare('INSERT INTO circles (room, vibe, topic, hushed, cap, welcome, at, last) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)').bind(room, vibe, topic, hushed, cap, now).run();
    const c = await circleOf(res.meta.last_row_id);
    await seatMe(c);
    return apiJson(req, { ok: true, cid: c.id });
  }
  if (path === '/api/sq/h/join') {
    const c = await circleOf(body.id);
    if (!c) return apiJson(req, { ok: false, error: 'That circle has broken up. Start one nearby?' }, 404);
    const n = await countOf(c.id);
    const inv = await D1.prepare("SELECT id FROM knocks WHERE cid = ?1 AND uid = ?2 AND status IN ('invited','in')").bind(c.id, me).first();
    if (hHushed(c, n) && !inv) return apiJson(req, { ok: false, knock: true, error: 'This one is a private conversation. You can knock.' }, 403);
    if (!c.welcome && !inv && n > 0 && !(await adCore(env, me))) {
      const k = await D1.prepare("SELECT COUNT(*) AS n FROM seats s JOIN bonds b ON ((b.a = ?2 AND b.b = s.uid) OR (b.b = ?2 AND b.a = s.uid)) AND b.status = 'bonded' WHERE s.cid = ?1").bind(c.id, me).first();
      if (!k || !k.n) return apiJson(req, { ok: false, knock: true, intro: true, error: 'You don’t know anyone in this circle yet. Knock, and someone inside can introduce you.' }, 403);
    }
    if (n >= c.cap && (hHushed(c, n) || c.cap < 4)) return apiJson(req, { ok: false, full: true, error: 'This circle is full. Wait for a seat, or start one nearby.' }, 409);
    if (n >= c.cap) {
      const seats = (await D1.prepare('SELECT s.uid, p.alias FROM seats s JOIN people p ON p.uid = s.uid WHERE s.cid = ?1 AND s.uid != ?2 ORDER BY s.at').bind(c.id, me).all()).results || [];
      const keep = Math.ceil(seats.length / 2), moving = seats.slice(keep);
      await hLeaveAll(env, me, now);
      const res = await D1.prepare('INSERT INTO circles (room, vibe, topic, hushed, cap, welcome, at, last) VALUES (?1, ?2, ?3, 0, ?4, 0, ?5, ?5)').bind(room, c.vibe, c.topic, c.cap, now).run();
      const nid = res.meta.last_row_id;
      const ops = [D1.prepare('INSERT INTO seats (cid, uid, at) VALUES (?1, ?2, ?3)').bind(nid, me, now + 1), D1.prepare('UPDATE presence SET vibe = ?2, near = ?3, since = ?4 WHERE uid = ?1').bind(me, c.vibe, nid, now)];
      moving.forEach((m, i) => { ops.push(D1.prepare('UPDATE seats SET cid = ?2, at = ?3 WHERE cid = ?1 AND uid = ?4').bind(c.id, nid, now - moving.length + i, m.uid)); ops.push(D1.prepare('UPDATE presence SET near = ?2 WHERE uid = ?1').bind(m.uid, nid)); });
      ops.push(D1.prepare('INSERT INTO lines (cid, uid, body, at) SELECT ?2, uid, body, at FROM (SELECT uid, body, at FROM lines WHERE cid = ?1 ORDER BY id DESC LIMIT 3) ORDER BY at').bind(c.id, nid));
      const names = moving.map((m) => m.alias);
      ops.push(D1.prepare('INSERT INTO cnotes (cid, body, at) VALUES (?1, ?2, ?3)').bind(c.id, 'The circle grew, so it split in two. A sister circle on the same topic is just beside you.', now));
      ops.push(D1.prepare('INSERT INTO cnotes (cid, body, at) VALUES (?1, ?2, ?3)').bind(nid, 'The circle grew, so it split in two. This half: ' + (names.length ? names.join(', ') + ' and you.' : 'you.') + ' The last few lines came with you.', now));
      ops.push(D1.prepare('UPDATE circles SET last = ?2 WHERE id = ?1').bind(c.id, now));
      await D1.batch(ops);
      return apiJson(req, { ok: true, cid: nid, split: true });
    }
    await seatMe(c);
    if (inv) await D1.prepare("UPDATE knocks SET status = 'in' WHERE id = ?1").bind(inv.id).run();
    return apiJson(req, { ok: true, cid: c.id });
  }
  if (path === '/api/sq/h/leave') {
    await hLeaveAll(env, me, now);
    await D1.prepare('UPDATE presence SET near = 0, since = ?2 WHERE uid = ?1').bind(me, now).run();
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/h/say') {
    const cid = await myCid();
    if (!cid) return apiJson(req, { ok: false, error: 'Step into a circle first.' }, 400);
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) return apiJson(req, { ok: false, error: 'Say something first.' }, 400);
    const last = await D1.prepare('SELECT at FROM lines WHERE uid = ?1 ORDER BY id DESC LIMIT 1').bind(me).first();
    if (last && now - last.at < 1500) return apiJson(req, { ok: false, error: 'A breath between lines, love.' }, 429);
    await D1.batch([D1.prepare('INSERT INTO lines (cid, uid, body, at) VALUES (?1, ?2, ?3, ?4)').bind(cid, me, text, now), D1.prepare('UPDATE circles SET last = ?2 WHERE id = ?1').bind(cid, now)]);
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/h/hush') {
    const cid = await myCid();
    const c = await circleOf(cid);
    if (!c) return apiJson(req, { ok: false, error: 'Step into a circle first.' }, 400);
    if (c.welcome) return apiJson(req, { ok: false, error: 'The Foyer’s welcome circle is always open.' }, 400);
    if (!HV[c.vibe].hush) return apiJson(req, { ok: false, error: 'This circle stays open.' }, 400);
    const on = !!body.on;
    await D1.prepare('UPDATE circles SET hushed = ?2 WHERE id = ?1').bind(c.id, on ? 1 : 0).run();
    if (!on) {
      const later = (await D1.prepare("SELECT id, uid FROM knocks WHERE cid = ?1 AND status = 'later'").bind(c.id).all()).results || [];
      for (const k of later) {
        await D1.prepare("UPDATE knocks SET status = 'invited', at = ?2 WHERE id = ?1").bind(k.id, now).run();
        if (!(await hQuiet(env, k.uid))) await say(env, k.uid, '✦ The circle on “' + c.topic + '” in ' + HV[c.vibe].name + ' has opened again. You’re invited back first.', [[{ text: 'Step in', url: SQ_APP + '#go' }]]);
      }
    }
    return apiJson(req, { ok: true, hushed: on });
  }
  if (path === '/api/sq/h/knock') {
    const c = await circleOf(body.id);
    if (!c) return apiJson(req, { ok: false, error: 'That circle has broken up.' }, 404);
    const recent = await D1.prepare("SELECT COUNT(*) AS n FROM knocks WHERE uid = ?1 AND at > ?2").bind(me, now - 600000).first();
    if (recent && recent.n >= 8) return apiJson(req, { ok: false, error: 'Take a breath, love. Try an open circle for now.' }, 429);
    await D1.prepare("DELETE FROM knocks WHERE uid = ?1 AND status = 'waiting'").bind(me).run();
    await D1.prepare("INSERT INTO knocks (cid, uid, status, at) VALUES (?1, ?2, 'waiting', ?3)").bind(c.id, me, now).run();
    await D1.prepare('UPDATE presence SET near = ?2 WHERE uid = ?1').bind(me, c.id).run();
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/h/answer') {
    const cid = await myCid();
    const k = await D1.prepare('SELECT * FROM knocks WHERE id = ?1').bind(Math.floor(Number(body.kid) || 0)).first();
    if (!k || k.cid !== cid || k.status !== 'waiting') return apiJson(req, { ok: true });
    if (body.a === 'in') {
      const c = await circleOf(cid);
      if ((await countOf(cid)) >= c.cap) return apiJson(req, { ok: false, error: 'The circle is full right now.' }, 409);
      const prev = (await D1.prepare('SELECT cid FROM seats WHERE uid = ?1').bind(k.uid).all()).results || [];
      for (const s of prev) await D1.prepare('INSERT INTO departs (cid, uid, at) VALUES (?1, ?2, ?3)').bind(s.cid, k.uid, now).run();
      await D1.batch([D1.prepare('DELETE FROM seats WHERE uid = ?1').bind(k.uid), D1.prepare('INSERT OR REPLACE INTO seats (cid, uid, at) VALUES (?1, ?2, ?3)').bind(cid, k.uid, now), D1.prepare("UPDATE knocks SET status = 'in' WHERE id = ?1").bind(k.id), D1.prepare('UPDATE presence SET vibe = ?2, near = ?3 WHERE uid = ?1').bind(k.uid, c.vibe, cid)]);
    } else await D1.prepare("UPDATE knocks SET status = 'later' WHERE id = ?1").bind(k.id).run();
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/h/glad') {
    const cid = await myCid();
    const t = await D1.prepare('SELECT uid FROM people WHERE pid = ?1').bind(String(body.pid || '')).first();
    if (!t || !cid) return apiJson(req, { ok: true });
    const d = await D1.prepare('SELECT at FROM departs WHERE cid = ?1 AND uid = ?2 AND at > ?3').bind(cid, t.uid, now - 300000).first();
    if (!d) return apiJson(req, { ok: true });
    await D1.prepare('DELETE FROM departs WHERE cid = ?1 AND uid = ?2').bind(cid, t.uid).run();
    if (!(await hQuiet(env, t.uid))) await say(env, t.uid, '✦ Someone in your circle was glad you were there.');
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/h/prefs') {
    if (body.quiet !== undefined) await D1.prepare('INSERT OR REPLACE INTO prefs (uid, quiet) VALUES (?1, ?2)').bind(me, body.quiet ? 1 : 0).run();
    const p = await D1.prepare('SELECT quiet FROM prefs WHERE uid = ?1').bind(me).first();
    return apiJson(req, { ok: true, quiet: !!(p && p.quiet) });
  }
  if (path.startsWith('/api/sq/h/dm/')) {
    const bonded = async (o) => !!(await D1.prepare("SELECT 1 AS x FROM bonds WHERE ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)) AND status = 'bonded'").bind(me, o).first());
    const pair = (o) => (me < o ? [me, o] : [o, me]);
    if (path === '/api/sq/h/dm/list') {
      const peers = (await D1.prepare("SELECT CASE WHEN a = ?1 THEN b ELSE a END AS o FROM bonds WHERE (a = ?1 OR b = ?1) AND status = 'bonded' UNION SELECT CASE WHEN a = ?1 THEN b ELSE a END AS o FROM dms WHERE a = ?1 OR b = ?1").bind(me).all()).results || [];
      const list = [];
      for (const x of peers) {
        const p = await D1.prepare('SELECT pid, alias, member, points FROM people WHERE uid = ?1').bind(x.o).first();
        if (!p) continue;
        const [a, b] = pair(x.o);
        const last = await D1.prepare('SELECT uid, body, at FROM dms WHERE a = ?1 AND b = ?2 ORDER BY id DESC LIMIT 1').bind(a, b).first();
        const un = await D1.prepare('SELECT COUNT(*) AS n FROM dms WHERE a = ?1 AND b = ?2 AND uid != ?3 AND seen = 0').bind(a, b, me).first();
        list.push({ pid: p.pid, alias: p.alias, member: !!p.member, points: sqParse(p.points), last: last ? last.body : '', mine: last ? last.uid === me : false, at: last ? last.at : 0, unread: un ? un.n : 0, bonded: await bonded(x.o) });
      }
      list.sort((x, y) => y.at - x.at);
      return apiJson(req, { ok: true, threads: list });
    }
    const t = await D1.prepare('SELECT uid, alias, member, points, pid FROM people WHERE pid = ?1 AND room = ?2').bind(String(body.pid || ''), room).first();
    if (!t || t.uid === me) return apiJson(req, { ok: false, error: 'They’re not in your Village.' }, 404);
    const [a, b] = pair(t.uid);
    if (path === '/api/sq/h/dm/thread') {
      const after = Math.max(0, Math.floor(Number(body.after) || 0));
      const ms = (await D1.prepare('SELECT id, uid, body, at FROM dms WHERE a = ?1 AND b = ?2 AND id > ?3 ORDER BY id DESC LIMIT 100').bind(a, b, after).all()).results || [];
      ms.reverse();
      await D1.prepare('UPDATE dms SET seen = 1 WHERE a = ?1 AND b = ?2 AND uid != ?3 AND seen = 0').bind(a, b, me).run();
      return apiJson(req, { ok: true, bonded: await bonded(t.uid), peer: { pid: t.pid, alias: t.alias, member: !!t.member, points: sqParse(t.points) }, msgs: ms.map((m) => ({ id: m.id, body: m.body, at: m.at, mine: m.uid === me })) });
    }
    if (path === '/api/sq/h/dm/send') {
      if (!(await bonded(t.uid))) return apiJson(req, { ok: false, error: 'Bond with ' + t.alias + ' first, then you can write to each other.' }, 403);
      const text = String(body.text || '').replace(/[ \t]+/g, ' ').trim().slice(0, 1000);
      if (!text) return apiJson(req, { ok: false, error: 'Say something first.' }, 400);
      const last = await D1.prepare('SELECT at FROM dms WHERE uid = ?1 ORDER BY id DESC LIMIT 1').bind(me).first();
      if (last && now - last.at < 800) return apiJson(req, { ok: false, error: 'A breath between messages, love.' }, 429);
      await D1.prepare('INSERT INTO dms (a, b, uid, body, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(a, b, me, text, now).run();
      const pres = await D1.prepare('SELECT seen FROM presence WHERE uid = ?1').bind(t.uid).first();
      const note = await D1.prepare('SELECT at FROM dmnote WHERE to_uid = ?1 AND from_uid = ?2').bind(t.uid, me).first();
      if ((!pres || now - pres.seen > 120000) && (!note || now - note.at > 600000) && !(await hQuiet(env, t.uid))) {
        await D1.prepare('INSERT OR REPLACE INTO dmnote (to_uid, from_uid, at) VALUES (?1, ?2, ?3)').bind(t.uid, me, now).run();
        await say(env, t.uid, '✦ ' + (r.alias || 'Someone') + ' wrote to you in the Village.', [[{ text: 'Open messages', url: SQ_BASE + '#dm' }]]);
      }
      return apiJson(req, { ok: true });
    }
  }
  return apiJson(req, { ok: false, error: 'not found' }, 404);
}

/* ===== Vouches (weighted referrals), the City, and the admin console API (added 19 Nov 2026). ===== */
let AD_READY = false;
const AD_DEF = { ready: 5, core: 3, member: 1, fresh: 0.5, freshDays: 30 };
const AD_TEAM = new Map();
async function adReady(env) {
  if (AD_READY) return;
  await env.D1.batch([
    env.D1.prepare('CREATE TABLE IF NOT EXISTS vouches (aid TEXT, vid TEXT, kind TEXT, at INTEGER, PRIMARY KEY (aid, vid))'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS vouches_vid ON vouches (vid)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS readynote (aid TEXT PRIMARY KEY, at INTEGER)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS adlog (id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT, act TEXT, target TEXT, at INTEGER)'),
  ]);
  AD_READY = true;
}
async function adCfg(env) {
  const rows = (await env.D1.prepare('SELECT k, v FROM cfg').all()).results || [];
  const c = Object.assign({}, AD_DEF);
  for (const x of rows) { const n = Number(x.v); if (x.k in AD_DEF && isFinite(n)) c[x.k] = n; }
  return c;
}
// Staff = in the team chat. Cached for a minute so the console stays quick.
async function adStaff(env, uid) {
  const k = String(uid), hit = AD_TEAM.get(k);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  let v = false;
  try { v = !!(await isTeam(env, k)); } catch (e) { v = false; }
  AD_TEAM.set(k, { v, at: Date.now() });
  return v;
}
async function adCore(env, uid) { return (await adStaff(env, uid)) && !!isFounder(env, String(uid)); }
const adDays = (since) => { const t = Date.parse(since || ''); return isFinite(t) ? (Date.now() - t) / 86400000 : 9999; };
// How much one voucher's word counts right now.
async function vWeight(env, vid, kind, cfg, memo) {
  if (memo && memo.has(vid)) return memo.get(vid);
  let w = 0;
  const p = await env.D1.prepare('SELECT member, since FROM people WHERE uid = ?1').bind(vid).first();
  if (kind === 'core') w = cfg.core;
  else if (p && p.member) {
    w = adDays(p.since) >= cfg.freshDays ? cfg.member : cfg.fresh;
    const given = (await env.D1.prepare('SELECT v.aid FROM vouches v JOIN people q ON q.uid = v.aid WHERE v.vid = ?1 AND q.member = 1').bind(vid).all()).results || [];
    for (const g of given) { const a = await getRec(env, g.aid); if (a && a.breach) { w = 0; break; } }
  }
  if (memo) memo.set(vid, w);
  return w;
}
// Everyone who has vouched for an applicant, with points. The old single vouch-code counts too.
async function vTally(env, aid, cfg, memo, a) {
  const rows = (await env.D1.prepare('SELECT v.vid, v.kind, p.alias, p.pid FROM vouches v LEFT JOIN people p ON p.uid = v.vid WHERE v.aid = ?1 ORDER BY v.at').bind(aid).all()).results || [];
  const by = [];
  let pts = 0;
  for (const x of rows) { const w = await vWeight(env, x.vid, x.kind, cfg, memo); pts += w; by.push({ vid: x.vid, pid: x.pid, alias: x.alias || 'Someone', kind: x.kind, w }); }
  a = a || (await getRec(env, aid));
  const old = a && a.vouch === 'yes' ? String(a.voucherId || a.vouchFromId || '') : '';
  if (old && !rows.some((x) => x.vid === old)) {
    const kind = isFounder(env, old) && (await adStaff(env, old)) ? 'core' : 'member';
    const w = await vWeight(env, old, kind, cfg, memo);
    const p = await env.D1.prepare('SELECT alias, pid FROM people WHERE uid = ?1').bind(old).first();
    pts += w; by.push({ vid: old, pid: p ? p.pid : '', alias: (p && p.alias) || a.vouchedBy || 'A member', kind, w, code: true });
  }
  pts = Math.round(pts * 10) / 10;
  return { pts, ready: pts >= cfg.ready, by };
}
// Called after any vouch or bond change. Nobody is let in automatically: at the threshold the team gets a card.
async function vMaybeReady(env, aid) {
  await adReady(env);
  const a = await getRec(env, aid);
  if (!a || a.member || !a.code || a.stage === 'Declined' || a.flag) return;
  const cfg = await adCfg(env);
  const t = await vTally(env, aid, cfg, new Map(), a);
  if (!t.ready) return;
  const seen = await env.D1.prepare('SELECT at FROM readynote WHERE aid = ?1').bind(aid).first();
  if (seen) return;
  await env.D1.prepare('INSERT INTO readynote (aid, at) VALUES (?1, ?2)').bind(aid, Date.now()).run();
  const who = t.by.map((x) => x.alias + (x.kind === 'core' ? ' (core)' : '') + ' ' + x.w).join(', ');
  try {
    await teamKb(env, '✦ Ready for your yes: ' + (a.alias || 'someone') + ' in ' + roomOf(env, a) + ' has ' + t.pts + ' vouch points (' + who + '). Admit or decline here or in the admin console.', [[{ text: '✓ Admit', callback_data: 'fd|a|' + aid }, { text: '✖ Decline', callback_data: 'fd|d|' + aid }]]);
  } catch (e) {}
}
async function adLog(env, who, act, target) {
  try { await env.D1.prepare('INSERT INTO adlog (who, act, target, at) VALUES (?1, ?2, ?3, ?4)').bind(String(who), act, target || '', Date.now()).run(); } catch (e) {}
}
// Village and City data for the app.
async function vApi(req, path, env, body, me, r, room, now) {
  const D1 = env.D1;
  await adReady(env);
  await hReady(env);
  if (path === '/api/sq/city') {
    const rows = (await D1.prepare("SELECT room, SUM(member) AS m, SUM(CASE WHEN member = 0 THEN 1 ELSE 0 END) AS w FROM people WHERE done = 1 AND stage != 'Declined' GROUP BY room ORDER BY room").all()).results || [];
    const live = (await D1.prepare('SELECT room, COUNT(*) AS n FROM presence WHERE seen > ?1 GROUP BY room').bind(now - 30000).all()).results || [];
    const circ = (await D1.prepare('SELECT c.room, COUNT(DISTINCT c.id) AS n FROM circles c JOIN seats s ON s.cid = c.id GROUP BY c.room').all()).results || [];
    const villages = rows.map((x) => ({ room: x.room, members: x.m || 0, gate: x.w || 0, live: (live.find((l) => l.room === x.room) || { n: 0 }).n, circles: (circ.find((l) => l.room === x.room) || { n: 0 }).n, mine: x.room === room }));
    if (!villages.some((v) => v.mine)) villages.unshift({ room, members: 0, gate: 0, live: 0, circles: 0, mine: true });
    villages.sort((a, b) => (b.mine - a.mine) || a.room.localeCompare(b.room));
    return apiJson(req, { ok: true, city: env.CITY_NAME || 'Delhi NCR', villages });
  }
  if (path === '/api/sq/map') {
    const vil = (await D1.prepare("SELECT room, SUM(member) AS m, SUM(CASE WHEN member = 0 THEN 1 ELSE 0 END) AS w FROM people WHERE done = 1 AND stage != 'Declined' GROUP BY room ORDER BY room").all()).results || [];
    const live = (await D1.prepare('SELECT room, COUNT(*) AS n FROM presence WHERE seen > ?1 GROUP BY room').bind(now - 30000).all()).results || [];
    const sp = (await D1.prepare('SELECT c.vibe, COUNT(DISTINCT c.id) AS c, COUNT(s.uid) AS p FROM circles c JOIN seats s ON s.cid = c.id WHERE c.room = ?1 GROUP BY c.vibe').bind(room).all()).results || [];
    const here = (await D1.prepare('SELECT vibe, COUNT(*) AS n FROM presence WHERE room = ?1 AND seen > ?2 GROUP BY vibe').bind(room, now - 30000).all()).results || [];
    const mine = vil.find((v) => v.room === room) || { room, m: 0, w: 0 };
    const spaces = Object.keys(HV).map((k) => { const x = sp.find((y) => y.vibe === k) || { c: 0, p: 0 }; return { key: k, name: HV[k].name, party: !!HV[k].party, circles: x.c, people: x.p, here: (here.find((y) => y.vibe === k) || { n: 0 }).n }; });
    return apiJson(req, { ok: true, city: env.CITY_NAME || 'Delhi NCR', room, inside: mine.m || 0, gate: mine.w || 0, live: (live.find((l) => l.room === room) || { n: 0 }).n, spaces, villages: vil.filter((v) => v.room !== room).map((v) => ({ room: v.room, members: v.m || 0, gate: v.w || 0, live: (live.find((l) => l.room === v.room) || { n: 0 }).n })) });
  }
  if (path === '/api/sq/vouch') {
    const t = await D1.prepare('SELECT uid, alias, room, member FROM people WHERE pid = ?1').bind(String(body.pid || '')).first();
    if (!t) return apiJson(req, { ok: false, error: 'We couldn’t find them.' }, 404);
    if (t.uid === me) return apiJson(req, { ok: false, error: 'You can’t vouch for yourself, love.' }, 400);
    if (t.member) return apiJson(req, { ok: false, error: 'They’re already inside.' }, 400);
    const core = await adCore(env, me);
    if (!core && !(r.member && !r.member.suspended)) return apiJson(req, { ok: false, error: 'Only members can vouch.' }, 403);
    if (!core && t.room !== room) return apiJson(req, { ok: false, error: 'You can vouch for people waiting at your own Village’s gate.' }, 403);
    if (body.on === false) {
      await D1.prepare('DELETE FROM vouches WHERE aid = ?1 AND vid = ?2').bind(t.uid, me).run();
      return apiJson(req, { ok: true, vouched: false });
    }
    const today = await D1.prepare('SELECT COUNT(*) AS n FROM vouches WHERE vid = ?1 AND at > ?2').bind(me, now - 86400000).first();
    if (!core && today && today.n >= 5) return apiJson(req, { ok: false, error: 'Five vouches a day is plenty. Your word matters more when it’s rare.' }, 429);
    await D1.prepare('INSERT OR IGNORE INTO vouches (aid, vid, kind, at) VALUES (?1, ?2, ?3, ?4)').bind(t.uid, me, core ? 'core' : 'member', now).run();
    await say(env, t.uid, '✦ ' + (r.alias || 'A member') + ' vouched for you. Your place at the gate just got closer.', [[{ text: 'Open the Village', url: SQ_APP + '#go' }]]);
    await vMaybeReady(env, t.uid);
    return apiJson(req, { ok: true, vouched: true });
  }
  return apiJson(req, { ok: false, error: 'not found' }, 404);
}
// Admin console. Every route checks the team chat first; outsiders get nothing at all.
async function adApi(req, path, env, body, me, r, room, now) {
  const D1 = env.D1;
  await adReady(env);
  await hReady(env);
  const staff = await adStaff(env, me);
  if (!staff) return apiJson(req, { ok: false, error: 'forbidden' }, 403);
  const founder = !!isFounder(env, me);
  const cfg = await adCfg(env);
  const memo = new Map();
  const pidOf = async (pid) => (await D1.prepare('SELECT uid FROM people WHERE pid = ?1').bind(String(pid || '')).first());
  if (path === '/api/sq/ad/me') return apiJson(req, { ok: true, alias: r.alias || '', founder, cfg });
  if (path === '/api/sq/ad/overview') {
    const rows = (await D1.prepare("SELECT uid, pid, alias, room, member, points, temples, stage, since, need, flag, at FROM people WHERE done = 1 ORDER BY at DESC LIMIT 500").all()).results || [];
    const bondN = (await D1.prepare("SELECT u, COUNT(*) AS n FROM (SELECT a AS u FROM bonds WHERE status = 'bonded' UNION ALL SELECT b AS u FROM bonds WHERE status = 'bonded') GROUP BY u").all()).results || [];
    const bn = new Map(bondN.map((x) => [x.u, x.n]));
    const gate = [], members = [];
    for (const x of rows) {
      const base = { pid: x.pid, alias: x.alias, room: x.room, points: sqParse(x.points), temples: sqParse(x.temples) || [], stage: x.stage || '', flag: !!x.flag, bonds: bn.get(x.uid) || 0, seen: x.at };
      if (x.member) { members.push(Object.assign(base, { since: x.since || '' })); continue; }
      if (x.stage === 'Declined') continue;
      const t = await vTally(env, x.uid, cfg, memo);
      const v = x.stage === 'Voting' ? await getVote(env, x.uid) : null;
      gate.push(Object.assign(base, { need: !!x.need, pts: t.pts, ready: t.ready, by: t.by.map((b) => ({ alias: b.alias, kind: b.kind, w: b.w })), vote: v && v.status === 'open' ? { yes: v.yes.length, no: v.no.length, closes: istLabel(v.deadline) } : null }));
    }
    gate.sort((a, b) => (b.ready - a.ready) || (b.pts - a.pts) || (b.seen - a.seen));
    const rooms = {};
    for (const x of rows) { if (x.stage === 'Declined') continue; rooms[x.room] = rooms[x.room] || { room: x.room, members: 0, gate: 0 }; rooms[x.room][x.member ? 'members' : 'gate']++; }
    const live = await D1.prepare('SELECT COUNT(*) AS n FROM presence WHERE seen > ?1').bind(now - 30000).first();
    const circles = (await D1.prepare('SELECT c.id, c.room, c.topic, c.cap, c.hushed, COUNT(s.uid) AS n FROM circles c JOIN seats s ON s.cid = c.id GROUP BY c.id ORDER BY c.last DESC LIMIT 50').all()).results || [];
    const log = ((await D1.prepare('SELECT l.act, l.target, l.at, p.alias FROM adlog l LEFT JOIN people p ON p.uid = l.who ORDER BY l.id DESC LIMIT 40').all()).results || []).map((x) => ({ who: x.alias || 'team', act: x.act, target: x.target, at: x.at }));
    return apiJson(req, { ok: true, founder, cfg, gate, members, villages: Object.values(rooms), live: live ? live.n : 0, circles: circles.map((c) => ({ id: c.id, room: c.room, topic: c.topic, n: c.n, cap: c.cap, knock: c.hushed === 1 })), log });
  }
  if (path === '/api/sq/ad/decide') {
    if (!founder) return apiJson(req, { ok: false, error: 'Only founders can admit or decline.' }, 403);
    const t = await pidOf(body.pid);
    const a = t ? await getRec(env, t.uid) : null;
    if (!a) return apiJson(req, { ok: false, error: 'Not found.' }, 404);
    if (a.member) return apiJson(req, { ok: false, error: 'Already a member.' }, 400);
    const yes = body.yes === true;
    await founderDecide(env, t.uid, a, yes, (r.alias || 'founder') + ' (console)');
    await adLog(env, me, yes ? 'admitted' : 'declined', a.alias || '');
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/ad/flag') {
    const t = await pidOf(body.pid);
    const a = t ? await getRec(env, t.uid) : null;
    if (!a) return apiJson(req, { ok: false, error: 'Not found.' }, 404);
    if (body.on) a.flag = (r.alias || 'team') + ' · console'; else delete a.flag;
    await putRec(env, t.uid, a);
    await adLog(env, me, body.on ? 'flagged' : 'unflagged', a.alias || '');
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/ad/close') {
    const c = await D1.prepare('SELECT topic FROM circles WHERE id = ?1').bind(Math.floor(Number(body.id) || 0)).first();
    if (!c) return apiJson(req, { ok: true });
    await D1.batch([D1.prepare('DELETE FROM seats WHERE cid = ?1').bind(Math.floor(Number(body.id))), D1.prepare('DELETE FROM circles WHERE id = ?1 AND id NOT IN (SELECT cid FROM owned)').bind(Math.floor(Number(body.id)))]);
    await adLog(env, me, 'closed circle', c.topic);
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/ad/cfg') {
    if (!founder) return apiJson(req, { ok: false, error: 'Only founders can change settings.' }, 403);
    const ch = [];
    for (const k of Object.keys(AD_DEF)) {
      if (body[k] === undefined) continue;
      const n = Number(body[k]);
      if (!isFinite(n) || n < 0 || n > (k === 'freshDays' ? 365 : 50)) return apiJson(req, { ok: false, error: 'That value for ' + k + ' doesn’t look right.' }, 400);
      await D1.prepare('INSERT OR REPLACE INTO cfg (k, v) VALUES (?1, ?2)').bind(k, String(n)).run();
      ch.push(k + '=' + n);
    }
    if (ch.length) { await adLog(env, me, 'changed settings', ch.join(', ')); await D1.prepare('DELETE FROM readynote').run(); }
    return apiJson(req, { ok: true, cfg: await adCfg(env) });
  }
  return apiJson(req, { ok: false, error: 'not found' }, 404);
}

/* ===== The Duty Board and tokens (added 19 Nov 2026, Lab first). ===== */
let PG_READY = false;
const PG_FUEL = 1;
const PG_MAX_HOPS = 6;
async function pgReady(env) {
  if (PG_READY) return;
  await duReady(env);
  await hReady(env);
  await env.D1.batch([
    env.D1.prepare('CREATE TABLE IF NOT EXISTS pilgrims (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, target TEXT, status TEXT, welcomed INTEGER DEFAULT 0, at INTEGER, last INTEGER)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS pilgrims_t ON pilgrims (target)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS pgintro (id INTEGER PRIMARY KEY AUTOINCREMENT, pg INTEGER, uid TEXT, by TEXT, to_uid TEXT, status TEXT, kind TEXT, note TEXT, paid INTEGER DEFAULT 0, at INTEGER)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS pgmsg (id INTEGER PRIMARY KEY AUTOINCREMENT, intro INTEGER, uid TEXT, body TEXT, at INTEGER)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS pgseen (intro INTEGER, uid TEXT, seen INTEGER, PRIMARY KEY (intro, uid))'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS pgparts (intro INTEGER, k TEXT, body TEXT, at INTEGER, PRIMARY KEY (intro, k))'),
  ]);
  PG_READY = true;
}
async function pgGraph(env) {
  const rows = (await env.D1.prepare("SELECT a, b FROM bonds WHERE status = 'bonded'").all()).results || [];
  const g = new Map();
  const add = (x, y) => { if (!g.has(x)) g.set(x, []); g.get(x).push(y); };
  rows.forEach((r) => { add(r.a, r.b); add(r.b, r.a); });
  return g;
}
function pgBfs(g, from) {
  const prev = new Map([[from, null]]);
  const dist = new Map([[from, 0]]);
  const q = [from];
  while (q.length) {
    const x = q.shift();
    if (dist.get(x) >= PG_MAX_HOPS) continue;
    for (const y of g.get(x) || []) if (!prev.has(y)) { prev.set(y, x); dist.set(y, dist.get(x) + 1); q.push(y); }
  }
  return { prev, dist };
}
function pgPath(b, to) {
  if (!b.prev.has(to)) return null;
  const p = [];
  for (let x = to; x !== null; x = b.prev.get(x)) p.unshift(x);
  return p;
}
async function pgPerson(env, uid) { return await env.D1.prepare('SELECT uid, pid, alias, room, member FROM people WHERE uid = ?1').bind(uid).first(); }
async function pgSpend(env, uid, n, why) {
  const bal = await duBal(env, uid);
  if (bal < n) return false;
  await env.D1.batch([
    env.D1.prepare('UPDATE tokens SET bal = bal - ?2 WHERE uid = ?1').bind(uid, n),
    env.D1.prepare('INSERT INTO tokenlog (uid, delta, why, at) VALUES (?1, ?2, ?3, ?4)').bind(uid, -n, why, Date.now()),
  ]);
  return true;
}
async function pgTell(env, uid, text) { if (!(await hQuiet(env, uid))) await say(env, uid, text, [[{ text: 'Open the Wayside', url: SQ_APP + '#go' }]]); }
async function pgIntroduced(env, x, y) {
  await pgReady(env);
  return !!(await env.D1.prepare("SELECT 1 AS k FROM pgintro WHERE status IN ('open','met') AND ((uid = ?1 AND to_uid = ?2) OR (uid = ?2 AND to_uid = ?1))").bind(x, y).first());
}
async function pgRefundAsks(env, pg) {
  const asks = (await env.D1.prepare("SELECT id, paid FROM pgintro WHERE pg = ?1 AND status = 'asked'").bind(pg.id).all()).results || [];
  const back = asks.reduce((s, x) => s + (x.paid || 0), 0);
  await env.D1.prepare("UPDATE pgintro SET status = 'withdrawn' WHERE pg = ?1 AND status = 'asked'").bind(pg.id).run();
  if (back) await duMint(env, pg.uid, back, 'Pilgrimage: fuel returned');
  return back;
}
const pgDay = (ms) => { try { return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return ''; } };
const pgMon = (iso) => { const t = Date.parse(iso || ''); if (!isFinite(t)) return ''; try { return new Date(t).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return ''; } };
async function pgDraft(env, by, uid) {
  const D1 = env.D1;
  const p = await D1.prepare('SELECT alias, member, since, flag FROM people WHERE uid = ?1').bind(uid).first();
  const b = await pgPerson(env, by);
  if (!p) return [];
  const name = p.alias || 'They';
  const parts = [];
  const bond = await D1.prepare("SELECT at FROM bonds WHERE ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)) AND status = 'bonded'").bind(by, uid).first();
  if (bond && bond.at > 1) parts.push({ k: 'bond', body: name + ' and ' + ((b && b.alias) || 'I') + ' have been bonded since ' + pgDay(bond.at) + '.' });
  const [x, y] = by < uid ? [by, uid] : [uid, by];
  const tg = await D1.prepare('SELECT secs FROM together WHERE a = ?1 AND b = ?2').bind(x, y).first();
  const mins = Math.round(((tg && tg.secs) || 0) / 60);
  if (mins >= 1) parts.push({ k: 'time', body: name + ' and ' + ((b && b.alias) || 'I') + ' have spent ' + (mins >= 90 ? 'about ' + Math.round(mins / 60) + ' hours' : mins + ' min') + ' together in circles.' });
  if (p.member && p.since && pgMon(p.since)) parts.push({ k: 'since', body: name + ' has been a member since ' + pgMon(p.since) + '.' });
  try {
    const d = await D1.prepare("SELECT COUNT(*) AS n FROM duties WHERE taker = ?1 AND status = 'closed'").bind(uid).first();
    if (d && d.n) parts.push({ k: 'duties', body: name + ' has answered ' + d.n + ' dut' + (d.n === 1 ? 'y' : 'ies') + ' for the village.' });
  } catch (e) {}
  try {
    const v = await D1.prepare('SELECT COUNT(*) AS n FROM vouches WHERE aid = ?1').bind(uid).first();
    if (v && v.n) parts.push({ k: 'vouch', body: name + ' came in on ' + v.n + ' vouch' + (v.n === 1 ? '' : 'es') + '.' });
  } catch (e) {}
  if (p.member && !p.flag) parts.push({ k: 'clean', body: 'No reports or flags on record.' });
  return parts;
}
async function pgPartsOf(env, intro) { return ((await env.D1.prepare('SELECT k, body FROM pgparts WHERE intro = ?1 ORDER BY at').bind(intro).all()).results || []).map((x) => ({ k: x.k, body: x.body })); }
async function pgApi(req, path, env, body, me, r, room, now) {
  await pgReady(env);
  const D1 = env.D1;
  const core = await adCore(env, me);
  const pub = (p) => (p ? { pid: p.pid, alias: p.alias, room: p.room, member: !!p.member } : null);
  const active = async () => await D1.prepare("SELECT * FROM pilgrims WHERE uid = ?1 AND status = 'walking' ORDER BY id DESC LIMIT 1").bind(me).first();
  const bondedTo = async (o) => !!(await D1.prepare("SELECT 1 AS k FROM bonds WHERE ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)) AND status = 'bonded'").bind(me, o).first());
  const route = async (pg) => {
    const b = pgBfs(await pgGraph(env), pg.uid);
    return pgPath(b, pg.target);
  };
  const arrive = async (pg) => {
    await D1.prepare("UPDATE pilgrims SET status = 'arrived', last = ?2 WHERE id = ?1").bind(pg.id, now).run();
    const t = await pgPerson(env, pg.target), p = await pgPerson(env, pg.uid);
    await pgTell(env, pg.uid, '✦ Your pilgrimage is complete. You and ' + ((t && t.alias) || 'them') + ' are bonded now.');
    await pgTell(env, pg.target, '✦ ' + ((p && p.alias) || 'A pilgrim') + ' has arrived. Their road to you is complete.');
  };
  const trail = async (pg) => {
    const steps = (await D1.prepare("SELECT i.id, i.by, i.to_uid, i.kind, i.note, i.status, i.at FROM pgintro i WHERE i.pg = ?1 AND i.status IN ('open','met') ORDER BY i.id").bind(pg.id).all()).results || [];
    const out = [];
    for (const s of steps) out.push({ by: pub(await pgPerson(env, s.by)), to: pub(await pgPerson(env, s.to_uid)), kind: s.kind || 'plain', note: s.note || '', parts: s.kind === 'verified' ? await pgPartsOf(env, s.id) : [], at: s.at });
    return out;
  };
  const meetView = async (i) => {
    const p = await pgPerson(env, i.uid), a = await pgPerson(env, i.by), b = await pgPerson(env, i.to_uid);
    const other = me === i.uid ? b : p;
    return { id: i.id, status: i.status, pilgrim: pub(p), by: pub(a), to: pub(b), other: pub(other), note: i.note || '', kind: i.kind || 'plain', parts: i.kind === 'verified' ? await pgPartsOf(env, i.id) : [], bonded: other ? await bondedTo(other.uid) : false, canBond: me === i.uid || me === i.to_uid, at: i.at };
  };

  if (path === '/api/sq/pg/list') {
    const pg = await active();
    let mine = null;
    if (pg) {
      const t = await pgPerson(env, pg.target);
      const path_ = await route(pg);
      if (path_ && path_.length === 2) { await arrive(pg); }
      else {
        const ask = await D1.prepare("SELECT * FROM pgintro WHERE pg = ?1 AND status = 'asked' ORDER BY id DESC LIMIT 1").bind(pg.id).first();
        const next = path_ ? await pgPerson(env, path_[1]) : null;
        mine = { id: pg.id, target: pub(t), welcomed: !!pg.welcomed, steps: path_ ? path_.length - 1 : null, next: pub(next), asked: ask ? pub(await pgPerson(env, ask.by)) : null, made: ((await D1.prepare("SELECT COUNT(*) AS n FROM pgintro WHERE pg = ?1 AND status IN ('open','met')").bind(pg.id).first()) || {}).n || 0, at: pg.at };
      }
    }
    const done = await D1.prepare("SELECT p.id, p.target, p.last FROM pilgrims p WHERE p.uid = ?1 AND p.status = 'arrived' ORDER BY p.last DESC LIMIT 1").bind(me).first();
    const asks = [];
    for (const i of (await D1.prepare("SELECT * FROM pgintro WHERE by = ?1 AND status = 'asked' ORDER BY id").bind(me).all()).results || []) asks.push({ id: i.id, pilgrim: pub(await pgPerson(env, i.uid)), to: pub(await pgPerson(env, i.to_uid)), at: i.at });
    const coming = [];
    for (const pg2 of (await D1.prepare("SELECT * FROM pilgrims WHERE target = ?1 AND status = 'walking' ORDER BY id").bind(me).all()).results || []) {
      const b = pgBfs(await pgGraph(env), pg2.uid);
      coming.push({ id: pg2.id, pilgrim: pub(await pgPerson(env, pg2.uid)), welcomed: !!pg2.welcomed, steps: b.dist.has(me) ? b.dist.get(me) : null, trail: await trail(pg2), at: pg2.at });
    }
    const meets = [];
    for (const i of (await D1.prepare("SELECT * FROM pgintro WHERE status IN ('open','met') AND (uid = ?1 OR by = ?1 OR to_uid = ?1) ORDER BY id DESC LIMIT 12").bind(me).all()).results || []) meets.push(await meetView(i));
    return apiJson(req, { ok: true, fuel: PG_FUEL, core, tokens: await duBal(env, me), mine, arrived: done ? pub(await pgPerson(env, done.target)) : null, asks, coming, meets });
  }
  if (path === '/api/sq/pg/targets') {
    const b = pgBfs(await pgGraph(env), me);
    const rows = (await D1.prepare("SELECT uid, pid, alias, room, member FROM people WHERE done = 1 AND stage != 'Declined' AND uid != ?1 ORDER BY (room = ?2) DESC, member DESC, alias LIMIT 200").bind(me, room).all()).results || [];
    const out = rows.filter((x) => b.dist.get(x.uid) !== 1).map((x) => ({ ...pub(x), steps: b.dist.has(x.uid) ? b.dist.get(x.uid) : null }));
    out.sort((x, y) => (x.steps === null) - (y.steps === null) || (x.steps || 0) - (y.steps || 0));
    return apiJson(req, { ok: true, people: out.slice(0, 80) });
  }
  if (path === '/api/sq/pg/start') {
    if (!r.member && !core) return apiJson(req, { ok: false, error: 'Pilgrimages open once you’re a member.' }, 403);
    if (await active()) return apiJson(req, { ok: false, error: 'You’re already on a pilgrimage. Finish it or set it down first.' }, 409);
    const t = await D1.prepare("SELECT uid, alias FROM people WHERE pid = ?1 AND done = 1 AND stage != 'Declined'").bind(String(body.pid || '')).first();
    if (!t) return apiJson(req, { ok: false, error: 'We couldn’t find them on the Map.' }, 404);
    if (t.uid === me) return apiJson(req, { ok: false, error: 'That’s you, love.' }, 400);
    if (await bondedTo(t.uid)) return apiJson(req, { ok: false, error: 'You’re already bonded with ' + t.alias + '. No road needed.' }, 400);
    const turned = await D1.prepare("SELECT 1 AS k FROM pilgrims WHERE uid = ?1 AND target = ?2 AND status = 'turned' AND last > ?3").bind(me, t.uid, now - 30 * 86400000).first();
    if (turned) return apiJson(req, { ok: false, error: 'That road is closed for now.' }, 403);
    const p = pgPath(pgBfs(await pgGraph(env), me), t.uid);
    if (!p) return apiJson(req, { ok: false, noroad: true, error: 'No road to ' + t.alias + ' yet. Nobody you know knows them. Spend time in circles; roads appear.' }, 404);
    const res = await D1.prepare("INSERT INTO pilgrims (uid, target, status, at, last) VALUES (?1, ?2, 'walking', ?3, ?3)").bind(me, t.uid, now).run();
    await pgTell(env, t.uid, '✦ Someone has set out on a pilgrimage toward you, ' + (p.length - 1) + ' introductions away. You can see who, and the road they take, in the Wayside.');
    return apiJson(req, { ok: true, id: res.meta.last_row_id, steps: p.length - 1 });
  }
  if (path === '/api/sq/pg/ask') {
    const pg = await active();
    if (!pg) return apiJson(req, { ok: false, error: 'You’re not on a pilgrimage.' }, 404);
    if (await D1.prepare("SELECT 1 AS k FROM pgintro WHERE pg = ?1 AND status = 'asked'").bind(pg.id).first()) return apiJson(req, { ok: false, error: 'You’ve already asked. Give them time.' }, 409);
    const p = await route(pg);
    if (!p) return apiJson(req, { ok: false, noroad: true, error: 'The road has closed. A bond on it was broken.' }, 409);
    if (p.length === 2) { await arrive(pg); return apiJson(req, { ok: true, arrived: true }); }
    const by = p[1], to = p[2];
    const recent = await D1.prepare("SELECT 1 AS k FROM pgintro WHERE uid = ?1 AND by = ?2 AND to_uid = ?3 AND status = 'declined' AND at > ?4").bind(me, by, to, now - 7 * 86400000).first();
    if (recent) return apiJson(req, { ok: false, error: 'They said not now. Try again in a few days, or let the road change.' }, 429);
    const paid = core ? 0 : PG_FUEL;
    if (paid && !(await pgSpend(env, me, paid, 'Pilgrimage: an introduction'))) return apiJson(req, { ok: false, fuel: true, error: 'Each introduction costs ' + PG_FUEL + ' token of fuel. Answer a duty on the Duty Board to earn one.' }, 402);
    const res = await D1.prepare("INSERT INTO pgintro (pg, uid, by, to_uid, status, kind, paid, at) VALUES (?1, ?2, ?3, ?4, 'asked', 'plain', ?5, ?6)").bind(pg.id, me, by, to, paid, now).run();
    const tp = await pgPerson(env, to);
    await pgTell(env, by, '✦ ' + (r.alias || 'Someone') + ' is on a pilgrimage and asks you to introduce them to ' + ((tp && tp.alias) || 'someone you know') + '.');
    return apiJson(req, { ok: true, id: res.meta.last_row_id });
  }
  if (path === '/api/sq/pg/draft') {
    const i = await D1.prepare("SELECT * FROM pgintro WHERE id = ?1 AND by = ?2 AND status = 'asked'").bind(Math.floor(Number(body.id) || 0), me).first();
    if (!i) return apiJson(req, { ok: false, error: 'That ask has closed.' }, 404);
    return apiJson(req, { ok: true, parts: await pgDraft(env, me, i.uid) });
  }
  if (path === '/api/sq/pg/intro') {
    const i = await D1.prepare("SELECT * FROM pgintro WHERE id = ?1 AND by = ?2 AND status = 'asked'").bind(Math.floor(Number(body.id) || 0), me).first();
    if (!i) return apiJson(req, { ok: false, error: 'That ask has closed.' }, 404);
    const p = await pgPerson(env, i.uid), b = await pgPerson(env, i.to_uid);
    if (!body.yes) {
      await D1.prepare("UPDATE pgintro SET status = 'declined', at = ?2 WHERE id = ?1").bind(i.id, now).run();
      if (i.paid) await duMint(env, i.uid, i.paid, 'Pilgrimage: fuel returned');
      await pgTell(env, i.uid, '✦ ' + (r.alias || 'They') + ' can’t make that introduction just now. Your fuel is back.');
      return apiJson(req, { ok: true });
    }
    const note = String(body.note || '').replace(/[ \t]+/g, ' ').trim().slice(0, 400);
    const want = new Set(Array.isArray(body.parts) ? body.parts.map(String) : []);
    const keep = body.kind === 'verified' ? (await pgDraft(env, me, i.uid)).filter((x) => want.has(x.k)) : [];
    const kind = keep.length ? 'verified' : 'plain';
    if (keep.length) await D1.batch(keep.map((x, n) => D1.prepare('INSERT OR REPLACE INTO pgparts (intro, k, body, at) VALUES (?1, ?2, ?3, ?4)').bind(i.id, x.k, x.body, now + n)));
    await D1.prepare("UPDATE pgintro SET status = 'open', note = ?2, kind = ?3, at = ?4 WHERE id = ?1").bind(i.id, note, kind, now).run();
    if (note) await D1.prepare('INSERT INTO pgmsg (intro, uid, body, at) VALUES (?1, ?2, ?3, ?4)').bind(i.id, me, note, now).run();
    await pgTell(env, i.to_uid, '✦ ' + (r.alias || 'Someone') + ' has introduced you to ' + ((p && p.alias) || 'a pilgrim') + ' at the Wayside.');
    await pgTell(env, i.uid, '✦ ' + (r.alias || 'They') + ' introduced you to ' + ((b && b.alias) || 'them') + '. Meet at the Wayside.');
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/pg/meet' || path === '/api/sq/pg/say') {
    const i = await D1.prepare("SELECT * FROM pgintro WHERE id = ?1 AND status IN ('open','met') AND (uid = ?2 OR by = ?2 OR to_uid = ?2)").bind(Math.floor(Number(body.id) || 0), me).first();
    if (!i) return apiJson(req, { ok: false, error: 'That meeting has closed.' }, 404);
    if (path === '/api/sq/pg/say') {
      const text = String(body.text || '').replace(/[ \t]+/g, ' ').trim().slice(0, 1000);
      if (!text) return apiJson(req, { ok: false, error: 'Say something first.' }, 400);
      const last = await D1.prepare('SELECT at FROM pgmsg WHERE uid = ?1 ORDER BY id DESC LIMIT 1').bind(me).first();
      if (last && now - last.at < 800) return apiJson(req, { ok: false, error: 'A breath between messages, love.' }, 429);
      await D1.prepare('INSERT INTO pgmsg (intro, uid, body, at) VALUES (?1, ?2, ?3, ?4)').bind(i.id, me, text, now).run();
      return apiJson(req, { ok: true });
    }
    const mine = await D1.prepare('SELECT seen FROM pgseen WHERE intro = ?1 AND uid = ?2').bind(i.id, me).first();
    const others = (await D1.prepare('SELECT uid, seen FROM pgseen WHERE intro = ?1 AND uid != ?2 AND seen > ?3').bind(i.id, me, now - 20000).all()).results || [];
    if (mine && mine.seen) {
      const dt = Math.min(15, Math.max(0, (now - mine.seen) / 1000));
      if (dt > 0 && others.length) await D1.batch(others.map((o) => { const x = me < o.uid ? me : o.uid, y = me < o.uid ? o.uid : me; return D1.prepare('INSERT INTO together (a, b, secs, last) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (a, b) DO UPDATE SET secs = secs + ?3, last = ?4').bind(x, y, dt / 2, now); }));
    }
    await D1.prepare('INSERT INTO pgseen (intro, uid, seen) VALUES (?1, ?2, ?3) ON CONFLICT (intro, uid) DO UPDATE SET seen = ?3').bind(i.id, me, now).run();
    const after = Math.max(0, Math.floor(Number(body.after) || 0));
    const ms = (await D1.prepare('SELECT m.id, m.uid, m.body, m.at, p.alias FROM pgmsg m JOIN people p ON p.uid = m.uid WHERE m.intro = ?1 AND m.id > ?2 ORDER BY m.id LIMIT 200').bind(i.id, after).all()).results || [];
    const v = await meetView(i);
    const [x, y] = i.uid < i.to_uid ? [i.uid, i.to_uid] : [i.to_uid, i.uid];
    const tg = await D1.prepare('SELECT secs FROM together WHERE a = ?1 AND b = ?2').bind(x, y).first();
    v.mins = Math.round(((tg && tg.secs) || 0) / 60);
    v.here = others.map((o) => o.uid === i.uid ? 'pilgrim' : o.uid === i.by ? 'by' : 'to');
    return apiJson(req, { ok: true, meet: v, msgs: ms.map((m) => ({ id: m.id, alias: m.alias, body: m.body, at: m.at, mine: m.uid === me, by: m.uid === i.by })) });
  }
  if (path === '/api/sq/pg/turn') {
    const pg = await D1.prepare("SELECT * FROM pilgrims WHERE id = ?1 AND target = ?2 AND status = 'walking'").bind(Math.floor(Number(body.id) || 0), me).first();
    if (!pg) return apiJson(req, { ok: false, error: 'That pilgrimage has ended.' }, 404);
    if (body.yes) {
      await D1.prepare('UPDATE pilgrims SET welcomed = 1, last = ?2 WHERE id = ?1').bind(pg.id, now).run();
      await pgTell(env, pg.uid, '✦ Someone at the end of your road has heard you’re coming, and you’re welcome.');
      return apiJson(req, { ok: true });
    }
    const back = await pgRefundAsks(env, pg);
    await D1.prepare("UPDATE pilgrims SET status = 'turned', last = ?2 WHERE id = ?1").bind(pg.id, now).run();
    await pgTell(env, pg.uid, '✦ This road has closed. The person at the end of it isn’t receiving pilgrims right now. Nothing more is said.');
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/pg/drop') {
    const pg = await active();
    if (!pg) return apiJson(req, { ok: true });
    await pgRefundAsks(env, pg);
    await D1.prepare("UPDATE pilgrims SET status = 'dropped', last = ?2 WHERE id = ?1").bind(pg.id, now).run();
    return apiJson(req, { ok: true });
  }
  return apiJson(req, { ok: false, error: 'Not found' }, 404);
}
const LB_NAMES = ['Asha', 'Kabir', 'Noor', 'Ira', 'Dev', 'Mira', 'Zoya', 'Arjun', 'Tara', 'Rohan', 'Leela', 'Vikram', 'Saanvi', 'Neel', 'Anaya', 'Kian', 'Rhea', 'Aarav', 'Myra', 'Ishaan', 'Kavya', 'Reyansh', 'Diya', 'Vihaan', 'Sana', 'Advait', 'Pari', 'Yash', 'Inaya', 'Omar', 'Riya', 'Farhan', 'Meher', 'Kabeer', 'Alina', 'Rudra', 'Tanvi', 'Zubin', 'Nyra', 'Shaan', 'Esha', 'Laksh', 'Aditi', 'Vir', 'Juhi', 'Rafi', 'Siya', 'Ayaan'];
const LB_TOPICS = {
  foyer: ['Just got here, who else is new?', 'Saturday plans?', 'Someone recommend a good chai spot'],
  salon: ['A book that changed your mind', 'What Delhi gets wrong about itself', 'A song that sounds like a person', 'Is nostalgia a trap?'],
  cards: ['Which smell takes you straight home?', 'What would you teach for free?', 'One year in any decade: which?'],
  snug: ['What are you looking forward to?', 'When did you last feel completely yourself?'],
};
const LB_LINES = {
  foyer: ['Hello hello ✦', 'First week here. Everyone seems lovely so far', 'Anyone going to the First House?', 'I came in through Noor, she wouldn’t stop talking about this place', 'Hauz Khas this weekend, anyone?', 'What’s everyone drinking tonight?', 'Ha, welcome!', 'The Card Room is fun tonight, go peek'],
  salon: ['Sapiens, honestly. Changed how I see everything', 'Delhi pretends it doesn’t care about art, it cares a lot', 'Hard disagree, but tell me more', 'That’s such a good way to put it', 'Rumi, always Rumi', 'I think nostalgia is just love with nowhere to go', 'Okay that one landed', 'Wait, say that again?'],
  cards: ['Wet earth after the first rain. Every time', 'My nani’s kitchen, cardamom everywhere', 'I’d teach people how to cook dal properly', 'The 70s, for the music alone', 'Fresh paper from a new notebook', 'I’d teach swimming. Everyone should be able to swim', 'Okay this question is too good', 'Mine’s the sea at Gokarna'],
  snug: ['Honestly, this weekend', 'Last month in the hills, no signal, just people', 'Seeing my sister after a year', 'Right now, kind of', 'That’s beautiful', 'Thank you for asking that'],
};
const LB_REPLY = ['Ooh, tell us more', 'Welcome in ✦', 'Ha, I love that', 'Same here honestly', 'That’s a great question', 'Wait, really?', 'Agreed', 'Okay you’re officially one of us'];
const LB_DUTIES = [
  ['Host a circle on Sunday evening', 'Keep the Salon warm for an hour, any topic.', 'digital'],
  ['Write the welcome note for new members', 'Two lines, in the house voice.', 'digital'],
  ['Make a playlist for the First House', '20 songs, slow to fast.', 'digital'],
  ['Help set up the lanterns', 'Saturday 6pm at the house. Bring tape.', 'irl'],
  ['Walk someone to the metro after the night', 'Safety first, a friendly face.', 'irl'],
  ['Bring a speaker to the Snug night', 'Anything with bluetooth.', 'irl'],
  ['Find a good samosa place near Saket', 'Report back with photos.', 'digital'],
];
const lbPick = (a) => a[Math.floor(Math.random() * a.length)];
const lbHex = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
let LB_LAST = 0;
async function lbRooms(env, myRoom) {
  const rows = (await env.D1.prepare("SELECT DISTINCT room FROM people WHERE room IS NOT NULL AND room != ''").all()).results || [];
  const set = new Set(rows.map((r) => r.room).filter((r) => r !== 'outside'));
  set.add(myRoom);
  const m = /^(.*?)(\d+)$/.exec(myRoom || '');
  if (m) for (let i = 1; set.size < 4 && i < 9; i++) set.add(m[1] + i);
  else for (let i = 2; set.size < 4; i++) set.add((myRoom || 'Village') + ' ' + i);
  return [myRoom, ...[...set].filter((r) => r !== myRoom)].slice(0, 4);
}
async function lbClear(env) {
  const D1 = env.D1;
  const like = "'bot:%'";
  const qs = [
    `DELETE FROM lines WHERE uid LIKE ${like} OR cid IN (SELECT DISTINCT cid FROM seats WHERE uid LIKE ${like})`,
    `DELETE FROM knocks WHERE uid LIKE ${like}`,
    `DELETE FROM circles WHERE id IN (SELECT DISTINCT cid FROM seats WHERE uid LIKE ${like}) AND id NOT IN (SELECT cid FROM seats WHERE uid NOT LIKE ${like})`,
    `DELETE FROM seats WHERE uid LIKE ${like}`,
    `DELETE FROM presence WHERE uid LIKE ${like}`,
    `DELETE FROM bonds WHERE a LIKE ${like} OR b LIKE ${like}`,
    `DELETE FROM together WHERE a LIKE ${like} OR b LIKE ${like}`,
    `DELETE FROM dms WHERE a LIKE ${like} OR b LIKE ${like}`,
    `DELETE FROM duties WHERE by LIKE ${like} OR taker LIKE ${like}`,
    `DELETE FROM tokens WHERE uid LIKE ${like}`,
    `DELETE FROM tokenlog WHERE uid LIKE ${like}`,
    `DELETE FROM pgmsg WHERE intro IN (SELECT id FROM pgintro WHERE uid LIKE ${like} OR by LIKE ${like} OR to_uid LIKE ${like})`,
    `DELETE FROM pgparts WHERE intro IN (SELECT id FROM pgintro WHERE uid LIKE ${like} OR by LIKE ${like} OR to_uid LIKE ${like})`,
    `DELETE FROM pgintro WHERE uid LIKE ${like} OR by LIKE ${like} OR to_uid LIKE ${like}`,
    `DELETE FROM pilgrims WHERE uid LIKE ${like} OR target LIKE ${like}`,
    `DELETE FROM vouches WHERE aid LIKE ${like} OR vid LIKE ${like}`,
    `DELETE FROM people WHERE uid LIKE ${like}`,
  ];
  for (const q of qs) { try { await D1.prepare(q).run(); } catch (e) {} }
}
async function lbSeed(env, me, myRoom, now) {
  await pgReady(env);
  try { await adReady(env); } catch (e) {}
  await lbClear(env);
  const D1 = env.D1;
  const rooms = await lbRooms(env, myRoom);
  const per = [16, 12, 10, 8];
  const bots = [];
  let k = 0;
  rooms.forEach((room, ri) => {
    for (let i = 0; i < per[ri]; i++) {
      const name = LB_NAMES[k % LB_NAMES.length] + (k >= LB_NAMES.length ? ' ' + (Math.floor(k / LB_NAMES.length) + 1) : '');
      const gate = i >= per[ri] - 2;
      const since = new Date(now - (20 + Math.floor(Math.random() * 60)) * 86400000).toISOString().slice(0, 10);
      bots.push({ uid: 'bot:' + (k + 1), pid: lbHex(), alias: name, room, member: gate ? 0 : 1, stage: gate ? 'Chatting' : 'Member', since: gate ? '' : since });
      k++;
    }
  });
  const ops = [];
  for (const b of bots) ops.push(D1.prepare('INSERT OR REPLACE INTO people (uid, pid, room, alias, done, member, points, temples, stage, since, need, flag, at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)').bind(b.uid, b.pid, b.room, b.alias, b.member, 'null', '[]', b.stage, b.since, b.member ? 0 : 1, now));
  const pair = (x, y) => (x < y ? [x, y] : [y, x]);
  const seen = new Set();
  const bond = (x, y, secs) => {
    const [a, b] = pair(x, y);
    if (a === b || seen.has(a + '|' + b)) return;
    seen.add(a + '|' + b);
    ops.push(D1.prepare("INSERT OR REPLACE INTO bonds (a, b, status, at) VALUES (?1, ?2, 'bonded', ?3)").bind(a, b, now - Math.floor(Math.random() * 30) * 86400000));
    ops.push(D1.prepare('INSERT OR REPLACE INTO together (a, b, secs, last) VALUES (?1, ?2, ?3, ?4)').bind(a, b, secs || 600 + Math.floor(Math.random() * 18000), now));
  };
  for (const room of rooms) {
    const vs = bots.filter((b) => b.room === room);
    const mem = vs.filter((b) => b.member);
    for (let i = 0; i < mem.length; i++) { bond(mem[i].uid, mem[(i + 1) % mem.length].uid); if (Math.random() < 0.6) bond(mem[i].uid, lbPick(mem).uid); }
    vs.filter((b) => !b.member).forEach((g, j) => {
      ops.push(D1.prepare('INSERT OR REPLACE INTO vouches (aid, vid, kind, at) VALUES (?1, ?2, ?3, ?4)').bind(g.uid, mem[j % mem.length].uid, 'member', now - 3600000));
      if (j === 0) ops.push(D1.prepare('INSERT OR REPLACE INTO vouches (aid, vid, kind, at) VALUES (?1, ?2, ?3, ?4)').bind(g.uid, mem[(j + 2) % mem.length].uid, 'member', now - 1800000));
    });
  }
  const head = (room) => bots.filter((b) => b.room === room && b.member);
  for (let i = 1; i < rooms.length; i++) bond(lbPick(head(rooms[i - 1])).uid, lbPick(head(rooms[i])).uid);
  const mine = head(myRoom);
  [0, 3, 7].forEach((i) => mine[i] && bond(me, mine[i].uid, 1200 + i * 900));
  // live circles: bots seated, chatting
  const circles = [];
  for (const room of rooms) {
    const vs = head(room).slice();
    const plan = room === myRoom ? ['foyer', 'salon', 'cards', 'snug', 'salon'] : ['salon', 'cards', 'foyer'];
    for (const vibe of plan) {
      const n = Math.min(vs.length, vibe === 'snug' ? 2 : 2 + Math.floor(Math.random() * 3));
      if (n < 2) break;
      circles.push({ room, vibe, topic: lbPick(LB_TOPICS[vibe]), seated: vs.splice(0, n) });
    }
  }
  await D1.batch(ops);
  for (const c of circles) {
    const res = await D1.prepare('INSERT INTO circles (room, vibe, topic, hushed, cap, welcome, at, last) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)').bind(c.room, c.vibe, c.topic, HV[c.vibe].hush ? 1 : 0, HV[c.vibe].cap, now).run();
    const cid = res.meta.last_row_id;
    const o2 = [];
    c.seated.forEach((s, i) => {
      o2.push(D1.prepare('INSERT OR REPLACE INTO seats (cid, uid, at) VALUES (?1, ?2, ?3)').bind(cid, s.uid, now - 600000 + i));
      o2.push(D1.prepare('INSERT OR REPLACE INTO presence (uid, room, vibe, near, seen, since) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(s.uid, c.room, c.vibe, cid, now, now - 600000));
    });
    const said = LB_LINES[c.vibe].slice().sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 3));
    said.forEach((t, i) => o2.push(D1.prepare('INSERT INTO lines (cid, uid, body, at) VALUES (?1, ?2, ?3, ?4)').bind(cid, c.seated[i % c.seated.length].uid, t, now - (said.length - i) * 45000)));
    await D1.batch(o2);
  }
  // wanderers: present in the village but not seated
  const wander = bots.filter((b) => !circles.some((c) => c.seated.includes(b))).slice(0, 14);
  if (wander.length) await D1.batch(wander.map((b) => D1.prepare('INSERT OR REPLACE INTO presence (uid, room, vibe, near, seen, since) VALUES (?1, ?2, ?3, 0, ?4, ?4)').bind(b.uid, b.room, lbPick(['foyer', 'salon', 'cards']), now)));
  // duty board
  const o3 = [];
  LB_DUTIES.forEach((d, i) => {
    const by = lbPick(head(i < 5 ? myRoom : rooms[1] || myRoom));
    const taken = i === 2 ? lbPick(mine) : null;
    o3.push(D1.prepare('INSERT INTO duties (room, by, title, body, kind, official, reward, status, taker, at, taken_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10)').bind(by.room, by.uid, d[0], d[1], d[2], d[2] === 'irl' ? DU_REWARD.irl : DU_REWARD.digital, taken ? 'taken' : 'open', taken ? taken.uid : null, now - i * 3600000, taken ? now - 1800000 : null));
  });
  for (const b of bots.filter((x) => x.member)) o3.push(D1.prepare('INSERT OR REPLACE INTO tokens (uid, bal) VALUES (?1, ?2)').bind(b.uid, Math.floor(Math.random() * 6)));
  await D1.batch(o3);
  // pilgrims coming toward the founder, and one asking the founder for an introduction
  const far = bots.filter((b) => b.member && b.room !== myRoom);
  const p1 = far[0], p2 = far[far.length - 1];
  const g0 = await pgGraph(env);
  for (const p of [p1, p2].filter(Boolean).filter((p, i) => i === 0 || pgPath(pgBfs(g0, p.uid), me))) await D1.prepare("INSERT INTO pilgrims (uid, target, status, at, last) VALUES (?1, ?2, 'walking', ?3, ?3)").bind(p.uid, me, now - 7200000).run();
  if (p1) {
    const pg = await D1.prepare("SELECT id FROM pilgrims WHERE uid = ?1 AND status = 'walking'").bind(p1.uid).first();
    const via = mine[3] || mine[0];
    const hop = lbPick(head(rooms[1] || myRoom));
    if (pg && via && hop) {
      const r1 = await D1.prepare("INSERT INTO pgintro (pg, uid, by, to_uid, status, kind, note, paid, at) VALUES (?1, ?2, ?3, ?4, 'open', 'verified', ?5, 1, ?6)").bind(pg.id, p1.uid, hop.uid, via.uid, p1.alias + ' is the warmest person in our village. You’ll see.', now - 5000000).run();
      const [h1, h2] = pair(p1.uid, hop.uid), [v1, v2] = pair(p1.uid, via.uid);
      await D1.batch([
        D1.prepare("INSERT OR REPLACE INTO bonds (a, b, status, at) VALUES (?1, ?2, 'bonded', ?3)").bind(h1, h2, now - 9000000),
        D1.prepare('INSERT OR REPLACE INTO together (a, b, secs, last) VALUES (?1, ?2, 14400, ?3)').bind(h1, h2, now),
        D1.prepare("INSERT OR REPLACE INTO bonds (a, b, status, at) VALUES (?1, ?2, 'bonded', ?3)").bind(v1, v2, now - 3000000),
        D1.prepare('INSERT OR REPLACE INTO together (a, b, secs, last) VALUES (?1, ?2, 1500, ?3)').bind(v1, v2, now),
      ]);
      await D1.batch([
        D1.prepare('INSERT OR REPLACE INTO pgparts (intro, k, body, at) VALUES (?1, ?2, ?3, ?4)').bind(r1.meta.last_row_id, 'time', p1.alias + ' and ' + hop.alias + ' have spent about 4 hours together in circles.', now),
        D1.prepare('INSERT OR REPLACE INTO pgparts (intro, k, body, at) VALUES (?1, ?2, ?3, ?4)').bind(r1.meta.last_row_id, 'clean', 'No reports or flags on record.', now + 1),
        D1.prepare("INSERT INTO pgintro (pg, uid, by, to_uid, status, kind, paid, at) VALUES (?1, ?2, ?3, ?4, 'asked', 'plain', 1, ?5)").bind(pg.id, p1.uid, via.uid, me, now - 600000),
      ]);
    }
  }
  const ask = far[1];
  if (ask && mine[0] && mine[3]) {
    const [x1, x2] = pair(ask.uid, me);
    await D1.batch([D1.prepare("INSERT OR REPLACE INTO bonds (a, b, status, at) VALUES (?1, ?2, 'bonded', ?3)").bind(x1, x2, now - 20 * 86400000), D1.prepare('INSERT OR REPLACE INTO together (a, b, secs, last) VALUES (?1, ?2, 5400, ?3)').bind(x1, x2, now)]);
    const r2 = await D1.prepare("INSERT INTO pilgrims (uid, target, status, at, last) VALUES (?1, ?2, 'walking', ?3, ?3)").bind(ask.uid, mine[3].uid, now - 3600000).run();
    await D1.prepare("INSERT INTO pgintro (pg, uid, by, to_uid, status, kind, paid, at) VALUES (?1, ?2, ?3, ?4, 'asked', 'plain', 1, ?5)").bind(r2.meta.last_row_id, ask.uid, me, mine[3].uid, now - 900000).run();
  }
  LB_LAST = 0;
  return { bots: bots.length, rooms, circles: circles.length, bonded: [0, 3, 7].filter((i) => mine[i]).map((i) => mine[i].alias) };
}
// keep bots alive while someone is looking: presence, gentle chatter, replies, accepting bonds and knocks
async function lbPulse(env, now) {
  if (now - LB_LAST < 12000) return;
  LB_LAST = now;
  const D1 = env.D1;
  try {
    const any = await D1.prepare("SELECT 1 AS k FROM people WHERE uid LIKE 'bot:%' LIMIT 1").first();
    if (!any) return;
    await D1.batch([
      D1.prepare("UPDATE presence SET seen = ?1 WHERE uid LIKE 'bot:%'").bind(now),
      D1.prepare("UPDATE bonds SET status = 'bonded', at = ?1 WHERE status = 'pending' AND b LIKE 'bot:%' AND at < ?2").bind(now, now - 20000),
      D1.prepare("UPDATE circles SET last = ?1 WHERE id IN (SELECT cid FROM seats WHERE uid LIKE 'bot:%')").bind(now),
      D1.prepare("UPDATE pgintro SET status = 'open', at = ?1 WHERE status = 'asked' AND by LIKE 'bot:%' AND at < ?2").bind(now, now - 30000),
    ]);
    // a bot answers a knock on its circle
    const kn = await D1.prepare("SELECT k.id, k.cid, k.uid, c.vibe FROM knocks k JOIN circles c ON c.id = k.cid WHERE k.status = 'waiting' AND k.at < ?1 AND k.cid IN (SELECT cid FROM seats WHERE uid LIKE 'bot:%') LIMIT 1").bind(now - 8000).first();
    if (kn) {
      const host = await D1.prepare("SELECT uid FROM seats WHERE cid = ?1 AND uid LIKE 'bot:%' LIMIT 1").bind(kn.cid).first();
      await D1.batch([
        D1.prepare('DELETE FROM seats WHERE uid = ?1').bind(kn.uid),
        D1.prepare('INSERT OR REPLACE INTO seats (cid, uid, at) VALUES (?1, ?2, ?3)').bind(kn.cid, kn.uid, now),
        D1.prepare("UPDATE knocks SET status = 'in' WHERE id = ?1").bind(kn.id),
        D1.prepare('UPDATE presence SET vibe = ?2, near = ?3 WHERE uid = ?1').bind(kn.uid, kn.vibe, kn.cid),
        D1.prepare('INSERT INTO lines (cid, uid, body, at) VALUES (?1, ?2, ?3, ?4)').bind(kn.cid, host.uid, lbPick(LB_REPLY), now),
      ]);
      return;
    }
    // reply when a real person spoke last in a bot circle
    const last = await D1.prepare("SELECT l.cid, l.uid, l.at, c.vibe FROM lines l JOIN circles c ON c.id = l.cid WHERE l.id IN (SELECT MAX(id) FROM lines GROUP BY cid) AND l.uid NOT LIKE 'bot:%' AND l.at > ?1 AND l.cid IN (SELECT cid FROM seats WHERE uid LIKE 'bot:%') LIMIT 1").bind(now - 120000).first();
    let cid = last && last.cid, vibe = last && last.vibe, text = last ? lbPick(LB_REPLY) : null;
    if (!cid && Math.random() < 0.55) {
      const c = await D1.prepare("SELECT c.id, c.vibe FROM circles c WHERE c.id IN (SELECT cid FROM seats WHERE uid LIKE 'bot:%') ORDER BY RANDOM() LIMIT 1").first();
      if (c) { cid = c.id; vibe = c.vibe; text = lbPick(LB_LINES[c.vibe] || LB_LINES.foyer); }
    }
    if (cid && text) {
      const who = await D1.prepare("SELECT uid FROM seats WHERE cid = ?1 AND uid LIKE 'bot:%' ORDER BY RANDOM() LIMIT 1").bind(cid).first();
      if (who) await D1.prepare('INSERT INTO lines (cid, uid, body, at) VALUES (?1, ?2, ?3, ?4)').bind(cid, who.uid, text, now).run();
    }
    // a bot replies to a DM
    const dm = await D1.prepare("SELECT a, b, uid FROM dms WHERE id IN (SELECT MAX(id) FROM dms GROUP BY a, b) AND (a LIKE 'bot:%' OR b LIKE 'bot:%') AND uid NOT LIKE 'bot:%' AND at < ?1 AND at > ?2 LIMIT 1").bind(now - 6000, now - 600000).first();
    if (dm) {
      const bot = String(dm.a).startsWith('bot:') ? dm.a : dm.b;
      await D1.prepare('INSERT INTO dms (a, b, uid, body, at, seen) VALUES (?1, ?2, ?3, ?4, ?5, 0)').bind(dm.a, dm.b, bot, lbPick(['Hey! So nice to hear from you ✦', 'Haha yes, see you in the Salon?', 'I’m a Lab bot, but I like you already', 'Let’s find a circle together sometime']), now).run();
    }
  } catch (e) {}
}
async function lbApi(req, path, env, body, me, r, room, now) {
  if (!env.LAB) return apiJson(req, { ok: false, error: 'Not found' }, 404);
  if (!isFounder(env, me) || !(await adCore(env, me))) return apiJson(req, { ok: false, error: 'Only founders can do this.' }, 403);
  if (path === '/api/sq/lab/seed') return apiJson(req, { ok: true, ...(await lbSeed(env, me, room, now)) });
  if (path === '/api/sq/lab/clear') { await lbClear(env); return apiJson(req, { ok: true }); }
  if (path === '/api/sq/lab/count') { const n = await env.D1.prepare("SELECT COUNT(*) AS n FROM people WHERE uid LIKE 'bot:%'").first(); return apiJson(req, { ok: true, bots: (n && n.n) || 0 }); }
  return apiJson(req, { ok: false, error: 'Not found' }, 404);
}
async function skyApi(req, env, me, r, room, now) {
  await hReady(env);
  await pgReady(env);
  const D1 = env.D1;
  const core = await adCore(env, me);
  const b = pgBfs(await pgGraph(env), me);
  const live = now - 90000;
  await D1.prepare('INSERT INTO presence (uid, room, vibe, near, seen, since) VALUES (?1, ?2, ?3, 0, ?4, ?4) ON CONFLICT (uid) DO UPDATE SET room = ?2, seen = ?4').bind(me, room, 'all', now).run();
  // same sweep the circle screen runs, so both views see the same seats
  await D1.batch([
    D1.prepare('DELETE FROM seats WHERE uid IN (SELECT uid FROM presence WHERE seen < ?1)').bind(live),
    D1.prepare('DELETE FROM circles WHERE welcome = 0 AND id NOT IN (SELECT cid FROM owned) AND at < ?1 AND id NOT IN (SELECT cid FROM seats)').bind(now - 60000),
  ]);
  const mySeat = await D1.prepare('SELECT cid FROM seats WHERE uid = ?1').bind(me).first();
  const myCid = mySeat ? mySeat.cid : 0;
  const hop = (u) => (u === me ? 0 : b.dist.has(u) ? b.dist.get(u) : null);
  const cs = (await D1.prepare('SELECT id, vibe, topic, cap, welcome, hushed, last FROM circles WHERE room = ?1 ORDER BY id').bind(room).all()).results || [];
  const seats = (await D1.prepare('SELECT s.cid, s.uid, p.pid, p.alias FROM seats s JOIN circles c ON c.id = s.cid JOIN people p ON p.uid = s.uid WHERE c.room = ?1 ORDER BY s.at').bind(room).all()).results || [];
  const talk = new Map(((await D1.prepare('SELECT cid, COUNT(*) AS n FROM lines WHERE at > ?1 GROUP BY cid').bind(now - 180000).all()).results || []).map((x) => [x.cid, x.n]));
  const heard = new Map();
  for (const l of (await D1.prepare('SELECT l.cid, l.body, p.alias FROM lines l JOIN people p ON p.uid = l.uid JOIN circles c ON c.id = l.cid WHERE c.room = ?1 AND l.at > ?2 ORDER BY l.id DESC LIMIT 400').bind(room, now - 900000).all()).results || []) {
    const a = heard.get(l.cid) || [];
    if (a.length < 2) { a.unshift({ alias: l.alias, body: String(l.body || '').slice(0, 90) }); heard.set(l.cid, a); }
  }
  const stars = [];
  for (const c of cs) {
    const ps = seats.filter((s) => s.cid === c.id);
    if (!ps.length && !c.welcome && c.id !== myCid) continue;
    const people = ps.map((s) => ({ pid: s.pid, alias: s.alias, hops: hop(s.uid), me: s.uid === me }));
    const hs = people.map((p) => p.hops).filter((x) => x !== null);
    const mine = c.id === myCid;
    const hushed = hHushed(c, ps.length);
    const known = people.filter((p) => p.hops === 1).length;
    stars.push({ id: c.id, topic: hushed && !mine ? hFirstWords(c.topic) : c.topic || '', hushed, cap: c.cap || 5, n: ps.length, welcome: !!c.welcome, people, near: mine ? 0 : hs.length ? Math.min(...hs) : null, known, mine, talk: talk.get(c.id) || 0, heard: hushed && !mine ? [] : heard.get(c.id) || [], intro: !mine && !c.welcome && !core && ps.length > 0 && known === 0 });
  }
  const villages = ((await D1.prepare("SELECT room, COUNT(*) AS n FROM people WHERE room != ?1 AND room != '' AND done = 1 AND member = 1 GROUP BY room ORDER BY room").bind(room).all()).results || []).map((v) => ({ room: v.room, members: v.n }));
  const here = await D1.prepare('SELECT COUNT(*) AS n FROM presence WHERE room = ?1 AND seen > ?2').bind(room, now - 30000).first();
  const gate = await D1.prepare("SELECT COUNT(*) AS n FROM people WHERE room = ?1 AND done = 1 AND member = 0 AND stage != 'Declined'").bind(room).first();
  let next = null;
  const pg = await D1.prepare("SELECT target FROM pilgrims WHERE uid = ?1 AND status = 'walking' ORDER BY id DESC LIMIT 1").bind(me).first();
  if (pg) {
    const p = pgPath(b, pg.target);
    const t = await pgPerson(env, pg.target);
    const n1 = p && p.length > 1 ? await pgPerson(env, p[1]) : null;
    next = { pid: n1 && n1.pid, alias: n1 && n1.alias, target: t && t.alias, steps: p ? p.length - 1 : null };
  }
  const bonds = [];
  for (const [u, d] of b.dist) if (d === 1) bonds.push(u);
  return apiJson(req, { ok: true, room, alias: r.alias || '', core, here: (here && here.n) || 0, cid: myCid, gate: (gate && gate.n) || 0, bonds: bonds.length, stars, villages, next });
}
let DU_READY = false;
const DU_REWARD = { digital: 1, irl: 2 };
const DU_OFFICIAL = { digital: 3, irl: 5 };
const DU_DEEP_SECS = 3600;
async function duReady(env) {
  if (DU_READY) return;
  await env.D1.batch([
    env.D1.prepare("CREATE TABLE IF NOT EXISTS duties (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, by TEXT, title TEXT, body TEXT, kind TEXT, official INTEGER DEFAULT 0, reward INTEGER, status TEXT, taker TEXT, at INTEGER, taken_at INTEGER, done_at INTEGER)"),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS duties_room ON duties (room, status)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS tokens (uid TEXT PRIMARY KEY, bal INTEGER)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS tokenlog (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, delta INTEGER, why TEXT, at INTEGER)'),
  ]);
  DU_READY = true;
}
async function duBal(env, uid) { const x = await env.D1.prepare('SELECT bal FROM tokens WHERE uid = ?1').bind(uid).first(); return x ? x.bal : 0; }
async function duMint(env, uid, n, why) {
  await env.D1.batch([
    env.D1.prepare('INSERT INTO tokens (uid, bal) VALUES (?1, ?2) ON CONFLICT (uid) DO UPDATE SET bal = bal + ?2').bind(uid, n),
    env.D1.prepare('INSERT INTO tokenlog (uid, delta, why, at) VALUES (?1, ?2, ?3, ?4)').bind(uid, n, why, Date.now()),
  ]);
}
// How deep two people's tie is: bonded, and how long they've spent together.
async function duTie(env, a, b) {
  const x = a < b ? a : b, y = a < b ? b : a;
  const t = await env.D1.prepare('SELECT secs FROM together WHERE a = ?1 AND b = ?2').bind(x, y).first();
  const bd = await env.D1.prepare("SELECT 1 AS k FROM bonds WHERE ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)) AND status = 'bonded'").bind(a, b).first();
  return { secs: t ? t.secs : 0, bonded: !!bd };
}
async function duApi(req, path, env, body, me, r, room, now) {
  const D1 = env.D1;
  await adReady(env); await hReady(env); await duReady(env);
  const core = await adCore(env, me);
  const member = !!(r.member && !r.member.suspended);
  const view = (d, rows) => {
    const p = rows.get(d.by) || {}, q = d.taker ? rows.get(d.taker) || {} : null;
    return { id: d.id, title: d.title, body: d.body, kind: d.kind, official: !!d.official, reward: d.reward, status: d.status, at: d.at, by: { pid: p.pid, alias: d.official ? 'The House' : p.alias || 'Someone', points: sqParse(p.points), member: !!p.member }, taker: q ? { pid: q.pid, alias: q.alias || 'Someone' } : null, mineRaised: d.by === me, mineTaken: d.taker === me };
  };
  const people = async (ids) => { const u = [...new Set(ids.filter(Boolean))]; const m = new Map(); for (const id of u) { const p = await D1.prepare('SELECT pid, alias, points, member FROM people WHERE uid = ?1').bind(id).first(); if (p) m.set(id, p); } return m; };
  const get = async (id) => await D1.prepare('SELECT * FROM duties WHERE id = ?1').bind(Math.floor(Number(id) || 0)).first();
  const tell = async (uid, text) => { if (!(await hQuiet(env, uid))) await say(env, uid, text, [[{ text: 'Open the Duty Board', url: SQ_BASE + '#duty' }]]); };
  if (path === '/api/sq/duty/list') {
    const open = (await D1.prepare("SELECT * FROM duties WHERE status = 'open' AND (room = ?1 OR official = 1) ORDER BY official DESC, at DESC LIMIT 60").bind(room).all()).results || [];
    const mine = (await D1.prepare("SELECT * FROM duties WHERE (by = ?1 OR taker = ?1) AND status IN ('open','taken','done') ORDER BY at DESC LIMIT 40").bind(me).all()).results || [];
    const rows = await people([...open, ...mine].flatMap((d) => [d.by, d.taker]));
    const log = ((await D1.prepare('SELECT delta, why, at FROM tokenlog WHERE uid = ?1 ORDER BY id DESC LIMIT 8').bind(me).all()).results || []);
    return apiJson(req, { ok: true, room, tokens: await duBal(env, me), log, member, core, open: open.filter((d) => d.by !== me).map((d) => view(d, rows)), mine: mine.map((d) => view(d, rows)), reward: DU_REWARD, official: DU_OFFICIAL });
  }
  if (path === '/api/sq/duty/new') {
    const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const text = String(body.body || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const kind = body.kind === 'irl' ? 'irl' : 'digital';
    if (title.length < 4) return apiJson(req, { ok: false, error: 'Give the duty a short title.' }, 400);
    if (kind === 'irl' && !member) return apiJson(req, { ok: false, error: 'Real-life duties can be raised by members only.' }, 403);
    const official = core && body.official ? 1 : 0;
    const n = await D1.prepare("SELECT COUNT(*) AS n FROM duties WHERE by = ?1 AND status IN ('open','taken','done')").bind(me).first();
    if (!official && n && n.n >= 3) return apiJson(req, { ok: false, error: 'You have three duties open already. Close one first.' }, 429);
    const reward = (official ? DU_OFFICIAL : DU_REWARD)[kind];
    const res = await D1.prepare("INSERT INTO duties (room, by, title, body, kind, official, reward, status, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8)").bind(room, me, title, text, kind, official, reward, now).run();
    if (official) await adLog(env, me, 'raised a house duty', title);
    return apiJson(req, { ok: true, id: res.meta.last_row_id });
  }
  const d = await get(body.id);
  if (!d) return apiJson(req, { ok: false, error: 'That duty is gone.' }, 404);
  if (path === '/api/sq/duty/take') {
    if (d.status !== 'open') return apiJson(req, { ok: false, error: 'Someone has already taken this one.' }, 409);
    if (d.by === me) return apiJson(req, { ok: false, error: 'That’s your own duty, love.' }, 400);
    if (!d.official && d.room !== room) return apiJson(req, { ok: false, error: 'Duties are answered within your own village.' }, 403);
    if (d.kind === 'irl' && !core) {
      if (!member) return apiJson(req, { ok: false, error: 'Real-life duties are for members.' }, 403);
      if (!d.official) {
        const t = await duTie(env, me, d.by);
        if (!t.bonded || t.secs < DU_DEEP_SECS) return apiJson(req, { ok: false, deep: true, error: 'Real-life duties need a deeper bond: be bonded and spend at least an hour together in circles first.' }, 403);
      }
    }
    const busy = await D1.prepare("SELECT COUNT(*) AS n FROM duties WHERE taker = ?1 AND status = 'taken'").bind(me).first();
    if (busy && busy.n >= 3) return apiJson(req, { ok: false, error: 'Finish one of your three duties first.' }, 429);
    await D1.prepare("UPDATE duties SET status = 'taken', taker = ?2, taken_at = ?3 WHERE id = ?1 AND status = 'open'").bind(d.id, me, now).run();
    if (!d.official) await tell(d.by, '✦ ' + (r.alias || 'Someone') + ' has answered your duty: “' + d.title + '”.');
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/duty/done') {
    if (d.taker !== me || d.status !== 'taken') return apiJson(req, { ok: false, error: 'This isn’t a duty you’ve taken.' }, 400);
    await D1.prepare("UPDATE duties SET status = 'done', done_at = ?2 WHERE id = ?1").bind(d.id, now).run();
    if (!d.official) await tell(d.by, '✦ ' + (r.alias || 'Someone') + ' says your duty is done: “' + d.title + '”. Confirm it so they receive their tokens.');
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/duty/confirm') {
    if (d.status !== 'done') return apiJson(req, { ok: false, error: 'It hasn’t been marked done yet.' }, 400);
    if (!(d.by === me || (d.official && core))) return apiJson(req, { ok: false, error: 'Only the person who raised it can confirm.' }, 403);
    let n = d.reward;
    if (!d.official) {
      const recent = await D1.prepare("SELECT COUNT(*) AS n FROM duties WHERE by = ?1 AND taker = ?2 AND status = 'closed' AND done_at > ?3").bind(d.by, d.taker, now - 7 * 86400000).first();
      if (recent && recent.n >= 2) n = 0;
    }
    await D1.prepare("UPDATE duties SET status = 'closed' WHERE id = ?1").bind(d.id).run();
    if (n > 0) await duMint(env, d.taker, n, 'Duty: ' + d.title);
    await tell(d.taker, n > 0 ? '✦ Duty confirmed: “' + d.title + '”. +' + n + ' token' + (n > 1 ? 's' : '') + '.' : '✦ Duty confirmed: “' + d.title + '”. Thank you. (You two have traded duties often this week, so this one carries no tokens.)');
    return apiJson(req, { ok: true, minted: n });
  }
  if (path === '/api/sq/duty/drop') {
    if (d.taker === me && d.status === 'taken') { await D1.prepare("UPDATE duties SET status = 'open', taker = NULL, taken_at = NULL WHERE id = ?1").bind(d.id).run(); return apiJson(req, { ok: true }); }
    if (d.by === me && d.status === 'done') { await D1.prepare("UPDATE duties SET status = 'taken', done_at = NULL WHERE id = ?1").bind(d.id).run(); return apiJson(req, { ok: true, back: true }); }
    if ((d.by === me || (d.official && core)) && d.status !== 'closed') { await D1.prepare("UPDATE duties SET status = 'cancelled' WHERE id = ?1").bind(d.id).run(); if (d.taker && d.taker !== me) await tell(d.taker, '✦ The duty “' + d.title + '” was withdrawn. No harm done.'); return apiJson(req, { ok: true }); }
    return apiJson(req, { ok: false, error: 'Nothing to change here.' }, 400);
  }
  return apiJson(req, { ok: false, error: 'not found' }, 404);
}

/* ── Fly together (Lab, v9): ships share the sky; two ships that fly side by side can link,
   steer together, talk briefly, and part. The talk vanishes when they part. ── */
let FL_OK = 0;
async function flReady(env) {
  if (FL_OK) return;
  await env.D1.batch([
    env.D1.prepare('CREATE TABLE IF NOT EXISTS fly_pos (uid TEXT PRIMARY KEY, room TEXT, sid INTEGER, dx REAL, dy REAL, a REAL, jx REAL, jy REAL, at INTEGER)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS fly_pos_room ON fly_pos (room, at)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS fly_pair (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT, room TEXT, status TEXT, at INTEGER, ended INTEGER, by TEXT, ca INTEGER DEFAULT 0, cb INTEGER DEFAULT 0)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS fly_pair_a ON fly_pair (a, status)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS fly_pair_b ON fly_pair (b, status)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS fly_ask (a TEXT, b TEXT, at INTEGER, PRIMARY KEY (a, b))'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS fly_line (id INTEGER PRIMARY KEY AUTOINCREMENT, pr INTEGER, uid TEXT, body TEXT, at INTEGER)'),
    env.D1.prepare('CREATE INDEX IF NOT EXISTS fly_line_pr ON fly_line (pr, id)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS fly_rep (id INTEGER PRIMARY KEY AUTOINCREMENT, pr INTEGER, by TEXT, who TEXT, at INTEGER)'),
  ]);
  FL_OK = 1;
}
function flNum(v, lo, hi) { const n = Number(v); if (!isFinite(n)) return 0; return Math.max(lo, Math.min(hi, n)); }
async function flPair(env, me) {
  return await env.D1.prepare("SELECT * FROM fly_pair WHERE (a = ?1 OR b = ?1) AND status = 'on' ORDER BY id DESC LIMIT 1").bind(me).first();
}
async function flEnd(env, pr, by, now) {
  await env.D1.batch([
    env.D1.prepare("UPDATE fly_pair SET status = 'off', ended = ?2, by = ?3 WHERE id = ?1 AND status = 'on'").bind(pr.id, now, by),
    env.D1.prepare('DELETE FROM fly_line WHERE pr = ?1').bind(pr.id),
  ]);
}
async function flApi(req, path, env, body, me, r, room, now) {
  const D1 = env.D1;
  await flReady(env);
  if (path === '/api/sq/fly/tick') {
    const sid = Math.floor(Number(body.sid) || 0);
    await D1.prepare('INSERT INTO fly_pos (uid, room, sid, dx, dy, a, jx, jy, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(uid) DO UPDATE SET room = ?2, sid = ?3, dx = ?4, dy = ?5, a = ?6, jx = ?7, jy = ?8, at = ?9')
      .bind(me, room, sid, flNum(body.dx, -5000, 5000), flNum(body.dy, -5000, 5000), flNum(body.a, -10, 10), flNum(body.jx, -1, 1), flNum(body.jy, -1, 1), now).run();
    if (Math.random() < 0.02) await D1.batch([
      D1.prepare('DELETE FROM fly_pos WHERE at < ?1').bind(now - 3600000),
      D1.prepare('DELETE FROM fly_ask WHERE at < ?1').bind(now - 600000),
    ]);
    const live = (await D1.prepare("SELECT a, b FROM fly_pair WHERE status = 'on' AND room = ?1").bind(room).all()).results || [];
    const paired = new Set(); live.forEach((x) => { paired.add(x.a); paired.add(x.b); });
    const ships = ((await D1.prepare('SELECT f.uid, f.sid, f.dx, f.dy, f.a, p.pid, p.alias FROM fly_pos f JOIN people p ON p.uid = f.uid WHERE f.room = ?1 AND f.at > ?2 AND f.uid != ?3 LIMIT 40').bind(room, now - 8000, me).all()).results || [])
      .map((s) => ({ pid: s.pid, alias: s.alias, sid: s.sid, dx: s.dx, dy: s.dy, a: s.a, paired: paired.has(s.uid) }));
    const asks = ((await D1.prepare('SELECT p.pid FROM fly_ask k JOIN people p ON p.uid = k.a WHERE k.b = ?1 AND k.at > ?2').bind(me, now - 20000).all()).results || []).map((x) => x.pid);
    const mine = ((await D1.prepare('SELECT p.pid FROM fly_ask k JOIN people p ON p.uid = k.b WHERE k.a = ?1 AND k.at > ?2').bind(me, now - 20000).all()).results || []).map((x) => x.pid);
    let pair = null;
    const pr = await flPair(env, me);
    if (pr) {
      const other = pr.a === me ? pr.b : pr.a;
      const op = await D1.prepare('SELECT f.jx, f.jy, f.at, p.pid, p.alias FROM fly_pos f JOIN people p ON p.uid = f.uid WHERE f.uid = ?1').bind(other).first();
      if (!op || now - op.at > 20000) { await flEnd(env, pr, 'gone', now); }
      else {
        const ls = ((await D1.prepare('SELECT id, uid, body, at FROM fly_line WHERE pr = ?1 ORDER BY id DESC LIMIT 30').bind(pr.id).all()).results || []).reverse();
        pair = { id: pr.id, since: pr.at, other: { pid: op.pid, alias: op.alias }, jx: op.jx, jy: op.jy, lines: ls.map((l) => ({ id: l.id, body: l.body, at: l.at, mine: l.uid === me })) };
      }
    }
    let after = null;
    if (!pair) {
      const pe = await D1.prepare("SELECT * FROM fly_pair WHERE (a = ?1 OR b = ?1) AND status = 'off' AND ended > ?2 ORDER BY id DESC LIMIT 1").bind(me, now - 180000).first();
      if (pe) {
        const isA = pe.a === me, myC = isA ? pe.ca : pe.cb;
        if (!myC) {
          const o = await D1.prepare('SELECT pid, alias FROM people WHERE uid = ?1').bind(isA ? pe.b : pe.a).first();
          if (o) after = { id: pe.id, other: { pid: o.pid, alias: o.alias }, mins: Math.max(1, Math.round((pe.ended - pe.at) / 60000)), left: pe.by === me ? 'you' : pe.by === 'gone' ? 'gone' : 'them' };
        }
      }
    }
    return apiJson(req, { ok: true, ships, asks, mine, pair, after });
  }
  if (path === '/api/sq/fly/ask') {
    const t = await D1.prepare('SELECT uid, alias, room FROM people WHERE pid = ?1').bind(String(body.pid || '')).first();
    if (!t || t.uid === me) return apiJson(req, { ok: false, error: 'They flew off.' }, 404);
    if (t.room !== room && !(await pgIntroduced(env, me, t.uid))) return apiJson(req, { ok: false, error: 'They’re not in your Village.' }, 404);
    const tp = await D1.prepare('SELECT at FROM fly_pos WHERE uid = ?1').bind(t.uid).first();
    if (!tp || now - tp.at > 10000) return apiJson(req, { ok: false, error: 'They flew off.' }, 404);
    if (await flPair(env, me)) return apiJson(req, { ok: false, error: 'You are already flying with someone.' }, 409);
    if (await flPair(env, t.uid)) return apiJson(req, { ok: false, error: t.alias + ' is flying with someone.' }, 409);
    const cool = await D1.prepare("SELECT ended FROM fly_pair WHERE ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)) AND status = 'off' AND ended > ?3 LIMIT 1").bind(me, t.uid, now - 600000).first();
    if (cool) return apiJson(req, { ok: false, error: 'Give it a little time before flying together again.' }, 429);
    if (body.off) { await D1.prepare('DELETE FROM fly_ask WHERE a = ?1 AND b = ?2').bind(me, t.uid).run(); return apiJson(req, { ok: true, off: true }); }
    const theirs = await D1.prepare('SELECT at FROM fly_ask WHERE a = ?1 AND b = ?2 AND at > ?3').bind(t.uid, me, now - 20000).first();
    if (theirs) {
      const res = await D1.prepare("INSERT INTO fly_pair (a, b, room, status, at) VALUES (?1, ?2, ?3, 'on', ?4)").bind(t.uid, me, room, now).run();
      await D1.prepare('DELETE FROM fly_ask WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)').bind(me, t.uid).run();
      return apiJson(req, { ok: true, pair: res.meta ? res.meta.last_row_id : 1 });
    }
    await D1.prepare('INSERT INTO fly_ask (a, b, at) VALUES (?1, ?2, ?3) ON CONFLICT(a, b) DO UPDATE SET at = ?3').bind(me, t.uid, now).run();
    return apiJson(req, { ok: true, waiting: true });
  }
  if (path === '/api/sq/fly/say') {
    const pr = await flPair(env, me);
    if (!pr) return apiJson(req, { ok: false, error: 'You parted ways.' }, 404);
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return apiJson(req, { ok: false, error: 'Say something first.' }, 400);
    const last = await D1.prepare('SELECT at FROM fly_line WHERE pr = ?1 AND uid = ?2 ORDER BY id DESC LIMIT 1').bind(pr.id, me).first();
    if (last && now - last.at < 700) return apiJson(req, { ok: false, error: 'A breath between messages, love.' }, 429);
    await D1.prepare('INSERT INTO fly_line (pr, uid, body, at) VALUES (?1, ?2, ?3, ?4)').bind(pr.id, me, text, now).run();
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/fly/leave') {
    const pr = await flPair(env, me);
    if (!pr) return apiJson(req, { ok: true });
    await flEnd(env, pr, me, now);
    if (body.report) await D1.prepare('INSERT INTO fly_rep (pr, by, who, at) VALUES (?1, ?2, ?3, ?4)').bind(pr.id, me, pr.a === me ? pr.b : pr.a, now).run();
    return apiJson(req, { ok: true });
  }
  if (path === '/api/sq/fly/choose') {
    const pe = await D1.prepare("SELECT * FROM fly_pair WHERE id = ?1 AND (a = ?2 OR b = ?2) AND status = 'off'").bind(Math.floor(Number(body.id) || 0), me).first();
    if (!pe) return apiJson(req, { ok: false, error: 'That moment has passed.' }, 404);
    const isA = pe.a === me, c = body.bond ? 1 : 2, other = isA ? pe.b : pe.a, oc = isA ? pe.cb : pe.ca;
    await D1.prepare('UPDATE fly_pair SET ' + (isA ? 'ca' : 'cb') + ' = ?2 WHERE id = ?1').bind(pe.id, c).run();
    let bonded = false;
    if (c === 1 && oc === 1) {
      const ex = await D1.prepare("SELECT status FROM bonds WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)").bind(me, other).first();
      if (!ex || ex.status !== 'bonded') await D1.batch([
        D1.prepare('DELETE FROM bonds WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)').bind(me, other),
        D1.prepare("INSERT INTO bonds (a, b, status, at) VALUES (?1, ?2, 'bonded', ?3)").bind(other, me, now),
      ]);
      bonded = true;
    }
    return apiJson(req, { ok: true, bonded });
  }
  return apiJson(req, { ok: false, error: 'Not found' }, 404);
}


/* ✦ Starlove: the inbox and the God account.
   Every message to Starlove is kept (D1 sl_msgs) and sent to the inbox chat set with /inbox.
   Starlove's console lives at /starlove on this Worker: password + authenticator (TOTP) + backup codes. */
/* God setup code hash now lives in the GOD_SETUP_HASH Worker secret (env), not in source. */
const GOD_ITER = 60000;
const GOD_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function godB32(bytes) { let bits = 0, val = 0, out = ''; for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += GOD_B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += GOD_B32[(val << (5 - bits)) & 31]; return out; }
function godB32d(s) { s = String(s).replace(/[=\s]/g, '').toUpperCase(); let bits = 0, val = 0; const out = []; for (const c of s) { const i = GOD_B32.indexOf(c); if (i < 0) continue; val = ((val << 5) | i) & 0xffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
function godHex(b) { return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function godUnhex(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
function godRnd(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
async function godSha(s) { return godHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)))); }
function godEq(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function godTotpAt(secret, step) {
  const key = await crypto.subtle.importKey('raw', godB32d(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8); const dv = new DataView(msg); dv.setUint32(0, Math.floor(step / 4294967296)); dv.setUint32(4, step >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)); const o = h[19] & 15;
  const c = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(c % 1000000).padStart(6, '0');
}
async function godTotpCheck(secret, code, last) {
  code = String(code || '').replace(/\D/g, ''); if (code.length !== 6) return 0;
  const step = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) { const s = step + d; if (last && s <= last) continue; if (godEq(await godTotpAt(secret, s), code)) return s; }
  return 0;
}
async function godPw(pw, saltHex, iter) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  return godHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: godUnhex(saltHex), iterations: iter }, k, 256));
}
async function slReady(env) {
  await env.D1.batch([
    env.D1.prepare('CREATE TABLE IF NOT EXISTS sl_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, who TEXT, label TEXT, body TEXT, dest TEXT, replied_at INTEGER, reply TEXT, replied_by TEXT)'),
    env.D1.prepare('CREATE TABLE IF NOT EXISTS god_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, who TEXT, what TEXT)'),
  ]);
}
async function godLog(env, who, what) { try { await slReady(env); await env.D1.prepare('INSERT INTO god_log (at, who, what) VALUES (?1, ?2, ?3)').bind(Date.now(), who, String(what).slice(0, 300)).run(); } catch (e) {} }

const slOnPrivate0 = onPrivate;
async function slSend(env, chat, text, extra) {
  try { return await tg(env, 'sendMessage', Object.assign({ chat_id: chat, text: text }, extra || {})); } catch (e) { return null; }
}
async function slDeliver(env, to, text) {
  if (!to) return false;
  if (to.indexOf('tg:') === 0) { const r = await slSend(env, to.slice(3), text); return !!(r && r.ok !== false); }
  if (to.indexOf('gate:') === 0 && typeof slGateReply === 'function') return !!(await slGateReply(env, to.slice(5), text));
  return false;
}
async function slForward(env, label, who, text, to) {
  let id = 0;
  try {
    await slReady(env);
    const r = await env.D1.prepare('INSERT INTO sl_msgs (at, who, label, body, dest) VALUES (?1, ?2, ?3, ?4, ?5)').bind(Date.now(), who, label, String(text).slice(0, 4000), to || '').run();
    id = (r && r.meta && r.meta.last_row_id) || 0;
  } catch (e) {}
  const inbox = await env.DB.get('sl:inbox');
  if (!inbox) return;
  const res = await slSend(env, inbox, '✦ To Starlove · ' + who + ' · ' + label + '\n\n' + String(text).slice(0, 3500));
  const mid = res && res.result && res.result.message_id;
  if (mid && to) await env.DB.put('sl:fwd:' + mid, JSON.stringify({ to: to, id: id }), { expirationTtl: 1209600 });
}
async function slMarkReplied(env, id, text, by) {
  if (!id) return;
  try { await env.D1.prepare('UPDATE sl_msgs SET replied_at = ?2, reply = ?3, replied_by = ?4 WHERE id = ?1').bind(id, Date.now(), String(text).slice(0, 4000), by).run(); } catch (e) {}
}
onPrivate = async function (m, cmd, env) {
  try {
    const id = m && m.from && m.from.id;
    const chat = m && m.chat && m.chat.id;
    const text = String((m && (m.text || m.caption)) || '');
    const inbox = await env.DB.get('sl:inbox');
    if (id && text.trim() === '/inbox' && (await isTeam(env, id))) {
      await env.DB.put('sl:inbox', String(chat));
      await slSend(env, chat, "✦ Starlove's inbox is now this chat. Every message people send Starlove will arrive here too. Reply to one to answer them as Starlove.");
      return;
    }
    if (inbox && String(chat) === inbox && m.reply_to_message) {
      const raw = await env.DB.get('sl:fwd:' + m.reply_to_message.message_id);
      if (raw && text) {
        let to = raw, mid = 0;
        try { const j = JSON.parse(raw); to = j.to; mid = j.id; } catch (e) {}
        const ok = await slDeliver(env, to, text);
        if (ok) { await slMarkReplied(env, mid, text, 'Telegram'); await godLog(env, 'Starlove (Telegram)', 'replied to message ' + mid); }
        await slSend(env, inbox, ok ? '✓ Sent as Starlove' : 'Could not deliver that one.', { reply_to_message_id: m.message_id });
        return;
      }
    }
    if (id && String(chat) !== inbox && text) {
      let r = null;
      try { r = await getRec(env, id); } catch (e) {}
      if (!(r && r.with)) {
        const who = ((r && r.alias) || (m.from.first_name || 'Someone')) + (m.from.username ? ' @' + m.from.username : '');
        await slForward(env, 'Telegram', who, text, 'tg:' + chat);
      }
    }
  } catch (e) {}
  return slOnPrivate0(m, cmd, env);
};

function godJson(o, s) { return new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
async function godAcct(env) { const r = await env.DB.get('god:acct'); return r ? JSON.parse(r) : null; }
async function godSession(env, token) { if (!token || String(token).length < 40) return null; const r = await env.DB.get('god:sess:' + (await godSha(token))); return r ? JSON.parse(r) : null; }
async function godFail(env) { const n = Number((await env.DB.get('god:fail')) || 0) + 1; await env.DB.put('god:fail', String(n), { expirationTtl: 900 }); return n; }
async function godLocked(env) { return Number((await env.DB.get('god:fail')) || 0) >= 5; }

async function godFetch(req, env) {
  const url = new URL(req.url);
  if (url.pathname === '/starlove' || url.pathname === '/starlove/') return new Response(GOD_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
  if (req.method !== 'POST') return godJson({ ok: false }, 405);
  let b = {}; try { b = await req.json(); } catch (e) {}
  const p = url.pathname.slice('/api/god/'.length);
  const acct = await godAcct(env);
  if (p === 'status') return godJson({ ok: true, setup: !acct });
  if (p === 'setup/start' || p === 'setup/finish') {
    if (acct) return godJson({ ok: false, error: 'Starlove is already set up.' });
    if (await godLocked(env)) return godJson({ ok: false, error: 'Too many tries. Wait 15 minutes.' }, 429);
    if (!godEq(await godSha(String(b.code || '').trim().toUpperCase()), env.GOD_SETUP_HASH)) { await godFail(env); return godJson({ ok: false, error: 'That setup code is not right.' }, 403); }
    if (p === 'setup/start') {
      const secret = godB32(godRnd(20));
      await env.DB.put('god:pending', secret, { expirationTtl: 900 });
      return godJson({ ok: true, secret: secret, uri: 'otpauth://totp/DIONYSTY:Starlove?secret=' + secret + '&issuer=DIONYSTY&algorithm=SHA1&digits=6&period=30' });
    }
    const secret = await env.DB.get('god:pending');
    if (!secret) return godJson({ ok: false, error: 'Setup timed out. Start again.' });
    const pw = String(b.password || '');
    if (pw.length < 12) return godJson({ ok: false, error: 'Use a password of at least 12 characters.' });
    const step = await godTotpCheck(secret, b.otp, 0);
    if (!step) { await godFail(env); return godJson({ ok: false, error: 'That code from the authenticator is not right. Try the newest one.' }); }
    const salt = godHex(godRnd(16));
    const backup = []; const bh = [];
    for (let i = 0; i < 10; i++) { const c = godB32(godRnd(5)); const f = c.slice(0, 4) + '-' + c.slice(4, 8); backup.push(f); bh.push(await godSha(f)); }
    await env.DB.put('god:acct', JSON.stringify({ salt: salt, iter: GOD_ITER, hash: await godPw(pw, salt, GOD_ITER), totp: secret, backup: bh, last: step, at: Date.now() }));
    await env.DB.delete('god:pending');
    await godLog(env, 'Starlove', 'God account created');
    return godJson({ ok: true, backup: backup });
  }
  if (p === 'login') {
    if (!acct) return godJson({ ok: false, error: 'Not set up yet.' });
    if (await godLocked(env)) return godJson({ ok: false, error: 'Locked for 15 minutes after too many tries.' }, 429);
    const pwOk = godEq(await godPw(String(b.password || ''), acct.salt, acct.iter), acct.hash);
    let codeOk = false;
    if (pwOk) {
      const otp = String(b.otp || '').trim();
      if (/^\d{6}$/.test(otp.replace(/\s/g, ''))) { const s = await godTotpCheck(acct.totp, otp, acct.last); if (s) { acct.last = s; codeOk = true; } }
      else { const h = await godSha(otp.toUpperCase()); const i = acct.backup.indexOf(h); if (i >= 0) { acct.backup.splice(i, 1); codeOk = true; await godLog(env, 'Starlove', 'used a backup code (' + acct.backup.length + ' left)'); } }
    }
    if (!pwOk || !codeOk) { const n = await godFail(env); await godLog(env, 'Starlove', 'failed sign-in (' + n + ')'); return godJson({ ok: false, error: n >= 5 ? 'Locked for 15 minutes after too many tries.' : 'Password or code is not right.' }, 403); }
    await env.DB.delete('god:fail');
    await env.DB.put('god:acct', JSON.stringify(acct));
    const token = godHex(godRnd(32));
    await env.DB.put('god:sess:' + (await godSha(token)), JSON.stringify({ at: Date.now() }), { expirationTtl: 43200 });
    await godLog(env, 'Starlove', 'signed in');
    return godJson({ ok: true, token: token, backupLeft: acct.backup.length });
  }
  const sess = await godSession(env, b.token);
  if (!sess) return godJson({ ok: false, error: 'auth' }, 401);
  await slReady(env);
  if (p === 'logout') { await env.DB.delete('god:sess:' + (await godSha(b.token))); await godLog(env, 'Starlove', 'signed out'); return godJson({ ok: true }); }
  if (p === 'inbox') {
    const rows = (await env.D1.prepare('SELECT id, at, who, label, body, dest, replied_at, reply, replied_by FROM sl_msgs ORDER BY id DESC LIMIT 150').all()).results || [];
    return godJson({ ok: true, msgs: rows.map((r) => ({ id: r.id, at: r.at, who: r.who, label: r.label, body: r.body, canReply: !!r.dest, repliedAt: r.replied_at, reply: r.reply, by: r.replied_by })), inbox: !!(await env.DB.get('sl:inbox')) });
  }
  if (p === 'reply') {
    const r = await env.D1.prepare('SELECT id, dest FROM sl_msgs WHERE id = ?1').bind(Number(b.id) || 0).first();
    const text = String(b.text || '').trim();
    if (!r || !text) return godJson({ ok: false, error: 'Nothing to send.' });
    const ok = await slDeliver(env, r.dest, text);
    if (!ok) return godJson({ ok: false, error: 'Could not deliver that one.' });
    await slMarkReplied(env, r.id, text, 'Console');
    await godLog(env, 'Starlove (Console)', 'replied to message ' + r.id);
    return godJson({ ok: true });
  }
  if (p === 'log') {
    const rows = (await env.D1.prepare('SELECT at, who, what FROM god_log ORDER BY id DESC LIMIT 80').all()).results || [];
    return godJson({ ok: true, log: rows });
  }
  return godJson({ ok: false, error: 'not found' }, 404);
}

const GOD_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>Starlove · DIONYSTY</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,400&family=Jost:wght@300;400;500&family=Michroma&display=swap" rel="stylesheet">
<style>
:root{--ink:#1a0c11;--umber:#2a1018;--gold:#c6a36d;--ivory:#f2e7d5;--muted:#cdb490;--line:rgba(198,163,109,.25);--wine:#6b2936}
*{box-sizing:border-box}html,body{margin:0;background:radial-gradient(120% 80% at 50% 0%,#2a1018 0%,#1a0c11 60%);color:var(--ivory);font:300 16px/1.5 Jost,system-ui,sans-serif;min-height:100dvh}
.wrap{max-width:640px;margin:0 auto;padding:calc(env(safe-area-inset-top,0px) + 28px) 20px 40px}
.eb{font:400 9px Michroma,sans-serif;letter-spacing:.3em;text-transform:uppercase;color:var(--gold)}
h1{font:300 40px/1.05 'Cormorant Garamond',serif;margin:10px 0 6px}h1 em{color:var(--gold)}
p.sub{color:var(--muted);margin:0 0 22px}
.card{border:1px solid var(--line);border-radius:20px;background:rgba(42,16,24,.55);padding:18px;margin:14px 0}
label{display:block;font:400 9px Michroma,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:14px 0 6px}
input,textarea{width:100%;border:1px solid var(--line);border-radius:14px;background:rgba(26,12,17,.7);color:var(--ivory);font:400 16px Jost,sans-serif;padding:13px 15px;outline:none}
input:focus,textarea:focus{border-color:var(--gold)}
button{border:0;border-radius:24px;background:var(--gold);color:var(--ink);font:400 10px Michroma,sans-serif;letter-spacing:.24em;text-transform:uppercase;padding:15px 20px;margin-top:16px;cursor:pointer;width:100%}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--ivory)}
button:disabled{opacity:.5}
.err{color:#f0a070;min-height:20px;margin-top:10px;font-size:14px}
.key{font:400 14px Michroma,monospace;letter-spacing:.12em;word-break:break-all;color:var(--gold);margin:10px 0}
#qr{background:#f2e7d5;border-radius:14px;padding:12px;width:220px;margin:12px auto 4px}#qr svg{width:100%;height:auto;display:block}
.codes{display:grid;grid-template-columns:1fr 1fr;gap:8px;font:400 14px Michroma,monospace;letter-spacing:.1em;color:var(--gold);margin:12px 0}
.top{display:flex;justify-content:space-between;align-items:center;gap:10px}
.tabs{display:flex;gap:8px;margin:18px 0 4px}.tabs button{margin:0;width:auto;padding:10px 16px}.tabs button.off{background:transparent;color:var(--muted);border:1px solid var(--line)}
.msg{border-top:1px solid var(--line);padding:14px 0}.msg:first-child{border-top:0}
.who{font:400 20px 'Cormorant Garamond',serif}.meta{font:400 8px Michroma,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.body{white-space:pre-wrap;margin:6px 0}.rep{color:var(--gold);font-size:14px;margin:4px 0;white-space:pre-wrap}
.msg textarea{min-height:46px;margin-top:6px}.msg button{width:auto;margin-top:8px;padding:11px 18px}
.new{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--gold);margin-right:8px;vertical-align:middle}
.note{color:var(--muted);font-size:13px}
</style></head><body><div class="wrap" id="app"><div class="eb">DIONYSTY · Starlove</div><h1>Starlove</h1><p class="sub">Loading…</p></div>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<script>
(function(){
var A=document.getElementById('app'),T=sessionStorage.getItem('sl_t')||'',tab='inbox',timer=0;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function api(p,b){b=b||{};if(T)b.token=T;return fetch('/api/god/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()}).catch(function(){return {ok:false,error:'Network'}})}
function head(t,s){return '<div class="eb">DIONYSTY · Starlove</div><h1>'+t+'</h1>'+(s?'<p class="sub">'+s+'</p>':'')}
function ago(t){var s=(Date.now()-t)/1000;if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return new Date(t).toLocaleDateString()}
function setup(){A.innerHTML=head('Become <em>Starlove</em>','A one-time setup. You choose the password and scan the code yourself.')+'<div class="card"><label>Setup code</label><input id="sc" autocomplete="off" autocapitalize="characters"><button id="go">Begin</button><div class="err" id="er"></div></div>';
document.getElementById('go').onclick=function(){var code=document.getElementById('sc').value;api('setup/start',{code:code}).then(function(r){if(!r.ok){document.getElementById('er').textContent=r.error||'Try again';return}step2(code,r)})}}
function step2(code,r){A.innerHTML=head('Your <em>authenticator</em>','Scan this with Google Authenticator, or type the key in by hand.')+'<div class="card"><div id="qr"></div><div class="key">'+esc(r.secret.replace(/(.{4})/g,'$1 '))+'</div><label>Choose a password (12+ characters)</label><input id="p1" type="password" autocomplete="new-password"><label>Type it again</label><input id="p2" type="password" autocomplete="new-password"><label>6-digit code from the app</label><input id="ot" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><button id="go">Finish</button><div class="err" id="er"></div></div>';
try{var q=qrcode(0,'M');q.addData(r.uri);q.make();document.getElementById('qr').innerHTML=q.createSvgTag(5,0)}catch(e){document.getElementById('qr').style.display='none'}
document.getElementById('go').onclick=function(){var a=document.getElementById('p1').value,b=document.getElementById('p2').value,e=document.getElementById('er');if(a!==b){e.textContent='The two passwords are different.';return}if(a.length<12){e.textContent='Use at least 12 characters.';return}
api('setup/finish',{code:code,password:a,otp:document.getElementById('ot').value}).then(function(x){if(!x.ok){e.textContent=x.error||'Try again';return}A.innerHTML=head('Backup <em>codes</em>','Each works once, if you ever lose your phone. Save them somewhere safe now: they will not be shown again.')+'<div class="card"><div class="codes">'+x.backup.map(function(c){return '<span>'+c+'</span>'}).join('')+'</div><button id="ok">I have saved them</button></div>';document.getElementById('ok').onclick=login})}}
function login(){A.innerHTML=head('Welcome, <em>Starlove</em>','')+'<div class="card"><label>Password</label><input id="pw" type="password" autocomplete="current-password"><label>Code from the authenticator (or a backup code)</label><input id="ot" autocomplete="one-time-code"><button id="go">Enter</button><div class="err" id="er"></div></div>';
var go=function(){var b=document.getElementById('go');b.disabled=true;api('login',{password:document.getElementById('pw').value,otp:document.getElementById('ot').value}).then(function(r){b.disabled=false;if(!r.ok){document.getElementById('er').textContent=r.error||'Try again';return}T=r.token;sessionStorage.setItem('sl_t',T);if(r.backupLeft<3)alert('Only '+r.backupLeft+' backup codes left.');con()})};
document.getElementById('go').onclick=go;document.getElementById('ot').onkeydown=function(e){if(e.key==='Enter')go()}}
function con(){A.innerHTML='<div class="top"><div class="eb">DIONYSTY · Starlove</div><button class="ghost" id="out" style="width:auto;margin:0;padding:9px 14px">Sign out</button></div><h1>Every <em>star</em></h1><div class="tabs"><button id="t1">Inbox</button><button id="t2">Log</button></div><div class="card" id="pane"><p class="note">Loading…</p></div>';
document.getElementById('out').onclick=function(){api('logout').then(function(){T='';sessionStorage.removeItem('sl_t');login()})};
document.getElementById('t1').onclick=function(){tab='inbox';paint()};document.getElementById('t2').onclick=function(){tab='log';paint()};paint();clearInterval(timer);timer=setInterval(function(){if(tab==='inbox'&&!(document.activeElement&&document.activeElement.tagName==='TEXTAREA'))paint()},15000)}
function paint(){document.getElementById('t1').className=tab==='inbox'?'':'off';document.getElementById('t2').className=tab==='log'?'':'off';var P=document.getElementById('pane');
if(tab==='log'){api('log').then(function(r){if(!r.ok)return gone(r);P.innerHTML=r.log.map(function(l){return '<div class="msg"><div class="meta">'+ago(l.at)+' · '+esc(l.who)+'</div><div class="body">'+esc(l.what)+'</div></div>'}).join('')||'<p class="note">Nothing yet.</p>'});return}
api('inbox').then(function(r){if(!r.ok)return gone(r);P.innerHTML=(r.inbox?'':'<p class="note">Telegram notifications are off: send /inbox to @DionystyBot to get every message on your phone too.</p>')+(r.msgs.map(function(m){return '<div class="msg" data-id="'+m.id+'"><div class="who">'+(m.repliedAt?'':'<span class="new"></span>')+esc(m.who)+'</div><div class="meta">'+esc(m.label)+' · '+ago(m.at)+'</div><div class="body">'+esc(m.body)+'</div>'+(m.repliedAt?'<div class="rep">↳ Starlove: '+esc(m.reply)+'</div>':'')+(m.canReply?'<textarea placeholder="Reply as Starlove"></textarea><button>Send as Starlove</button>':'')+'</div>'}).join('')||'<p class="note">No messages yet. Everything people send Starlove will appear here.</p>');
[].forEach.call(P.querySelectorAll('.msg button'),function(b){b.onclick=function(){var box=b.parentNode,t=box.querySelector('textarea').value.trim();if(!t)return;b.disabled=true;api('reply',{id:+box.dataset.id,text:t}).then(function(x){b.disabled=false;if(!x.ok){alert(x.error||'Not sent');return}paint()})}})})}
function gone(r){if(r.error==='auth'){T='';sessionStorage.removeItem('sl_t');login()}}
if(T){api('inbox').then(function(r){if(r.ok)con();else{T='';sessionStorage.removeItem('sl_t');start()}})}else start();
function start(){api('status').then(function(r){if(r.setup)setup();else login()})}
})();
</script></body></html>`;


/* ✦ DIONYSTY v2: stars you own, bonds that pull, villages with Gates, a public record you can rewind,
   requests to talk, blocks and reports, the House, invitations, and private photos (view once).
   Routes live under /api/sq/v2/. Shapes and numbers follow docs 37–43. */
const V2 = { GAP: 221, LMIN: 253, LFAR: 936, TAU: 21, R0: 0.35, C: 0.9, NEAR: 364, CAP: 7, UNSAY: 600000, MET: 1800000 };
const V2_TEMPLES = ['The Artists', 'The Thinkers', 'The Healers', 'The Lovers', 'The Wanderers', 'The Revellers', 'The Builders'];
const V2_FIXED = [{ kind: 'starlove', name: 'Starlove', x: 0, y: 0 }, { kind: 'house', name: 'The First House', x: -39, y: -806 }].concat(
  V2_TEMPLES.map(function (t, i) { const a = -Math.PI / 2 + i * 2 * Math.PI / 7 + 0.22; return { kind: 'temple', name: t, x: Math.round(Math.cos(a) * 1950), y: Math.round(Math.sin(a) * 1950) }; }));
let v2IsReady = false;
async function v2Ready(env) {
  if (v2IsReady) return;
  const q = [
    'CREATE TABLE IF NOT EXISTS owned (cid INTEGER PRIMARY KEY, uid TEXT UNIQUE, wx REAL, wy REAL, at INTEGER)',
    'CREATE TABLE IF NOT EXISTS villages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, title TEXT, host TEXT, cx REAL, cy REAL, R REAL, at INTEGER)',
    'CREATE TABLE IF NOT EXISTS vapps (id INTEGER PRIMARY KEY AUTOINCREMENT, vid INTEGER, uid TEXT, note TEXT, at INTEGER, status TEXT)',
    'CREATE TABLE IF NOT EXISTS vvotes (app INTEGER, uid TEXT, yes INTEGER, at INTEGER, PRIMARY KEY (app, uid))',
    'CREATE TABLE IF NOT EXISTS met (a TEXT, b TEXT, at INTEGER, cid INTEGER, PRIMARY KEY (a, b))',
    'CREATE TABLE IF NOT EXISTS creqs (a TEXT, b TEXT, body TEXT, at INTEGER, status TEXT, PRIMARY KEY (a, b))',
    'CREATE TABLE IF NOT EXISTS talks (a TEXT, b TEXT, at INTEGER, PRIMARY KEY (a, b))',
    'CREATE TABLE IF NOT EXISTS blocks (a TEXT, b TEXT, at INTEGER, PRIMARY KEY (a, b))',
    'CREATE TABLE IF NOT EXISTS looks (uid TEXT, ev TEXT, line TEXT, at INTEGER, PRIMARY KEY (uid, ev))',
    'CREATE TABLE IF NOT EXISTS places (uid TEXT, ev TEXT, how TEXT, status TEXT, at INTEGER, PRIMARY KEY (uid, ev))',
    'CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT, cid INTEGER, at INTEGER, seen INTEGER DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, a TEXT, b TEXT, uid TEXT, blob TEXT, once INTEGER, opened INTEGER DEFAULT 0, at INTEGER)',
    'CREATE TABLE IF NOT EXISTS dmx (id INTEGER PRIMARY KEY, edited INTEGER DEFAULT 0, del INTEGER DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS dm_save (id INTEGER PRIMARY KEY, by TEXT, at INTEGER)',
    'CREATE TABLE IF NOT EXISTS mpurge (id TEXT PRIMARY KEY, at INTEGER, tries INTEGER DEFAULT 0)',
  ];
  await env.D1.batch(q.map(function (s) { return env.D1.prepare(s); }));
  try { await env.D1.prepare('ALTER TABLE media ADD ext INTEGER DEFAULT 0').run(); } catch (e) {}
  const v = await env.D1.prepare('SELECT COUNT(*) AS n FROM villages').first();
  if (!v || !v.n) await env.D1.prepare('INSERT OR IGNORE INTO villages (name, title, host, cx, cy, R, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind('Village 1', 'The First Village', '', -4290, 1105, 1170, Date.now()).run();
  v2IsReady = true;
}
async function mediaStore(env, id, blob) {
  if (!env.MEDIA_BRIDGE_URL || !env.MEDIA_KEY) return false;
  try {
    const r = await fetch(env.MEDIA_BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ key: env.MEDIA_KEY, op: 'put', id: 'm_' + id, b64: blob }) });
    const j = await r.json(); return !!(j && j.ok);
  } catch (e) { return false; }
}
async function mediaFetch(env, id) {
  if (!env.MEDIA_BRIDGE_URL || !env.MEDIA_KEY) return null;
  try {
    const r = await fetch(env.MEDIA_BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ key: env.MEDIA_KEY, op: 'get', id: 'm_' + id }) });
    const j = await r.json();
    if (j && j.ok) return String(j.b64 || '');
    return j && j.error === 'notfound' ? null : undefined;
  } catch (e) { return undefined; }
}
async function mediaDrop(env, id) {
  // true = blob confirmed physically gone, or its id is durably queued for retry (safe to remove the D1 row)
  if (!env.MEDIA_BRIDGE_URL || !env.MEDIA_KEY) return true;
  try {
    const r = await fetch(env.MEDIA_BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(8000), body: JSON.stringify({ key: env.MEDIA_KEY, op: 'del', id: 'm_' + id }) });
    const j = await r.json();
    if (j && (j.ok || j.error === 'notfound')) return true; // physically gone (or never stored)
  } catch (e) {}
  // delete unconfirmed: persist the blob id BEFORE the caller removes the D1 row, so a failed enqueue cannot silently lose the locator
  try { await env.D1.prepare('INSERT OR REPLACE INTO mpurge (id, at, tries) VALUES (?1, ?2, 0)').bind(id, Date.now()).run(); return true; } catch (e) { console.log('mpurge enqueue failed for', id, e && e.message); return false; }
}
async function mediaPurgeSweep(env) {
  if (!env.MEDIA_BRIDGE_URL || !env.MEDIA_KEY) return;
  let pend = [];
  try { pend = (await env.D1.prepare('SELECT id FROM mpurge ORDER BY at LIMIT 50').all()).results || []; } catch (e) { return; }
  for (const x of pend) {
    let done = false;
    try {
      const r = await fetch(env.MEDIA_BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(8000), body: JSON.stringify({ key: env.MEDIA_KEY, op: 'del', id: 'm_' + x.id }) });
      const j = await r.json();
      done = !!(j && (j.ok || j.error === 'notfound'));
    } catch (e) {}
    try {
      if (done) await env.D1.prepare('DELETE FROM mpurge WHERE id = ?1').bind(x.id).run();
      else await env.D1.prepare('UPDATE mpurge SET tries = tries + 1 WHERE id = ?1').bind(x.id).run();
    } catch (e) {}
  }
}
function v2Pair(a, b) { a = String(a); b = String(b); return a < b ? [a, b] : [b, a]; }
async function v2Person(env, uid) { return await env.D1.prepare('SELECT uid, pid, alias, room, member, temples, since FROM people WHERE uid = ?1').bind(String(uid)).first(); }
async function v2ByPid(env, pid) { return await env.D1.prepare('SELECT uid, pid, alias, room, member, temples, since FROM people WHERE pid = ?1').bind(String(pid)).first(); }
function v2Temple(p) { try { const t = JSON.parse(p.temples || '[]'); return Array.isArray(t) ? (t[0] || '') : String(t || ''); } catch (e) { return String(p.temples || '').split(',')[0] || ''; } }
async function v2Villages(env) { return (await env.D1.prepare('SELECT v.id, v.name, v.title, v.host, v.cx, v.cy, v.R, (SELECT COUNT(*) FROM people p WHERE p.room = v.name AND p.member = 1) AS members FROM villages v').all()).results || []; }
function v2VillageAt(vils, x, y) { for (const v of vils) if (Math.hypot(x - v.cx, y - v.cy) < v.R) return v; return null; }
async function v2Blocked(env, a, b) { const r = await env.D1.prepare('SELECT 1 FROM blocks WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)').bind(String(a), String(b)).first(); return !!r; }
async function v2BondCount(env, uid) { const r = await env.D1.prepare("SELECT COUNT(*) AS n FROM bonds WHERE status = 'bonded' AND (a = ?1 OR b = ?1)").bind(String(uid)).first(); return (r && r.n) || 0; }
/* where may a star sit? spacing from every star and fixed place, and only inside your own village's territory or open space */
async function v2PlaceOk(env, uid, room, x, y, skipCid) {
  if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 40000 || Math.abs(y) > 40000) return 'That place is out of the city.';
  for (const f of V2_FIXED) if (Math.hypot(x - f.x, y - f.y) < V2.GAP * (f.kind === 'starlove' ? 2 : f.kind === 'temple' ? 1.6 : 1.4)) return 'Too close to ' + f.name + '.';
  const vils = await v2Villages(env), v = v2VillageAt(vils, x, y);
  if (v && v.name !== room) return v.name + ' is for its members.';
  const near = await env.D1.prepare('SELECT o.cid, p.alias FROM owned o LEFT JOIN people p ON p.uid = o.uid WHERE o.cid != ?3 AND (o.wx - ?1) * (o.wx - ?1) + (o.wy - ?2) * (o.wy - ?2) < ?4 LIMIT 1').bind(x, y, skipCid || -1, V2.GAP * V2.GAP).first();
  if (near) return 'Too close to ' + (near.alias || 'another') + '’s star. Find open sky, or ask them to move.';
  return '';
}
async function v2Stars(env, me, myRoom) {
  const vils = await v2Villages(env);
  const rows = (await env.D1.prepare('SELECT o.cid, o.uid, o.wx, o.wy, c.topic, c.hushed, p.pid, p.alias, p.room, p.temples, p.since FROM owned o LEFT JOIN circles c ON c.id = o.cid LEFT JOIN people p ON p.uid = o.uid').all()).results || [];
  const bonds = (await env.D1.prepare("SELECT a, b, at FROM bonds WHERE status = 'bonded'").all()).results || [];
  const now = Date.now();
  const stars = rows.map(function (r) {
    const v = v2VillageAt(vils, r.wx, r.wy), veiled = v && v.name !== myRoom;
    if (veiled) return { cid: r.cid, wx: r.wx, wy: r.wy, veiled: 1, village: v.name };
    return { cid: r.cid, pid: r.pid, alias: r.alias, wx: r.wx, wy: r.wy, topic: r.topic || '', hushed: !!r.hushed, temple: v2Temple(r), since: r.since || '', room: r.room || '', mine: String(r.uid) === String(me) };
  });
  const pidOfUid = {}; rows.forEach(function (r) { pidOfUid[r.uid] = r.pid; });
  const ownedUid = {}; rows.forEach(function (r) { ownedUid[r.uid] = 1; });
  const bl = bonds.filter(function (b) { return ownedUid[b.a] && ownedUid[b.b]; }).map(function (b) { return { a: pidOfUid[b.a], b: pidOfUid[b.b], days: Math.floor((now - (b.at || now)) / 86400000), mine: String(b.a) === String(me) || String(b.b) === String(me) }; });
  return { fixed: V2_FIXED, villages: vils, stars: stars, bonds: bl, gap: V2.GAP, cap: V2.CAP };
}
/* one day of bond drift (doc 37): rest length shrinks with age, pull slows with crowding, spacing always holds */
async function v2Drift(env) {
  await v2Ready(env);
  const day = new Date().toISOString().slice(0, 10);
  if ((await env.DB.get('v2:drift')) === day) return;
  await env.DB.put('v2:drift', day);
  const rows = (await env.D1.prepare("SELECT cid, uid, wx, wy FROM owned WHERE uid NOT LIKE 'fixed:%'").all()).results || [];
  if (rows.length < 2) return;
  const byUid = {}; rows.forEach(function (r) { byUid[r.uid] = r; });
  const bonds = (await env.D1.prepare("SELECT a, b, at FROM bonds WHERE status = 'bonded'").all()).results || [];
  const now = Date.now(), vils = await v2Villages(env), people = {};
  ((await env.D1.prepare('SELECT uid, room FROM people').all()).results || []).forEach(function (p) { people[p.uid] = p.room; });
  bonds.forEach(function (k) {
    const a = byUid[k.a], b = byUid[k.b]; if (!a || !b) return;
    const d = (now - (k.at || now)) / 86400000, L = V2.LMIN + (V2.LFAR - V2.LMIN) * Math.exp(-d / V2.TAU);
    const dx = b.wx - a.wx, dy = b.wy - a.wy, D = Math.hypot(dx, dy) || 1; if (D <= L) return;
    const mx = (a.wx + b.wx) / 2, my = (a.wy + b.wy) / 2; let n = 0;
    rows.forEach(function (s) { if (s !== a && s !== b && Math.hypot(s.wx - mx, s.wy - my) < V2.NEAR) n++; });
    const mv = (D - L) * (1 - Math.exp(-V2.R0 / (1 + V2.C * n)));
    a.wx += dx / D * mv / 2; a.wy += dy / D * mv / 2; b.wx -= dx / D * mv / 2; b.wy -= dy / D * mv / 2;
  });
  for (let it = 0; it < 60; it++) {
    let moved = false;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j], dx = b.wx - a.wx, dy = b.wy - a.wy, D = Math.hypot(dx, dy) || 1;
      if (D < V2.GAP) { const p = (V2.GAP - D) * 0.55; a.wx -= dx / D * p; a.wy -= dy / D * p; b.wx += dx / D * p; b.wy += dy / D * p; moved = true; }
    }
    rows.forEach(function (r) { /* members stay inside their village, outsiders outside every other village */
      vils.forEach(function (v) { const dx = r.wx - v.cx, dy = r.wy - v.cy, D = Math.hypot(dx, dy) || 1, mine = people[r.uid] === v.name;
        if (mine && D > v.R - 1) { r.wx = v.cx + dx / D * (v.R - 1); r.wy = v.cy + dy / D * (v.R - 1); }
        if (!mine && D < v.R + 1) { r.wx = v.cx + dx / D * (v.R + 1); r.wy = v.cy + dy / D * (v.R + 1); } });
    });
    if (!moved) break;
  }
  await env.D1.batch(rows.map(function (r) { return env.D1.prepare('UPDATE owned SET wx = ?2, wy = ?3 WHERE cid = ?1').bind(r.cid, Math.round(r.wx), Math.round(r.wy)); }));
}
async function v2Api(req, path, env, body, user, id, r) {
  await v2Ready(env);
  const me = String(id), p = path.slice('/api/sq/v2/'.length), b = body || {}, now = Date.now();
  const J = function (o, s) { return apiJson(req, o, s); };
  const mine = await v2Person(env, me);
  if (!mine) return J({ ok: false, error: 'Please register first.' }, 403);
  const room = mine.room || '';
  if (p === 'stars') return J(Object.assign({ ok: true, me: mine.pid, room: room }, await v2Stars(env, me, room)));
  if (p === 'star/light' || p === 'star/move') {
    const own = await env.D1.prepare('SELECT cid FROM owned WHERE uid = ?1').bind(me).first();
    if (p === 'star/light' && own) return J({ ok: false, error: 'You already have a star lit. One at a time: move it, or let it go out first.' });
    if (p === 'star/move' && !own) return J({ ok: false, error: 'Light a star first.' });
    const x = Math.round(Number(b.wx)), y = Math.round(Number(b.wy)), why = await v2PlaceOk(env, me, room, x, y, own ? own.cid : -1);
    if (why) return J({ ok: false, error: why });
    if (own) { await env.D1.prepare('UPDATE owned SET wx = ?2, wy = ?3 WHERE cid = ?1').bind(own.cid, x, y).run(); return J({ ok: true, cid: own.cid }); }
    const topic = String(b.topic || '').trim().slice(0, 120);
    const c = await env.D1.prepare("INSERT INTO circles (room, vibe, topic, hushed, cap, welcome, at, last) VALUES (?1, 'salon', ?2, 0, 5, 0, ?3, ?3)").bind(room, topic, now).run();
    const cid = c.meta.last_row_id;
    await env.D1.prepare('INSERT INTO owned (cid, uid, wx, wy, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(cid, me, x, y, now).run();
    return J({ ok: true, cid: cid });
  }
  if (p === 'star/topic') { const own = await env.D1.prepare('SELECT cid FROM owned WHERE uid = ?1').bind(me).first(); if (!own) return J({ ok: false }); await env.D1.prepare('UPDATE circles SET topic = ?2 WHERE id = ?1').bind(own.cid, String(b.topic || '').trim().slice(0, 120)).run(); return J({ ok: true }); }
  if (p === 'star/out') { await env.D1.prepare('DELETE FROM owned WHERE uid = ?1').bind(me).run(); return J({ ok: true }); }
  /* the public record: every line kept; anyone who may see a star may rewind it */
  if (p === 'history') {
    const cid = Number(b.cid) || 0, to = Number(b.to) || now, from = Number(b.from) || (to - 3 * 3600000);
    const o = await env.D1.prepare('SELECT o.wx, o.wy FROM owned o WHERE o.cid = ?1').bind(cid).first();
    if (o) { const v = v2VillageAt(await v2Villages(env), o.wx, o.wy); if (v && v.name !== room) return J({ ok: false, error: 'Members only.' }, 403); }
    const rows = (await env.D1.prepare('SELECT l.id, l.uid, l.body, l.at, p.alias, p.pid FROM lines l LEFT JOIN people p ON p.uid = l.uid WHERE l.cid = ?1 AND l.at BETWEEN ?2 AND ?3 ORDER BY l.at LIMIT 500').bind(cid, from, to).all()).results || [];
    return J({ ok: true, lines: rows.map(function (l) { return { id: l.id, pid: l.pid, alias: l.alias, body: l.body, at: l.at, mine: String(l.uid) === me, canTake: String(l.uid) === me && now - l.at < V2.UNSAY }; }) });
  }
  if (p === 'unsay') {
    const l = await env.D1.prepare('SELECT id, at FROM lines WHERE id = ?1 AND uid = ?2').bind(Number(b.id) || 0, me).first();
    if (!l) return J({ ok: false, error: 'Not your line.' });
    if (now - l.at > V2.UNSAY) return J({ ok: false, error: 'Lines can only be taken back within 10 minutes.' });
    await env.D1.prepare('DELETE FROM lines WHERE id = ?1').bind(l.id).run();
    return J({ ok: true });
  }
  /* villages */
  if (p === 'vil/list') return J({ ok: true, room: room, villages: await v2Villages(env) });
  if (p === 'vil/apply') {
    const v = await env.D1.prepare('SELECT * FROM villages WHERE id = ?1').bind(Number(b.vid) || 0).first();
    if (!v) return J({ ok: false, error: 'No such village.' });
    if (v.name === room) return J({ ok: false, error: 'You already live here.' });
    const open = await env.D1.prepare("SELECT id FROM vapps WHERE uid = ?1 AND status = 'open'").bind(me).first();
    if (open) return J({ ok: false, error: 'You already have an application open.' });
    const n = await env.D1.prepare('SELECT COUNT(*) AS n FROM people WHERE room = ?1 AND member = 1').bind(v.name).first();
    const st = (n && n.n >= 50) ? 'waitlist' : 'open';
    const a = await env.D1.prepare('INSERT INTO vapps (vid, uid, note, at, status) VALUES (?1, ?2, ?3, ?4, ?5)').bind(v.id, me, String(b.note || '').slice(0, 280), now, st).run();
    return J({ ok: true, id: a.meta.last_row_id, status: st });
  }
  if (p === 'vil/mine') {
    const a = await env.D1.prepare('SELECT a.id, a.status, a.at, v.name, v.title, (SELECT COUNT(*) FROM vvotes w WHERE w.app = a.id) AS votes, (SELECT COUNT(*) FROM vvotes w WHERE w.app = a.id AND w.yes = 1) AS yes, (SELECT COUNT(*) FROM people p WHERE p.room = v.name AND p.member = 1) AS members FROM vapps a JOIN villages v ON v.id = a.vid WHERE a.uid = ?1 ORDER BY a.id DESC LIMIT 1').bind(me).first();
    return J({ ok: true, app: a || null });
  }
  if (p === 'vil/apps') {
    const v = await env.D1.prepare('SELECT id, name FROM villages WHERE name = ?1').bind(room).first();
    if (!v || !mine.member) return J({ ok: true, apps: [] });
    const rows = (await env.D1.prepare("SELECT a.id, a.note, a.at, p.pid, p.alias, p.temples, p.since, a.uid, (SELECT yes FROM vvotes w WHERE w.app = a.id AND w.uid = ?2) AS myvote FROM vapps a JOIN people p ON p.uid = a.uid WHERE a.vid = ?1 AND a.status = 'open' ORDER BY a.at").bind(v.id, me).all()).results || [];
    const out = [];
    for (const a of rows) {
      const inside = await env.D1.prepare("SELECT COUNT(*) AS n FROM bonds b JOIN people p ON p.uid = (CASE WHEN b.a = ?1 THEN b.b ELSE b.a END) WHERE b.status = 'bonded' AND (b.a = ?1 OR b.b = ?1) AND p.room = ?2").bind(a.uid, room).first();
      out.push({ id: a.id, pid: a.pid, alias: a.alias, temple: v2Temple(a), since: a.since, note: a.note, at: a.at, bondsInside: (inside && inside.n) || 0, myVote: a.myvote });
    }
    return J({ ok: true, apps: out });
  }
  if (p === 'vil/vote') {
    if (!mine.member) return J({ ok: false, error: 'Only members vote.' });
    const a = await env.D1.prepare("SELECT a.*, v.name, v.cx, v.cy, v.R FROM vapps a JOIN villages v ON v.id = a.vid WHERE a.id = ?1 AND a.status = 'open'").bind(Number(b.app) || 0).first();
    if (!a || a.name !== room) return J({ ok: false, error: 'Nothing to vote on.' });
    await env.D1.prepare('INSERT OR REPLACE INTO vvotes (app, uid, yes, at) VALUES (?1, ?2, ?3, ?4)').bind(a.id, me, b.yes ? 1 : 0, now).run();
    const n = (await env.D1.prepare('SELECT COUNT(*) AS n FROM people WHERE room = ?1 AND member = 1').bind(room).first()).n || 1;
    const t = await env.D1.prepare('SELECT SUM(yes) AS y, COUNT(*) AS c FROM vvotes WHERE app = ?1').bind(a.id).first();
    let status = 'open';
    if ((t.y || 0) * 2 > n) status = 'in'; else if ((t.c - (t.y || 0)) * 2 >= n) status = 'declined';
    if (status !== 'open') {
      await env.D1.prepare('UPDATE vapps SET status = ?2 WHERE id = ?1').bind(a.id, status).run();
      if (status === 'in') { await env.D1.prepare('UPDATE people SET room = ?2 WHERE uid = ?1').bind(a.uid, room).run(); await v2MoveInto(env, a.uid, a); try { await slSend(env, a.uid, '✦ ' + room + ' took you in. Your star now shines there.'); } catch (e) {} }
    }
    return J({ ok: true, status: status });
  }
  /* meeting, requests and who you can talk to */
  if (p === 'req/send') {
    const to = await v2ByPid(env, b.pid); if (!to) return J({ ok: false, error: 'No one by that name.' });
    if (await v2Blocked(env, me, to.uid)) return J({ ok: false, error: 'You can’t write to them.' });
    const pr = v2Pair(me, to.uid), met = await env.D1.prepare('SELECT 1 FROM met WHERE a = ?1 AND b = ?2').bind(pr[0], pr[1]).first();
    if (!met) return J({ ok: false, error: 'You can ask once you’ve met: talked at the same star.' });
    await env.D1.prepare("INSERT OR REPLACE INTO creqs (a, b, body, at, status) VALUES (?1, ?2, ?3, ?4, 'open')").bind(me, to.uid, String(b.text || '').slice(0, 280), now).run();
    try { await slSend(env, to.uid, '✦ ' + (mine.alias || 'Someone') + ' would like to talk. Open DIONYSTY to answer.'); } catch (e) {}
    return J({ ok: true });
  }
  if (p === 'req/list') {
    const rows = (await env.D1.prepare("SELECT q.body, q.at, p.pid, p.alias, p.temples, p.since, m.cid FROM creqs q JOIN people p ON p.uid = q.a LEFT JOIN met m ON (m.a = q.a AND m.b = q.b) OR (m.a = q.b AND m.b = q.a) WHERE q.b = ?1 AND q.status = 'open' AND q.at > ?2 ORDER BY q.at DESC").bind(me, now - 14 * 86400000).all()).results || [];
    const out = [];
    for (const q of rows) { const c = q.cid ? await env.D1.prepare('SELECT o.uid, p.alias, c.topic FROM circles c LEFT JOIN owned o ON o.cid = c.id LEFT JOIN people p ON p.uid = o.uid WHERE c.id = ?1').bind(q.cid).first() : null;
      out.push({ pid: q.pid, alias: q.alias, temple: v2Temple(q), since: q.since, text: q.body, at: q.at, where: c ? (c.alias ? c.alias + '’s star' : (c.topic || 'a star')) : 'a star' }); }
    return J({ ok: true, requests: out });
  }
  if (p === 'req/answer') {
    const from = await v2ByPid(env, b.pid); if (!from) return J({ ok: false });
    const st = b.block ? 'blocked' : b.yes ? 'accepted' : 'later';
    await env.D1.prepare('UPDATE creqs SET status = ?3 WHERE a = ?1 AND b = ?2').bind(from.uid, me, st).run();
    if (b.yes) { const pr = v2Pair(me, from.uid); await env.D1.prepare('INSERT OR IGNORE INTO talks (a, b, at) VALUES (?1, ?2, ?3)').bind(pr[0], pr[1], now).run(); }
    if (b.block) await env.D1.prepare('INSERT OR IGNORE INTO blocks (a, b, at) VALUES (?1, ?2, ?3)').bind(me, from.uid, now).run();
    return J({ ok: true });
  }
  if (p === 'talks') {
    const rows = (await env.D1.prepare('SELECT p.pid, p.alias, p.temples, p.since, t.at, m.cid FROM talks t JOIN people p ON p.uid = (CASE WHEN t.a = ?1 THEN t.b ELSE t.a END) LEFT JOIN met m ON m.a = t.a AND m.b = t.b WHERE t.a = ?1 OR t.b = ?1').bind(me).all()).results || [];
    return J({ ok: true, talks: rows.map(function (t) { return { pid: t.pid, alias: t.alias, temple: v2Temple(t), since: t.since, at: t.at }; }) });
  }
  if (p === 'block' || p === 'unblock') {
    const o = await v2ByPid(env, b.pid); if (!o) return J({ ok: false });
    if (p === 'block') { await env.D1.prepare('INSERT OR IGNORE INTO blocks (a, b, at) VALUES (?1, ?2, ?3)').bind(me, o.uid, now).run(); await env.D1.prepare("UPDATE creqs SET status = 'blocked' WHERE a = ?1 AND b = ?2").bind(o.uid, me).run(); }
    else await env.D1.prepare('DELETE FROM blocks WHERE a = ?1 AND b = ?2').bind(me, o.uid).run();
    return J({ ok: true });
  }
  if (p === 'blocks') { const rows = (await env.D1.prepare('SELECT p.pid FROM blocks b JOIN people p ON p.uid = b.b WHERE b.a = ?1 UNION SELECT p.pid FROM blocks b JOIN people p ON p.uid = b.a WHERE b.b = ?1').bind(me).all()).results || []; return J({ ok: true, pids: rows.map(function (x) { return x.pid; }) }); }
  if (p === 'report') {
    const o = await v2ByPid(env, b.pid); if (!o) return J({ ok: false });
    const text = 'Report about ' + (o.alias || o.pid) + ' (pid ' + o.pid + '): ' + String(b.reason || '').slice(0, 120) + (b.note ? '\n' + String(b.note).slice(0, 800) : '');
    try { await slForward(env, 'Report', 'Anonymous member', text, ''); } catch (e) {}
    return J({ ok: true });
  }
  /* the House: places and looking-for lines */
  if (p === 'look/set') { const line = String(b.line || '').trim().slice(0, 90); if (!line) return J({ ok: false, error: 'Write one line.' }); await env.D1.prepare('INSERT OR REPLACE INTO looks (uid, ev, line, at) VALUES (?1, ?2, ?3, ?4)').bind(me, String(b.ev || 'house1'), line, now).run(); return J({ ok: true }); }
  if (p === 'look/del') { await env.D1.prepare('DELETE FROM looks WHERE uid = ?1 AND ev = ?2').bind(me, String(b.ev || 'house1')).run(); return J({ ok: true }); }
  if (p === 'look/list') {
    const rows = (await env.D1.prepare('SELECT l.line, l.at, l.uid, p.pid, p.alias, p.temples, p.since FROM looks l JOIN people p ON p.uid = l.uid WHERE l.ev = ?1 ORDER BY l.at DESC LIMIT 200').bind(String(b.ev || 'house1')).all()).results || [];
    const bl = {}; ((await env.D1.prepare('SELECT a, b FROM blocks WHERE a = ?1 OR b = ?1').bind(me).all()).results || []).forEach(function (x) { bl[x.a === me ? x.b : x.a] = 1; });
    return J({ ok: true, lines: rows.filter(function (l) { return !bl[l.uid]; }).map(function (l) { return { pid: l.pid, alias: l.alias, temple: v2Temple(l), since: l.since, line: l.line, at: l.at, mine: String(l.uid) === me }; }) });
  }
  if (p === 'place/ask') { await env.D1.prepare("INSERT OR REPLACE INTO places (uid, ev, how, status, at) VALUES (?1, ?2, ?3, 'asked', ?4)").bind(me, String(b.ev || 'house1'), String(b.how || '').slice(0, 40), now).run(); try { await slForward(env, 'House place', (mine.alias || '') , 'Asked for a place at the House' + (b.how ? ' · coming ' + b.how : ''), 'tg:' + me); } catch (e) {} return J({ ok: true }); }
  if (p === 'place/me') { const r2 = await env.D1.prepare('SELECT how, status FROM places WHERE uid = ?1 AND ev = ?2').bind(me, String(b.ev || 'house1')).first(); const n = await env.D1.prepare("SELECT COUNT(*) AS n FROM places WHERE ev = ?1 AND status = 'going'").bind(String(b.ev || 'house1')).first(); const l = await env.D1.prepare('SELECT COUNT(*) AS n FROM looks WHERE ev = ?1').bind(String(b.ev || 'house1')).first(); return J({ ok: true, place: r2 || null, going: (n && n.n) || 0, looking: (l && l.n) || 0 }); }
  /* invitations: they see the star you're at, never your flight */
  if (p === 'invite') {
    const to = await v2ByPid(env, b.pid); if (!to) return J({ ok: false });
    if (await v2Blocked(env, me, to.uid)) return J({ ok: false, error: 'You can’t invite them.' });
    const seat = await env.D1.prepare('SELECT cid FROM seats WHERE uid = ?1').bind(me).first(), own = await env.D1.prepare('SELECT cid FROM owned WHERE uid = ?1').bind(me).first();
    const cid = (seat && seat.cid) || (own && own.cid); if (!cid) return J({ ok: false, error: 'Be at a star first.' });
    await env.D1.prepare('INSERT INTO invites (a, b, cid, at) VALUES (?1, ?2, ?3, ?4)').bind(me, to.uid, cid, now).run();
    try { await slSend(env, to.uid, '✦ ' + (mine.alias || 'Someone') + ' invites you to their star. Open DIONYSTY to travel straight there.'); } catch (e) {}
    return J({ ok: true });
  }
  if (p === 'invites') {
    const rows = (await env.D1.prepare('SELECT i.id, i.cid, i.at, p.pid, p.alias, c.topic, (SELECT COUNT(*) FROM seats s WHERE s.cid = i.cid) AS n FROM invites i JOIN people p ON p.uid = i.a LEFT JOIN circles c ON c.id = i.cid WHERE i.b = ?1 AND i.seen = 0 AND i.at > ?2 ORDER BY i.at DESC LIMIT 5').bind(me, now - 6 * 3600000).all()).results || [];
    if (rows.length && b.seen) await env.D1.prepare('UPDATE invites SET seen = 1 WHERE b = ?1').bind(me).run();
    return J({ ok: true, invites: rows });
  }
  /* private photos: the client encrypts; the server keeps only ciphertext. View-once ones are deleted on first open. */
  if (p === 'media/put') {
    const to = await v2ByPid(env, b.pid); if (!to) return J({ ok: false });
    const blob = String(b.blob || ''); if (blob.length > 900000) return J({ ok: false, error: 'That photo is too large.' });
    const mid = godHex(godRnd(12)), pr = v2Pair(me, to.uid);
    const ext = (await mediaStore(env, mid, blob)) ? 1 : 0;
    await env.D1.prepare('INSERT INTO media (id, a, b, uid, blob, once, at, ext) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(mid, pr[0], pr[1], me, ext ? '' : blob, b.once ? 1 : 0, now, ext).run();
    return J({ ok: true, id: mid });
  }
  if (p === 'media/get') {
    const m = await env.D1.prepare('SELECT * FROM media WHERE id = ?1').bind(String(b.id || '')).first();
    if (!m || (m.a !== me && m.b !== me)) return J({ ok: false, error: 'Not found.' }, 404);
    if (m.opened) return J({ ok: true, gone: true });
    if (m.once && m.uid === me) return J({ ok: true, sealed: true });
    let blob = m.blob;
    if (m.ext) { blob = await mediaFetch(env, m.id); if (blob === undefined) return J({ ok: false, error: 'Photo storage is hiccuping; try again in a moment.' }, 502); if (blob === null) return J({ ok: true, gone: true }); }
    if (m.once) { await env.D1.prepare("UPDATE media SET opened = 1, blob = '' WHERE id = ?1").bind(m.id).run(); if (m.ext) await mediaDrop(env, m.id); }
    return J({ ok: true, blob: blob, once: !!m.once });
  }
  if (p === 'media/status') { const ids = (b.ids || []).slice(0, 100).map(String); if (!ids.length) return J({ ok: true, opened: {} }); const stm = env.D1.prepare('SELECT id, opened FROM media WHERE (a = ?1 OR b = ?1) AND id IN (' + ids.map(function (_, i) { return '?' + (i + 2); }).join(',') + ')'); const rows = (await stm.bind(me, ...ids).all()).results || []; const o = {}; rows.forEach(function (x) { o[x.id] = !!x.opened; }); return J({ ok: true, opened: o }); }
  /* editing and deleting your own private messages */
  if (p === 'dm/edit' || p === 'dm/del') {
    const m = await env.D1.prepare('SELECT id FROM dms WHERE id = ?1 AND uid = ?2').bind(Number(b.id) || 0, me).first();
    if (!m) return J({ ok: false, error: 'Not your message.' });
    if (p === 'dm/edit') { const body2 = String(b.body || ''); if (!body2 || body2.length > 20000) return J({ ok: false }); await env.D1.prepare('UPDATE dms SET body = ?2 WHERE id = ?1').bind(m.id, body2).run(); await env.D1.prepare('INSERT INTO dmx (id, edited) VALUES (?1, 1) ON CONFLICT(id) DO UPDATE SET edited = 1').bind(m.id).run(); }
    else { const mid = ((await env.D1.prepare('SELECT substr(body, 4) AS mid FROM dms WHERE id = ?1').bind(m.id).first()) || {}).mid;
    await env.D1.prepare("UPDATE dms SET body = '' WHERE id = ?1").bind(m.id).run(); await env.D1.prepare('INSERT INTO dmx (id, del) VALUES (?1, 1) ON CONFLICT(id) DO UPDATE SET del = 1').bind(m.id).run();
    if (mid) { const mx = await env.D1.prepare('SELECT id, ext FROM media WHERE id = ?1 AND uid = ?2').bind(mid, me).first();
      if (mx) { if (mx.ext) await mediaDrop(env, mx.id); await env.D1.prepare('DELETE FROM media WHERE id = ?1').bind(mx.id).run(); } } }
    return J({ ok: true });
  }
  if (p === 'dm/flags') { const ids = (b.ids || []).slice(0, 300).map(Number).filter(isFinite); if (!ids.length) return J({ ok: true, flags: {} }); const live = {}; ((await env.D1.prepare('SELECT id, a, b FROM dms WHERE id IN (' + ids.join(',') + ')').all()).results || []).forEach(function (x) { if (String(x.a) === String(me) || String(x.b) === String(me)) live[x.id] = 1; }); const o = {}; const rows = (await env.D1.prepare('SELECT id, edited, del FROM dmx WHERE id IN (' + ids.join(',') + ')').all()).results || []; rows.forEach(function (x) { if (live[x.id]) { o[x.id] = { edited: !!x.edited, del: !!x.del }; } }); const sv = (await env.D1.prepare('SELECT id, by FROM dm_save WHERE id IN (' + ids.join(',') + ')').all()).results || []; sv.forEach(function (x) { if (live[x.id]) { o[x.id] = o[x.id] || {}; o[x.id].saved = true; o[x.id].saved_by_me = String(x.by) === String(me); } }); ids.forEach(function (x) { if (!o[x] && !live[x]) o[x] = { gone: true }; }); return J({ ok: true, flags: o }); }
  if (p === 'dm/save') {
    const mid = Math.floor(Number(b.id) || 0);
    const m = await env.D1.prepare('SELECT id, a, b FROM dms WHERE id = ?1').bind(mid).first();
    if (!m || (String(m.a) !== String(me) && String(m.b) !== String(me))) return J({ ok: false, error: 'Not found.' }, 404);
    const cur = await env.D1.prepare('SELECT id FROM dm_save WHERE id = ?1').bind(mid).first();
    if (cur) { await env.D1.prepare('DELETE FROM dm_save WHERE id = ?1').bind(mid).run(); return J({ ok: true, saved: false }); }
    await env.D1.prepare('INSERT INTO dm_save (id, by, at) VALUES (?1, ?2, ?3)').bind(mid, String(me), Date.now()).run();
    return J({ ok: true, saved: true });
  }
  return J({ ok: false, error: 'not found' }, 404);
}
/* moving a member's star into the village that took them in */
async function v2MoveInto(env, uid, v) {
  const own = await env.D1.prepare('SELECT cid FROM owned WHERE uid = ?1').bind(String(uid)).first(); if (!own) return;
  for (let k = 0; k < 60; k++) { const a = k * 2.4, r = 300 + (k % 8) * 100, x = Math.round(v.cx + Math.cos(a) * r), y = Math.round(v.cy + Math.sin(a) * r);
    const near = await env.D1.prepare('SELECT 1 FROM owned WHERE cid != ?3 AND (wx - ?1) * (wx - ?1) + (wy - ?2) * (wy - ?2) < ?4 LIMIT 1').bind(x, y, own.cid, V2.GAP * V2.GAP).first();
    if (!near) { await env.D1.prepare('UPDATE owned SET wx = ?2, wy = ?3 WHERE cid = ?1').bind(own.cid, x, y).run(); return; } }
}
/* hooks into the existing API: route v2, record who has met, cap bonds at seven, keep requests' partners talking */
const v2SqApi0 = sqApi;
sqApi = async function (req, path, env, body, user, id, r) {
  if (path.indexOf('/api/sq/v2/') === 0) { try { return await v2Api(req, path, env, body, user, id, r); } catch (e) { return apiJson(req, { ok: false, error: 'Something went wrong.' }, 500); } }
  const res = await v2SqApi0(req, path, env, body, user, id, r);
  if (path === '/api/sq/bond') { try { await v2Ready(env); const me = String(id); if ((await v2BondCount(env, me)) > V2.CAP) {
    const last = await env.D1.prepare("SELECT a, b FROM bonds WHERE status = 'bonded' AND (a = ?1 OR b = ?1) ORDER BY at DESC LIMIT 1").bind(me).first();
    if (last) await env.D1.prepare('DELETE FROM bonds WHERE a = ?1 AND b = ?2').bind(last.a, last.b).run();
    return apiJson(req, { ok: false, error: 'Your seven are full. Let one go to make room.' }); }
    const other = await env.D1.prepare("SELECT a, b FROM bonds WHERE status = 'bonded' AND (a = ?1 OR b = ?1) ORDER BY at DESC LIMIT 1").bind(me).first();
    if (other) { const o = other.a === me ? other.b : other.a; if ((await v2BondCount(env, o)) > V2.CAP) { await env.D1.prepare('DELETE FROM bonds WHERE a = ?1 AND b = ?2').bind(other.a, other.b).run(); return apiJson(req, { ok: false, error: 'Their seven are full.' }); } }
  } catch (e) {} }
  return res;
};
const v2HApi0 = hApi;
hApi = async function (req, path, env, body, me, r, room, now) {
  const res = await v2HApi0(req, path, env, body, me, r, room, now);
  if (path === '/api/sq/h/say') { try { await v2Ready(env); const uid = String(me && me.uid !== undefined ? me.uid : me), t = Date.now();
    const seat = await env.D1.prepare('SELECT cid FROM seats WHERE uid = ?1').bind(uid).first();
    if (seat) { const others = (await env.D1.prepare('SELECT DISTINCT uid FROM lines WHERE cid = ?1 AND at > ?2 AND uid != ?3').bind(seat.cid, t - V2.MET, uid).all()).results || [];
      if (others.length) await env.D1.batch(others.map(function (o) { const pr = v2Pair(uid, o.uid); return env.D1.prepare('INSERT OR REPLACE INTO met (a, b, at, cid) VALUES (?1, ?2, ?3, ?4)').bind(pr[0], pr[1], t, seat.cid); })); }
  } catch (e) {} }
  return res;
};


/* v2 private messages: bonded people and anyone whose request to talk was accepted can write, across villages. Blocks always win. */
async function v2CanDm(env, me, o) {
  if (await v2Blocked(env, me, o)) return false;
  const b = await env.D1.prepare("SELECT 1 FROM bonds WHERE ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)) AND status = 'bonded'").bind(me, o).first();
  if (b) return true;
  const pr = v2Pair(me, o);
  return !!(await env.D1.prepare('SELECT 1 FROM talks WHERE a = ?1 AND b = ?2').bind(pr[0], pr[1]).first());
}
const v2HApi1 = hApi;
hApi = async function (req, path, env, body, me, r, room, now) {
  if (path === '/api/sq/h/dm/thread' || path === '/api/sq/h/dm/send' || path === '/api/sq/h/dm/list') {
    try {
      await v2Ready(env);
      const uid = String(me && me.uid !== undefined ? me.uid : me), D1 = env.D1, t0 = Date.now();
      if (path === '/api/sq/h/dm/list') {
        const res = await v2HApi1(req, path, env, body, me, r, room, now);
        let j; try { j = await res.clone().json(); } catch (e) { return res; }
        if (!j || !j.ok) return res;
        const have = {}; (j.threads || []).forEach(function (x) { have[x.pid] = 1; });
        const bl = {}; ((await D1.prepare('SELECT a, b FROM blocks WHERE a = ?1 OR b = ?1').bind(uid).all()).results || []).forEach(function (x) { bl[x.a === uid ? x.b : x.a] = 1; });
        const peers = (await D1.prepare('SELECT CASE WHEN a = ?1 THEN b ELSE a END AS o FROM talks WHERE a = ?1 OR b = ?1 UNION SELECT CASE WHEN a = ?1 THEN b ELSE a END AS o FROM dms WHERE a = ?1 OR b = ?1').bind(uid).all()).results || [];
        for (const x of peers) {
          const p = await D1.prepare('SELECT pid, alias, member, points FROM people WHERE uid = ?1').bind(x.o).first();
          if (!p || have[p.pid]) continue;
          const pr = v2Pair(uid, x.o);
          const last = await D1.prepare('SELECT uid, body, at FROM dms WHERE a = ?1 AND b = ?2 ORDER BY id DESC LIMIT 1').bind(pr[0], pr[1]).first();
          const un = await D1.prepare('SELECT COUNT(*) AS n FROM dms WHERE a = ?1 AND b = ?2 AND uid != ?3 AND seen = 0').bind(pr[0], pr[1], uid).first();
          (j.threads = j.threads || []).push({ pid: p.pid, alias: p.alias, member: !!p.member, points: sqParse(p.points), last: last ? last.body : '', mine: last ? last.uid === uid : false, at: last ? last.at : 0, unread: un ? un.n : 0, bonded: false, talks: true });
        }
        const blp = {}; for (const k in bl) { const q = await D1.prepare('SELECT pid FROM people WHERE uid = ?1').bind(k).first(); if (q) blp[q.pid] = 1; }
        j.threads = (j.threads || []).filter(function (x) { return !blp[x.pid]; }).sort(function (x, y) { return y.at - x.at; });
        return apiJson(req, j);
      }
      const t = await D1.prepare('SELECT uid, alias, member, points, pid FROM people WHERE pid = ?1').bind(String(body.pid || '')).first();
      if (!t || String(t.uid) === uid) return apiJson(req, { ok: false, error: 'Not found.' }, 404);
      const ok = await v2CanDm(env, uid, String(t.uid));
      if (!ok) {
        if (await v2Blocked(env, uid, String(t.uid))) return apiJson(req, { ok: false, error: 'You can’t write to them.' }, 403);
        return v2HApi1(req, path, env, body, me, r, room, now);
      }
      const pr = v2Pair(uid, String(t.uid));
      if (path === '/api/sq/h/dm/thread') {
        const after = Math.max(0, Math.floor(Number(body.after) || 0));
        const ms = (await D1.prepare('SELECT id, uid, body, at FROM dms WHERE a = ?1 AND b = ?2 AND id > ?3 ORDER BY id DESC LIMIT 100').bind(pr[0], pr[1], after).all()).results || [];
        ms.reverse();
        await D1.prepare('UPDATE dms SET seen = 1 WHERE a = ?1 AND b = ?2 AND uid != ?3 AND seen = 0').bind(pr[0], pr[1], uid).run();
        const bd = await D1.prepare("SELECT 1 FROM bonds WHERE ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)) AND status = 'bonded'").bind(uid, String(t.uid)).first();
        return apiJson(req, { ok: true, bonded: !!bd, talks: !bd, peer: { pid: t.pid, alias: t.alias, member: !!t.member, points: sqParse(t.points) }, msgs: ms.map(function (m) { return { id: m.id, body: m.body, at: m.at, mine: String(m.uid) === uid }; }) });
      }
      const text = String(body.text || '').trim().slice(0, 20000);
      if (!text) return apiJson(req, { ok: false, error: 'Say something first.' }, 400);
      const last = await D1.prepare('SELECT at FROM dms WHERE uid = ?1 ORDER BY id DESC LIMIT 1').bind(uid).first();
      if (last && t0 - last.at < 800) return apiJson(req, { ok: false, error: 'A breath between messages, love.' }, 429);
      const ins = await D1.prepare('INSERT INTO dms (a, b, uid, body, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(pr[0], pr[1], uid, text, t0).run();
      try {
        const pres = await D1.prepare('SELECT seen FROM presence WHERE uid = ?1').bind(t.uid).first();
        const note = await D1.prepare('SELECT at FROM dmnote WHERE to_uid = ?1 AND from_uid = ?2').bind(t.uid, uid).first();
        if ((!pres || t0 - pres.seen > 120000) && (!note || t0 - note.at > 600000) && !(await hQuiet(env, t.uid))) {
          await D1.prepare('INSERT OR REPLACE INTO dmnote (to_uid, from_uid, at) VALUES (?1, ?2, ?3)').bind(t.uid, uid, t0).run();
          await say(env, t.uid, '✦ ' + ((r && r.alias) || 'Someone') + ' wrote to you.', [[{ text: 'Open messages', url: SQ_APP + '#dm' }]]);
        }
      } catch (e) {}
      return apiJson(req, { ok: true, id: ins.meta.last_row_id });
    } catch (e) { return apiJson(req, { ok: false, error: 'Something went wrong.' }, 500); }
  }
  return v2HApi1(req, path, env, body, me, r, room, now);
};


/* v2 extras: fixed places get real circles anyone may sit at; stars carry who is there and what was just said; me, met, unbond. */
async function v2Fixed(env) {
  const have = (await env.D1.prepare("SELECT uid, cid FROM owned WHERE uid LIKE 'fixed:%'").all()).results || [];
  if (have.length >= V2_FIXED.length) return;
  const got = {}; have.forEach(function (h) { got[h.uid] = 1; });
  const now = Date.now();
  for (const f of V2_FIXED) {
    const key = 'fixed:' + f.name; if (got[key]) continue;
    const c = await env.D1.prepare("INSERT INTO circles (room, vibe, topic, hushed, cap, welcome, at, last) VALUES ('', 'salon', ?1, 0, 50, 1, ?2, ?2)").bind(f.name, now).run();
    await env.D1.prepare('INSERT OR IGNORE INTO owned (cid, uid, wx, wy, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(c.meta.last_row_id, key, f.x, f.y, now).run();
  }
}
const v2Api0 = v2Api;
v2Api = async function (req, path, env, body, user, id, r) {
  await v2Ready(env);
  const me = String(id), p = path.slice('/api/sq/v2/'.length), b = body || {}, now = Date.now();
  const J = function (o, s) { return apiJson(req, o, s); };
  if (p === 'me') {
    const m = await v2Person(env, me); if (!m) return J({ ok: false, error: 'Please register first.' }, 403);
    const own = await env.D1.prepare('SELECT cid FROM owned WHERE uid = ?1').bind(me).first();
    const seat = await env.D1.prepare('SELECT cid FROM seats WHERE uid = ?1').bind(me).first();
    return J({ ok: true, pid: m.pid, alias: m.alias, room: m.room || '', member: !!m.member, temple: v2Temple(m), since: m.since || '', star: own ? own.cid : 0, cid: seat ? seat.cid : 0 });
  }
  if (p === 'unbond') {
    const o = await v2ByPid(env, b.pid); if (!o) return J({ ok: false });
    await env.D1.prepare('DELETE FROM bonds WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)').bind(me, String(o.uid)).run();
    return J({ ok: true });
  }
  if (p === 'met') {
    const rows = (await env.D1.prepare('SELECT m.at, m.cid, p.pid, p.alias, p.temples, p.since, c.topic, (SELECT q.alias FROM owned o JOIN people q ON q.uid = o.uid WHERE o.cid = m.cid) AS owner FROM met m JOIN people p ON p.uid = (CASE WHEN m.a = ?1 THEN m.b ELSE m.a END) LEFT JOIN circles c ON c.id = m.cid WHERE (m.a = ?1 OR m.b = ?1) ORDER BY m.at DESC LIMIT 100').bind(me).all()).results || [];
    return J({ ok: true, met: rows.map(function (x) { return { pid: x.pid, alias: x.alias, temple: v2Temple(x), since: x.since || '', at: x.at, where: x.owner ? x.owner + '’s star' : (x.topic || 'a star') }; }) });
  }
  if (p === 'sl/say') {
    const m = await v2Person(env, me); const text = String(b.text || '').trim().slice(0, 2000); if (!m || !text) return J({ ok: false });
    try { await slForward(env, 'Member', m.alias || 'Member', text, 'tg:' + me); } catch (e) {}
    return J({ ok: true });
  }
  if (p === 'req/send') {
    const to = await v2ByPid(env, b.pid);
    if (to) { const pr = v2Pair(me, String(to.uid)); const met = await env.D1.prepare('SELECT 1 FROM met WHERE a = ?1 AND b = ?2').bind(pr[0], pr[1]).first();
      if (!met) { const lk = await env.D1.prepare('SELECT 1 FROM looks WHERE uid = ?1').bind(String(to.uid)).first(); if (lk) await env.D1.prepare('INSERT OR IGNORE INTO met (a, b, at, cid) VALUES (?1, ?2, ?3, 0)').bind(pr[0], pr[1], now).run(); } }
    return v2Api0(req, path, env, body, user, id, r);
  }
  if (p === 'stars') {
    await v2Fixed(env);
    try { const pm = await v2Person(env, me); if (pm) await env.D1.prepare('INSERT INTO presence (uid, room, vibe, near, seen, since) VALUES (?1, ?2, ?3, 0, ?4, ?4) ON CONFLICT (uid) DO UPDATE SET room = ?2, seen = ?4').bind(me, pm.room || '', 'all', now).run(); } catch (e) {}
    const res = await v2Api0(req, path, env, body, user, id, r);
    let j; try { j = await res.clone().json(); } catch (e) { return res; }
    if (!j || !j.ok) return res;
    const fx = {}; ((await env.D1.prepare("SELECT uid, cid FROM owned WHERE uid LIKE 'fixed:%'").all()).results || []).forEach(function (x) { fx[x.cid] = x.uid.slice(6); });
    const seats = (await env.D1.prepare('SELECT s.cid, s.uid, p.pid, p.alias FROM seats s JOIN people p ON p.uid = s.uid JOIN presence x ON x.uid = s.uid WHERE x.seen > ?1 ORDER BY s.at').bind(now - 90000).all()).results || [];
    const heard = {}; ((await env.D1.prepare('SELECT l.cid, l.body, p.alias FROM lines l JOIN people p ON p.uid = l.uid WHERE l.at > ?1 ORDER BY l.id DESC LIMIT 400').bind(now - 900000).all()).results || []).forEach(function (l) { const a = heard[l.cid] = heard[l.cid] || []; if (a.length < 2) a.unshift({ alias: l.alias, body: String(l.body || '').slice(0, 90) }); });
    const talk = {}; ((await env.D1.prepare('SELECT cid, COUNT(*) AS n FROM lines WHERE at > ?1 GROUP BY cid').bind(now - 180000).all()).results || []).forEach(function (x) { talk[x.cid] = x.n; });
    const bset = {}; ((await env.D1.prepare("SELECT CASE WHEN a = ?1 THEN b ELSE a END AS u FROM bonds WHERE (a = ?1 OR b = ?1) AND status = 'bonded'").bind(me).all()).results || []).forEach(function (x) { bset[x.u] = 1; });
    const mySeat = await env.D1.prepare('SELECT cid FROM seats WHERE uid = ?1').bind(me).first();
    j.cid = mySeat ? mySeat.cid : 0;
    j.stars.forEach(function (s) {
      if (fx[s.cid]) { s.fixed = fx[s.cid]; delete s.alias; delete s.pid; }
      if (s.veiled) return;
      const ps = seats.filter(function (x) { return x.cid === s.cid; });
      s.people = ps.map(function (x) { return { pid: x.pid, alias: x.alias, me: String(x.uid) === me, known: !!bset[x.uid] }; });
      s.heard = s.hushed ? [] : (heard[s.cid] || []); s.talk = talk[s.cid] || 0;
    });
    const live = await env.D1.prepare('SELECT COUNT(*) AS n FROM presence WHERE seen > ?1').bind(now - 30000).first();
    j.here = (live && live.n) || 0;
    return J(j);
  }
  return v2Api0(req, path, env, body, user, id, r);
};

const dyMainExport = dyMain;
export default {
  ...dyMainExport,
  async fetch(req, env, ctx) {
    const p = new URL(req.url).pathname;
    if (p === '/starlove' || p === '/starlove/' || p.indexOf('/api/god/') === 0) {
      try { return await godFetch(req, env); } catch (e) { return godJson({ ok: false, error: 'Something went wrong.' }, 500); }
    }
    try { await v2Ready(env); } catch (e) {}
    return dyMain.fetch(req, env, ctx);
  },
  async scheduled(ev, env, ctx) { try { await v2Ready(env); } catch (e) {} if (dyMain.scheduled) await dyMain.scheduled(ev, env, ctx); try { await v2Drift(env); } catch (e) {} },
};
