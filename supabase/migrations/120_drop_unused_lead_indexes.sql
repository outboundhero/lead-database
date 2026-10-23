-- 120: drop three unused indexes on leads (APPLIED 2026-10-23 ~19:10 UTC, by
-- hand, one statement at a time — reclaims ~1.26 GB; leads indexes 10.7 -> 9.45 GB).
--
-- WHY: the database is 45 GB on a 16 GB XL instance, and leads carried 46
-- indexes that every import and update must maintain. pg_stat_user_indexes
-- showed 0 scans for these since the server started on 2026-08-06 (2.5 months;
-- migrations 082/083 kept them on an 18-day window):
--
--   idx_leads_bison_lead_id    (330 MB) no code reads leads by bison_lead_id —
--                              only imports WRITE it (scripts/import-bison-*.mjs,
--                              src/lib/uploads/parse-bison.ts), which the index
--                              only made slower.
--   idx_leads_first_name_trgm  (547 MB) GIN trigram — the only filter that can
--   idx_leads_last_name_trgm   (384 MB) use them is "full name"
--                              (first_name ILIKE … OR last_name ILIKE …), unused
--                              in that window. globalSearch cannot: it ORs in
--                              email and domain, which have no trigram index, so
--                              the planner never had a BitmapOr. GIN upkeep on
--                              every lead insert/update was the cost.
--
-- Effect: a "full name" search now scans instead of using an index (seconds,
-- like the other unindexed text filters). Rows are unchanged.
--
-- KEPT although it also showed 0 scans: idx_leads_category_pending — the
-- categorize-worker's daily "leads with no category and no company" query
-- (scripts/categorize-worker.mjs, step 5) needs it; the worker was crashing,
-- which is why the index looked unused.
--
-- TO RESTORE, run the matching statement (CONCURRENTLY: nothing is blocked;
-- not inside a transaction block; the GIN builds take several minutes):
--   CREATE INDEX CONCURRENTLY idx_leads_bison_lead_id ON public.leads USING btree (bison_lead_id) WHERE (bison_lead_id IS NOT NULL);
--   CREATE INDEX CONCURRENTLY idx_leads_first_name_trgm ON public.leads USING gin (first_name gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY idx_leads_last_name_trgm ON public.leads USING gin (last_name gin_trgm_ops);

DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_bison_lead_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_first_name_trgm;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_last_name_trgm;
