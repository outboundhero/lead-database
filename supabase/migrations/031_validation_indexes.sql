-- OutboundHero Database: indexes supporting validation + bounce filters
-- These power the export pre-pass query (find rows needing re-validation)
-- and the silent is_bounced=false filter applied to every filter/export call.

-- For the 45-day-TTL pre-pass:
--   SELECT id, email FROM leads
--   WHERE <filters> AND (validation_status IS NULL OR validated_at < now() - INTERVAL '45 days')
CREATE INDEX IF NOT EXISTS idx_leads_validation_status ON leads (validation_status);
CREATE INDEX IF NOT EXISTS idx_leads_validated_at ON leads (validated_at);

-- Partial index — most rows are is_bounced=false (the default), so a partial
-- index on the minority case is tiny and makes "exclude bounced" essentially free.
CREATE INDEX IF NOT EXISTS idx_leads_is_bounced_true ON leads (id) WHERE is_bounced = true;

-- Composite supports the export gate: validation_status IN (...) AND is_bounced = false
CREATE INDEX IF NOT EXISTS idx_leads_validation_bounce ON leads (validation_status, is_bounced);
