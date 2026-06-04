-- OutboundHero Database: Dashboard snapshots
-- Pre-aggregated data refreshed by pg_cron — never query leads table directly for dashboard

CREATE TABLE dashboard_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  total_leads BIGINT,
  total_job_titles INT,
  total_general_industries INT,
  total_specific_industries INT,
  leads_by_job_title JSONB,          -- [{ title: string, count: number }]
  leads_by_general_industry JSONB,   -- [{ industry: string, count: number }]
  leads_by_company_size JSONB,       -- [{ size: string, count: number }]
  leads_over_time JSONB,             -- [{ date: string, count: number }]
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_dashboard_snapshots_date ON dashboard_snapshots (snapshot_date DESC);
