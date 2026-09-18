-- 104: partial GIN indexes for the multi-location predicate surface (see 103).
--
-- ⚠ CREATE INDEX CONCURRENTLY CANNOT RUN INSIDE A TRANSACTION BLOCK. Apply
-- this file statement by statement (psql -f, or one statement per query),
-- never wrapped in BEGIN/COMMIT. Each is instant today: every alt_* column is
-- NULL on all ~9M rows, so the partial indexes start empty and grow only with
-- multi-location leads. If a build is interrupted, drop the INVALID index:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_alt_location_ids
  ON leads USING gin (alt_location_ids) WHERE alt_location_ids IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_alt_state_keys
  ON leads USING gin (alt_state_keys) WHERE alt_state_keys IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_alt_cities
  ON leads USING gin (alt_cities) WHERE alt_cities IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_alt_states
  ON leads USING gin (alt_states) WHERE alt_states IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_alt_location_text
  ON leads USING gin (alt_location_text gin_trgm_ops) WHERE alt_location_text IS NOT NULL;
