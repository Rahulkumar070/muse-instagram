CREATE TABLE IF NOT EXISTS conversations (
  igsid TEXT PRIMARY KEY,               -- Instagram-scoped ID of the customer
  username TEXT,
  name TEXT,
  last_text TEXT,
  last_message_at INTEGER,
  last_user_message_at INTEGER,         -- starts Instagram's 24-hour reply window
  paused_until INTEGER NOT NULL DEFAULT 0,
  needs_human INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  igsid TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'bot', 'owner', 'muse')),
  text TEXT NOT NULL,
  mid TEXT UNIQUE,                      -- Instagram message ID, used to drop duplicate webhooks
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (igsid, id);

CREATE TABLE IF NOT EXISTS leads (
  igsid TEXT PRIMARY KEY,
  name TEXT,
  contact TEXT,
  project_type TEXT,
  budget TEXT,
  timeline TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comment_replies (
  comment_id TEXT PRIMARY KEY,
  igsid TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
