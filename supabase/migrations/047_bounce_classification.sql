-- 047_bounce_classification.sql
-- Bounce-type classification, populated by the bounce-worker Railway cron
-- service (scripts/bounce-worker.mjs). For every lead with bounces > 0 the
-- worker fetches its bounced replies from Email Bison
-- (GET /api/leads/{email}/replies?folder=bounced) and classifies the NDR:
--   'sender'  -> failure was our sending inbox's fault (auth/quota/reputation).
--                Lead is still contactable: worker flips is_bounced back to
--                false so it re-enters default filters and exports.
--   'hard'    -> recipient invalid / blocked / policy-rejected. Never contact
--                again: is_bounced stays true (default-excluded, never exported).
--   'unknown' -> could not determine (no bounce reply found, ambiguous NDR).
--                Conservatively treated like hard.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bounce_type TEXT
  CHECK (bounce_type IN ('sender', 'hard', 'unknown'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bounce_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bounce_checked_at TIMESTAMPTZ;

-- Worker scans "bounced but not yet checked" — keep it cheap at 20M rows.
CREATE INDEX IF NOT EXISTS idx_leads_bounce_pending
  ON leads (bounce_checked_at)
  WHERE bounces > 0;
