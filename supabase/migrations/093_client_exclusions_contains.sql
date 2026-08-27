-- 093: client exclusion terms match by CONTAINS, not whole word.
--
-- Requested by the client, after being shown the trade-off: contains makes
-- "cleaning" catch "drycleaning" and "CleaningCo" (wanted, for excluding
-- competitors), and equally makes short terms match inside longer words -- "bar"
-- matches "Barbershop", which excludes roughly 34,000 leads that whole-word
-- kept. Confirmed and applied at their request.
--
-- Only the client EXCLUSION terms change. fn_commercial_cleaning_condition
-- keeps whole-word matching for its 230 job titles: those are titles, not
-- category keywords, and "bar" style collisions there would be worse.

CREATE OR REPLACE FUNCTION public.fn_client_eligibility_conditions(p_tag text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
AS $function$
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

  -- Unified term exclusions (migration 079): the two old lists are merged into
  -- exclude_terms, matched whole-word and plural-tolerant across six columns.
  --
  -- ONE alternation regex per column rather than one condition per term - the
  -- same shape fn_commercial_cleaning_condition uses for its 230 titles. Client
  -- HS previously generated 201 separate conditions (53,635 characters of SQL);
  -- it now generates 1. Company overview is deliberately NOT searched.
  IF array_length(t.exclude_terms, 1) > 0 THEN
    DECLARE ex_rx text; BEGIN
      -- CONTAINS, not whole-word (client decision 2026-08-27). fn_regex_escape
      -- alone is a substring match; fn_whole_term_regex wrapped it in \m..\M.
      -- This is the same construction the browse filter uses for its "Contains"
      -- mode, so what the Leads view shows and what the push actually sends can
      -- no longer disagree.
      --
      -- Deliberately broader: "cleaning" now also catches "drycleaning" and
      -- "CleaningCo", which is the point for competitor exclusion. It equally
      -- means a short term matches inside longer words -- "bar" hits
      -- "Barbershop" -- so short generic terms exclude more than they used to.
      SELECT string_agg('(' || fn_regex_escape(x) || ')', '|') INTO ex_rx
      FROM unnest(t.exclude_terms) x WHERE btrim(x) <> '';
      IF ex_rx IS NOT NULL THEN
        conds := array_append(conds, format(
          '(COALESCE(l.category, '''') !~* %L AND COALESCE(l.subcategory, '''') !~* %L AND COALESCE(l.additional_category, '''') !~* %L AND COALESCE(l.company, '''') !~* %L AND COALESCE(l.general_industry, '''') !~* %L AND COALESCE(l.specific_industry, '''') !~* %L)',
          ex_rx, ex_rx, ex_rx, ex_rx, ex_rx, ex_rx));
      END IF;
    END;
  END IF;


  IF t.commercial_cleaning THEN
    conds := array_append(conds, fn_commercial_cleaning_condition());
  END IF;

  -- SUPPRESSED ADDRESSES (091): never eligible for any client, on any campaign,
  -- with no override. This is the point of the list — a deleted lead comes back
  -- on the next Bison sync, so the gate has to be on the address, permanently.
  conds := array_append(conds, '(l.is_suppressed = false)');

  RETURN conds;
END;
$function$
;
