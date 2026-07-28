-- 065: state filter matches BOTH the full name and the code.
--
-- The location backfill flips leads.state to full names ("Washington") with
-- codes in leads.state_code ("WA"). Saved presets and in-flight UI sessions
-- still send codes — so exact state matching accepts either column. Applied
-- BEFORE the backfill runs so filtering never breaks mid-migration.

CREATE OR REPLACE FUNCTION public.fn_state_match(p_vals text[], p_negate boolean)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $fn$
DECLARE
  lv text[];
BEGIN
  IF p_vals IS NULL OR array_length(p_vals, 1) IS NULL THEN RETURN 'true'; END IF;
  SELECT array_agg(LOWER(x)) INTO lv FROM unnest(p_vals) x;
  IF p_negate THEN
    RETURN format('((l.state IS NULL AND l.state_code IS NULL) OR (LOWER(COALESCE(l.state, '''')) <> ALL(%L::text[]) AND LOWER(COALESCE(l.state_code, '''')) <> ALL(%L::text[])))', lv, lv);
  ELSE
    RETURN format('(LOWER(l.state) = ANY(%L::text[]) OR LOWER(l.state_code) = ANY(%L::text[]))', lv, lv);
  END IF;
END;
$fn$;
