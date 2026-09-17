-- 100: per-table autovacuum/analyze tuning for bison_leads (mirrors 084 for leads).
--
-- Measured 2026-09-16 (performance audit): bison_leads had 14.1M live rows,
-- 2.19M dead tuples, n_tup_upd 23.4M with only 20,523 HOT (0.09%), and NO
-- per-table settings, so it ran on the global defaults:
--
--   autovacuum_vacuum_scale_factor  0.2  -> vacuum only after ~2.82M dead rows
--   autovacuum_analyze_scale_factor 0.1  -> analyze only after ~1.4M changes
--
-- Every 3-day sync re-upserts millions of already-mirrored rows, and each
-- non-HOT update leaves a dead tuple and a stale entry in all 6 indexes. Letting
-- ~2.8M of those pile up before a vacuum is why the table's partial indexes
-- (pending_import 677 MB, cv_pending 242 MB) hold almost no live entries yet
-- stay large, and why the sync's claim scan grew from 46 ms to 6.7 s.
--
-- Same numbers as 084: vacuum at 5% (+10k) dead, analyze at 2% (+10k) changes.
-- More frequent, smaller autovacuum runs spread I/O instead of batching it.
--
-- ⚠ Because 2.19M dead already exceeds the new ~715k trigger, an autovacuum of
-- the 13 GB table starts within about a minute of this ALTER. Autovacuum is
-- cost-throttled, but apply this off-peak and watch Reports -> Database I/O.
-- The ALTER itself takes a brief ACCESS EXCLUSIVE lock (fails within the
-- 2-minute role timeout if a REINDEX CONCURRENTLY is running — wait it out).
--
-- Revert:
--   ALTER TABLE public.bison_leads RESET (
--     autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
--     autovacuum_analyze_scale_factor, autovacuum_analyze_threshold
--   );

ALTER TABLE public.bison_leads SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_vacuum_threshold     = 10000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold    = 10000
);
