-- Fix filter dropdown values:
-- 1. General Industry: filter out phone numbers, "Page Not Found", and other garbage
-- 2. Job Title: unnest JSON array strings into individual values
-- 3. Country: normalize US/USA/United States/etc. to a single canonical value

-- ─── 1. Normalize country data in-place ──────────────────────────────────────
UPDATE leads
SET country = 'United States'
WHERE UPPER(TRIM(country)) IN (
  'US', 'USA', 'U.S.', 'U.S.A.',
  'UNITED STATES', 'UNITED STATES OF AMERICA',
  'UNITED STATES OF AMERICA USA',
  'THE UNITED STATES', 'THE UNITED STATES OF AMERICA'
);

UPDATE leads
SET country = 'United Kingdom'
WHERE UPPER(TRIM(country)) IN (
  'UK', 'U.K.', 'UNITED KINGDOM', 'UNITED KINGDOM UK',
  'GREAT BRITAIN', 'ENGLAND', 'BRITAIN'
);

UPDATE leads
SET country = 'Canada'
WHERE UPPER(TRIM(country)) IN ('CA', 'CANADA');

UPDATE leads
SET country = 'Australia'
WHERE UPPER(TRIM(country)) IN ('AU', 'AUS', 'AUSTRALIA');

-- ─── 2. Clean garbage general_industry values ────────────────────────────────
UPDATE leads
SET general_industry = NULL
WHERE general_industry IS NOT NULL
  AND (
    general_industry ILIKE '%page not found%'
    OR general_industry ILIKE '%404%'
    OR general_industry ~ '^\s*\([0-9]{3}\)'       -- starts with (NXX) phone prefix
    OR general_industry ~ '^\s*\+?[0-9][\s\-\(\)0-9]{6,}' -- starts with phone digits
    OR general_industry ~ '^\s*[0-9]{3}[\.\-][0-9]{3}' -- NXX.NXX or NXX-NXX format
    OR LENGTH(TRIM(general_industry)) < 2
  );

-- ─── 3. distinct_values RPC — clean & normalized ────────────────────────────
CREATE OR REPLACE FUNCTION distinct_values(col_name TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  result TEXT[];
BEGIN
  -- ── Country: already normalized in data, just return sorted uniques ──────
  IF col_name = 'country' THEN
    SELECT ARRAY(
      SELECT DISTINCT TRIM(country)
      FROM leads
      WHERE country IS NOT NULL
        AND TRIM(country) <> ''
      ORDER BY 1
    ) INTO result;
    RETURN result;

  -- ── General Industry: skip any remaining garbage ──────────────────────────
  ELSIF col_name = 'general_industry' THEN
    SELECT ARRAY(
      SELECT DISTINCT TRIM(general_industry)
      FROM leads
      WHERE general_industry IS NOT NULL
        AND TRIM(general_industry) <> ''
        AND general_industry NOT ILIKE '%page not found%'
        AND general_industry !~ '^\s*\([0-9]{3}\)'
        AND general_industry !~ '^\s*\+?[0-9][\s\-\(\)0-9]{6,}'
        AND LENGTH(TRIM(general_industry)) > 2
      ORDER BY 1
    ) INTO result;
    RETURN result;

  -- ── Job Title: unnest JSON array strings into individual titles ───────────
  ELSIF col_name = 'job_title' THEN
    SELECT ARRAY(
      SELECT DISTINCT title
      FROM (
        -- Values stored as plain strings
        SELECT TRIM(job_title) AS title
        FROM leads
        WHERE job_title IS NOT NULL
          AND TRIM(job_title) <> ''
          AND job_title !~ '^\s*\['

        UNION

        -- Values stored as JSON arrays: ["Title A","Title B"]
        SELECT TRIM(elem) AS title
        FROM leads,
          LATERAL jsonb_array_elements_text(
            CASE
              WHEN job_title ~ '^\s*\[' THEN job_title::jsonb
              ELSE '[]'::jsonb
            END
          ) AS elem
        WHERE job_title IS NOT NULL
          AND job_title ~ '^\s*\['
      ) t
      WHERE title IS NOT NULL AND title <> ''
      ORDER BY 1
    ) INTO result;
    RETURN result;

  -- ── Specific Industry: same garbage filter as general ────────────────────
  ELSIF col_name = 'specific_industry' THEN
    SELECT ARRAY(
      SELECT DISTINCT TRIM(specific_industry)
      FROM leads
      WHERE specific_industry IS NOT NULL
        AND TRIM(specific_industry) <> ''
        AND specific_industry NOT ILIKE '%page not found%'
        AND specific_industry !~ '^\s*\([0-9]{3}\)'
        AND LENGTH(TRIM(specific_industry)) > 2
      ORDER BY 1
    ) INTO result;
    RETURN result;

  -- ── State: generic clean fetch ────────────────────────────────────────────
  ELSIF col_name = 'state' THEN
    SELECT ARRAY(
      SELECT DISTINCT TRIM(state)
      FROM leads
      WHERE state IS NOT NULL
        AND TRIM(state) <> ''
        AND LENGTH(TRIM(state)) >= 2
      ORDER BY 1
    ) INTO result;
    RETURN result;

  -- ── Fallback: generic distinct for any other column ──────────────────────
  ELSE
    EXECUTE format(
      'SELECT ARRAY(
         SELECT DISTINCT TRIM(%I::TEXT)
         FROM leads
         WHERE %I IS NOT NULL AND TRIM(%I::TEXT) <> ''''
         ORDER BY 1
       )',
      col_name, col_name, col_name
    ) INTO result;
    RETURN result;
  END IF;
END;
$$;
