-- Migration 051: indexes for ILIKE search + deterministic sort (F14, F03, F66).
-- Run OUTSIDE a transaction (CONCURRENTLY) so the 2.4M-row table stays writable
-- during the build. Apply with: psql "$DATABASE_URL" -f 051_search_sort_indexes.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_first_name_trgm ON leads USING gin (first_name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_last_name_trgm  ON leads USING gin (last_name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_city_trgm       ON leads USING gin (city gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_gen_ind_trgm    ON leads USING gin (general_industry gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_spec_ind_trgm   ON leads USING gin (specific_industry gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_overview_trgm   ON leads USING gin (company_overview gin_trgm_ops);
-- Composite for the default view's ORDER BY created_at DESC, id DESC.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_created_id ON leads (created_at DESC, id DESC);
