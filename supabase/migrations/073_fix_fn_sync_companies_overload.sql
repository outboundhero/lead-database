-- 073: remove the duplicate fn_sync_companies() overload.
--
-- PROBLEM
-- Migration 049 created  fn_sync_companies()                              [0 args]
-- Migration 050 created  fn_sync_companies(p_propagate_limit int = NULL)  [1 arg]
--
-- CREATE OR REPLACE FUNCTION only replaces when the SIGNATURE matches, so 050
-- added a second overload rather than replacing the first, and nothing ever
-- dropped the original. A no-argument call then matches BOTH candidates (the
-- 1-arg one via its DEFAULT), and Postgres refuses:
--
--   ERROR:  function fn_sync_companies() is not unique          (SQLSTATE 42725)
--   HINT:   Could not choose a best candidate function.
--
-- Two production callers pass no arguments and were failing:
--   * scripts/categorize-worker.mjs:368   -> crash-loops at step 1
--   * src/app/api/uploads/process/route.ts:303 -> fails SILENTLY (the error is
--     only console.error'd, so CSV uploads reported success while never
--     syncing companies or propagating categories)
-- The two importers pass p_propagate_limit explicitly and were unaffected.
--
-- WHY DROPPING THE 0-ARG VERSION IS A NO-OP
-- The 050 body is the 049 body with the propagation UPDATE wrapped in
--   IF p_propagate_limit IS NULL THEN <verbatim 049 UPDATE> ELSE <batched> END IF
-- so fn_sync_companies(NULL) executes byte-identical SQL to fn_sync_companies().
-- Verified by diffing the two bodies and by running each version alone against
-- identical seed data: same return values, same resulting rows.
--
-- The empty argument list below is required. `DROP FUNCTION fn_sync_companies;`
-- without it is itself ambiguous and errors.
--
-- SAFE UNDER A FULL MIGRATION RE-RUN. Re-applying every file in filename order
-- recreates the 0-arg overload at 049, then this file drops it again at 073.
-- (A wholesale re-run is the most likely way the duplicate appeared in the
-- first place.) IF EXISTS makes it a no-op when already applied.
--
-- Touches no rows in leads or companies; takes no table locks. Rollback, if
-- ever needed, is simply re-running the CREATE in migration 049.

DROP FUNCTION IF EXISTS public.fn_sync_companies();

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE p.proname = 'fn_sync_companies' AND ns.nspname = 'public';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 fn_sync_companies after this migration, found %', n;
  END IF;
  RAISE NOTICE '073: fn_sync_companies is now unambiguous (1 definition)';
END $$;
