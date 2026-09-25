-- SolarHisaab schema
-- Users sign in by email magic link. Meters (consumer IDs) belong to a user.
-- Each bill is one PDF in R2 plus its parsed data here.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  reminders     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  ip          TEXT
);
CREATE INDEX idx_login_tokens_email ON login_tokens(email, created_at);
CREATE INDEX idx_login_tokens_ip ON login_tokens(ip, created_at);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE meters (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consumer_id  TEXT NOT NULL,
  ref_no       TEXT,
  disco        TEXT,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (user_id, consumer_id)
);

CREATE TABLE bills (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meter_id      TEXT NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,              -- YYYY-MM
  r2_key        TEXT,                       -- null when added from QR text only
  file_name     TEXT,
  file_size     INTEGER,
  sha256        TEXT,
  disco         TEXT,
  imp_units     INTEGER,
  exp_units     INTEGER,
  net_units     INTEGER,
  current_bill  REAL,
  grand_total   REAL,
  issue_day     INTEGER,                    -- day of month the bill was issued, for reminders
  parsed_json   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (meter_id, month)
);
CREATE INDEX idx_bills_user ON bills(user_id, month);

CREATE TABLE reminder_log (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month    TEXT NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, month)
);
