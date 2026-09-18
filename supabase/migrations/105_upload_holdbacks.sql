-- 105: keep the rows an upload could not import, and count what happened.
--
-- Client decision 2026-09-17: rows without an email (48% of the incoming
-- LinkedIn-style export) must not be thrown away. They are kept EXACTLY as they
-- were in the file — the server-parsed cells, in file order — so that after the
-- upload the operator can download them as CSV parts of under 50,000 rows,
-- run an email waterfall on them, and re-upload. Today the route just did
-- `skipped++` on them and conflated that with duplicate-skips.
--
-- `seq` is a dense 0-based ordinal among held-back rows, so part p is exactly
-- rows [p*49999, (p+1)*49999) — non-overlapping by construction — and the
-- number of parts follows from upload_batches.no_email_rows with no count query.
-- `raw` is a jsonb ARRAY of cell strings (not text[][]: relax_column_count can
-- produce ragged rows and Postgres multi-dimensional arrays must be rectangular).

BEGIN;

CREATE TABLE IF NOT EXISTS upload_holdbacks (
  batch_id   uuid    NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  row_index  integer NOT NULL,   -- 1-based data-row index in the original file
  raw        jsonb   NOT NULL,   -- ["cell", "cell", ...] exactly as parsed
  PRIMARY KEY (batch_id, seq)
);
ALTER TABLE upload_holdbacks ENABLE ROW LEVEL SECURITY;   -- server-only (097 convention)

ALTER TABLE upload_batches
  ADD COLUMN IF NOT EXISTS no_email_rows      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_file_duplicates integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locations_added    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS esp_detected       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_headers     jsonb;   -- the header row as the server parsed it

-- 'upload' = the category came from an operator's CSV upload (client decision).
-- Provenance of the CATEGORY, like the other values: fn_sync_companies may still
-- propagate a cached company category onto an uploaded lead that arrived without one.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_category_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_category_source_check
  CHECK (category_source IS NULL OR category_source = ANY (ARRAY['keyword','ai','manual','bison','clay','upload']::text[]));

COMMIT;

NOTIFY pgrst, 'reload schema';
