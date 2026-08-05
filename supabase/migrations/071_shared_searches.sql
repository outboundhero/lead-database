-- 071: shareable search links (client feedback 2026-08-05). A saved snapshot of
-- a FilterState, addressed by uuid: /leads?s=<id>. Deduped by content hash so
-- repeated shares of the same search reuse one row.
CREATE TABLE IF NOT EXISTS shared_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filters jsonb NOT NULL,
  filters_hash text NOT NULL UNIQUE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE shared_searches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read shared_searches" ON shared_searches;
CREATE POLICY "read shared_searches" ON shared_searches FOR SELECT USING (true);
