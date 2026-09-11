-- 098: partial index for the location worker's pending cohort.
--
-- WHY. `backfill-lead-locations.mjs` walks leads that still need geo resolution
-- with keyset pagination:
--
--   SELECT id, city, state FROM leads
--    WHERE state IS NOT NULL AND length(btrim(state)) = 2   -- (pass 1)
--      AND state_code IS NULL AND id > $1
--    ORDER BY id LIMIT 5000
--
-- Nothing indexed that cohort, so the planner chose a parallel scan of the WHOLE
-- primary key (cost 1,056,401) and filtered 8.7M rows to find sparse matches.
-- That is fine when the backlog is dense — right after a big import most rows
-- match early — and fatal when it is sparse: on 2026-09-11 pass 1 had only
-- 11,495 rows to find and the query stopped completing, crashing the
-- location-worker cron on every 30-minute run.
--
-- The existing state/location indexes are all `WHERE ... IS NOT NULL`, i.e. they
-- index rows that are already RESOLVED. This one indexes exactly the rows that
-- are NOT, which is the set the worker actually looks for.
--
-- It is self-draining, like idx_bison_leads_pending_import: resolving a lead
-- sets state_code, which removes the row from the index. At the 2026-09-11
-- measurement the cohort was 386,153 rows (11,495 pass 1 / 365,766 pass 1b) and
-- shrinks toward zero as the worker catches up, so this stays small — which
-- matters on a table already carrying 40 indexes where every non-HOT update
-- rewrites all of them.
--
-- ⚠ CREATE INDEX CONCURRENTLY CANNOT RUN INSIDE A TRANSACTION BLOCK. Apply this
-- file with `psql -f`, never wrapped in BEGIN/COMMIT. If it is interrupted it
-- leaves an INVALID index behind — check and drop:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--
-- Revert: DROP INDEX CONCURRENTLY IF EXISTS idx_leads_location_pending;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_location_pending
  ON leads (id)
  WHERE state IS NOT NULL AND state_code IS NULL;
