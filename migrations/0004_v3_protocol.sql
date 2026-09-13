ALTER TABLE events_v3 ADD COLUMN trace_id TEXT;
ALTER TABLE events_v3 ADD COLUMN ingress TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_events_v3_trace ON events_v3(trace_id);
CREATE INDEX IF NOT EXISTS idx_events_v3_ingress ON events_v3(ingress, received_at DESC);

INSERT INTO agents_v3
  (id, display_name, source_label, active, policy_json, created_at, updated_at)
SELECT id, display_name, source_label, active, '{}', created_at, updated_at
FROM agents
WHERE 1
ON CONFLICT(id) DO NOTHING;

INSERT INTO credentials
  (id, agent_id, kind, secret_hash, hint, scopes, active, created_at, last_used_at)
SELECT 'credential:legacy:' || id, id, 'token', token_hash, token_hint, '["push:write"]', active,
       created_at, last_seen_at
FROM agents
WHERE token_hash IS NOT NULL
ON CONFLICT(id) DO NOTHING;
