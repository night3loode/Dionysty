-- Staging only: aliases of people who have used circles on the lab.
CREATE TABLE IF NOT EXISTS c_people (
  pid      TEXT PRIMARY KEY,
  alias    TEXT NOT NULL,
  temple   TEXT,
  seen_at  INTEGER NOT NULL
);
