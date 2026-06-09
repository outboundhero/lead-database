-- OutboundHero Database: two more Renaissance gaps caught on first real query
--
--  1. fn_handle_company_size(jsonb) — helper called by filter + export RPCs
--     for the companySize range filter. Called from 9 migrations but never
--     defined as a migration file.
--
--  2. filter_presets table — referenced by /api/filters/presets but no
--     migration creates it.

-- ─── fn_handle_company_size ──────────────────────────────────────────────
-- Takes the full p_filters JSONB and returns a single SQL condition string
-- (or NULL if no size filter is active). Caller appends the result to its
-- conditions array.
--
-- Input shape (companySize key of p_filters):
--   { buckets: ['1-10','11-50',...], includeUnknown: bool,
--     customMin: int|null, customMax: int|null }
--
-- Output: SQL fragment like
--   '((l.company_size >= 1 AND l.company_size <= 10) OR (l.company_size >= 11 AND l.company_size <= 50) OR l.company_size IS NULL)'
--   or NULL if nothing to filter.

CREATE OR REPLACE FUNCTION fn_handle_company_size(p_filters JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cs            JSONB := p_filters->'companySize';
  buckets       JSONB;
  iu            BOOLEAN;
  custom_min    INT;
  custom_max    INT;
  parts         TEXT[] := '{}';
  b             TEXT;
  bucket_cond   TEXT;
  unknown_cond  TEXT := NULL;
  range_cond    TEXT := NULL;
BEGIN
  IF cs IS NULL THEN RETURN NULL; END IF;

  buckets    := COALESCE(cs->'buckets', '[]'::jsonb);
  iu         := COALESCE((cs->>'includeUnknown')::boolean, false);
  custom_min := NULLIF(cs->>'customMin', '')::INT;
  custom_max := NULLIF(cs->>'customMax', '')::INT;

  -- Bucket selections
  IF jsonb_array_length(buckets) > 0 THEN
    FOR b IN SELECT jsonb_array_elements_text(buckets) LOOP
      bucket_cond := CASE b
        WHEN '1-10'      THEN '(l.company_size BETWEEN 1 AND 10)'
        WHEN '11-50'     THEN '(l.company_size BETWEEN 11 AND 50)'
        WHEN '51-200'    THEN '(l.company_size BETWEEN 51 AND 200)'
        WHEN '201-500'   THEN '(l.company_size BETWEEN 201 AND 500)'
        WHEN '501-1000'  THEN '(l.company_size BETWEEN 501 AND 1000)'
        WHEN '1001-5000' THEN '(l.company_size BETWEEN 1001 AND 5000)'
        WHEN '5000+'     THEN '(l.company_size > 5000)'
        ELSE NULL
      END;
      IF bucket_cond IS NOT NULL THEN
        parts := array_append(parts, bucket_cond);
      END IF;
    END LOOP;
  END IF;

  -- Custom min/max overrides the buckets if both provided; otherwise ANDed.
  IF custom_min IS NOT NULL AND custom_max IS NOT NULL THEN
    range_cond := format('(l.company_size BETWEEN %s AND %s)', custom_min, custom_max);
  ELSIF custom_min IS NOT NULL THEN
    range_cond := format('(l.company_size >= %s)', custom_min);
  ELSIF custom_max IS NOT NULL THEN
    range_cond := format('(l.company_size <= %s)', custom_max);
  END IF;

  IF range_cond IS NOT NULL THEN
    parts := array_append(parts, range_cond);
  END IF;

  -- "includeUnknown" — let null company_size rows through too
  IF iu THEN
    unknown_cond := 'l.company_size IS NULL';
  END IF;

  IF array_length(parts, 1) IS NULL AND unknown_cond IS NULL THEN
    RETURN NULL;
  END IF;

  -- Combine: (bucket1 OR bucket2 OR range) OR (IS NULL if includeUnknown)
  IF array_length(parts, 1) IS NULL THEN
    RETURN unknown_cond;
  ELSIF unknown_cond IS NULL THEN
    RETURN '(' || array_to_string(parts, ' OR ') || ')';
  ELSE
    RETURN '((' || array_to_string(parts, ' OR ') || ') OR ' || unknown_cond || ')';
  END IF;
END;
$$;

-- ─── filter_presets ──────────────────────────────────────────────────────
-- Saved filter presets per user (with optional sharing across the team).
-- Used by FilterPresets component on the leads page.
CREATE TABLE IF NOT EXISTS filter_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filters JSONB NOT NULL,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_filter_presets_user_id ON filter_presets (user_id);
CREATE INDEX IF NOT EXISTS idx_filter_presets_shared ON filter_presets (is_shared) WHERE is_shared = true;
