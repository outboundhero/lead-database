-- 079: client eligibility uses the merged exclude_terms list.
--
-- Depends on 078, which created exclude_terms/include_terms and merged the data.
--
-- WHAT CHANGES
--   before: exclude_industries (EXACT, 3 columns) AND
--           exclude_keywords   (whole-word, 4 columns, ONE CONDITION PER TERM)
--   after : exclude_terms      (whole-word, 6 columns, ONE regex per column)
--
-- Columns matched: category, subcategory, additional_category, company,
-- general_industry, specific_industry. Company overview is deliberately NOT
-- searched (client decision 2026-08-19).
--
-- The INCLUDE side still gates nothing. include_terms is stored and used only
-- to pre-fill the Leads filters when a client is selected — confirmed with the
-- client, since many leads have no category at all and gating on includes would
-- silently collapse their sendable lists.
--
-- ⚠ DELIBERATE BEHAVIOUR CHANGE. Terms that lived only in exclude_industries
-- move from EXACT to whole-word, so "General Medical" now also blocks a company
-- named "General Medical Supplies". 118 of the 171 industry terms were already
-- duplicated in exclude_keywords (whole-word already), so this affects ~53
-- terms. Contains-matching was considered and rejected: measured on production
-- it would have wrongly blocked ~227k leads on "car" alone, and "pub" (used by
-- 93 clients) would have blocked "Public" and "Republic".
--
-- PERFORMANCE — this should be FASTER than before. Each term previously became
-- its own SQL condition; client HS generated 201 conditions / 53,635 characters
-- of WHERE clause. Collapsing to one alternation regex per column makes that 1
-- condition. The pattern is copied from fn_commercial_cleaning_condition, which
-- already does this for its 230 job titles.
--
-- Built from the LIVE definition via pg_get_functiondef(), not from migration
-- 066 — production has drifted before. Net change: 19 lines removed, 17 added,
-- confined to the two exclusion blocks.
--
-- Rollback: re-apply migration 066's definition. exclude_industries and
-- exclude_keywords are still populated and untouched, so old behaviour returns
-- intact.

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
      SELECT string_agg('(' || fn_whole_term_regex(x) || ')', '|') INTO ex_rx
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

  RETURN conds;
END;
$function$;

DO $$
DECLARE sql_out text; n_conds int;
BEGIN
  SELECT array_to_string(fn_client_eligibility_conditions('HS'), ' AND '),
         array_length(fn_client_eligibility_conditions('HS'), 1)
    INTO sql_out, n_conds;
  IF position('l.general_industry' in sql_out) = 0 OR position('l.subcategory' in sql_out) = 0 THEN
    RAISE EXCEPTION '079: exclusion is not spanning the expected columns: %', left(sql_out, 400);
  END IF;
  IF position('l.company_overview' in sql_out) > 0 THEN
    RAISE EXCEPTION '079: company_overview must NOT be matched';
  END IF;
  IF n_conds > 20 THEN
    RAISE EXCEPTION '079: expected the per-term conditions to collapse, still got %', n_conds;
  END IF;
  RAISE NOTICE '079: HS now generates % conditions (was 205), % chars (was 53,635)', n_conds, length(sql_out);
END $$;
