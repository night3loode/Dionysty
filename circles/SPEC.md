# Circles, Stars and Starlight: product rules

Decisions marked DECIDED come from Dhairya. OPEN items run on the default shown (each is a Worker var) until he decides.

## Words
- **Circle**: people talking together, live. Lasts while anyone is inside.
- **Star**: what a well-loved circle leaves behind: its name, theme, Temple and one chosen line. Dims over time.
- **Starlight**: a free gesture anyone can give, like a like or a Discord boost. Never earned, never bought, never given to people.

Note: the app today calls its live conversations "stars". The new feature uses "circle" for those and keeps "star" for what a circle leaves behind.

## Circles (DECIDED)
- Anyone can start a circle anywhere: open sky, a Temple room, or around a star.
- The founder is whoever starts it. The role never transfers.
- Modes, chosen at the start and changeable any time by the founder: **Open** (come straight in), **Knock** (knock, someone lets you in), **Invite only** (only invited people).
- Invitations work in every mode. In Open circles anyone inside can invite. In Knock and Invite only circles only the founder invites directly; anyone else's invitation becomes a knock on the invitee's behalf ("Bilal wants to bring Chandni"), which must be answered.
- The founder answers knocks. If the founder has been inactive for 2 minutes, anyone inside can answer. When the founder is back, it returns to them.
- Invite only circles appear in the sky showing only their name and theme. Nothing about who is inside.
- Presence only: you are in a circle while you are in the app. Moving between screens keeps you in. Leaving the app removes you after a 2 minute grace.
- One circle at a time per person.
- When the last person leaves, the circle disperses.

## Starlight and stars
- DECIDED: enough Starlight turns a circle into a star when it disperses. Otherwise it disappears and everything said in it is deleted.
- OPEN, defaults: 5 Starlight per person per day (resets at midnight India time), at most 3 to the same circle or star per day, a star needs 10 light from at least 5 different people.
- Only people who were inside a circle can give it light. Anyone can give light to a star.
- The chosen line: anyone inside can keep one message as the circle's line; the founder can replace it.
- A star shows name, theme, Temple, its line and brightness. Never who was there. Only people who were in the circle can read what was said.
- DECIDED: stars dim over time (OPEN default: 2 light a day). Starlight brightens them. A star that goes fully dim disappears, and its messages are deleted forever (hard delete).

## Temple rooms
- Built: seven rooms as places in the sky (plus "Open sky"). Circles can be started in a room and stars keep their room.
- Not built, proposals needing Dhairya's go-ahead per room: Artists, The Gallery (daily curated wall; members apply to show work). Thinkers, The Symposium (question a day, paired debates). Healers, The Hearth (asks and offers, tied to the Duty Board). Lovers, Introductions (hosted introductions, mutual yes only, no swiping). Wanderers, The Crossroads (trips with open seats, tied to Wayside). Revellers, The Courtyard (what's on tonight, host a night). Builders, The Forum (proposals and votes that become traditions).

## API (POST JSON to /api/sq/c/<action>, same sign-in as the app)
| Action | Body | Does |
|---|---|---|
| `sky` | | Circles (invite only ones masked), stars, my circle id, invitations, my knock, Starlight left |
| `new` | topic, name?, mode?, temple?, star_id?, wx?, wy? | Start a circle and enter it |
| `join` | id | Enter (open, invited, or let in). Otherwise `{knock:true}` or `{invite:true}` |
| `knock` | id | Knock on a Knock circle |
| `answer` | kid, yes | Founder, or anyone inside when the founder is idle |
| `invite` | pid | Direct invite, or a sponsored knock (see rules) |
| `decline` | id | Dismiss an invitation |
| `mode` | mode | Founder only |
| `say` | text | Up to 500 characters |
| `pin` | mid | Keep a message as the circle's line |
| `leave` | | Step out (the circle disperses if empty) |
| `light` | kind (circle or star), id | Give one Starlight |
| `star` | id | Star detail; messages only for people who were there |
| `people` | | Members who can be invited |
| `state` | after | My circle: members, new messages, knocks I can answer, light progress |

Every call also counts as presence. Sweeps (presence, knock expiry, dimming, deletion) run on every call and on a 5 minute cron.

## Open decisions
| # | Question | Default |
|---|---|---|
| 1 | Do circles need names? | Optional name, required theme |
| 2 | Starlight per day | 5 |
| 3 | Per circle or star per day | 3 |
| 4 | What makes a star | 10 light from 5 people |
| 5 | How fast stars dim | 2 light a day |
| 6 | Seats per circle | 8 |
| 7 | Can former members "relight" a star with special rights? | No; anyone can start a circle around a star |
| 8 | Retire the app's existing circles once these are approved? | Both run side by side |
| 9 | Draw circles inside the main Space canvas | Follow-up; for now a Circles screen in the Space style |
| 10 | Each Temple room's ritual | Not built until approved |
