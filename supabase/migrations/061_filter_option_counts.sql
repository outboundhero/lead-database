-- 061: per-option lead counts for the State and City filter dropdowns.
-- Adds filter_options_cache.option_counts (jsonb value->count), populates it
-- for state + city in fn_refresh_filter_cache, and exposes it via the
-- filter_option_counts RPC. Other columns keep option_counts NULL.

ALTER TABLE filter_options_cache ADD COLUMN IF NOT EXISTS option_counts jsonb;

CREATE OR REPLACE FUNCTION public.filter_option_counts(col_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
  result JSONB;
BEGIN
  SELECT option_counts INTO result
  FROM filter_options_cache
  WHERE filter_options_cache.col_name = filter_option_counts.col_name;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$function$;

-- Recreate the refresh function with count aggregation for state + city.
-- (Full function body; other columns unchanged from migration 060.)
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

  -- Subcategory
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'subcategory', ARRAY(
    SELECT DISTINCT TRIM(subcategory)
    FROM leads
    WHERE subcategory IS NOT NULL AND TRIM(subcategory) <> ''
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
