-- Fix fn_export_leads to match fn_filter_leads_v2 fixes:
-- 1. Job title filtering: case-insensitive LOWER() comparison
-- 2. includeUnknown: EXCLUDE nulls/empty (not include them)
-- 3. Add missing includeUnknown handling for generalIndustry, specificIndustry, seniority, country, state

CREATE OR REPLACE FUNCTION fn_export_leads(
  p_filters JSONB,
  p_cursor TEXT DEFAULT NULL,
  p_limit INT DEFAULT 10000,
  p_skip INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '300s'
AS $$
DECLARE
  data_rows JSONB;
  where_clause TEXT := '';
  conditions TEXT[] := '{}';
  sql_text TEXT;
  v TEXT;
  vals TEXT[];
BEGIN
  -- Cursor
  IF p_cursor IS NOT NULL THEN
    conditions := array_append(conditions, format('l.id > %L', p_cursor));
  END IF;

  -- INCLUDES

  IF p_filters ? 'jobTitle' AND jsonb_array_length(COALESCE(p_filters->'jobTitle'->'include', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'jobTitle'->'include') x;
    conditions := array_append(conditions, format('l.id IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[]))', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u)));
  END IF;

  IF p_filters ? 'generalIndustry' AND jsonb_array_length(COALESCE(p_filters->'generalIndustry'->'include', '[]'::jsonb)) > 0 THEN
    DECLARE gi_conds TEXT[] := '{}'; BEGIN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'generalIndustry'->'include') LOOP
        gi_conds := array_append(gi_conds, format('LOWER(l.general_industry) = LOWER(%L)', v));
      END LOOP;
      conditions := array_append(conditions, '(' || array_to_string(gi_conds, ' OR ') || ')');
    END;
  END IF;

  IF p_filters ? 'specificIndustry' AND jsonb_array_length(COALESCE(p_filters->'specificIndustry'->'include', '[]'::jsonb)) > 0 THEN
    DECLARE si_conds TEXT[] := '{}'; BEGIN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'specificIndustry'->'include') LOOP
        si_conds := array_append(si_conds, format('LOWER(l.specific_industry) = LOWER(%L)', v));
      END LOOP;
      conditions := array_append(conditions, '(' || array_to_string(si_conds, ' OR ') || ')');
    END;
  END IF;

  IF p_filters ? 'source' AND jsonb_array_length(COALESCE(p_filters->'source'->'include', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'source'->'include') x;
    conditions := array_append(conditions, format('l.source = ANY(%L::text[])', vals));
  END IF;

  IF p_filters ? 'seniority' AND jsonb_array_length(COALESCE(p_filters->'seniority'->'include', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'seniority'->'include') x;
    conditions := array_append(conditions, format('l.seniority = ANY(%L::text[])', vals));
  END IF;

  IF p_filters ? 'esp' AND jsonb_array_length(COALESCE(p_filters->'esp'->'include', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'esp'->'include') x;
    conditions := array_append(conditions, format('l.esp = ANY(%L::text[])', vals));
  END IF;

  IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND jsonb_array_length(COALESCE(p_filters->'location'->'country'->'include', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'country'->'include') x;
    conditions := array_append(conditions, format('l.country = ANY(%L::text[])', vals));
  END IF;

  IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND jsonb_array_length(COALESCE(p_filters->'location'->'state'->'include', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'state'->'include') x;
    conditions := array_append(conditions, format('l.state = ANY(%L::text[])', vals));
  END IF;

  IF p_filters ? 'location' AND p_filters->'location' ? 'city' AND (p_filters->'location'->>'city') <> '' THEN
    conditions := array_append(conditions, format('l.city ILIKE %L', '%' || (p_filters->'location'->>'city') || '%'));
  END IF;

  IF p_filters ? 'companyName' AND (p_filters->>'companyName') <> '' THEN
    conditions := array_append(conditions, format('l.company_name ILIKE %L', '%' || (p_filters->>'companyName') || '%'));
  END IF;

  IF p_filters ? 'fullName' AND (p_filters->>'fullName') <> '' THEN
    conditions := array_append(conditions, format('(l.first_name ILIKE %L OR l.last_name ILIKE %L)',
      '%' || (p_filters->>'fullName') || '%', '%' || (p_filters->>'fullName') || '%'));
  END IF;

  -- EXCLUDES

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

  IF p_filters ? 'seniority' AND jsonb_array_length(COALESCE(p_filters->'seniority'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'seniority'->'exclude') x;
    conditions := array_append(conditions, format('(l.seniority IS NULL OR l.seniority <> ALL(%L::text[]))', vals));
  END IF;

  IF p_filters ? 'esp' AND jsonb_array_length(COALESCE(p_filters->'esp'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'esp'->'exclude') x;
    conditions := array_append(conditions, format('(l.esp IS NULL OR l.esp <> ALL(%L::text[]))', vals));
  END IF;

  IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND jsonb_array_length(COALESCE(p_filters->'location'->'country'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'country'->'exclude') x;
    conditions := array_append(conditions, format('(l.country IS NULL OR l.country <> ALL(%L::text[]))', vals));
  END IF;

  IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND jsonb_array_length(COALESCE(p_filters->'location'->'state'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'state'->'exclude') x;
    conditions := array_append(conditions, format('(l.state IS NULL OR l.state <> ALL(%L::text[]))', vals));
  END IF;

  -- EXCLUDE EMPTY
  IF (p_filters->>'excludeEmptyName')::boolean IS TRUE THEN
    conditions := array_append(conditions, '(l.first_name IS NOT NULL AND l.first_name <> '''' OR l.last_name IS NOT NULL AND l.last_name <> '''')');
  END IF;
  IF (p_filters->>'excludeEmptyCompany')::boolean IS TRUE THEN
    conditions := array_append(conditions, '(l.company_name IS NOT NULL AND l.company_name <> '''')');
  END IF;

  -- COMPANY SIZE (uses helper)
  IF p_filters ? 'companySize' THEN
    DECLARE cs_cond TEXT; BEGIN
      cs_cond := fn_handle_company_size(p_filters);
      IF cs_cond IS NOT NULL THEN
        conditions := array_append(conditions, cs_cond);
      END IF;
    END;
  END IF;

  -- REVENUE
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

  -- KEYWORD
  IF p_filters ? 'keyword' AND (p_filters->>'keyword') <> '' THEN
    DECLARE kw TEXT := p_filters->>'keyword'; BEGIN
      conditions := array_append(conditions, format(
        '(l.company_name ILIKE %L OR l.general_industry ILIKE %L OR l.company_overview ILIKE %L OR l.keywords ILIKE %L)',
        '%' || kw || '%', '%' || kw || '%', '%' || kw || '%', '%' || kw || '%'));
    END;
  END IF;

  -- EXCLUDE UNKNOWN / EMPTY (includeUnknown = true means EXCLUDE nulls/empty)
  IF p_filters ? 'jobTitle' AND COALESCE((p_filters->'jobTitle'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.job_title IS NOT NULL AND TRIM(l.job_title) <> '''')');
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

  IF p_filters ? 'seniority' AND COALESCE((p_filters->'seniority'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.seniority IS NOT NULL AND TRIM(l.seniority) <> '''')');
  END IF;

  IF p_filters ? 'esp' AND COALESCE((p_filters->'esp'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.esp IS NOT NULL AND TRIM(l.esp) <> '''')');
  END IF;

  IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND COALESCE((p_filters->'location'->'country'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.country IS NOT NULL AND TRIM(l.country) <> '''')');
  END IF;

  IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND COALESCE((p_filters->'location'->'state'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.state IS NOT NULL AND TRIM(l.state) <> '''')');
  END IF;

  -- BUILD WHERE
  IF array_length(conditions, 1) > 0 THEN
    where_clause := 'WHERE ' || array_to_string(conditions, ' AND ');
  END IF;

  IF p_skip > 0 THEN
    sql_text := format(
      'SELECT jsonb_agg(row_to_json(sub)) FROM (
        SELECT l.id, l.first_name, l.last_name, l.email, l.source,
          l.job_title, l.company_name, l.general_industry, l.specific_industry,
          l.phone, l.company_size, l.annual_revenue, l.esp, l.seniority,
          l.country, l.state, l.city, l.website, l.person_linkedin,
          l.company_linkedin, l.company_overview, l.keywords, l.status,
          l.domain, l.created_at, l.updated_at
        FROM leads l %s
        ORDER BY l.id
        LIMIT %s OFFSET %s
      ) sub',
      where_clause, p_limit, p_skip
    );
  ELSE
    sql_text := format(
      'SELECT jsonb_agg(row_to_json(sub)) FROM (
        SELECT l.id, l.first_name, l.last_name, l.email, l.source,
          l.job_title, l.company_name, l.general_industry, l.specific_industry,
          l.phone, l.company_size, l.annual_revenue, l.esp, l.seniority,
          l.country, l.state, l.city, l.website, l.person_linkedin,
          l.company_linkedin, l.company_overview, l.keywords, l.status,
          l.domain, l.created_at, l.updated_at
        FROM leads l %s
        ORDER BY l.id
        LIMIT %s
      ) sub',
      where_clause, p_limit
    );
  END IF;

  EXECUTE sql_text INTO data_rows;
  RETURN jsonb_build_object('data', COALESCE(data_rows, '[]'::jsonb));
END;
$$;
