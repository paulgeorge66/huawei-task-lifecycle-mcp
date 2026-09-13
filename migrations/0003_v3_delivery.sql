ALTER TABLE agents_v3 ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'shadow'
  CHECK (delivery_mode IN ('shadow', 'v3'));

ALTER TABLE outbox ADD COLUMN enqueued_at INTEGER;
ALTER TABLE outbox ADD COLUMN completed_at INTEGER;

ALTER TABLE card_delivery_state ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE card_delivery_state ADD COLUMN last_provider_code TEXT;
ALTER TABLE card_delivery_state ADD COLUMN last_provider_description TEXT;

ALTER TABLE delivery_attempts_v3 ADD COLUMN description TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_v3_delivery_mode
  ON agents_v3(delivery_mode, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_task_state
  ON outbox(task_id, state, target_revision DESC);
