-- 092: honour the suppression list in BOTH gates.
--
-- 091 created the list and the leads.is_suppressed flag. This is what actually
-- makes it bite:
--   * fn_lead_filter_conditions  — hides suppressed leads from browse and every
--     export, unless includeSuppressed is passed.
--   * fn_client_eligibility_conditions — makes them ineligible for every client
--     and every campaign, with NO override.
--
-- Both are the shared builders, so the table, the counts, the exports, the
-- availability figures and the push all pick this up together rather than one
-- of them being forgotten.
--
-- Regenerated from the live definitions; everything outside the marked blocks
-- is byte-identical to what was deployed.

CREATE OR REPLACE FUNCTION public.fn_lead_filter_conditions(p_filters jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  conditions TEXT[] := '{}';
  v TEXT;
  vals TEXT[];
BEGIN
  DECLARE su BOOLEAN := COALESCE((p_filters->'jobTitle'->>'selectUnknown')::boolean, false);
          m_jt TEXT := COALESCE(p_filters->'jobTitle'->>'includeMode', 'exact');
          jt_cond TEXT; BEGIN
    IF p_filters ? 'jobTitle' AND jsonb_array_length(COALESCE(p_filters->'jobTitle'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'jobTitle'->'include') x;
      IF m_jt = 'contains' THEN
        jt_cond := format('l.id IN (SELECT lead_id FROM lead_job_titles WHERE title ILIKE ANY(%L::text[]))', (SELECT array_agg('%' || u || '%') FROM unnest(vals) u));
      ELSE
        jt_cond := format('l.id IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[]))', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u));
      END IF;
      IF su THEN
        conditions := array_append(conditions, '(' || jt_cond || ' OR l.title IS NULL OR TRIM(l.title) = '''')');
      ELSE
        conditions := array_append(conditions, jt_cond);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.title IS NULL OR TRIM(l.title) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'generalIndustry'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'generalIndustry' AND jsonb_array_length(COALESCE(p_filters->'generalIndustry'->'include', '[]'::jsonb)) > 0 THEN
      DECLARE gi TEXT[] := '{}'; BEGIN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'generalIndustry'->'include') LOOP
          gi := array_append(gi, format('LOWER(l.general_industry) = LOWER(%L)', v));
        END LOOP;
        IF su THEN
          conditions := array_append(conditions, '(' || array_to_string(gi, ' OR ') || ' OR l.general_industry IS NULL OR TRIM(l.general_industry) = '''')');
        ELSE
          conditions := array_append(conditions, '(' || array_to_string(gi, ' OR ') || ')');
        END IF;
      END;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.general_industry IS NULL OR TRIM(l.general_industry) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'specificIndustry'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'specificIndustry' AND jsonb_array_length(COALESCE(p_filters->'specificIndustry'->'include', '[]'::jsonb)) > 0 THEN
      DECLARE si TEXT[] := '{}'; BEGIN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'specificIndustry'->'include') LOOP
          si := array_append(si, format('LOWER(l.specific_industry) = LOWER(%L)', v));
        END LOOP;
        IF su THEN
          conditions := array_append(conditions, '(' || array_to_string(si, ' OR ') || ' OR l.specific_industry IS NULL OR TRIM(l.specific_industry) = '''')');
        ELSE
          conditions := array_append(conditions, '(' || array_to_string(si, ' OR ') || ')');
        END IF;
      END;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.specific_industry IS NULL OR TRIM(l.specific_industry) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'source'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'source' AND jsonb_array_length(COALESCE(p_filters->'source'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'source'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.source = ANY(%L::text[]) OR l.source IS NULL OR TRIM(l.source) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.source = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.source IS NULL OR TRIM(l.source) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'company'->>'selectUnknown')::boolean, false);
          m_company TEXT := COALESCE(p_filters->'company'->>'includeMode', 'exact');
          mc_company TEXT; BEGIN
    IF p_filters ? 'company' AND jsonb_array_length(COALESCE(p_filters->'company'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'company'->'include') x;
      mc_company := fn_sided_match('l.company', vals, m_company, false);
      IF su THEN
        conditions := array_append(conditions, '(' || mc_company || ' OR l.company IS NULL OR TRIM(l.company) = '''')');
      ELSE
        conditions := array_append(conditions, mc_company);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.company IS NULL OR TRIM(l.company) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'seniority'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'seniority' AND jsonb_array_length(COALESCE(p_filters->'seniority'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'seniority'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.seniority = ANY(%L::text[]) OR l.seniority IS NULL OR TRIM(l.seniority) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.seniority = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.seniority IS NULL OR TRIM(l.seniority) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'esp'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'esp' AND jsonb_array_length(COALESCE(p_filters->'esp'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'esp'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.esp = ANY(%L::text[]) OR l.esp IS NULL OR TRIM(l.esp) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.esp = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.esp IS NULL OR TRIM(l.esp) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'category'->>'selectUnknown')::boolean, false);
          m_category TEXT := COALESCE(p_filters->'category'->>'includeMode', 'exact');
          mc_category TEXT; BEGIN
    IF p_filters ? 'category' AND jsonb_array_length(COALESCE(p_filters->'category'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'category'->'include') x;
      mc_category := fn_sided_match('l.category', vals, m_category, false);
      IF su THEN
        conditions := array_append(conditions, '(' || mc_category || ' OR l.category IS NULL OR TRIM(l.category) = '''')');
      ELSE
        conditions := array_append(conditions, mc_category);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.category IS NULL OR TRIM(l.category) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'subcategory'->>'selectUnknown')::boolean, false);
          m_subcategory TEXT := COALESCE(p_filters->'subcategory'->>'includeMode', 'exact');
          mc_subcategory TEXT; BEGIN
    IF p_filters ? 'subcategory' AND jsonb_array_length(COALESCE(p_filters->'subcategory'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'subcategory'->'include') x;
      mc_subcategory := fn_sided_match('l.subcategory', vals, m_subcategory, false);
      IF su THEN
        conditions := array_append(conditions, '(' || mc_subcategory || ' OR l.subcategory IS NULL OR TRIM(l.subcategory) = '''')');
      ELSE
        conditions := array_append(conditions, mc_subcategory);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.subcategory IS NULL OR TRIM(l.subcategory) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'additionalCategory'->>'selectUnknown')::boolean, false);
          m_additionalCategory TEXT := COALESCE(p_filters->'additionalCategory'->>'includeMode', 'exact');
          mc_additionalCategory TEXT; BEGIN
    IF p_filters ? 'additionalCategory' AND jsonb_array_length(COALESCE(p_filters->'additionalCategory'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'additionalCategory'->'include') x;
      mc_additionalCategory := fn_sided_match('l.additional_category', vals, m_additionalCategory, false);
      IF su THEN
        conditions := array_append(conditions, '(' || mc_additionalCategory || ' OR l.additional_category IS NULL OR TRIM(l.additional_category) = '''')');
      ELSE
        conditions := array_append(conditions, mc_additionalCategory);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.additional_category IS NULL OR TRIM(l.additional_category) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'location'->'country'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND jsonb_array_length(COALESCE(p_filters->'location'->'country'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'country'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.country = ANY(%L::text[]) OR l.country IS NULL OR TRIM(l.country) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.country = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.country IS NULL OR TRIM(l.country) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'location'->'state'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND jsonb_array_length(COALESCE(p_filters->'location'->'state'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'state'->'include') x;
      DECLARE mst TEXT := CASE WHEN COALESCE(p_filters->'location'->'state'->>'includeMode', 'exact') = 'exact'
                          THEN fn_state_match(vals, false)
                          ELSE fn_sided_match('l.state', vals, 'contains', false) END; BEGIN
      IF su THEN
        conditions := array_append(conditions, '(' || mst || ' OR l.state IS NULL OR TRIM(l.state) = '''')');
      ELSE
        conditions := array_append(conditions, mst);
      END IF;
      END;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.state IS NULL OR TRIM(l.state) = '''')');
    END IF;
  END;

  -- City: new shape {include[],exclude[]}; legacy plain string still accepted.
  IF p_filters ? 'location' AND p_filters->'location' ? 'city' THEN
    IF jsonb_typeof(p_filters->'location'->'city') = 'string' THEN
      IF (p_filters->'location'->>'city') <> '' THEN
        conditions := array_append(conditions, format('l.city ILIKE %L', '%' || (p_filters->'location'->>'city') || '%'));
      END IF;
    ELSIF jsonb_typeof(p_filters->'location'->'city') = 'object' THEN
      BEGIN
        IF jsonb_array_length(COALESCE(p_filters->'location'->'city'->'include', '[]'::jsonb)) > 0 THEN
          SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'city'->'include') x;
          conditions := array_append(conditions, fn_sided_match('l.city', vals, COALESCE(p_filters->'location'->'city'->>'includeMode', 'contains'), false));
        END IF;
        IF jsonb_array_length(COALESCE(p_filters->'location'->'city'->'exclude', '[]'::jsonb)) > 0 THEN
          SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'city'->'exclude') x;
          conditions := array_append(conditions, fn_sided_match('l.city', vals, COALESCE(p_filters->'location'->'city'->>'excludeMode', 'contains'), true));
        END IF;
      END;
    END IF;
  END IF;

  IF p_filters ? 'companyName' AND (p_filters->>'companyName') <> '' THEN
    conditions := array_append(conditions, format('l.company ILIKE %L', '%' || (p_filters->>'companyName') || '%'));
  END IF;

  IF p_filters ? 'fullName' AND (p_filters->>'fullName') <> '' THEN
    conditions := array_append(conditions, format('(l.first_name ILIKE %L OR l.last_name ILIKE %L)',
      '%' || (p_filters->>'fullName') || '%', '%' || (p_filters->>'fullName') || '%'));
  END IF;

  IF p_filters ? 'jobTitle' AND jsonb_array_length(COALESCE(p_filters->'jobTitle'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'jobTitle'->'exclude') x;
    IF COALESCE(p_filters->'jobTitle'->>'excludeMode', 'exact') = 'contains' THEN
      conditions := array_append(conditions, format('l.id NOT IN (SELECT lead_id FROM lead_job_titles WHERE title ILIKE ANY(%L::text[]))', (SELECT array_agg('%' || u || '%') FROM unnest(vals) u)));
    ELSE
      conditions := array_append(conditions, format('l.id NOT IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[]))', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u)));
    END IF;
  END IF;
  IF p_filters ? 'generalIndustry' AND jsonb_array_length(COALESCE(p_filters->'generalIndustry'->'exclude', '[]'::jsonb)) > 0 THEN
    FOR v IN SELECT jsonb_array_elements_text(p_filters->'generalIndustry'->'exclude') LOOP
      conditions := array_append(conditions, format('(l.general_industry IS NULL OR LOWER(l.general_industry) <> LOWER(%L))', v));
    END LOOP;
  END IF;
  IF p_filters ? 'specificIndustry' AND jsonb_array_length(COALESCE(p_filters->'specificIndustry'->'exclude', '[]'::jsonb)) > 0 THEN
    FOR v IN SELECT jsonb_array_elements_text(p_filters->'specificIndustry'->'exclude') LOOP
      conditions := array_append(conditions, format('(l.specific_industry IS NULL OR LOWER(l.specific_industry) <> LOWER(%L))', v));
    END LOOP;
  END IF;
  IF p_filters ? 'source' AND jsonb_array_length(COALESCE(p_filters->'source'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'source'->'exclude') x;
    conditions := array_append(conditions, format('(l.source IS NULL OR l.source <> ALL(%L::text[]))', vals));
  END IF;

  IF p_filters ? 'company' AND jsonb_array_length(COALESCE(p_filters->'company'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'company'->'exclude') x;
    conditions := array_append(conditions, fn_sided_match('l.company', vals, COALESCE(p_filters->'company'->>'excludeMode', 'exact'), true));
  END IF;
  IF p_filters ? 'seniority' AND jsonb_array_length(COALESCE(p_filters->'seniority'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'seniority'->'exclude') x;
    conditions := array_append(conditions, format('(l.seniority IS NULL OR l.seniority <> ALL(%L::text[]))', vals));
  END IF;
  IF p_filters ? 'esp' AND jsonb_array_length(COALESCE(p_filters->'esp'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'esp'->'exclude') x;
    conditions := array_append(conditions, format('(l.esp IS NULL OR l.esp <> ALL(%L::text[]))', vals));
  END IF;

  IF p_filters ? 'category' AND jsonb_array_length(COALESCE(p_filters->'category'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'category'->'exclude') x;
    conditions := array_append(conditions, fn_sided_match('l.category', vals, COALESCE(p_filters->'category'->>'excludeMode', 'exact'), true));
  END IF;

  IF p_filters ? 'subcategory' AND jsonb_array_length(COALESCE(p_filters->'subcategory'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'subcategory'->'exclude') x;
    conditions := array_append(conditions, fn_sided_match('l.subcategory', vals, COALESCE(p_filters->'subcategory'->>'excludeMode', 'exact'), true));
  END IF;
  IF p_filters ? 'additionalCategory' AND jsonb_array_length(COALESCE(p_filters->'additionalCategory'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'additionalCategory'->'exclude') x;
    conditions := array_append(conditions, fn_sided_match('l.additional_category', vals, COALESCE(p_filters->'additionalCategory'->>'excludeMode', 'exact'), true));
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND jsonb_array_length(COALESCE(p_filters->'location'->'country'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'country'->'exclude') x;
    conditions := array_append(conditions, format('(l.country IS NULL OR l.country <> ALL(%L::text[]))', vals));
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND jsonb_array_length(COALESCE(p_filters->'location'->'state'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'state'->'exclude') x;
    IF COALESCE(p_filters->'location'->'state'->>'excludeMode', 'exact') = 'exact' THEN
      conditions := array_append(conditions, fn_state_match(vals, true));
    ELSE
      conditions := array_append(conditions, fn_sided_match('l.state', vals, 'contains', true));
    END IF;
  END IF;

  IF p_filters ? 'jobTitle' AND COALESCE((p_filters->'jobTitle'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.title IS NOT NULL AND TRIM(l.title) <> '''')');
  END IF;
  IF p_filters ? 'generalIndustry' AND COALESCE((p_filters->'generalIndustry'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.general_industry IS NOT NULL AND TRIM(l.general_industry) <> '''')');
  END IF;
  IF p_filters ? 'specificIndustry' AND COALESCE((p_filters->'specificIndustry'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.specific_industry IS NOT NULL AND TRIM(l.specific_industry) <> '''')');
  END IF;
  IF p_filters ? 'source' AND COALESCE((p_filters->'source'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.source IS NOT NULL AND TRIM(l.source) <> '''')');
  END IF;

  IF p_filters ? 'company' AND COALESCE((p_filters->'company'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.company IS NOT NULL AND TRIM(l.company) <> '''')');
  END IF;
  IF p_filters ? 'seniority' AND COALESCE((p_filters->'seniority'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.seniority IS NOT NULL AND TRIM(l.seniority) <> '''')');
  END IF;
  IF p_filters ? 'esp' AND COALESCE((p_filters->'esp'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.esp IS NOT NULL AND TRIM(l.esp) <> '''')');
  END IF;

  IF p_filters ? 'category' AND COALESCE((p_filters->'category'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.category IS NOT NULL AND TRIM(l.category) <> '''')');
  END IF;

  IF p_filters ? 'subcategory' AND COALESCE((p_filters->'subcategory'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.subcategory IS NOT NULL AND TRIM(l.subcategory) <> '''')');
  END IF;
  IF p_filters ? 'additionalCategory' AND COALESCE((p_filters->'additionalCategory'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.additional_category IS NOT NULL AND TRIM(l.additional_category) <> '''')');
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND COALESCE((p_filters->'location'->'country'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.country IS NOT NULL AND TRIM(l.country) <> '''')');
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND COALESCE((p_filters->'location'->'state'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.state IS NOT NULL AND TRIM(l.state) <> '''')');
  END IF;

  IF (p_filters->>'excludeEmptyName')::boolean IS TRUE THEN
    conditions := array_append(conditions, '(l.first_name IS NOT NULL AND l.first_name <> '''' OR l.last_name IS NOT NULL AND l.last_name <> '''')');
  END IF;
  IF (p_filters->>'excludeEmptyCompany')::boolean IS TRUE THEN
    conditions := array_append(conditions, '(l.company IS NOT NULL AND l.company <> '''')');
  END IF;

  IF p_filters ? 'companySize' THEN
    DECLARE cs_cond TEXT; BEGIN
      cs_cond := fn_handle_company_size(p_filters);
      IF cs_cond IS NOT NULL THEN
        conditions := array_append(conditions, cs_cond);
      END IF;
    END;
  END IF;

  IF p_filters ? 'revenue' THEN
    DECLARE
      rb JSONB := COALESCE(p_filters->'revenue'->'buckets', '[]'::jsonb);
      iu BOOLEAN := COALESCE((p_filters->'revenue'->>'includeUnknown')::boolean, false);
      rc TEXT[] := '{}'; b TEXT;
    BEGIN
      IF jsonb_array_length(rb) > 0 THEN
        FOR b IN SELECT jsonb_array_elements_text(rb) LOOP
          CASE b
            WHEN '<$1M' THEN rc := array_append(rc, '(l.annual_revenue >= 0 AND l.annual_revenue < 1000000)');
            WHEN '$1M-$10M' THEN rc := array_append(rc, '(l.annual_revenue >= 1000000 AND l.annual_revenue < 10000000)');
            WHEN '$10M-$50M' THEN rc := array_append(rc, '(l.annual_revenue >= 10000000 AND l.annual_revenue < 50000000)');
            WHEN '$50M-$100M' THEN rc := array_append(rc, '(l.annual_revenue >= 50000000 AND l.annual_revenue < 100000000)');
            WHEN '$100M-$500M' THEN rc := array_append(rc, '(l.annual_revenue >= 100000000 AND l.annual_revenue < 500000000)');
            WHEN '$500M+' THEN rc := array_append(rc, '(l.annual_revenue >= 500000000)');
            ELSE NULL;
          END CASE;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(rc, ' OR ') || ')');
      ELSIF iu THEN
        conditions := array_append(conditions, 'l.annual_revenue IS NOT NULL');
      END IF;
    END;
  END IF;

  -- KEYWORD — two modes:
  --   contains (default): substring across company/industries/overview.
  --   exact: whole-term matching across company, domain, category, subcategory,
  --     additional_category. Multi-word terms match as a word-boundaried phrase
  --     (plural-tolerant: "dry cleaner" also hits "dry cleaners" but NEVER bare
  --     "cleaner"); single words are word-START anchored so "house" catches
  --     "housecleaning" while "cleaner" does not catch "drycleaner".
  IF p_filters ? 'keyword' THEN
    DECLARE
      kw_inc_exact BOOLEAN := COALESCE(p_filters->'keyword'->>'includeMode', p_filters->'keyword'->>'matchMode', 'contains') = 'exact';
      kw_exc_exact BOOLEAN := COALESCE(p_filters->'keyword'->>'excludeMode', p_filters->'keyword'->>'matchMode', 'contains') = 'exact';
      kw_rx TEXT;
    BEGIN
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'include', '[]'::jsonb)) > 0 THEN
      IF kw_inc_exact THEN
        DECLARE kw_any TEXT[] := '{}'; BEGIN
          FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'include') LOOP
            kw_rx := fn_exact_term_regex(v);
            kw_any := array_append(kw_any, format(
              '(l.company ~* %L OR l.domain ~* %L OR l.category ~* %L OR l.subcategory ~* %L OR l.additional_category ~* %L)',
              kw_rx, kw_rx, kw_rx, kw_rx, kw_rx));
          END LOOP;
          conditions := array_append(conditions, '(' || array_to_string(kw_any, ' OR ') || ')');
        END;
      ELSE
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'include') LOOP
          conditions := array_append(conditions, format(
            '(l.company ILIKE %L OR l.general_industry ILIKE %L OR l.specific_industry ILIKE %L OR l.company_overview ILIKE %L)',
            '%' || v || '%', '%' || v || '%', '%' || v || '%', '%' || v || '%'));
        END LOOP;
      END IF;
    END IF;
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'exclude', '[]'::jsonb)) > 0 THEN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'exclude') LOOP
        IF kw_exc_exact THEN
          kw_rx := fn_exact_term_regex(v);
          conditions := array_append(conditions, format(
            '(COALESCE(l.company, '''') !~* %L AND COALESCE(l.domain, '''') !~* %L AND COALESCE(l.category, '''') !~* %L AND COALESCE(l.subcategory, '''') !~* %L AND COALESCE(l.additional_category, '''') !~* %L)',
            kw_rx, kw_rx, kw_rx, kw_rx, kw_rx));
        ELSE
          conditions := array_append(conditions, format(
            '(COALESCE(l.company, '''') NOT ILIKE %L AND COALESCE(l.general_industry, '''') NOT ILIKE %L AND COALESCE(l.specific_industry, '''') NOT ILIKE %L AND COALESCE(l.company_overview, '''') NOT ILIKE %L)',
            '%' || v || '%', '%' || v || '%', '%' || v || '%', '%' || v || '%'));
        END IF;
      END LOOP;
    END IF;
    END;
  END IF;

  -- CATEGORY SEARCH: contains-match terms across category / subcategory /
  -- additional_category. Type "dry" -> matches "Dry cleaner", "Dry cleaning
  -- service", etc. Include = OR of the terms; exclude removes any match.
  IF p_filters ? 'categorySearch' THEN
    DECLARE
      cs_inc_exact BOOLEAN := COALESCE(p_filters->'categorySearch'->>'includeMode', p_filters->'categorySearch'->>'matchMode', 'contains') = 'exact';
      cs_exc_exact BOOLEAN := COALESCE(p_filters->'categorySearch'->>'excludeMode', p_filters->'categorySearch'->>'matchMode', 'contains') = 'exact';
      cs_rx TEXT;
    BEGIN
      -- ONE alternation regex covering every term, tested once per column, instead
      -- of one condition PER TERM x 7 columns. Identical result set:
      --   OR over terms of (OR over cols: col ~ t)  ==  OR over cols of (col ~ t1|t2|...)
      --   AND over terms of (AND over cols: NOT col ~ t) == AND over cols of (NOT col ~ t1|t2|...)
      -- but 91 terms goes from 637 regex evaluations per row to 7. Same collapse
      -- migration 079 applied to fn_client_eligibility_conditions.
      IF jsonb_array_length(COALESCE(p_filters->'categorySearch'->'include', '[]'::jsonb)) > 0 THEN
        SELECT string_agg('(' || CASE WHEN cs_inc_exact THEN fn_exact_term_regex(x) ELSE fn_regex_escape(x) END || ')', '|')
          INTO cs_rx
          FROM jsonb_array_elements_text(p_filters->'categorySearch'->'include') AS x
         WHERE NULLIF(TRIM(x), '') IS NOT NULL;
        IF cs_rx IS NOT NULL THEN
          conditions := array_append(conditions, format(
            '(l.category ~* %L OR l.subcategory ~* %L OR l.additional_category ~* %L OR l.company ~* %L OR l.general_industry ~* %L OR l.specific_industry ~* %L OR l.company_overview ~* %L)',
            cs_rx, cs_rx, cs_rx, cs_rx, cs_rx, cs_rx, cs_rx));
        END IF;
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'categorySearch'->'exclude', '[]'::jsonb)) > 0 THEN
        SELECT string_agg('(' || CASE WHEN cs_exc_exact THEN fn_exact_term_regex(x) ELSE fn_regex_escape(x) END || ')', '|')
          INTO cs_rx
          FROM jsonb_array_elements_text(p_filters->'categorySearch'->'exclude') AS x
         WHERE NULLIF(TRIM(x), '') IS NOT NULL;
        IF cs_rx IS NOT NULL THEN
          conditions := array_append(conditions, format(
            '(COALESCE(l.category, '''') !~* %L AND COALESCE(l.subcategory, '''') !~* %L AND COALESCE(l.additional_category, '''') !~* %L AND COALESCE(l.company, '''') !~* %L AND COALESCE(l.general_industry, '''') !~* %L AND COALESCE(l.specific_industry, '''') !~* %L AND COALESCE(l.company_overview, '''') !~* %L)',
            cs_rx, cs_rx, cs_rx, cs_rx, cs_rx, cs_rx, cs_rx));
        END IF;
      END IF;
    END;
  END IF;

  -- CUSTOM TAGS: free-text substring match on leads.tags (any tag, not just
  -- client tags). Separate from the 'tags' (Client Tags) filter.
  IF p_filters ? 'customTags' THEN
    DECLARE ctg TEXT[] := '{}';
            ct_mi TEXT := COALESCE(p_filters->'customTags'->>'includeMode', 'contains');
            ct_me TEXT := COALESCE(p_filters->'customTags'->>'excludeMode', 'contains'); BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'customTags'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'customTags'->'include') LOOP
          IF ct_mi = 'exact' THEN
            ctg := array_append(ctg, format('l.tags ~* %L', '(^|,)\s*' || fn_regex_escape(v) || '\s*(,|$)'));
          ELSE
            ctg := array_append(ctg, format('l.tags ILIKE %L', '%' || v || '%'));
          END IF;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(ctg, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'customTags'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'customTags'->'exclude') LOOP
          IF ct_me = 'exact' THEN
            conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags !~* %L)', '(^|,)\s*' || fn_regex_escape(v) || '\s*(,|$)'));
          ELSE
            conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags NOT ILIKE %L)', '%' || v || '%'));
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- WEBSITE / DOMAIN search: matches the website column, the domain column, OR
  -- the domain derived from the email (so it works even where domain is unset).
  IF p_filters ? 'website' THEN
    DECLARE wq TEXT[] := '{}'; dom TEXT := 'COALESCE(l.domain, split_part(lower(l.email), ''@'', 2))';
            wb_mi TEXT := COALESCE(p_filters->'website'->>'includeMode', 'contains');
            wb_me TEXT := COALESCE(p_filters->'website'->>'excludeMode', 'contains'); BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'website'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'website'->'include') LOOP
          IF wb_mi = 'exact' THEN
            wq := array_append(wq, format('(LOWER(COALESCE(l.website, '''')) = LOWER(%L) OR ' || dom || ' = LOWER(%L))', v, v));
          ELSE
            wq := array_append(wq, format('(COALESCE(l.website, '''') ILIKE %L OR ' || dom || ' ILIKE %L)', '%' || v || '%', '%' || v || '%'));
          END IF;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(wq, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'website'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'website'->'exclude') LOOP
          IF wb_me = 'exact' THEN
            conditions := array_append(conditions, format('(LOWER(COALESCE(l.website, '''')) <> LOWER(%L) AND ' || dom || ' <> LOWER(%L))', v, v));
          ELSE
            conditions := array_append(conditions, format('(COALESCE(l.website, '''') NOT ILIKE %L AND ' || dom || ' NOT ILIKE %L)', '%' || v || '%', '%' || v || '%'));
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- EMAIL CONTAINS (weebly.com / .gov / walmart.com purge-style searches)
  IF p_filters ? 'emailContains' THEN
    DECLARE ec TEXT[] := '{}'; BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'emailContains'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'emailContains'->'include') LOOP
          ec := array_append(ec, format('l.email ILIKE %L', '%' || v || '%'));
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(ec, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'emailContains'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'emailContains'->'exclude') LOOP
          conditions := array_append(conditions, format('l.email NOT ILIKE %L', '%' || v || '%'));
        END LOOP;
      END IF;
    END;
  END IF;

  -- TAGS (Bison comma-separated tags: client tags, ESP tags, ...)
  IF p_filters ? 'tags' THEN
    DECLARE tg TEXT[] := '{}';
            tg_mi TEXT := COALESCE(p_filters->'tags'->>'includeMode', 'contains');
            tg_me TEXT := COALESCE(p_filters->'tags'->>'excludeMode', 'contains'); BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'tags'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'tags'->'include') LOOP
          IF tg_mi = 'exact' THEN
            tg := array_append(tg, format('l.tags ~* %L', '(^|,)\s*' || fn_regex_escape(v) || '\s*(,|$)'));
          ELSE
            tg := array_append(tg, format('l.tags ILIKE %L', '%' || v || '%'));
          END IF;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(tg, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'tags'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'tags'->'exclude') LOOP
          IF tg_me = 'exact' THEN
            conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags !~* %L)', '(^|,)\s*' || fn_regex_escape(v) || '\s*(,|$)'));
          ELSE
            conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags NOT ILIKE %L)', '%' || v || '%'));
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- GLOBAL SEARCH: comma-separated terms OR'd across email/company/name/domain/categories
  IF p_filters ? 'globalSearch' AND TRIM(COALESCE(p_filters->>'globalSearch', '')) <> '' THEN
    DECLARE gs TEXT[] := '{}'; term TEXT; BEGIN
      FOREACH term IN ARRAY string_to_array(p_filters->>'globalSearch', ',') LOOP
        term := TRIM(term);
        IF term <> '' THEN
          gs := array_append(gs, format(
            '(l.email ILIKE %L OR l.company ILIKE %L OR l.first_name ILIKE %L OR l.last_name ILIKE %L OR l.domain ILIKE %L OR l.category ILIKE %L OR l.subcategory ILIKE %L)',
            '%' || term || '%', '%' || term || '%', '%' || term || '%', '%' || term || '%', '%' || term || '%', '%' || term || '%', '%' || term || '%'));
        END IF;
      END LOOP;
      IF array_length(gs, 1) > 0 THEN
        conditions := array_append(conditions, '(' || array_to_string(gs, ' OR ') || ')');
      END IF;
    END;
  END IF;

  -- EMAIL SIDE (send-to-Bison split): 'b2c' = freemail domain, 'b2b' = business
  IF COALESCE(p_filters->>'emailSide', '') = 'b2c' THEN
    conditions := array_append(conditions, 'split_part(lower(l.email), ''@'', 2) IN (SELECT domain FROM freemail_domains)');
  ELSIF COALESCE(p_filters->>'emailSide', '') = 'b2b' THEN
    conditions := array_append(conditions, 'split_part(lower(l.email), ''@'', 2) NOT IN (SELECT domain FROM freemail_domains)');
  END IF;

  -- EMAIL TYPE (same logic as fn_filter_leads_v2)
  IF p_filters ? 'emailType' THEN
    DECLARE
      want_personal BOOLEAN := COALESCE((p_filters->'emailType'->>'personal')::boolean, true);
      want_general  BOOLEAN := COALESCE((p_filters->'emailType'->>'general')::boolean, true);
    BEGIN
      IF want_personal AND NOT want_general THEN
        conditions := array_append(conditions, 'l.email_type = ''personal''');
      ELSIF want_general AND NOT want_personal THEN
        conditions := array_append(conditions, 'l.email_type = ''general''');
      ELSIF NOT want_personal AND NOT want_general THEN
        conditions := array_append(conditions, 'false');
      END IF;
    END;
  END IF;

  -- COMMERCIAL CLEANING CLIENT: exclude leads whose title matches the default
  -- exclusion list (whole-word, plural-tolerant). Leads without a title stay.
  IF COALESCE((p_filters->>'commercialCleaning')::boolean, false) THEN
    DECLARE cc_rx TEXT; BEGIN
      SELECT string_agg('(' || fn_whole_term_regex(term) || ')', '|') INTO cc_rx
      FROM commercial_cleaning_excluded_titles;
      IF cc_rx IS NOT NULL THEN
        conditions := array_append(conditions, format('(l.title IS NULL OR TRIM(l.title) = '''' OR l.title !~* %L)', cc_rx));
      END IF;
    END;
  END IF;

  -- LOCATION TARGETS: entity-based hierarchy targeting (migration 066).
  -- {include:[{country,state,city}], exclude:[...]} — exact normalized
  -- matching, exclusions override inclusions.
  IF p_filters ? 'locationTargets' THEN
    DECLARE lt_inc TEXT[] := '{}'; lt_c TEXT; lt_e JSONB; BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'locationTargets'->'include', '[]'::jsonb)) > 0 THEN
        FOR lt_e IN SELECT jsonb_array_elements(p_filters->'locationTargets'->'include') LOOP
          lt_c := fn_location_entry_condition(lt_e, false);
          IF lt_c IS NOT NULL THEN lt_inc := array_append(lt_inc, lt_c); END IF;
        END LOOP;
        IF array_length(lt_inc, 1) > 0 THEN
          conditions := array_append(conditions, '(' || array_to_string(lt_inc, ' OR ') || ')');
        END IF;
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'locationTargets'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR lt_e IN SELECT jsonb_array_elements(p_filters->'locationTargets'->'exclude') LOOP
          lt_c := fn_location_entry_condition(lt_e, true);
          IF lt_c IS NOT NULL THEN conditions := array_append(conditions, lt_c); END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- CLIENT TARGETING: full per-client rule set (send-preview / push-worker)
  IF COALESCE(p_filters->>'applyClientTargeting', '') <> '' THEN
    conditions := conditions || fn_client_eligibility_conditions(p_filters->>'applyClientTargeting');
  END IF;

  -- SILENT GATES: leads confidently outside supported countries, and leads in
  -- the unresolved-location review queue, are hidden from search + campaigns
  -- unless explicitly overridden.
  IF NOT COALESCE((p_filters->>'includeUnsupported')::boolean, false) THEN
    conditions := array_append(conditions, '(l.location_status IS DISTINCT FROM ''unsupported'')');
  END IF;
  IF NOT COALESCE((p_filters->>'includeUnresolved')::boolean, false) THEN
    conditions := array_append(conditions, '(l.location_status IS DISTINCT FROM ''unresolved'')');
  END IF;

  -- COLUMN FILTERS — the spreadsheet-style dropdown on each table header
  -- (2026-08-25). Shape: {"state": ["Nevada","Utah"], "esp": ["google"]}.
  --
  -- Semantics deliberately match a spreadsheet: the array is a KEEP-list of
  -- values the user left ticked, so an ABSENT or EMPTY array means "no
  -- constraint on this column", never "match nothing" — unticking everything
  -- would otherwise silently empty the table with no filter chip to explain it.
  --
  -- '__BLANK__' is the sentinel for NULL/empty, so rows with no value can be
  -- kept or dropped like any other value rather than being unfilterable.
  IF p_filters ? 'columnFilters' THEN
    DECLARE
      cf_col TEXT; cf_want TEXT[]; cf_blank BOOLEAN; cf_vals TEXT[]; cf_cond TEXT;
    BEGIN
      FOR cf_col IN SELECT jsonb_object_keys(p_filters->'columnFilters') LOOP
        -- Column names are never taken on trust: anything outside this fixed
        -- set is skipped, so a crafted payload cannot reach the SQL text. %I
        -- quotes the identifier on top of that.
        IF cf_col NOT IN (
          'source','title','company','city','state','email_type','esp','category',
          'subcategory','validation_status','replies','country','seniority',
          'general_industry','specific_industry','company_size','location_status',
          'additional_category','postal_code','annual_revenue'
        ) THEN
          CONTINUE;
        END IF;

        SELECT array_agg(x) INTO cf_want
          FROM jsonb_array_elements_text(p_filters->'columnFilters'->cf_col) x;
        IF cf_want IS NULL OR array_length(cf_want, 1) IS NULL THEN CONTINUE; END IF;

        cf_blank := '__BLANK__' = ANY(cf_want);
        SELECT array_agg(x) INTO cf_vals FROM unnest(cf_want) x WHERE x <> '__BLANK__';

        cf_cond := NULL;
        IF cf_vals IS NOT NULL AND array_length(cf_vals, 1) > 0 THEN
          cf_cond := format('TRIM(l.%I::text) = ANY(%L::text[])', cf_col, cf_vals);
        END IF;
        IF cf_blank THEN
          cf_cond := COALESCE(cf_cond || ' OR ', '')
                  || format('l.%I IS NULL OR TRIM(l.%I::text) = ''''', cf_col, cf_col);
        END IF;
        IF cf_cond IS NOT NULL THEN
          conditions := array_append(conditions, '(' || cf_cond || ')');
        END IF;
      END LOOP;
    END;
  END IF;

  -- SUPPRESSED ADDRESSES (091): permanently do-not-contact, hidden from browse
  -- and every export by default. includeSuppressed:true is the deliberate
  -- escape hatch for reviewing what has been suppressed.
  IF NOT COALESCE((p_filters->>'includeSuppressed')::boolean, false) THEN
    conditions := array_append(conditions, '(l.is_suppressed = false)');
  END IF;

  RETURN conditions;
END;
$function$
;

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

  -- SUPPRESSED ADDRESSES (091): never eligible for any client, on any campaign,
  -- with no override. This is the point of the list — a deleted lead comes back
  -- on the next Bison sync, so the gate has to be on the address, permanently.
  conds := array_append(conds, '(l.is_suppressed = false)');

  RETURN conds;
END;
$function$
;
