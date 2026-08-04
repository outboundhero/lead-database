-- 070: 'group' bounce type (client req #6). A hard-looking NDR that never
-- mentions the contact's own address but names other recipients is a
-- group/distribution-list expansion failure — the individual contact is NOT
-- undeliverable and re-enters filters/exports like sender/gateway recoveries.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_bounce_type_check;
ALTER TABLE leads ADD CONSTRAINT leads_bounce_type_check
  CHECK (bounce_type IS NULL OR bounce_type IN ('sender', 'hard', 'unknown', 'gateway', 'group'));
