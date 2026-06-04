-- Renaissance Database: Server-side filtering RPC function
-- All filtering goes through this function — server-side, indexed, sub-1-second

CREATE OR REPLACE FUNCTION fn_filter_leads(
  p_source TEXT[] DEFAULT NULL,
  p_source_exclude TEXT[] DEFAULT NULL,
  p_job_title TEXT[] DEFAULT NULL,
  p_job_title_exclude TEXT[] DEFAULT NULL,
  p_seniority TEXT[] DEFAULT NULL,
  p_general_industry TEXT[] DEFAULT NULL,
  p_general_industry_exclude TEXT[] DEFAULT NULL,
  p_specific_industry TEXT[] DEFAULT NULL,
  p_specific_industry_exclude TEXT[] DEFAULT NULL,
  p_company_size TEXT[] DEFAULT NULL,
  p_annual_revenue TEXT[] DEFAULT NULL,
  p_esp TEXT[] DEFAULT NULL,
  p_country TEXT[] DEFAULT NULL,
  p_country_exclude TEXT[] DEFAULT NULL,
  p_state TEXT[] DEFAULT NULL,
  p_state_exclude TEXT[] DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_company_name TEXT DEFAULT NULL,
  p_full_name TEXT DEFAULT NULL,
  p_keyword TEXT DEFAULT NULL,
  p_technologies TEXT[] DEFAULT NULL,
  p_sort_by TEXT DEFAULT 'created_at',
  p_sort_dir TEXT DEFAULT 'desc',
  p_page INT DEFAULT 1,
  p_page_size INT DEFAULT 50
)
RETURNS TABLE(
  leads_data JSONB,
  total_count BIGINT
) AS $$
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
    v_where := v_where || ' AND l.company_name ILIKE ''%'' || $18 || ''%''';
  END IF;
  IF p_full_name IS NOT NULL AND p_full_name != '' THEN
    v_where := v_where || ' AND (l.first_name ILIKE ''%'' || $19 || ''%'' OR l.last_name ILIKE ''%'' || $19 || ''%'')';
  END IF;

  -- Keyword search (full-text)
  IF p_keyword IS NOT NULL AND p_keyword != '' THEN
    v_where := v_where || ' AND to_tsvector(''english'', coalesce(l.company_name,'''') || '' '' || coalesce(l.general_industry,'''') || '' '' || coalesce(l.company_overview,'''')) @@ plainto_tsquery(''english'', $20)';
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
