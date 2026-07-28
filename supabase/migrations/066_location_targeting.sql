-- 066: entity-based location targeting + client eligibility.
--
-- 1. fn_location_entry_condition — one include/exclude entry
--    {"country":"US","state":"WA","city":"Spokane"} (state/city optional) to
--    an exact normalized SQL condition. City entries match by geoname id
--    (never text-contains); state entries by state_code; country by
--    country_code. Explicit exclusions override broader inclusions because
--    excludes are AND-ed after includes.
-- 2. fn_commercial_cleaning_condition — factored out of the commercialCleaning
--    filter block so client targeting can reuse it.
-- 3. fn_client_eligibility_conditions(tag) — the full rule set for one client
--    tag (countries, include/exclude locations, industries, keywords,
--    inferred-location policy, commercial cleaning).
-- 4. fn_lead_filter_conditions additions:
--      locationTargets {include:[entry], exclude:[entry]}
--      applyClientTargeting: "<tag>"  (send-preview / push-worker)
--      silent gates: location_status 'unsupported' + 'unresolved' leads are
--      hidden unless includeUnsupported / includeUnresolved are set.
-- 5. push_batches.target_market + eligibility snapshot columns.

CREATE OR REPLACE FUNCTION public.fn_location_entry_condition(p_entry jsonb, p_negate boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $fn$
DECLARE
  v_country text := NULLIF(TRIM(COALESCE(p_entry->>'country', '')), '');
  v_state   text := NULLIF(TRIM(COALESCE(p_entry->>'state', '')), '');
  v_city    text := NULLIF(TRIM(COALESCE(p_entry->>'city', '')), '');
  v_ids bigint[];
  cond text;
BEGIN
  IF v_country IS NULL THEN RETURN NULL; END IF;

  IF v_city IS NOT NULL AND v_state IS NOT NULL THEN
    -- city-level: resolve the entry to geoname ids (exact normalized entity)
    SELECT array_agg(g.geoname_id) INTO v_ids
    FROM geo_locations g
    JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
    WHERE g.country_code = v_country AND a.state_code = UPPER(v_state)
      AND g.city_key = regexp_replace(lower(v_city), '[^a-z]', '', 'g');
    IF v_ids IS NULL THEN
      -- unknown place: include-entry matches nothing, exclude-entry excludes nothing
      RETURN CASE WHEN p_negate THEN 'true' ELSE 'false' END;
    END IF;
    cond := format('l.location_id = ANY(%L::bigint[])', v_ids);
  ELSIF v_state IS NOT NULL THEN
    cond := format('(l.country_code = %L AND l.state_code = %L)', v_country, UPPER(v_state));
  ELSE
    cond := format('l.country_code = %L', v_country);
  END IF;

  IF p_negate THEN
    RETURN '(NOT COALESCE(' || cond || ', false))';
  END IF;
  RETURN cond;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_commercial_cleaning_condition()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $fn$
DECLARE cc_rx TEXT;
BEGIN
  SELECT string_agg('(' || fn_whole_term_regex(term) || ')', '|') INTO cc_rx
  FROM commercial_cleaning_excluded_titles;
  IF cc_rx IS NULL THEN RETURN 'true'; END IF;
  RETURN format('(l.title IS NULL OR TRIM(l.title) = '''' OR l.title !~* %L)', cc_rx);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_client_eligibility_conditions(p_tag text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
AS $fn$
DECLARE
  t RECORD;
  conds text[] := '{}';
  inc text[] := '{}';
  exc text;
  entry jsonb;
  c text;
BEGIN
  SELECT * INTO t FROM client_targeting WHERE client_tag = p_tag;
  IF NOT FOUND THEN
    -- no targeting config: only the global unsupported-country gate applies
    RETURN ARRAY['(l.location_status IS DISTINCT FROM ''unsupported'')'];
  END IF;

  -- supported/targeted countries (unknown-location leads pass unless require_location)
  IF t.require_location THEN
    conds := array_append(conds, format('l.country_code = ANY(%L::text[])', t.countries));
  ELSE
    conds := array_append(conds, format('(l.country_code = ANY(%L::text[]) OR l.country_code IS NULL)', t.countries));
  END IF;
  conds := array_append(conds, '(l.location_status IS DISTINCT FROM ''unsupported'')');
  conds := array_append(conds, '(l.location_status IS DISTINCT FROM ''unresolved'')');

  -- inferred-location policy
  IF NOT t.allow_inferred_location THEN
    conds := array_append(conds, '(l.location_source IS NULL OR l.location_source NOT LIKE ''company-%'')');
  END IF;

  -- include locations (OR of entries; leads with unknown location pass only
  -- when require_location is false AND no include list is set)
  IF jsonb_array_length(t.include_locations) > 0 THEN
    FOR entry IN SELECT jsonb_array_elements(t.include_locations) LOOP
      c := fn_location_entry_condition(entry, false);
      IF c IS NOT NULL THEN inc := array_append(inc, c); END IF;
    END LOOP;
    IF array_length(inc, 1) > 0 THEN
      IF t.require_location THEN
        conds := array_append(conds, '(' || array_to_string(inc, ' OR ') || ')');
      ELSE
        conds := array_append(conds, '((' || array_to_string(inc, ' OR ') || ') OR l.state_code IS NULL)');
      END IF;
    END IF;
  END IF;

  -- exclude locations (every exclusion is a hard AND — overrides inclusions)
  IF jsonb_array_length(t.exclude_locations) > 0 THEN
    FOR entry IN SELECT jsonb_array_elements(t.exclude_locations) LOOP
      exc := fn_location_entry_condition(entry, true);
      IF exc IS NOT NULL THEN conds := array_append(conds, exc); END IF;
    END LOOP;
  END IF;

  -- industry exclusions (exact, case-insensitive, either industry column or category)
  IF array_length(t.exclude_industries, 1) > 0 THEN
    conds := array_append(conds, format(
      '(LOWER(COALESCE(l.general_industry, '''')) <> ALL(%L::text[]) AND LOWER(COALESCE(l.specific_industry, '''')) <> ALL(%L::text[]) AND LOWER(COALESCE(l.category, '''')) <> ALL(%L::text[]))',
      (SELECT array_agg(LOWER(x)) FROM unnest(t.exclude_industries) x),
      (SELECT array_agg(LOWER(x)) FROM unnest(t.exclude_industries) x),
      (SELECT array_agg(LOWER(x)) FROM unnest(t.exclude_industries) x)));
  END IF;

  -- keyword exclusions (whole-term, across company/category/subcategory/additional)
  IF array_length(t.exclude_keywords, 1) > 0 THEN
    DECLARE kw text; rx text; BEGIN
      FOREACH kw IN ARRAY t.exclude_keywords LOOP
        rx := fn_whole_term_regex(kw);
        conds := array_append(conds, format(
          '(COALESCE(l.company, '''') !~* %L AND COALESCE(l.category, '''') !~* %L AND COALESCE(l.subcategory, '''') !~* %L AND COALESCE(l.additional_category, '''') !~* %L)',
          rx, rx, rx, rx));
      END LOOP;
    END;
  END IF;

  IF t.commercial_cleaning THEN
    conds := array_append(conds, fn_commercial_cleaning_condition());
  END IF;

  RETURN conds;
END;
$fn$;

-- push provenance: which market/rules selected the leads
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS target_market jsonb;
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS eligibility jsonb;
