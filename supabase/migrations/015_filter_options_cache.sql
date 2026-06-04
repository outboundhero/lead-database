-- Filter options cache table: stores pre-computed distinct values for filter dropdowns.
-- Avoids full-table DISTINCT scans on 6M+ row leads table.

-- ── 1. Create cache table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS filter_options_cache (
  col_name TEXT PRIMARY KEY,
  options TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Allow PostgREST / authenticated users to read
ALTER TABLE filter_options_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read filter cache" ON filter_options_cache FOR SELECT USING (true);

-- ── 2. Function to refresh the cache (run via cron or manually) ───────────
CREATE OR REPLACE FUNCTION fn_refresh_filter_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '300s'
AS $$
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
  SELECT 'job_title', ARRAY(
    SELECT DISTINCT title FROM (
      SELECT TRIM(job_title) AS title
      FROM leads
      WHERE job_title IS NOT NULL AND TRIM(job_title) <> '' AND job_title !~ '^\s*\['
      UNION
      SELECT TRIM(elem) AS title
      FROM leads,
        LATERAL jsonb_array_elements_text(
          CASE WHEN job_title ~ '^\s*\[' THEN job_title::jsonb ELSE '[]'::jsonb END
        ) AS elem
      WHERE job_title IS NOT NULL AND job_title ~ '^\s*\['
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
END;
$$;

-- ── 3. Update distinct_values to read from cache ──────────────────────────
DROP FUNCTION IF EXISTS distinct_values(text);
CREATE OR REPLACE FUNCTION distinct_values(col_name TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  result TEXT[];
BEGIN
  SELECT options INTO result
  FROM filter_options_cache
  WHERE filter_options_cache.col_name = distinct_values.col_name;

  -- If cache is empty/missing, return empty array (cache needs populating)
  RETURN COALESCE(result, '{}');
END;
$$;
