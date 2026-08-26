-- 090: carry enough identity in the mirror to CREATE a lead from it.
--
-- 089 stored only what Bison uniquely knows (campaign membership, engagement),
-- because the goal was answering "which campaign is this lead in". The goal has
-- widened: leads that exist in Bison but not here are to be added to leads, and
-- an address with no name or company is not a usable lead.
--
-- Cost is small — these four fields are ~73 of the 1,190 bytes a lead returns,
-- so ~0.8 GB across all 11.1M, against the ~5 GB that mirroring
-- custom_variables would have cost (still deliberately not stored).
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS last_name  text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS company    text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS title      text;

-- Which mirrored leads have been promoted into leads, so a re-run is cheap and
-- an import is never counted twice.
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS imported_at timestamptz;

-- Finding the not-yet-imported ones. Partial, so it stays small as the backlog
-- drains rather than indexing all 11.1M rows.
CREATE INDEX IF NOT EXISTS idx_bison_leads_pending_import
  ON bison_leads (instance_url, bison_id)
  WHERE imported_at IS NULL AND email IS NOT NULL;
