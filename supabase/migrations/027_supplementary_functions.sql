-- ============================================================================
-- 027_supplementary_functions.sql
-- ============================================================================
-- Captures database objects that were created DIRECTLY in the Supabase SQL
-- editor during development and never written to a migration file. Migrations
-- 001-026 therefore did NOT fully describe the database — running them alone
-- on a fresh project left the dashboard and filter-search features broken.
--
-- This file backfills the 4 known missing objects so a fresh database built
-- from 001 -> 027 is complete.
--
-- Sources were captured via `pg_get_functiondef()` from the live database.
--
-- NOTE: this is a best-effort capture of KNOWN gaps. After standing up a new
-- environment, smoke-test the dashboard + filter search; if something else is
-- still missing it was another un-migrated object and must be added here.
--
-- Order matters: the table is created before the functions that read/write it.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. dashboard_top_job_titles — single-row cache table (id is always 1) holding
--    the pre-aggregated top job titles as JSONB. Read by fn_dashboard_stats,
--    written by fn_refresh_top_job_titles.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_top_job_titles (
  id           INT PRIMARY KEY,
  data         JSONB NOT NULL DEFAULT '[]'::jsonb,
  refreshed_at TIMESTAMPTZ
);

INSERT INTO dashboard_top_job_titles (id, data)
VALUES (1, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;


-- ----------------------------------------------------------------------------
-- 2. Defensive: company_size_bucket column on leads.
--    fn_dashboard_stats groups by this column. It was also added directly via
--    the SQL editor in the original project, so it may be missing on a fresh
--    DB. ADD COLUMN IF NOT EXISTS is idempotent — no-op if already present.
-- ----------------------------------------------------------------------------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_size_bucket   TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS annual_revenue_bucket TEXT;


-- ----------------------------------------------------------------------------
-- 3. fn_dashboard_stats — full dashboard aggregation. Computes totals,
--    leads-by-industry, leads-by-company-size, time series; reads the
--    pre-computed top job titles from dashboard_top_job_titles; upserts the
--    result into dashboard_snapshots for the current date.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_dashboard_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_total_leads BIGINT;
  v_jt_data JSONB;
  v_jt_count INT;
  v_gi_data JSONB;
  v_gi_count INT;
  v_si_count INT;
  v_cs_data JSONB;
  v_time_data JSONB;
  v_result JSONB;
BEGIN
  SELECT reltuples::BIGINT INTO v_total_leads FROM pg_class WHERE relname = 'leads';

  SELECT COALESCE(array_length(options, 1), 0) INTO v_jt_count
  FROM filter_options_cache WHERE col_name = 'job_title';

  SELECT data INTO v_jt_data FROM dashboard_top_job_titles WHERE id = 1;

  SELECT COALESCE(array_length(options, 1), 0) INTO v_gi_count
  FROM filter_options_cache WHERE col_name = 'general_industry';

  -- Industries: no LIMIT — there are only ~153 distinct values, the dashboard
  -- chart scrolls so showing all is fine.
  SELECT jsonb_agg(row_to_json(t)) INTO v_gi_data FROM (
    SELECT INITCAP(LOWER(general_industry)) AS industry, COUNT(*) AS count
    FROM leads
    WHERE general_industry IS NOT NULL AND general_industry <> ''
    GROUP BY INITCAP(LOWER(general_industry))
    ORDER BY count DESC
  ) t;

  SELECT COALESCE(array_length(options, 1), 0) INTO v_si_count
  FROM filter_options_cache WHERE col_name = 'specific_industry';

  SELECT jsonb_agg(row_to_json(t)) INTO v_cs_data FROM (
    SELECT company_size_bucket AS size, COUNT(*) AS count
    FROM leads
    WHERE company_size_bucket IS NOT NULL
    GROUP BY company_size_bucket
    ORDER BY count DESC
  ) t;

  SELECT jsonb_agg(row_to_json(t)) INTO v_time_data FROM (
    SELECT TO_CHAR(created_at, 'YYYY-MM') AS date, COUNT(*) AS count
    FROM leads
    WHERE created_at >= now() - INTERVAL '12 months'
    GROUP BY 1 ORDER BY 1
  ) t;

  v_result := jsonb_build_object(
    'total_leads', v_total_leads,
    'total_job_titles', v_jt_count,
    'leads_by_job_title', COALESCE(v_jt_data, '[]'::jsonb),
    'total_general_industries', v_gi_count,
    'leads_by_general_industry', COALESCE(v_gi_data, '[]'::jsonb),
    'total_specific_industries', v_si_count,
    'leads_by_company_size', COALESCE(v_cs_data, '[]'::jsonb),
    'leads_over_time', COALESCE(v_time_data, '[]'::jsonb)
  );

  INSERT INTO dashboard_snapshots (
    snapshot_date, total_leads, total_job_titles, leads_by_job_title,
    total_general_industries, leads_by_general_industry, total_specific_industries,
    leads_by_company_size, leads_over_time
  ) VALUES (
    CURRENT_DATE, v_total_leads, v_jt_count, COALESCE(v_jt_data, '[]'::jsonb),
    v_gi_count, COALESCE(v_gi_data, '[]'::jsonb), v_si_count,
    COALESCE(v_cs_data, '[]'::jsonb), COALESCE(v_time_data, '[]'::jsonb)
  )
  ON CONFLICT (snapshot_date) DO UPDATE SET
    total_leads = EXCLUDED.total_leads,
    total_job_titles = EXCLUDED.total_job_titles,
    leads_by_job_title = EXCLUDED.leads_by_job_title,
    total_general_industries = EXCLUDED.total_general_industries,
    leads_by_general_industry = EXCLUDED.leads_by_general_industry,
    total_specific_industries = EXCLUDED.total_specific_industries,
    leads_by_company_size = EXCLUDED.leads_by_company_size,
    leads_over_time = EXCLUDED.leads_over_time;

  RETURN v_result;
END;
$function$;


-- ----------------------------------------------------------------------------
-- 4. search_column_values — typeahead search for filter dropdowns. Searches the
--    filter_options_cache first; for job_title uses the lead_job_titles
--    junction table; falls back to a direct DISTINCT scan of the column.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_column_values(col_name text, search_term text, max_results integer DEFAULT 50)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  result TEXT[];
BEGIN
  IF search_term IS NULL OR TRIM(search_term) = '' THEN
    SELECT options INTO result FROM filter_options_cache WHERE filter_options_cache.col_name = search_column_values.col_name;
    RETURN COALESCE(result, '{}');
  END IF;

  -- Job title: use the fast junction table
  IF col_name = 'job_title' THEN
    SELECT ARRAY(
      SELECT DISTINCT title
      FROM lead_job_titles
      WHERE title ILIKE '%' || search_term || '%'
      ORDER BY title
      LIMIT max_results
    ) INTO result;
    RETURN COALESCE(result, '{}');
  END IF;

  -- For other columns: search the cache first, fall back to DB
  SELECT ARRAY(
    SELECT unnest(options)
    FROM filter_options_cache
    WHERE filter_options_cache.col_name = search_column_values.col_name
  ) INTO result;

  IF result IS NOT NULL AND array_length(result, 1) > 0 THEN
    -- Filter cached values
    SELECT ARRAY(
      SELECT v FROM unnest(result) AS v
      WHERE v ILIKE '%' || search_term || '%'
      ORDER BY v
      LIMIT max_results
    ) INTO result;
    RETURN COALESCE(result, '{}');
  END IF;

  -- Fallback: direct DB search
  EXECUTE format(
    'SELECT ARRAY(
       SELECT DISTINCT TRIM(%I::TEXT) AS val
       FROM leads
       WHERE %I IS NOT NULL
         AND TRIM(%I::TEXT) <> ''''
         AND %I ILIKE $1
       ORDER BY val
       LIMIT %s
     )',
    col_name, col_name, col_name, col_name, max_results
  ) INTO result USING '%' || search_term || '%';

  RETURN COALESCE(result, '{}');
END;
$function$;


-- ----------------------------------------------------------------------------
-- 5. fn_refresh_top_job_titles — recomputes the top 100 job titles from the
--    lead_job_titles junction table into dashboard_top_job_titles. Run on a
--    schedule (or manually) since the GROUP BY across millions of rows is
--    too heavy to do inline on every dashboard refresh.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_refresh_top_job_titles()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '300s'
AS $function$
BEGIN
  UPDATE dashboard_top_job_titles SET
    data = COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT INITCAP(LOWER(TRIM(title))) AS title, COUNT(*)::int AS count
        FROM lead_job_titles
        GROUP BY INITCAP(LOWER(TRIM(title)))
        ORDER BY count DESC
        LIMIT 100
      ) t
    ), '[]'::jsonb),
    refreshed_at = now()
  WHERE id = 1;
END;
$function$;


-- ----------------------------------------------------------------------------
-- Post-setup: populate the job-title cache once so the dashboard isn't empty.
-- ----------------------------------------------------------------------------
SELECT fn_refresh_top_job_titles();
