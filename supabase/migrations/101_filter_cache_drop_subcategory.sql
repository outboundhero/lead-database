-- 101: fn_refresh_filter_cache without the subcategory block, and drop that row.
--
-- Built from pg_get_functiondef() of the LIVE definition on 2026-09-17 (per
-- CLAUDE.md: never from the repo's previous migration). The only change is the
-- removal of the `-- Subcategory` INSERT.
--
-- WHY. filter_options_cache is 12 rows and 254 MB, 121 MB of it the
-- subcategory options array — and nothing has read that row since the
-- Category/Subcategory/Additional-SEO chips were merged into the single
-- Category chip on 2026-08-19 (the chip's values come from categorySearch, not
-- from distinct_values('subcategory')). Every refresh rebuilt it anyway: a
-- DISTINCT over 9M rows producing a 121 MB array that the distinct_values RPC
-- could detoast on a mis-click. Live readers of the cache today: filter-bar
-- (company, source, title, city, state, esp) and the admin page (source).
--
-- The refresh itself is now driven by scripts/refresh-filter-cache.mjs on the
-- client-sync cron (see that file for why the old path stopped running).
--
-- After applying, reclaim the space (VACUUM cannot run inside a transaction,
-- so this is a separate step; 12 rows, a few seconds, brief ACCESS EXCLUSIVE):
--   VACUUM FULL public.filter_options_cache;

BEGIN;

DELETE FROM public.filter_options_cache WHERE col_name = 'subcategory';

CREATE OR REPLACE FUNCTION public.fn_refresh_filter_cache()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '300s'
AS $function$
BEGIN
  -- General Industry
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'general_industry', ARRAY(
    SELECT DISTINCT TRIM(general_industry)
    FROM leads
    WHERE general_industry IS NOT NULL
      AND TRIM(general_industry) <> ''
      AND general_industry NOT ILIKE '%page not found%'
      AND general_industry !~ '^\s*\([0-9]{3}\)'
      AND general_industry !~ '^\s*\+?[0-9][\s\-\(\)0-9]{6,}'
      AND LENGTH(TRIM(general_industry)) > 2
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  -- Specific Industry
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'specific_industry', ARRAY(
    SELECT DISTINCT TRIM(specific_industry)
    FROM leads
    WHERE specific_industry IS NOT NULL
      AND TRIM(specific_industry) <> ''
      AND specific_industry NOT ILIKE '%page not found%'
      AND specific_industry !~ '^\s*\([0-9]{3}\)'
      AND LENGTH(TRIM(specific_industry)) > 2
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  -- Job Title (unnest JSON arrays)
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'title', ARRAY(
    SELECT DISTINCT title FROM (
      SELECT TRIM(title) AS title
      FROM leads
      WHERE title IS NOT NULL AND TRIM(title) <> '' AND title !~ '^\s*\['
      UNION
      SELECT TRIM(elem) AS title
      FROM leads,
        LATERAL jsonb_array_elements_text(
          CASE WHEN title ~ '^\s*\[' THEN title::jsonb ELSE '[]'::jsonb END
        ) AS elem
      WHERE title IS NOT NULL AND title ~ '^\s*\['
    ) t
    WHERE title IS NOT NULL AND title <> ''
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  -- Country
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'country', ARRAY(
    SELECT DISTINCT TRIM(country)
    FROM leads
    WHERE country IS NOT NULL AND TRIM(country) <> ''
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  -- State (with per-option lead counts)
  INSERT INTO filter_options_cache (col_name, options, option_counts, updated_at)
  SELECT 'state',
    ARRAY(
      SELECT DISTINCT TRIM(state)
      FROM leads
      WHERE state IS NOT NULL AND TRIM(state) <> '' AND LENGTH(TRIM(state)) >= 2
      ORDER BY 1
    ),
    (SELECT jsonb_object_agg(val, cnt) FROM (
      SELECT TRIM(state) AS val, count(*) AS cnt
      FROM leads
      WHERE state IS NOT NULL AND TRIM(state) <> ''
      GROUP BY 1
    ) t),
    now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, option_counts = EXCLUDED.option_counts, updated_at = EXCLUDED.updated_at;

  -- Source
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'source', ARRAY(
    SELECT DISTINCT TRIM(source)
    FROM leads
    WHERE source IS NOT NULL AND TRIM(source) <> ''
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  -- Category
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'category', ARRAY(
    SELECT DISTINCT TRIM(category)
    FROM leads
    WHERE category IS NOT NULL AND TRIM(category) <> ''
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'additional_category', ARRAY(
    SELECT DISTINCT TRIM(additional_category)
    FROM leads
    WHERE additional_category IS NOT NULL AND TRIM(additional_category) <> ''
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  -- Seniority
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'seniority', ARRAY(
    SELECT DISTINCT TRIM(seniority)
    FROM leads
    WHERE seniority IS NOT NULL AND TRIM(seniority) <> ''
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  -- ESP (merge Microsoft + Outlook into single "Microsoft / Outlook")
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'esp', ARRAY(
    SELECT DISTINCT val FROM (
      SELECT CASE
        WHEN TRIM(esp) IN ('Microsoft', 'Outlook') THEN 'Microsoft / Outlook'
        ELSE TRIM(esp)
      END AS val
      FROM leads
      WHERE esp IS NOT NULL AND TRIM(esp) <> ''
    ) t
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

  -- City (with per-option lead counts)
  INSERT INTO filter_options_cache (col_name, options, option_counts, updated_at)
  SELECT 'city',
    ARRAY(
      SELECT DISTINCT TRIM(city)
      FROM leads
      WHERE city IS NOT NULL AND TRIM(city) <> ''
      ORDER BY 1
    ),
    (SELECT jsonb_object_agg(val, cnt) FROM (
      SELECT TRIM(city) AS val, count(*) AS cnt
      FROM leads
      WHERE city IS NOT NULL AND TRIM(city) <> ''
      GROUP BY 1
    ) t),
    now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, option_counts = EXCLUDED.option_counts, updated_at = EXCLUDED.updated_at;
END;
$function$;


COMMIT;

NOTIFY pgrst, 'reload schema';
