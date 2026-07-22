-- Migration 058: category-search exact mode + Custom Tags filter + Website/Domain filter.

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
  DECLARE su BOOLEAN := COALESCE((p_filters->'jobTitle'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'jobTitle' AND jsonb_array_length(COALESCE(p_filters->'jobTitle'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'jobTitle'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.id IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[])) OR l.title IS NULL OR TRIM(l.title) = '''')', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u)));
      ELSE
        conditions := array_append(conditions, format('l.id IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[]))', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u)));
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

  DECLARE su BOOLEAN := COALESCE((p_filters->'company'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'company' AND jsonb_array_length(COALESCE(p_filters->'company'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'company'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.company = ANY(%L::text[]) OR l.company IS NULL OR TRIM(l.company) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.company = ANY(%L::text[])', vals));
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

  DECLARE su BOOLEAN := COALESCE((p_filters->'category'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'category' AND jsonb_array_length(COALESCE(p_filters->'category'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'category'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.category = ANY(%L::text[]) OR l.category IS NULL OR TRIM(l.category) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.category = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.category IS NULL OR TRIM(l.category) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'subcategory'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'subcategory' AND jsonb_array_length(COALESCE(p_filters->'subcategory'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'subcategory'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.subcategory = ANY(%L::text[]) OR l.subcategory IS NULL OR TRIM(l.subcategory) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.subcategory = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.subcategory IS NULL OR TRIM(l.subcategory) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'additionalCategory'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'additionalCategory' AND jsonb_array_length(COALESCE(p_filters->'additionalCategory'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'additionalCategory'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.additional_category = ANY(%L::text[]) OR l.additional_category IS NULL OR TRIM(l.additional_category) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.additional_category = ANY(%L::text[])', vals));
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
      IF su THEN
        conditions := array_append(conditions, format('(l.state = ANY(%L::text[]) OR l.state IS NULL OR TRIM(l.state) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.state = ANY(%L::text[])', vals));
      END IF;
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
      DECLARE cc TEXT[] := '{}'; BEGIN
        IF jsonb_array_length(COALESCE(p_filters->'location'->'city'->'include', '[]'::jsonb)) > 0 THEN
          FOR v IN SELECT jsonb_array_elements_text(p_filters->'location'->'city'->'include') LOOP
            cc := array_append(cc, format('l.city ILIKE %L', '%' || v || '%'));
          END LOOP;
          conditions := array_append(conditions, '(' || array_to_string(cc, ' OR ') || ')');
        END IF;
        IF jsonb_array_length(COALESCE(p_filters->'location'->'city'->'exclude', '[]'::jsonb)) > 0 THEN
          FOR v IN SELECT jsonb_array_elements_text(p_filters->'location'->'city'->'exclude') LOOP
            conditions := array_append(conditions, format('(l.city IS NULL OR l.city NOT ILIKE %L)', '%' || v || '%'));
          END LOOP;
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
    conditions := array_append(conditions, format('l.id NOT IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[]))', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u)));
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
    conditions := array_append(conditions, format('(l.company IS NULL OR l.company <> ALL(%L::text[]))', vals));
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
    conditions := array_append(conditions, format('(l.category IS NULL OR l.category <> ALL(%L::text[]))', vals));
  END IF;

  IF p_filters ? 'subcategory' AND jsonb_array_length(COALESCE(p_filters->'subcategory'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'subcategory'->'exclude') x;
    conditions := array_append(conditions, format('(l.subcategory IS NULL OR l.subcategory <> ALL(%L::text[]))', vals));
  END IF;
  IF p_filters ? 'additionalCategory' AND jsonb_array_length(COALESCE(p_filters->'additionalCategory'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'additionalCategory'->'exclude') x;
    conditions := array_append(conditions, format('(l.additional_category IS NULL OR l.additional_category <> ALL(%L::text[]))', vals));
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND jsonb_array_length(COALESCE(p_filters->'location'->'country'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'country'->'exclude') x;
    conditions := array_append(conditions, format('(l.country IS NULL OR l.country <> ALL(%L::text[]))', vals));
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND jsonb_array_length(COALESCE(p_filters->'location'->'state'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'state'->'exclude') x;
    conditions := array_append(conditions, format('(l.state IS NULL OR l.state <> ALL(%L::text[]))', vals));
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
      kw_exact BOOLEAN := COALESCE(p_filters->'keyword'->>'matchMode', 'contains') = 'exact';
      kw_rx TEXT;
    BEGIN
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'include', '[]'::jsonb)) > 0 THEN
      IF kw_exact THEN
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
        IF kw_exact THEN
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
      cs TEXT[] := '{}';
      cs_exact BOOLEAN := COALESCE(p_filters->'categorySearch'->>'matchMode', 'contains') = 'exact';
      cs_rx TEXT;
    BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'categorySearch'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'categorySearch'->'include') LOOP
          IF cs_exact THEN
            cs_rx := fn_exact_term_regex(v);
            cs := array_append(cs, format(
              '(l.category ~* %L OR l.subcategory ~* %L OR l.additional_category ~* %L)',
              cs_rx, cs_rx, cs_rx));
          ELSE
            cs := array_append(cs, format(
              '(l.category ILIKE %L OR l.subcategory ILIKE %L OR l.additional_category ILIKE %L)',
              '%' || v || '%', '%' || v || '%', '%' || v || '%'));
          END IF;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(cs, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'categorySearch'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'categorySearch'->'exclude') LOOP
          IF cs_exact THEN
            cs_rx := fn_exact_term_regex(v);
            conditions := array_append(conditions, format(
              '(COALESCE(l.category, '''') !~* %L AND COALESCE(l.subcategory, '''') !~* %L AND COALESCE(l.additional_category, '''') !~* %L)',
              cs_rx, cs_rx, cs_rx));
          ELSE
            conditions := array_append(conditions, format(
              '(COALESCE(l.category, '''') NOT ILIKE %L AND COALESCE(l.subcategory, '''') NOT ILIKE %L AND COALESCE(l.additional_category, '''') NOT ILIKE %L)',
              '%' || v || '%', '%' || v || '%', '%' || v || '%'));
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- CUSTOM TAGS: free-text substring match on leads.tags (any tag, not just
  -- client tags). Separate from the 'tags' (Client Tags) filter.
  IF p_filters ? 'customTags' THEN
    DECLARE ctg TEXT[] := '{}'; BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'customTags'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'customTags'->'include') LOOP
          ctg := array_append(ctg, format('l.tags ILIKE %L', '%' || v || '%'));
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(ctg, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'customTags'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'customTags'->'exclude') LOOP
          conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags NOT ILIKE %L)', '%' || v || '%'));
        END LOOP;
      END IF;
    END;
  END IF;

  -- WEBSITE / DOMAIN search: matches the website column, the domain column, OR
  -- the domain derived from the email (so it works even where domain is unset).
  IF p_filters ? 'website' THEN
    DECLARE wq TEXT[] := '{}'; dom TEXT := 'COALESCE(l.domain, split_part(lower(l.email), ''@'', 2))'; BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'website'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'website'->'include') LOOP
          wq := array_append(wq, format('(COALESCE(l.website, '''') ILIKE %L OR ' || dom || ' ILIKE %L)', '%' || v || '%', '%' || v || '%'));
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(wq, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'website'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'website'->'exclude') LOOP
          conditions := array_append(conditions, format('(COALESCE(l.website, '''') NOT ILIKE %L AND ' || dom || ' NOT ILIKE %L)', '%' || v || '%', '%' || v || '%'));
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
    DECLARE tg TEXT[] := '{}'; BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'tags'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'tags'->'include') LOOP
          tg := array_append(tg, format('l.tags ILIKE %L', '%' || v || '%'));
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(tg, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'tags'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'tags'->'exclude') LOOP
          conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags NOT ILIKE %L)', '%' || v || '%'));
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

  RETURN conditions;
END;
$function$;

