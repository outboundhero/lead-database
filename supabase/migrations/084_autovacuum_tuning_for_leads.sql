-- 084: per-table autovacuum/analyze tuning for leads.
--
-- WHY: leads was running on the GLOBAL defaults, which are sized for small
-- tables and are far too lax at 8.2M rows:
--
--   autovacuum_vacuum_scale_factor  0.2  -> vacuum only after ~1,640,000 dead rows
--   autovacuum_analyze_scale_factor 0.1  -> analyze only after ~820,000 changes
--
-- Measured on 2026-08-19 before this change: last_autovacuum was 9 days old,
-- last_autoanalyze 10 days old, and only 6 autovacuums had ever run.
--
-- Two consequences, both of which we hit:
--
-- 1. BLOAT. leads has taken 7,330,903 updates of which only 758,585 were HOT,
--    so ~90% of updates rewrite every index entry (leads carries ~39 indexes —
--    this is the write amplification CLAUDE.md warns about). With vacuum
--    running that rarely, dead index entries accumulated: idx_leads_created_id
--    measured 46.8% bloat and leads_email_key 36.2%. Reclaiming that took the
--    leads index footprint from 7,971 MB to ~4.7 GB. Without this change the
--    bloat simply returns.
--
-- 2. BAD PLANS. Stale statistics make the planner misestimate selectivity. A
--    representative category+state filter estimated 1,288 rows against an
--    actual 3,906, which pushes it toward the wrong join/scan shape.
--
-- Both matter more than usual here because shared_buffers is only 4,096 MB
-- against a working set of roughly 13-15 GB: every MB of bloat is cache the
-- rest of the database does not get.
--
-- WHAT THIS CHANGES: thresholds only. No schema, no data, no index, no query
-- behaviour. Autovacuum simply runs more often and in smaller increments,
-- which is also GENTLER on the I/O budget than the rare, huge vacuums the
-- defaults produce.
--
--   vacuum:  0.2  -> 0.05  (~410,000 dead rows, was ~1,640,000)
--   analyze: 0.1  -> 0.02  (~164,000 changes,  was ~820,000)
--
-- Analyze is deliberately the more aggressive of the two: it samples rather
-- than scanning, so it is cheap, and plan quality is what users feel.
--
-- TO REVERT:
--   ALTER TABLE public.leads RESET (
--     autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
--     autovacuum_analyze_scale_factor, autovacuum_analyze_threshold
--   );

ALTER TABLE public.leads SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_vacuum_threshold     = 10000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold    = 10000
);

-- lead_history is append-heavy and nearly as large (8.04M rows); keeping its
-- statistics fresh is cheap and stops the planner drifting there too.
ALTER TABLE public.lead_history SET (
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_analyze_threshold    = 10000
);
