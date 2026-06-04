-- Fix two bugs in fn_filter_leads_v2:
-- 1. Job title filtering uses case-sensitive = ANY() but cache values have different casing
--    than lead_job_titles. Fix: use LOWER() comparison.
-- 2. "Exclude Unknown / Empty" checkbox (includeUnknown flag) was INCLUDING nulls instead of
--    EXCLUDING them. Fix: invert the logic to filter OUT null/empty values.

CREATE OR REPLACE FUNCTION fn_filter_leads_v2(
  p_filters JSONB,
  p_sort_by TEXT DEFAULT '',
  p_sort_dir TEXT DEFAULT 'desc',
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
AS $$
DECLARE
  data_rows JSONB;
  total_count BIGINT;
  row_count INT;
  where_clause TEXT := '';
  conditions TEXT[] := '{}';
  order_clause TEXT := '';
  v TEXT;
  vals TEXT[];
  sql_text TEXT;
BEGIN
  IF p_sort_by IS NOT NULL AND p_sort_by <> '' THEN
    order_clause := 'ORDER BY l.' || CASE p_sort_by
      WHEN 'created_at' THEN 'created_at'
      WHEN 'first_name' THEN 'first_name'
      WHEN 'last_name' THEN 'last_name'
      WHEN 'email' THEN 'email'
      WHEN 'company_name' THEN 'company_name'
      WHEN 'general_industry' THEN 'general_industry'
      WHEN 'updated_at' THEN 'updated_at'
      ELSE 'created_at'
    END || ' ' || CASE WHEN p_sort_dir = 'asc' THEN 'ASC' ELSE 'DESC' END;
  END IF;

  -- INCLUDES

  IF p_filters ? 'jobTitle' AND jsonb_array_length(COALESCE(p_filters->'jobTitle'->'include', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'jobTitle'->'include') x;
    conditions := array_append(conditions, format('l.id IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[]))', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u)));
  END IF;

  IF p_filters ? 'generalIndustry' AND jsonb_array_length(COALESCE(p_filters->'generalIndustry'->'include', '[]'::jsonb)) > 0 THEN
    DECLARE gi TEXT[] := '{}'; BEGIN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'generalIndustry'->'include') LOOP
        gi := array_append(gi, format('LOWER(l.general_industry) = LOWER(%L)', v));
      END LOOP;
      conditions := array_append(conditions, '(' || array_to_string(gi, ' OR ') || ')');
    END;
  END IF;

  IF p_filters ? 'specificIndustry' AND jsonb_array_length(COALESCE(p_filters->'specificIndustry'->'include', '[]'::jsonb)) > 0 THEN
    DECLARE si TEXT[] := '{}'; BEGIN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'specificIndustry'->'include') LOOP
        si := array_append(si, format('LOWER(l.specific_industry) = LOWER(%L)', v));
      END LOOP;
      conditions := array_append(conditions, '(' || array_to_string(si, ' OR ') || ')');
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

  IF p_filters ? 'fullName' AND (p_filters->>'fullName') <> '' THEN
    conditions := array_append(conditions, format('(l.first_name ILIKE %L OR l.last_name ILIKE %L)',
      '%' || (p_filters->>'fullName') || '%', '%' || (p_filters->>'fullName') || '%'));
  END IF;

  IF p_filters ? 'companyName' AND (p_filters->>'companyName') <> '' THEN
    conditions := array_append(conditions, format('l.company_name ILIKE %L', '%' || (p_filters->>'companyName') || '%'));
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

  -- EXCLUDE UNKNOWN / EMPTY (includeUnknown flag = true means EXCLUDE nulls/empty)
  -- When user checks "Exclude Unknown / Empty", we filter OUT rows where field is null or empty.

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

  IF (p_filters->>'excludeEmptyName')::boolean IS TRUE THEN
    conditions := array_append(conditions, '(l.first_name IS NOT NULL AND l.first_name <> '''' OR l.last_name IS NOT NULL AND l.last_name <> '''')');
  END IF;
  IF (p_filters->>'excludeEmptyCompany')::boolean IS TRUE THEN
    conditions := array_append(conditions, '(l.company_name IS NOT NULL AND l.company_name <> '''')');
  END IF;

  -- COMPANY SIZE
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
        -- For revenue with buckets, excludeUnknown means DON'T add "IS NULL" to the OR
        -- Without the flag, nulls are already excluded by the bucket ranges
        conditions := array_append(conditions, '(' || array_to_string(rc, ' OR ') || ')');
      ELSIF iu THEN
        -- No buckets selected, just exclude unknown = filter to only non-null revenue
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

  IF array_length(conditions, 1) > 0 THEN
    where_clause := 'WHERE ' || array_to_string(conditions, ' AND ');
  END IF;

  sql_text := format(
    'SELECT jsonb_agg(row_to_json(sub)) FROM (
      SELECT l.id, l.first_name, l.last_name, l.email, l.source,
        l.job_title, l.company_name, l.general_industry, l.specific_industry,
        l.phone, l.company_size, l.annual_revenue, l.esp, l.seniority,
        l.country, l.state, l.city, l.website, l.person_linkedin,
        l.company_linkedin, l.company_overview, l.keywords, l.status,
        l.domain, l.created_at, l.updated_at
      FROM leads l %s %s
      LIMIT %s OFFSET %s
    ) sub',
    where_clause, order_clause, p_limit, p_offset
  );
  EXECUTE sql_text INTO data_rows;

  -- COUNT
  row_count := COALESCE(jsonb_array_length(data_rows), 0);
  IF array_length(conditions, 1) IS NULL OR array_length(conditions, 1) = 0 THEN
    -- No filters: use dashboard snapshot for accurate count
    SELECT total_leads INTO total_count
    FROM dashboard_snapshots
    ORDER BY snapshot_date DESC
    LIMIT 1;
    IF total_count IS NULL THEN
      SELECT COUNT(*) INTO total_count FROM leads;
    END IF;
  ELSIF row_count < p_limit THEN
    total_count := p_offset + row_count;
  ELSE
    BEGIN
      SET LOCAL statement_timeout = '15s';
      sql_text := format('SELECT COUNT(*) FROM leads l %s', where_clause);
      EXECUTE sql_text INTO total_count;
      RESET statement_timeout;
    EXCEPTION WHEN query_canceled THEN
      RESET statement_timeout;
      total_count := p_offset + row_count + 10000;
    END;
  END IF;

  RETURN jsonb_build_object('data', COALESCE(data_rows, '[]'::jsonb), 'totalCount', total_count);
END;
$$;
