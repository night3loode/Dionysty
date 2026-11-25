-- Dionysty circles, stars and Starlight. Additive only: new tables, all prefixed c_.
-- Safe to apply to the live database: nothing existing is altered.

CREATE TABLE IF NOT EXISTS c_circles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  founder     TEXT    NOT NULL,
  name        TEXT,
  topic       TEXT    NOT NULL,
  temple      TEXT,
  star_id     INTEGER,
  mode        TEXT    NOT NULL DEFAULT 'open',   -- open | knock | invite
  cap         INTEGER NOT NULL DEFAULT 8,
  wx          REAL    NOT NULL DEFAULT 0,
  wy          REAL    NOT NULL DEFAULT 0,
  pinned      INTEGER,
  created_at  INTEGER NOT NULL
);

-- Who is inside right now. pid is the primary key: one circle at a time.
CREATE TABLE IF NOT EXISTS c_members (
  pid        TEXT    PRIMARY KEY,
  circle_id  INTEGER NOT NULL,
  joined_at  INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS c_members_circle ON c_members(circle_id);
CREATE INDEX IF NOT EXISTS c_members_seen   ON c_members(seen_at);

-- Everyone who was ever inside a circle. Kept while its star lives.
CREATE TABLE IF NOT EXISTS c_ever (
  circle_id  INTEGER NOT NULL,
  pid        TEXT    NOT NULL,
  PRIMARY KEY (circle_id, pid)
);

CREATE TABLE IF NOT EXISTS c_knocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id    INTEGER NOT NULL,
  pid          TEXT    NOT NULL,
  sponsor      TEXT,
  status       TEXT    NOT NULL DEFAULT 'waiting', -- waiting | in | no | expired | used
  created_at   INTEGER NOT NULL,
  answered_by  TEXT,
  answered_at  INTEGER
);
CREATE INDEX IF NOT EXISTS c_knocks_circle ON c_knocks(circle_id, status);
CREATE INDEX IF NOT EXISTS c_knocks_pid    ON c_knocks(pid, status);

CREATE TABLE IF NOT EXISTS c_invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id   INTEGER NOT NULL,
  from_pid    TEXT    NOT NULL,
  to_pid      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS c_invites_to ON c_invites(to_pid);

CREATE TABLE IF NOT EXISTS c_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id  INTEGER NOT NULL,
  pid        TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS c_messages_circle ON c_messages(circle_id, id);

CREATE TABLE IF NOT EXISTS c_light (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  giver   TEXT    NOT NULL,
  kind    TEXT    NOT NULL,   -- circle | star
  target  INTEGER NOT NULL,
  day     TEXT    NOT NULL,   -- YYYY-MM-DD in Asia/Kolkata
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS c_light_giver  ON c_light(giver, day);
CREATE INDEX IF NOT EXISTS c_light_target ON c_light(kind, target);

CREATE TABLE IF NOT EXISTS c_stars (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id   INTEGER NOT NULL,   -- the circle it came from; its messages and c_ever rows hang off this
  name        TEXT,
  topic       TEXT    NOT NULL,
  temple      TEXT,
  line        TEXT,
  wx          REAL    NOT NULL DEFAULT 0,
  wy          REAL    NOT NULL DEFAULT 0,
  light       REAL    NOT NULL,
  light_at    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
