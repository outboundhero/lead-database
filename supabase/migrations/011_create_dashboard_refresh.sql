-- Renaissance Database: Dashboard refresh function
-- Called by pg_cron to pre-aggregate dashboard data

CREATE OR REPLACE FUNCTION fn_refresh_dashboard()
RETURNS void AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;
