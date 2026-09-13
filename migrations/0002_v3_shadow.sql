PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents_v3 (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source_label TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('token', 'oauth')),
  secret_hash TEXT,
  hint TEXT,
  oauth_client_id TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents_v3(id)
);

CREATE INDEX IF NOT EXISTS idx_credentials_agent ON credentials(agent_id, active);

CREATE TABLE IF NOT EXISTS client_instances (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  host_label TEXT,
  external_instance_id TEXT,
  last_seen_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (agent_id) REFERENCES agents_v3(id)
);

CREATE INDEX IF NOT EXISTS idx_client_instances_agent ON client_instances(agent_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS tasks_v3 (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  external_task_id TEXT NOT NULL,
  card_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('new', 'running', 'waiting', 'completed', 'failed', 'canceled')),
  current_run_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK (delivered_revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent_id, external_task_id),
  FOREIGN KEY (agent_id) REFERENCES agents_v3(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_v3_agent_state ON tasks_v3(agent_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  external_run_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'completed', 'failed', 'canceled')),
  terminal_event_id TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (task_id, external_run_id),
  FOREIGN KEY (task_id) REFERENCES tasks_v3(id)
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events_v3 (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'task.started', 'task.progress', 'task.waiting', 'task.completed',
    'task.failed', 'task.canceled', 'turn.completed', 'task.renamed'
  )),
  request_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('applied', 'observed', 'suppressed', 'stale')),
  suppression_reason TEXT,
  PRIMARY KEY (agent_id, id),
  UNIQUE (task_id, revision),
  FOREIGN KEY (agent_id) REFERENCES agents_v3(id),
  FOREIGN KEY (task_id) REFERENCES tasks_v3(id),
  FOREIGN KEY (run_id) REFERENCES task_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_events_v3_task ON events_v3(task_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_events_v3_received ON events_v3(received_at DESC);

CREATE TABLE IF NOT EXISTS card_projections (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  result TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  display_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, revision),
  FOREIGN KEY (task_id) REFERENCES tasks_v3(id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('shadowed', 'pending', 'enqueuing', 'enqueued', 'failed')),
  available_at INTEGER NOT NULL,
  enqueue_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (task_id, target_revision),
  FOREIGN KEY (task_id) REFERENCES tasks_v3(id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_dispatch ON outbox(state, available_at);

CREATE TABLE IF NOT EXISTS card_delivery_state (
  task_id TEXT PRIMARY KEY,
  desired_revision INTEGER NOT NULL DEFAULT 0,
  accepted_revision INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks_v3(id)
);

CREATE TABLE IF NOT EXISTS delivery_attempts_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_msg_id TEXT NOT NULL,
  batch_id TEXT,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  provider_code TEXT,
  latency_ms INTEGER,
  error_class TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks_v3(id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_v3_task ON delivery_attempts_v3(task_id, revision, attempt);
