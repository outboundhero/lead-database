-- OutboundHero Database: align schema to Email Bison CSV field names + add Bison-native columns
--
-- Renames (table is empty at apply time → instant, lossless):
--   job_title        -> title    (CSV "title")
--   company_name_raw -> company  (CSV "company")
--   keywords         -> tags     (CSV "comma separated tags")
--
-- Adds Bison-native columns (all nullable / defaulted so non-Bison imports still work):
--   bison_lead_id, workspace_id, workspace_name, instance_url, notes, bison_status,
--   emails_sent, opens, replies, bounces, unique_replies, unique_opens   (engagement)
--   address, question, company_phone, google_maps_url                    (from custom_variables JSON)
--
-- Then redefines all 9 functions that referenced the renamed columns. Each function body
-- below was captured from the live DB and transformed with word-boundary-safe renames, so
-- identifiers like lead_job_titles / total_job_titles / leads_by_job_title are preserved.

-- ── 1. Column renames ────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='job_title')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='title') THEN
    ALTER TABLE leads RENAME COLUMN job_title TO title;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='company_name_raw')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='company') THEN
    ALTER TABLE leads RENAME COLUMN company_name_raw TO company;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='keywords')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='tags') THEN
    ALTER TABLE leads RENAME COLUMN keywords TO tags;
  END IF;
END $$;

-- ── 2. New Bison-native columns ──────────────────────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bison_lead_id   BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS workspace_id    INT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS workspace_name  TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS instance_url    TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes           TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bison_status    TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS emails_sent     INT DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS opens           INT DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS replies         INT DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bounces         INT DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS unique_replies  INT DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS unique_opens    INT DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS address         TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS question        TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_phone   TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_maps_url TEXT;

-- bison_lead_id is unique per workspace; index for fast dedup on re-import.
CREATE INDEX IF NOT EXISTS idx_leads_bison_lead_id ON leads (bison_lead_id) WHERE bison_lead_id IS NOT NULL;

-- ── 3. Redefine functions (captured from live DB, renamed) ────────────────

-- ───────────────── fn_sync_lead_job_titles ─────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_lead_job_titles()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  raw TEXT;
  parsed JSONB;
  title_text TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title THEN
    RETURN NEW;
  END IF;
  DELETE FROM lead_job_titles WHERE lead_id = NEW.id;
  raw := TRIM(COALESCE(NEW.title, ''));
  IF raw = '' THEN
    RETURN NEW;
  END IF;
  -- Try to parse as JSON array first
  IF left(raw, 1) = '[' THEN
    BEGIN
      parsed := raw::jsonb;
      FOR title_text IN SELECT jsonb_array_elements_text(parsed) LOOP
        IF TRIM(title_text) <> '' THEN
          INSERT INTO lead_job_titles (lead_id, title) VALUES (NEW.id, TRIM(title_text));
        END IF;
      END LOOP;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- fall through to plain insert
    END;
  END IF;
  INSERT INTO lead_job_titles (lead_id, title) VALUES (NEW.id, raw);
  RETURN NEW;
END;
$function$

;

