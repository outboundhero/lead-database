-- 113: fn_refresh_filter_cache must not die on a title that starts with '['.
--
-- The Title list parsed every title matching '^\s*\[' as a JSON array
-- (`title::jsonb`). On 2026-09-18 an upload brought one legitimate title,
-- "[Interim] Chief Operations Officer", and from then on every daily refresh
-- failed with "invalid input syntax for type json" — all Leads-page dropdowns
-- went stale (found 2026-09-19 while testing migration 112 end to end). The
-- table holds ZERO valid JSON-array titles, so the branch was dead code whose
-- only effect was to crash. Now a bracketed title is JSON only when it IS a
-- JSON array (`IS JSON ARRAY`, PG16+); otherwise it is plain text like any
-- other title. fn_sync_lead_job_titles already behaved this way (it catches
-- the parse error and falls back to plain text).
--
-- Rebuilt from pg_get_functiondef of the LIVE body (2026-09-19); only the
-- three title predicates change.

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
    SELECT title FROM (
      SELECT TRIM(title) AS title
      FROM leads
      WHERE title IS NOT NULL AND TRIM(title) <> '' AND (title !~ '^\s*\[' OR title IS NOT JSON ARRAY)
      UNION ALL
      SELECT TRIM(elem) AS title
      FROM leads,
        LATERAL jsonb_array_elements_text(
          CASE WHEN title ~ '^\s*\[' AND title IS JSON ARRAY THEN title::jsonb ELSE '[]'::jsonb END
        ) AS elem
      WHERE title IS NOT NULL AND title ~ '^\s*\[' AND title IS JSON ARRAY
    ) t
    WHERE title IS NOT NULL AND title <> '' AND LENGTH(title) <= 120
    GROUP BY title
    HAVING count(*) >= 3
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
        AND TRIM(state) IN (SELECT name FROM geo_admin1 UNION SELECT state_code FROM geo_admin1)
      ORDER BY 1
    ),
    (SELECT jsonb_object_agg(val, cnt) FROM (
      SELECT TRIM(state) AS val, count(*) AS cnt
      FROM leads
      WHERE state IS NOT NULL AND TRIM(state) <> ''
        AND TRIM(state) IN (SELECT name FROM geo_admin1 UNION SELECT state_code FROM geo_admin1)
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
      SELECT val FROM (
        SELECT TRIM(city) AS val, count(*) AS cnt
        FROM leads
        WHERE city IS NOT NULL AND TRIM(city) <> ''
        GROUP BY 1
      ) c
      WHERE cnt >= 5 AND val !~ '[0-9]' AND LENGTH(val) BETWEEN 2 AND 60
      ORDER BY 1
    ),
    (SELECT jsonb_object_agg(val, cnt) FROM (
      SELECT TRIM(city) AS val, count(*) AS cnt
      FROM leads
      WHERE city IS NOT NULL AND TRIM(city) <> ''
      GROUP BY 1
      HAVING count(*) >= 5 AND TRIM(city) !~ '[0-9]' AND LENGTH(TRIM(city)) BETWEEN 2 AND 60
    ) t),
    now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, option_counts = EXCLUDED.option_counts, updated_at = EXCLUDED.updated_at;
END;
$function$;

NOTIFY pgrst, 'reload schema';
