PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source_label TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  token_hint TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notifications_enabled IN (0, 1)),
  notify_started INTEGER NOT NULL DEFAULT 0 CHECK (notify_started IN (0, 1)),
  notify_progress INTEGER NOT NULL DEFAULT 0 CHECK (notify_progress IN (0, 1)),
  notify_completed INTEGER NOT NULL DEFAULT 1 CHECK (notify_completed IN (0, 1)),
  notify_failed INTEGER NOT NULL DEFAULT 1 CHECK (notify_failed IN (0, 1)),
  notify_canceled INTEGER NOT NULL DEFAULT 1 CHECK (notify_canceled IN (0, 1)),
  minimum_duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (minimum_duration_seconds BETWEEN 0 AND 604800),
  dedupe_window_seconds INTEGER NOT NULL DEFAULT 120 CHECK (dedupe_window_seconds BETWEEN 0 AND 86400),
  include_full_content INTEGER NOT NULL DEFAULT 1 CHECK (include_full_content IN (0, 1)),
  max_content_length INTEGER NOT NULL DEFAULT 5000 CHECK (max_content_length BETWEEN 100 AND 5000),
  muted_projects TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agents_token_hash ON agents(token_hash);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(active, updated_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project TEXT,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'progress', 'completed', 'failed', 'canceled')),
  progress INTEGER CHECK (progress IS NULL OR progress BETWEEN 0 AND 100),
  started_at INTEGER,
  finished_at INTEGER,
  last_event_id TEXT NOT NULL,
  last_event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, agent_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_agent_updated ON tasks(agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_state_updated ON tasks(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'progress', 'completed', 'failed', 'canceled')),
  progress INTEGER CHECK (progress IS NULL OR progress BETWEEN 0 AND 100),
  project TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  result TEXT NOT NULL,
  source TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  fingerprint TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('suppressed', 'pending', 'queued', 'delivering', 'retry_scheduled', 'delivered', 'failed', 'enqueue_failed')),
  suppression_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  huawei_code TEXT,
  huawei_description TEXT,
  last_error TEXT,
  queued_at INTEGER,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_id, agent_id) REFERENCES tasks(id, agent_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_events_task_created ON events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_agent_created ON events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status_created ON events(delivery_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON events(agent_id, fingerprint, created_at DESC);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  queue_message_id TEXT,
  attempt_number INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'delivered', 'retry', 'failed', 'dead_letter')),
  http_status INTEGER,
  huawei_code TEXT,
  description TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX IF NOT EXISTS idx_attempts_event_created ON delivery_attempts(event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at DESC);
