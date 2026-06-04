-- OutboundHero Database: extend upload_batches to support bounce-list uploads
-- The CSV upload wizard already records lead-import batches here. The bounce
-- uploader (POST /api/uploads/bounces) reuses the same table but with
-- batch_type='bounces' so admin/uploads UI can list both kinds together.

ALTER TABLE upload_batches
  ADD COLUMN IF NOT EXISTS batch_type TEXT NOT NULL DEFAULT 'leads'
  CHECK (batch_type IN ('leads', 'bounces'));

CREATE INDEX IF NOT EXISTS idx_upload_batches_batch_type ON upload_batches (batch_type);
