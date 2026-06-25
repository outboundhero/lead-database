-- 046_export_jobs_duration_seconds.sql
-- export_jobs was missing the duration_seconds column that the export code
-- writes on completion (stream route, log 'complete' action, process route).
-- Supabase's .update() does NOT throw on an unknown column -- it returns an
-- error object the code ignores -- so the completion update silently affected
-- 0 rows and jobs stayed stuck on 'processing' forever even though the CSV
-- downloaded fine. The column exists in the original Renaissance DB but was
-- added ad-hoc (never captured as a migration), so it never carried over to
-- this project.
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
