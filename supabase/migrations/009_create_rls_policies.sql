-- OutboundHero Database: Row Level Security policies
-- RLS is always on — no service role key on the frontend

-- Helper function to get current user's role
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM user_profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Enable RLS on all tables
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_snapshots ENABLE ROW LEVEL SECURITY;

-- LEADS: All authenticated users can read
CREATE POLICY "leads_select" ON leads
  FOR SELECT TO authenticated
  USING (true);

-- LEADS: Manager+ can insert
CREATE POLICY "leads_insert" ON leads
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('owner', 'admin', 'manager'));

-- LEADS: Manager+ can update
CREATE POLICY "leads_update" ON leads
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('owner', 'admin', 'manager'));

-- LEADS: Only owner can delete
CREATE POLICY "leads_delete" ON leads
  FOR DELETE TO authenticated
  USING (get_user_role() = 'owner');

-- COMPANIES: All authenticated can read
CREATE POLICY "companies_select" ON companies
  FOR SELECT TO authenticated
  USING (true);

-- COMPANIES: Manager+ can modify
CREATE POLICY "companies_modify" ON companies
  FOR ALL TO authenticated
  USING (get_user_role() IN ('owner', 'admin', 'manager'));

-- LEAD_HISTORY: All authenticated can read
CREATE POLICY "lead_history_select" ON lead_history
  FOR SELECT TO authenticated
  USING (true);

-- LEAD_HISTORY: Manager+ can insert
CREATE POLICY "lead_history_insert" ON lead_history
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('owner', 'admin', 'manager'));

-- USER_PROFILES: All authenticated can read
CREATE POLICY "profiles_select" ON user_profiles
  FOR SELECT TO authenticated
  USING (true);

-- USER_PROFILES: Admin+ can modify others, users can read own
CREATE POLICY "profiles_modify" ON user_profiles
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('owner', 'admin') OR id = auth.uid());

-- UPLOAD_BATCHES: Users see own uploads, admin+ sees all
CREATE POLICY "upload_batches_select" ON upload_batches
  FOR SELECT TO authenticated
  USING (uploaded_by = auth.uid() OR get_user_role() IN ('owner', 'admin'));

-- UPLOAD_BATCHES: Manager+ can create
CREATE POLICY "upload_batches_insert" ON upload_batches
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('owner', 'admin', 'manager'));

-- EXPORT_JOBS: Users see own exports, admin+ sees all
CREATE POLICY "export_jobs_select" ON export_jobs
  FOR SELECT TO authenticated
  USING (requested_by = auth.uid() OR get_user_role() IN ('owner', 'admin'));

-- EXPORT_JOBS: Manager+ can create
CREATE POLICY "export_jobs_insert" ON export_jobs
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('owner', 'admin', 'manager'));

-- DASHBOARD_SNAPSHOTS: All authenticated can read
CREATE POLICY "dashboard_select" ON dashboard_snapshots
  FOR SELECT TO authenticated
  USING (true);
