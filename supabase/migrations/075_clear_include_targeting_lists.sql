-- 075: empty client_targeting.include_industries / include_keywords.
--
-- Client request (2026-08-18): these two lists should be blank by default and
-- only ever set by hand in the Rules dialog. Before this they were populated by
-- the AI passes in scripts/sync-client-targeting-from-sheet.mjs from onboarding
-- sheet column L — 177 clients had include_industries (960 entries) and 184 had
-- include_keywords (1,960 entries).
--
-- NEITHER GATES PUSHES. fn_client_eligibility_conditions deliberately ignores
-- the include side (see migration 067: many leads have no category yet, so
-- include-gating would silently block them all). What actually changes:
--   * include_keywords fed the Category-search filter when a client was selected
--     on the Leads page (src/app/(app)/leads/page.tsx -> categorySearchInclude).
--     Selecting a client no longer pre-fills those terms. Locations and the
--     exclusion filters still apply exactly as before.
--   * include_industries was display-only (the low-availability popup).
--
-- MUST SHIP WITH the sync-targeting change. The script now always writes '{}'
-- for both columns; without that change the next client-sync run (every 6h)
-- would repopulate them and undo this.
--
-- Columns are NOT NULL DEFAULT '{}', so no schema change is needed. Safe to
-- re-run. exclude_industries / exclude_keywords are untouched.

UPDATE client_targeting
   SET include_industries = '{}',
       include_keywords   = '{}',
       updated_at         = now()
 WHERE array_length(include_industries, 1) IS NOT NULL
    OR array_length(include_keywords, 1) IS NOT NULL;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM client_targeting
   WHERE array_length(include_industries, 1) IS NOT NULL
      OR array_length(include_keywords, 1) IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION '075: % client_targeting rows still have include lists', n;
  END IF;
  RAISE NOTICE '075: include_industries / include_keywords are empty for every client';
END $$;
