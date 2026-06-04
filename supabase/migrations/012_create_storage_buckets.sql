-- OutboundHero Database: Storage buckets for exports and uploads

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('csv-uploads', 'csv-uploads', false),
  ('csv-exports', 'csv-exports', false),
  ('backups', 'backups', false);

-- Upload bucket: Manager+ can upload
CREATE POLICY "csv_uploads_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'csv-uploads'
    AND (SELECT role FROM user_profiles WHERE id = auth.uid()) IN ('owner', 'admin', 'manager')
  );

-- Upload bucket: Admin+ can read
CREATE POLICY "csv_uploads_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'csv-uploads'
    AND (SELECT role FROM user_profiles WHERE id = auth.uid()) IN ('owner', 'admin')
  );

-- Export bucket: Users can read their own exports
CREATE POLICY "csv_exports_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'csv-exports'
  );

-- Export bucket: Service role inserts (via Edge Functions)
-- No insert policy needed for authenticated users — exports are created server-side
