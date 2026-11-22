CREATE TABLE IF NOT EXISTS fileexpress_objects (id TEXT PRIMARY KEY, name TEXT NOT NULL, size BIGINT NOT NULL, mime_type TEXT NOT NULL, checksum TEXT NOT NULL, tenant_id TEXT, owner_id TEXT, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, metadata JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS fileexpress_audit (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, payload JSONB NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS fileexpress_audit_tenant_idx ON fileexpress_audit(tenant_id, created_at);
-- @down
DROP TABLE IF EXISTS fileexpress_audit;
DROP TABLE IF EXISTS fileexpress_objects CASCADE;
