-- 072: Client Tracker cols E/F + policy bounces (client feedback 2026-08-06).
--
-- client_tags.client_type: Client Tracker column F ("Cleaning"/"Non-Cleaning").
-- Selecting a Cleaning client auto-enables the Commercial Cleaning filter.
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS client_type text;

-- 'policy' bounce type: "blocked by recipient policy" NDRs are NOT proof the
-- address is dead — only invalid-address or specifically security-gateway
-- rejections count as real bounces. Policy blocks are recoverable.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_bounce_type_check;
ALTER TABLE leads ADD CONSTRAINT leads_bounce_type_check
  CHECK (bounce_type IS NULL OR bounce_type IN ('sender', 'hard', 'unknown', 'gateway', 'group', 'policy'));
