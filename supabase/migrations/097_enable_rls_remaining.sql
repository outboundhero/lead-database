-- 097: enable RLS on the 8 remaining public tables that had it off.
--
-- Audit 2026-09-09. Access paths per table:
--   api_logs                 browser SELECT (api-keys page)  -> authenticated-read policy
--   audit_logs               browser SELECT (admin page)     -> authenticated-read policy
--   dashboard_top_job_titles server-only (admin client / SECURITY DEFINER fns)
--   filter_presets           server-only (/api/filters/presets uses the admin client)
--   freemail_domains         server-only (SECURITY DEFINER filter fns)
--   lead_job_titles          server-only (admin client + SECURITY DEFINER fns)
--   validation_jobs          server-only (exports routes use the admin client)
--   worker_locks             scripts only (DATABASE_URL = table owner)
--
-- The service-role client bypasses RLS and the postgres role owns the tables
-- (RLS is not FORCEd), so nothing server-side changes behaviour. What this
-- closes: any authenticated browser session could previously read AND WRITE
-- all 8 tables straight through PostgREST — including worker_locks (parks the
-- categorize worker) and audit/api logs (tamperable). Now the two log tables
-- are readable (the pages that list them), and everything else is default-deny
-- outside the server.

BEGIN;

ALTER TABLE api_logs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_top_job_titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE filter_presets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE freemail_domains         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_job_titles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_jobs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_locks             ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read api logs" ON api_logs;
CREATE POLICY "Authenticated read api logs" ON api_logs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated read audit logs" ON audit_logs;
CREATE POLICY "Authenticated read audit logs" ON audit_logs
  FOR SELECT TO authenticated USING (true);

COMMIT;

NOTIFY pgrst, 'reload schema';
