-- 102: quality gates in fn_refresh_filter_cache for the State, City and Title dropdowns.
--
-- Built from pg_get_functiondef() of the LIVE definition (post-101) on
-- 2026-09-17. Only the three blocks named above change.
--
-- WHY. The first refresh after 7 weeks (13:18 UTC today) dropped the State chip
-- from 65 clean options to 13,156 — phone numbers, street addresses, a JSON
-- blob, "Калифорния", sales questions — because leads.state/city now hold raw
-- Bison custom-variable text the July cleanup never saw, and the function had
-- no quality gate. The State chip renders its whole list locally (no search),
-- so every operator got 13k junk rows. City went 4,077 -> 29,620 (10,193 with
-- digits, 18,720 backing <5 leads); Title 45,852 -> 182,126 (2.2 MB per open).
--
-- Gates, measured against today's option_counts:
--   state : only values that are a geo_admin1 name or state_code
--           -> 125 options covering 7,781,950 of 7,924,073 leads (98.2%);
--              the rest is the 142k junk-state cohort the location worker
--              deliberately leaves alone.
--   city  : >= 5 leads, no digits, 2-60 chars
--           -> 10,296 of 29,620 options covering 7,779,555 of 7,814,959 (99.5%).
--   title : >= 3 leads, <= 120 chars (UNION -> UNION ALL so counts survive).
-- Rare values still work by typing them: the City/Title chips search the live
-- column (search_column_values) — the cache is only the initial list.
--
-- scripts/refresh-filter-cache.mjs additionally refuses to commit a refresh
-- whose state/city/title cardinalities exceed sane bounds.

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
      WHERE title IS NOT NULL AND TRIM(title) <> '' AND title !~ '^\s*\['
      UNION ALL
      SELECT TRIM(elem) AS title
      FROM leads,
        LATERAL jsonb_array_elements_text(
          CASE WHEN title ~ '^\s*\[' THEN title::jsonb ELSE '[]'::jsonb END
        ) AS elem
      WHERE title IS NOT NULL AND title ~ '^\s*\['
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
$function$
;

NOTIFY pgrst, 'reload schema';