-- ───────────────── fn_filter_leads ─────────────────
CREATE OR REPLACE FUNCTION public.fn_filter_leads(p_source text[] DEFAULT NULL::text[], p_source_exclude text[] DEFAULT NULL::text[], p_job_title text[] DEFAULT NULL::text[], p_job_title_exclude text[] DEFAULT NULL::text[], p_seniority text[] DEFAULT NULL::text[], p_general_industry text[] DEFAULT NULL::text[], p_general_industry_exclude text[] DEFAULT NULL::text[], p_specific_industry text[] DEFAULT NULL::text[], p_specific_industry_exclude text[] DEFAULT NULL::text[], p_company_size text[] DEFAULT NULL::text[], p_annual_revenue text[] DEFAULT NULL::text[], p_esp text[] DEFAULT NULL::text[], p_country text[] DEFAULT NULL::text[], p_country_exclude text[] DEFAULT NULL::text[], p_state text[] DEFAULT NULL::text[], p_state_exclude text[] DEFAULT NULL::text[], p_city text DEFAULT NULL::text, p_company_name text DEFAULT NULL::text, p_full_name text DEFAULT NULL::text, p_keyword text DEFAULT NULL::text, p_technologies text[] DEFAULT NULL::text[], p_sort_by text DEFAULT 'created_at'::text, p_sort_dir text DEFAULT 'desc'::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 50)
 RETURNS TABLE(leads_data jsonb, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_offset INT;
  v_query TEXT;
  v_count_query TEXT;
  v_where TEXT := 'WHERE 1=1';
  v_total BIGINT;
  v_result JSONB;
BEGIN
  v_offset := (p_page - 1) * p_page_size;

  -- Build WHERE clause dynamically
  -- Source filters
  IF p_source IS NOT NULL AND array_length(p_source, 1) > 0 THEN
    v_where := v_where || ' AND l.source = ANY($1)';
  END IF;
  IF p_source_exclude IS NOT NULL AND array_length(p_source_exclude, 1) > 0 THEN
    v_where := v_where || ' AND l.source != ALL($2)';
  END IF;

  -- Job title filters
  IF p_job_title IS NOT NULL AND array_length(p_job_title, 1) > 0 THEN
    v_where := v_where || ' AND l.job_title_normalized = ANY($3)';
  END IF;
  IF p_job_title_exclude IS NOT NULL AND array_length(p_job_title_exclude, 1) > 0 THEN
    v_where := v_where || ' AND l.job_title_normalized != ALL($4)';
  END IF;

  -- Seniority
  IF p_seniority IS NOT NULL AND array_length(p_seniority, 1) > 0 THEN
    v_where := v_where || ' AND l.seniority = ANY($5)';
  END IF;

  -- Industry filters
  IF p_general_industry IS NOT NULL AND array_length(p_general_industry, 1) > 0 THEN
    v_where := v_where || ' AND l.general_industry = ANY($6)';
  END IF;
  IF p_general_industry_exclude IS NOT NULL AND array_length(p_general_industry_exclude, 1) > 0 THEN
    v_where := v_where || ' AND l.general_industry != ALL($7)';
  END IF;
  IF p_specific_industry IS NOT NULL AND array_length(p_specific_industry, 1) > 0 THEN
    v_where := v_where || ' AND l.specific_industry = ANY($8)';
  END IF;
  IF p_specific_industry_exclude IS NOT NULL AND array_length(p_specific_industry_exclude, 1) > 0 THEN
    v_where := v_where || ' AND l.specific_industry != ALL($9)';
  END IF;

  -- Company size
  IF p_company_size IS NOT NULL AND array_length(p_company_size, 1) > 0 THEN
    v_where := v_where || ' AND l.company_size = ANY($10)';
  END IF;

  -- Revenue
  IF p_annual_revenue IS NOT NULL AND array_length(p_annual_revenue, 1) > 0 THEN
    v_where := v_where || ' AND l.annual_revenue = ANY($11)';
  END IF;

  -- ESP
  IF p_esp IS NOT NULL AND array_length(p_esp, 1) > 0 THEN
    v_where := v_where || ' AND l.esp = ANY($12)';
  END IF;

  -- Location filters
  IF p_country IS NOT NULL AND array_length(p_country, 1) > 0 THEN
    v_where := v_where || ' AND l.country = ANY($13)';
  END IF;
  IF p_country_exclude IS NOT NULL AND array_length(p_country_exclude, 1) > 0 THEN
    v_where := v_where || ' AND l.country != ALL($14)';
  END IF;
  IF p_state IS NOT NULL AND array_length(p_state, 1) > 0 THEN
    v_where := v_where || ' AND l.state = ANY($15)';
  END IF;
  IF p_state_exclude IS NOT NULL AND array_length(p_state_exclude, 1) > 0 THEN
    v_where := v_where || ' AND l.state != ALL($16)';
  END IF;
  IF p_city IS NOT NULL AND p_city != '' THEN
    v_where := v_where || ' AND l.city ILIKE ''%'' || $17 || ''%''';
  END IF;

  -- Text search filters
  IF p_company_name IS NOT NULL AND p_company_name != '' THEN
    v_where := v_where || ' AND l.company ILIKE ''%'' || $18 || ''%''';
  END IF;
  IF p_full_name IS NOT NULL AND p_full_name != '' THEN
    v_where := v_where || ' AND (l.first_name ILIKE ''%'' || $19 || ''%'' OR l.last_name ILIKE ''%'' || $19 || ''%'')';
  END IF;

  -- Keyword search (full-text)
  IF p_keyword IS NOT NULL AND p_keyword != '' THEN
    v_where := v_where || ' AND to_tsvector(''english'', coalesce(l.company,'''') || '' '' || coalesce(l.general_industry,'''') || '' '' || coalesce(l.company_overview,'''')) @@ plainto_tsquery(''english'', $20)';
  END IF;

  -- Technologies (array contains)
  IF p_technologies IS NOT NULL AND array_length(p_technologies, 1) > 0 THEN
    v_where := v_where || ' AND l.technologies @> $21';
  END IF;

  -- Get total count
  EXECUTE format(
    'SELECT COUNT(*) FROM leads l %s',
    v_where
  ) INTO v_total
  USING p_source, p_source_exclude, p_job_title, p_job_title_exclude,
        p_seniority, p_general_industry, p_general_industry_exclude,
        p_specific_industry, p_specific_industry_exclude,
        p_company_size, p_annual_revenue, p_esp,
        p_country, p_country_exclude, p_state, p_state_exclude,
        p_city, p_company_name, p_full_name, p_keyword, p_technologies;

  -- Get paginated results
  EXECUTE format(
    'SELECT jsonb_agg(row_to_json(sub)) FROM (
      SELECT l.* FROM leads l %s
      ORDER BY l.%I %s
      LIMIT %s OFFSET %s
    ) sub',
    v_where,
    p_sort_by,
    CASE WHEN p_sort_dir = 'asc' THEN 'ASC' ELSE 'DESC' END,
    p_page_size,
    v_offset
  ) INTO v_result
  USING p_source, p_source_exclude, p_job_title, p_job_title_exclude,
        p_seniority, p_general_industry, p_general_industry_exclude,
        p_specific_industry, p_specific_industry_exclude,
        p_company_size, p_annual_revenue, p_esp,
        p_country, p_country_exclude, p_state, p_state_exclude,
        p_city, p_company_name, p_full_name, p_keyword, p_technologies;

  RETURN QUERY SELECT COALESCE(v_result, '[]'::JSONB), v_total;
END;
$function$

;

-- ───────────────── fn_filter_leads_v2 ─────────────────
CREATE OR REPLACE FUNCTION public.fn_filter_leads_v2(p_filters jsonb, p_sort_by text DEFAULT ''::text, p_sort_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  data_rows JSONB;
  total_count BIGINT;
  row_count INT;
  is_approximate BOOLEAN := false;
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
      WHEN 'company' THEN 'company'
      WHEN 'general_industry' THEN 'general_industry'
      WHEN 'updated_at' THEN 'updated_at'
      ELSE 'created_at'
    END || ' ' || CASE WHEN p_sort_dir = 'asc' THEN 'ASC' ELSE 'DESC' END;
  END IF;

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

  IF p_filters ? 'location' AND p_filters->'location' ? 'city' AND (p_filters->'location'->>'city') <> '' THEN
    conditions := array_append(conditions, format('l.city ILIKE %L', '%' || (p_filters->'location'->>'city') || '%'));
  END IF;

  IF p_filters ? 'fullName' AND (p_filters->>'fullName') <> '' THEN
    conditions := array_append(conditions, format('(l.first_name ILIKE %L OR l.last_name ILIKE %L)',
      '%' || (p_filters->>'fullName') || '%', '%' || (p_filters->>'fullName') || '%'));
  END IF;

  IF p_filters ? 'companyName' AND (p_filters->>'companyName') <> '' THEN
    conditions := array_append(conditions, format('l.company ILIKE %L', '%' || (p_filters->>'companyName') || '%'));
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

  -- KEYWORD (new shape: { include: [], exclude: [] })
  -- Searches company, general_industry, specific_industry, company_overview.
  IF p_filters ? 'keyword' THEN
    -- Include: each term must match SOMEWHERE in the 4 columns (terms AND across, columns OR within).
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'include', '[]'::jsonb)) > 0 THEN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'include') LOOP
        conditions := array_append(conditions, format(
          '(l.company ILIKE %L OR l.general_industry ILIKE %L OR l.specific_industry ILIKE %L OR l.company_overview ILIKE %L)',
          '%' || v || '%', '%' || v || '%', '%' || v || '%', '%' || v || '%'));
      END LOOP;
    END IF;
    -- Exclude: no term may match any of the 4 columns.
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'exclude', '[]'::jsonb)) > 0 THEN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'exclude') LOOP
        conditions := array_append(conditions, format(
          '(COALESCE(l.company, '''') NOT ILIKE %L AND COALESCE(l.general_industry, '''') NOT ILIKE %L AND COALESCE(l.specific_industry, '''') NOT ILIKE %L AND COALESCE(l.company_overview, '''') NOT ILIKE %L)',
          '%' || v || '%', '%' || v || '%', '%' || v || '%', '%' || v || '%'));
      END LOOP;
    END IF;
  END IF;

  -- EMAIL TYPE (new): { personal: boolean, general: boolean }
  -- If both true (or absent) → no filter. If exactly one true → filter to that.
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
        -- UI prevents this, but be safe — return no rows
        conditions := array_append(conditions, 'false');
      END IF;
    END;
  END IF;

  -- BOUNCE FILTER (new): default exclude is_bounced=true; admin can include via includeBounced=true
  IF NOT COALESCE((p_filters->>'includeBounced')::boolean, false) THEN
    conditions := array_append(conditions, 'l.is_bounced = false');
  END IF;

  IF array_length(conditions, 1) > 0 THEN
    where_clause := 'WHERE ' || array_to_string(conditions, ' AND ');
  END IF;

  sql_text := format(
    'SELECT jsonb_agg(row_to_json(sub)) FROM (
      SELECT l.id, l.first_name, l.last_name, l.email, l.source,
        l.title, l.company, l.general_industry, l.specific_industry,
        l.phone, l.company_size, l.annual_revenue, l.esp, l.seniority,
        l.country, l.state, l.city, l.website, l.person_linkedin,
        l.company_linkedin, l.company_overview, l.tags, l.status,
        l.domain, l.email_type, l.validation_status, l.validation_provider,
        l.validated_at, l.is_bounced, l.bounced_at, l.created_at, l.updated_at
      FROM leads l %s %s
      LIMIT %s OFFSET %s
    ) sub',
    where_clause, order_clause, p_limit, p_offset
  );
  EXECUTE sql_text INTO data_rows;

  row_count := COALESCE(jsonb_array_length(data_rows), 0);
  IF array_length(conditions, 1) IS NULL OR array_length(conditions, 1) = 0 THEN
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
      DECLARE plan_data JSON;
      BEGIN
        EXECUTE 'EXPLAIN (FORMAT JSON) ' ||
          format('SELECT 1 FROM leads l %s', where_clause)
          INTO plan_data;
        total_count := COALESCE(
          (plan_data::jsonb -> 0 -> 'Plan' ->> 'Plan Rows')::BIGINT,
          p_offset + row_count + 10000
        );
        is_approximate := true;
      EXCEPTION WHEN OTHERS THEN
        total_count := p_offset + row_count + 10000;
        is_approximate := true;
      END;
    END;
  END IF;

  RETURN jsonb_build_object(
    'data', COALESCE(data_rows, '[]'::jsonb),
    'totalCount', total_count,
    'isApproximate', is_approximate
  );
END;
$function$

;

-- ───────────────── fn_export_leads ─────────────────
CREATE OR REPLACE FUNCTION public.fn_export_leads(p_filters jsonb, p_cursor text DEFAULT NULL::text, p_limit integer DEFAULT 10000, p_skip integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  data_rows JSONB;
  where_clause TEXT := '';
  conditions TEXT[] := '{}';
  sql_text TEXT;
  v TEXT;
  vals TEXT[];
  cur_created_at TIMESTAMPTZ;
  cur_id UUID;
  use_composite BOOLEAN := false;
BEGIN
  IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
    IF position('|' in p_cursor) > 0 THEN
      cur_created_at := split_part(p_cursor, '|', 1)::timestamptz;
      cur_id := split_part(p_cursor, '|', 2)::uuid;
      conditions := array_append(conditions, format(
        '(l.created_at, l.id) > (%L::timestamptz, %L::uuid)',
        cur_created_at, cur_id));
      use_composite := true;
    ELSE
      conditions := array_append(conditions, format('l.id > %L', p_cursor));
    END IF;
  END IF;

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

  IF p_filters ? 'location' AND p_filters->'location' ? 'city' AND (p_filters->'location'->>'city') <> '' THEN
    conditions := array_append(conditions, format('l.city ILIKE %L', '%' || (p_filters->'location'->>'city') || '%'));
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

  -- KEYWORD (new shape: { include: [], exclude: [] }) — searches company,
  -- general_industry, specific_industry, company_overview.
  IF p_filters ? 'keyword' THEN
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'include', '[]'::jsonb)) > 0 THEN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'include') LOOP
        conditions := array_append(conditions, format(
          '(l.company ILIKE %L OR l.general_industry ILIKE %L OR l.specific_industry ILIKE %L OR l.company_overview ILIKE %L)',
          '%' || v || '%', '%' || v || '%', '%' || v || '%', '%' || v || '%'));
      END LOOP;
    END IF;
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'exclude', '[]'::jsonb)) > 0 THEN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'exclude') LOOP
        conditions := array_append(conditions, format(
          '(COALESCE(l.company, '''') NOT ILIKE %L AND COALESCE(l.general_industry, '''') NOT ILIKE %L AND COALESCE(l.specific_industry, '''') NOT ILIKE %L AND COALESCE(l.company_overview, '''') NOT ILIKE %L)',
          '%' || v || '%', '%' || v || '%', '%' || v || '%', '%' || v || '%'));
      END LOOP;
    END IF;
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

  -- HARD VALIDATION + BOUNCE GATES (export-only) — no override flag honored here.
  -- Pre-export validation pass (src/lib/validation/validate-leads.ts) is responsible for
  -- populating validation_status for every row that matches the user's filter before the
  -- export RPC is called.
  conditions := array_append(conditions, 'l.validation_status IN (''valid'', ''catch_all'')');
  conditions := array_append(conditions, 'l.is_bounced = false');

  IF array_length(conditions, 1) > 0 THEN
    where_clause := 'WHERE ' || array_to_string(conditions, ' AND ');
  END IF;

  sql_text := format(
    'SELECT jsonb_build_object(''data'', COALESCE(jsonb_agg(row_to_json(sub)), ''[]''::jsonb)) FROM (
      SELECT l.id, l.first_name, l.last_name, l.email, l.source,
        l.title, l.company, l.general_industry, l.specific_industry,
        l.phone, l.company_size, l.annual_revenue, l.esp, l.seniority,
        l.country, l.state, l.city, l.website, l.person_linkedin,
        l.company_linkedin, l.company_overview, l.tags, l.status,
        l.domain, l.email_type, l.validation_status, l.validation_provider,
        l.validated_at, l.created_at, l.updated_at
      FROM leads l %s
      ORDER BY %s
      LIMIT %s OFFSET %s
    ) sub',
    where_clause,
    CASE WHEN use_composite THEN 'l.created_at ASC, l.id ASC' ELSE 'l.id' END,
    p_limit, p_skip
  );
  EXECUTE sql_text INTO data_rows;

  RETURN data_rows;
END;
$function$

;

-- ───────────────── fn_dashboard_stats ─────────────────
CREATE OR REPLACE FUNCTION public.fn_dashboard_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_total_leads BIGINT;
  v_jt_data JSONB;
  v_jt_count INT;
  v_gi_data JSONB;
  v_gi_count INT;
  v_si_count INT;
  v_cs_data JSONB;
  v_time_data JSONB;
  v_result JSONB;
BEGIN
  SELECT reltuples::BIGINT INTO v_total_leads FROM pg_class WHERE relname = 'leads';

  SELECT COALESCE(array_length(options, 1), 0) INTO v_jt_count
  FROM filter_options_cache WHERE col_name = 'title';

  SELECT data INTO v_jt_data FROM dashboard_top_job_titles WHERE id = 1;

  SELECT COALESCE(array_length(options, 1), 0) INTO v_gi_count
  FROM filter_options_cache WHERE col_name = 'general_industry';

  -- Industries: no LIMIT — there are only ~153 distinct values, the dashboard
  -- chart scrolls so showing all is fine.
  SELECT jsonb_agg(row_to_json(t)) INTO v_gi_data FROM (
    SELECT INITCAP(LOWER(general_industry)) AS industry, COUNT(*) AS count
    FROM leads
    WHERE general_industry IS NOT NULL AND general_industry <> ''
    GROUP BY INITCAP(LOWER(general_industry))
    ORDER BY count DESC
  ) t;

  SELECT COALESCE(array_length(options, 1), 0) INTO v_si_count
  FROM filter_options_cache WHERE col_name = 'specific_industry';

  SELECT jsonb_agg(row_to_json(t)) INTO v_cs_data FROM (
    SELECT company_size_bucket AS size, COUNT(*) AS count
    FROM leads
    WHERE company_size_bucket IS NOT NULL
    GROUP BY company_size_bucket
    ORDER BY count DESC
  ) t;

  SELECT jsonb_agg(row_to_json(t)) INTO v_time_data FROM (
    SELECT TO_CHAR(created_at, 'YYYY-MM') AS date, COUNT(*) AS count
    FROM leads
    WHERE created_at >= now() - INTERVAL '12 months'
    GROUP BY 1 ORDER BY 1
  ) t;

  v_result := jsonb_build_object(
    'total_leads', v_total_leads,
    'total_job_titles', v_jt_count,
    'leads_by_job_title', COALESCE(v_jt_data, '[]'::jsonb),
    'total_general_industries', v_gi_count,
    'leads_by_general_industry', COALESCE(v_gi_data, '[]'::jsonb),
    'total_specific_industries', v_si_count,
    'leads_by_company_size', COALESCE(v_cs_data, '[]'::jsonb),
    'leads_over_time', COALESCE(v_time_data, '[]'::jsonb)
  );

  INSERT INTO dashboard_snapshots (
    snapshot_date, total_leads, total_job_titles, leads_by_job_title,
    total_general_industries, leads_by_general_industry, total_specific_industries,
    leads_by_company_size, leads_over_time
  ) VALUES (
    CURRENT_DATE, v_total_leads, v_jt_count, COALESCE(v_jt_data, '[]'::jsonb),
    v_gi_count, COALESCE(v_gi_data, '[]'::jsonb), v_si_count,
    COALESCE(v_cs_data, '[]'::jsonb), COALESCE(v_time_data, '[]'::jsonb)
  )
  ON CONFLICT (snapshot_date) DO UPDATE SET
    total_leads = EXCLUDED.total_leads,
    total_job_titles = EXCLUDED.total_job_titles,
    leads_by_job_title = EXCLUDED.leads_by_job_title,
    total_general_industries = EXCLUDED.total_general_industries,
    leads_by_general_industry = EXCLUDED.leads_by_general_industry,
    total_specific_industries = EXCLUDED.total_specific_industries,
    leads_by_company_size = EXCLUDED.leads_by_company_size,
    leads_over_time = EXCLUDED.leads_over_time;

  RETURN v_result;
END;
$function$

;

-- ───────────────── fn_refresh_top_job_titles ─────────────────
CREATE OR REPLACE FUNCTION public.fn_refresh_top_job_titles()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '300s'
AS $function$
BEGIN
  UPDATE dashboard_top_job_titles SET
    data = COALESCE((
      SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT INITCAP(LOWER(TRIM(title))) AS title, COUNT(*)::int AS count
        FROM lead_job_titles
        GROUP BY INITCAP(LOWER(TRIM(title)))
        ORDER BY count DESC
        LIMIT 100
      ) t
    ), '[]'::jsonb),
    refreshed_at = now()
  WHERE id = 1;
END;
$function$

;

-- ───────────────── fn_refresh_dashboard ─────────────────
CREATE OR REPLACE FUNCTION public.fn_refresh_dashboard()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_total_leads BIGINT;
  v_total_job_titles INT;
  v_total_general_industries INT;
  v_total_specific_industries INT;
  v_by_job_title JSONB;
  v_by_industry JSONB;
  v_by_company_size JSONB;
  v_over_time JSONB;
BEGIN
  -- Total counts
  SELECT COUNT(*) INTO v_total_leads FROM leads;
  SELECT COUNT(DISTINCT job_title_normalized) INTO v_total_job_titles FROM leads WHERE job_title_normalized IS NOT NULL;
  SELECT COUNT(DISTINCT general_industry) INTO v_total_general_industries FROM leads WHERE general_industry IS NOT NULL;
  SELECT COUNT(DISTINCT specific_industry) INTO v_total_specific_industries FROM leads WHERE specific_industry IS NOT NULL;

  -- Top 25 job titles
  SELECT jsonb_agg(row_to_json(sub)) INTO v_by_job_title FROM (
    SELECT job_title_normalized AS title, COUNT(*) AS count
    FROM leads
    WHERE job_title_normalized IS NOT NULL
    GROUP BY job_title_normalized
    ORDER BY count DESC
    LIMIT 25
  ) sub;

  -- Leads by general industry
  SELECT jsonb_agg(row_to_json(sub)) INTO v_by_industry FROM (
    SELECT general_industry AS industry, COUNT(*) AS count
    FROM leads
    WHERE general_industry IS NOT NULL
    GROUP BY general_industry
    ORDER BY count DESC
  ) sub;

  -- Leads by company size
  SELECT jsonb_agg(row_to_json(sub)) INTO v_by_company_size FROM (
    SELECT company_size AS size, COUNT(*) AS count
    FROM leads
    WHERE company_size IS NOT NULL
    GROUP BY company_size
    ORDER BY count DESC
  ) sub;

  -- Leads over time (daily, last 365 days)
  SELECT jsonb_agg(row_to_json(sub)) INTO v_over_time FROM (
    SELECT DATE_TRUNC('day', created_at)::DATE AS date, COUNT(*) AS count
    FROM leads
    WHERE created_at >= now() - INTERVAL '365 days'
    GROUP BY DATE_TRUNC('day', created_at)::DATE
    ORDER BY date
  ) sub;

  -- Insert snapshot
  INSERT INTO dashboard_snapshots (
    snapshot_date, total_leads, total_job_titles,
    total_general_industries, total_specific_industries,
    leads_by_job_title, leads_by_general_industry,
    leads_by_company_size, leads_over_time
  ) VALUES (
    CURRENT_DATE, v_total_leads, v_total_job_titles,
    v_total_general_industries, v_total_specific_industries,
    COALESCE(v_by_job_title, '[]'),
    COALESCE(v_by_industry, '[]'),
    COALESCE(v_by_company_size, '[]'),
    COALESCE(v_over_time, '[]')
  );
END;
$function$

;

-- ───────────────── fn_refresh_filter_cache ─────────────────
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
    SELECT DISTINCT title FROM (
      SELECT TRIM(title) AS title
      FROM leads
      WHERE title IS NOT NULL AND TRIM(title) <> '' AND title !~ '^\s*\['
      UNION
      SELECT TRIM(elem) AS title
      FROM leads,
        LATERAL jsonb_array_elements_text(
          CASE WHEN title ~ '^\s*\[' THEN title::jsonb ELSE '[]'::jsonb END
        ) AS elem
      WHERE title IS NOT NULL AND title ~ '^\s*\['
    ) t
    WHERE title IS NOT NULL AND title <> ''
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

  -- State
  INSERT INTO filter_options_cache (col_name, options, updated_at)
  SELECT 'state', ARRAY(
    SELECT DISTINCT TRIM(state)
    FROM leads
    WHERE state IS NOT NULL AND TRIM(state) <> '' AND LENGTH(TRIM(state)) >= 2
    ORDER BY 1
  ), now()
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at;

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
END;
$function$

;

-- ───────────────── search_column_values ─────────────────
CREATE OR REPLACE FUNCTION public.search_column_values(col_name text, search_term text, max_results integer DEFAULT 50)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  result TEXT[];
BEGIN
  IF search_term IS NULL OR TRIM(search_term) = '' THEN
    SELECT options INTO result FROM filter_options_cache WHERE filter_options_cache.col_name = search_column_values.col_name;
    RETURN COALESCE(result, '{}');
  END IF;

  -- Job title: use the fast junction table
  IF col_name = 'title' THEN
    SELECT ARRAY(
      SELECT DISTINCT title
      FROM lead_job_titles
      WHERE title ILIKE '%' || search_term || '%'
      ORDER BY title
      LIMIT max_results
    ) INTO result;
    RETURN COALESCE(result, '{}');
  END IF;

  -- For other columns: search the cache first, fall back to DB
  SELECT ARRAY(
    SELECT unnest(options)
    FROM filter_options_cache
    WHERE filter_options_cache.col_name = search_column_values.col_name
  ) INTO result;

  IF result IS NOT NULL AND array_length(result, 1) > 0 THEN
    -- Filter cached values
    SELECT ARRAY(
      SELECT v FROM unnest(result) AS v
      WHERE v ILIKE '%' || search_term || '%'
      ORDER BY v
      LIMIT max_results
    ) INTO result;
    RETURN COALESCE(result, '{}');
  END IF;

  -- Fallback: direct DB search
  EXECUTE format(
    'SELECT ARRAY(
       SELECT DISTINCT TRIM(%I::TEXT) AS val
       FROM leads
       WHERE %I IS NOT NULL
         AND TRIM(%I::TEXT) <> ''''
         AND %I ILIKE $1
       ORDER BY val
       LIMIT %s
     )',
    col_name, col_name, col_name, col_name, max_results
  ) INTO result USING '%' || search_term || '%';

  RETURN COALESCE(result, '{}');
END;
$function$

;

-- ── 4. Recreate junction trigger to fire on the renamed `title` column ─────
DROP TRIGGER IF EXISTS trg_sync_lead_job_titles ON leads;
CREATE TRIGGER trg_sync_lead_job_titles
  AFTER INSERT OR UPDATE OF title ON leads
  FOR EACH ROW EXECUTE FUNCTION fn_sync_lead_job_titles();
