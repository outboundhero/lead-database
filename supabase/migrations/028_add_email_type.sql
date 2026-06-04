-- OutboundHero Database: email_type column on leads
-- Classifies each contact as either:
--   'general'  — role-based / shared inbox (info@, contact@, sales@, etc.)
--                or contact labeled "(general)" in Email Bison exports
--   'personal' — individual decision-maker
-- Detection happens at import time (src/lib/uploads/detect-email-type.ts);
-- a one-off backfill script exists for existing rows.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS email_type TEXT
  CHECK (email_type IS NULL OR email_type IN ('general', 'personal'));

CREATE INDEX IF NOT EXISTS idx_leads_email_type ON leads (email_type);
