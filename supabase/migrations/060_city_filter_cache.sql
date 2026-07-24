-- 060: add City to the filter options cache.
-- City was previously search-only in the UI (100K+ distinct junk values);
-- after the 2026-07-24 state/city normalization it has ~4K clean values,
-- so it can be cached and preloaded like every other filter column.

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

  -- State
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'state', ARRAY(
    SELECT DISTINCT TRIM(state)
    FROM leads
    WHERE state IS NOT NULL AND TRIM(state) <> '' AND LENGTH(TRIM(state)) >= 2
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

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

  -- Category
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

  -- City
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'city', ARRAY(
    SELECT DISTINCT TRIM(city)
    FROM leads
    WHERE city IS NOT NULL AND TRIM(city) <> ''
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;
END;
$function$
;
