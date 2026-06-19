-- OutboundHero Database: rework dashboard stats around the fields we actually have.
--
-- The old fn_dashboard_stats aggregated job titles / general & specific industry /
-- company size — all empty for Email Bison data. This redefines it to compute the
-- meaningful aggregates (email type, validation, state, ESP, engagement, over-time)
-- and store them in a flexible `stats` JSONB column on dashboard_snapshots so the
-- dashboard page can render whatever it needs without further schema churn.

ALTER TABLE dashboard_snapshots ADD COLUMN IF NOT EXISTS stats JSONB;

CREATE OR REPLACE FUNCTION public.fn_dashboard_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_total BIGINT;
  v_general BIGINT;
  v_personal BIGINT;
  v_bounced BIGINT;
  v_valid BIGINT;
  v_by_state JSONB;
  v_by_esp JSONB;
  v_by_email_type JSONB;
  v_by_workspace JSONB;
  v_by_validation JSONB;
  v_engagement JSONB;
  v_over_time JSONB;
  v_stats JSONB;
BEGIN
  SELECT COUNT(*) INTO v_total FROM leads;
  SELECT COUNT(*) INTO v_general  FROM leads WHERE email_type = 'general';
  SELECT COUNT(*) INTO v_personal FROM leads WHERE email_type = 'personal';
  SELECT COUNT(*) INTO v_bounced  FROM leads WHERE is_bounced = true;
  SELECT COUNT(*) INTO v_valid    FROM leads WHERE validation_status IN ('valid','catch_all');

  SELECT jsonb_agg(row_to_json(t)) INTO v_by_state FROM (
    SELECT state, COUNT(*) AS count
    FROM leads WHERE state IS NOT NULL AND state <> ''
    GROUP BY state ORDER BY count DESC LIMIT 25
  ) t;

  SELECT jsonb_agg(row_to_json(t)) INTO v_by_esp FROM (
    SELECT esp, COUNT(*) AS count
    FROM leads WHERE esp IS NOT NULL AND esp <> ''
    GROUP BY esp ORDER BY count DESC
  ) t;

  SELECT jsonb_agg(row_to_json(t)) INTO v_by_email_type FROM (
    SELECT COALESCE(email_type, 'unknown') AS type, COUNT(*) AS count
    FROM leads GROUP BY email_type ORDER BY count DESC
  ) t;

  SELECT jsonb_agg(row_to_json(t)) INTO v_by_workspace FROM (
    SELECT COALESCE(workspace_name, 'Unknown') AS workspace, COUNT(*) AS count
    FROM leads GROUP BY workspace_name ORDER BY count DESC LIMIT 15
  ) t;

  SELECT jsonb_agg(row_to_json(t)) INTO v_by_validation FROM (
    SELECT COALESCE(validation_status, 'not_validated') AS status, COUNT(*) AS count
    FROM leads GROUP BY validation_status ORDER BY count DESC
  ) t;

  SELECT jsonb_build_object(
    'emails_sent', COALESCE(SUM(emails_sent), 0),
    'opens', COALESCE(SUM(opens), 0),
    'replies', COALESCE(SUM(replies), 0),
    'bounces', COALESCE(SUM(bounces), 0)
  ) INTO v_engagement FROM leads;

  SELECT jsonb_agg(row_to_json(t)) INTO v_over_time FROM (
    SELECT TO_CHAR(created_at, 'YYYY-MM') AS date, COUNT(*) AS count
    FROM leads WHERE created_at >= now() - INTERVAL '12 months'
    GROUP BY 1 ORDER BY 1
  ) t;

  v_stats := jsonb_build_object(
    'total_leads', v_total,
    'general', v_general,
    'personal', v_personal,
    'bounced', v_bounced,
    'valid', v_valid,
    'by_state', COALESCE(v_by_state, '[]'::jsonb),
    'by_esp', COALESCE(v_by_esp, '[]'::jsonb),
    'by_email_type', COALESCE(v_by_email_type, '[]'::jsonb),
    'by_workspace', COALESCE(v_by_workspace, '[]'::jsonb),
    'by_validation', COALESCE(v_by_validation, '[]'::jsonb),
    'engagement', v_engagement,
    'leads_over_time', COALESCE(v_over_time, '[]'::jsonb)
  );

  INSERT INTO dashboard_snapshots (snapshot_date, total_leads, stats)
  VALUES (CURRENT_DATE, v_total, v_stats)
  ON CONFLICT (snapshot_date) DO UPDATE SET
    total_leads = EXCLUDED.total_leads,
    stats = EXCLUDED.stats;

  RETURN v_stats;
END;
$function$;
