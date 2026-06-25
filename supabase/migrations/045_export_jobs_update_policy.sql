-- 045_export_jobs_update_policy.sql
-- export_jobs had RLS enabled with only INSERT + SELECT policies and NO UPDATE
-- policy. With RLS on and no permissive UPDATE policy, every client-side update
-- is silently denied (0 rows, no error) -- which broke BOTH the Cancel button
-- and the orphaned-job auto-timeout in exports/page.tsx, so jobs stuck in
-- 'processing' could never be cleared from the UI. (Server routes update via the
-- service-role client, which bypasses RLS, so normal completion still worked.)
-- Mirror the SELECT policy: a user can update/delete their own export jobs;
-- owners/admins can update/delete any.

DROP POLICY IF EXISTS export_jobs_update ON export_jobs;
CREATE POLICY export_jobs_update ON export_jobs
  FOR UPDATE
  USING ((requested_by = auth.uid()) OR (get_user_role() = ANY (ARRAY['owner','admin'])))
  WITH CHECK ((requested_by = auth.uid()) OR (get_user_role() = ANY (ARRAY['owner','admin'])));

DROP POLICY IF EXISTS export_jobs_delete ON export_jobs;
CREATE POLICY export_jobs_delete ON export_jobs
  FOR DELETE
  USING ((requested_by = auth.uid()) OR (get_user_role() = ANY (ARRAY['owner','admin'])));
