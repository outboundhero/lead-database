-- OutboundHero Database: bounce tracking on leads
-- When an Email Bison bounce list is uploaded (see /api/uploads/bounces),
-- matched leads get is_bounced=true. Filter and export RPCs silently exclude
-- bounced rows by default; admin-only override via filters.includeBounced.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_bounced BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;

-- Where the bounce came from — currently 'emailbison_upload' only.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS bounce_source TEXT;
