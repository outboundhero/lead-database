-- 082: drop nine provably-unusable indexes on `leads` (reclaims 1,448 MB).
--
-- WHY
--   leads heap    : 3,979 MB
--   leads indexes : 9,419 MB   <- 2.4x the data
--   shared_buffers: 4,096 MB
-- The indexes alone were more than double the available cache, so they evicted
-- each other constantly: heap cache hit 73%, index cache hit 89% (healthy is
-- >99%). Every INSERT/UPDATE also had to maintain all of them, which is why
-- imports and the mass category/location updates were so write-heavy.
--
-- HOW THESE WERE CHOSEN — pg_stat_user_indexes showed 23 indexes with
-- idx_scan = 0, and pg_stat_database.stats_reset is NULL, so "never used" is
-- since the database was created. But "never used" is NOT sufficient grounds to
-- drop: several cover filters that exist in the UI and simply have not been
-- exercised yet. Each candidate was EXPLAINed to see whether the planner would
-- use it if that feature were used.
--
-- KEPT despite zero scans, because EXPLAIN shows they WOULD be used:
--   idx_leads_seniority(_industry), idx_leads_country, idx_leads_company_size,
--   idx_leads_annual_revenue, idx_leads_first/last_name_trgm,
--   idx_leads_validated_at, idx_leads_category_pending, idx_leads_postal_code,
--   idx_leads_technologies, idx_leads_bison_lead_id, idx_leads_industry_size,
--   idx_leads_title_industry
--
-- DROPPED — each proven unusable or an exact duplicate:
--   idx_leads_email (500 MB)     duplicate of the UNIQUE leads_email_key; email
--                                lookups now use that instead (verified)
--   idx_leads_fullname_fts (169) full-text is never queried. The only function
--   idx_leads_company_fts  (154) mentioning to_tsvector is the legacy
--                                fn_filter_leads (v1) — 0 calls, no app
--                                references — and its expression differs from
--                                the indexed one, so it could not match anyway
--   idx_leads_city (135 MB)      city is filtered with ILIKE '%x%'; the planner
--                                uses idx_leads_city_trgm (2,490 scans)
--   idx_leads_website_domain(106) the website filter queries website/domain,
--                                not the website_domain column
--   idx_leads_source_title (99)  planner picks idx_leads_source instead
--   idx_leads_general_industry(95) filtered as LOWER(col) = LOWER(x), which a
--   idx_leads_specific_industry(95) plain btree cannot serve — EXPLAIN confirms
--                                Seq Scan even with the index present
--   idx_leads_job_title_normalized(95) titles are filtered through the
--                                lead_job_titles junction table
--
-- Applied with DROP INDEX CONCURRENTLY, one at a time, with no table lock and
-- nothing else running. Afterwards every query path was re-EXPLAINed: email,
-- city, name, seniority, country, company size, category, company lookup,
-- categorize worker and validation TTL all still use an index.
--
-- Also ran ANALYZE leads — planner statistics were 10 days stale.
--
-- TO RESTORE any of these, run its CREATE below (add CONCURRENTLY in production):
--
--   CREATE INDEX idx_leads_city ON public.leads USING btree (city);
--   CREATE INDEX idx_leads_company_fts ON public.leads USING gin (to_tsvector('english'::regconfig, COALESCE(company, ''::text)));
--   CREATE INDEX idx_leads_email ON public.leads USING btree (email);
--   CREATE INDEX idx_leads_fullname_fts ON public.leads USING gin (to_tsvector('english'::regconfig, ((COALESCE(first_name, ''::text) || ' '::text) || COALESCE(last_name, ''::text))));
--   CREATE INDEX idx_leads_general_industry ON public.leads USING btree (general_industry);
--   CREATE INDEX idx_leads_job_title_normalized ON public.leads USING btree (job_title_normalized);
--   CREATE INDEX idx_leads_source_title ON public.leads USING btree (source, job_title_normalized);
--   CREATE INDEX idx_leads_specific_industry ON public.leads USING btree (specific_industry);
--   CREATE INDEX idx_leads_website_domain ON public.leads USING btree (website_domain);
--
-- NB: DROP INDEX CONCURRENTLY cannot run inside a transaction block, so this
-- file must be applied with psql -f (which does not wrap it), never inside BEGIN.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_email;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_fullname_fts;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_company_fts;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_city;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_website_domain;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_source_title;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_general_industry;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_specific_industry;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_leads_job_title_normalized;

ANALYZE leads;
