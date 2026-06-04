-- Fix #3 (production issues May 2026):
-- The filter RPC does `WHERE LOWER(title) = ANY(...)` against lead_job_titles
-- (11.5M+ rows). The existing `idx_ljt_title` is a regular b-tree on `title` —
-- Postgres can't use it for the LOWER() expression, so it does a full table scan
-- and times out the page (especially when filtering by "CEO", "Owner", etc.).
--
-- Add a functional index on LOWER(title) so case-insensitive lookups can use
-- index scans.
--
-- IMPORTANT: This must be run with CREATE INDEX CONCURRENTLY to avoid locking
-- the table in production. CONCURRENTLY cannot run inside a transaction block,
-- so this CANNOT be pasted into the Supabase SQL editor (which wraps queries
-- in transactions). Run via psql against the pooler URL instead:
--
--   psql "$DATABASE_URL" -f supabase/migrations/021_index_lead_job_titles_lower.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ljt_title_lower
  ON lead_job_titles (LOWER(title));
