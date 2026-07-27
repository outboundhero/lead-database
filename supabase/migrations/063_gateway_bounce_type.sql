-- 063: 'gateway' bounce type — recipient security gateways (Proofpoint,
-- Mimecast, Barracuda ESS, Exchange Online Protection, IronPort, ...).
-- Gateway blocks are NOT proof the address is dead: the bounce-worker flips
-- is_bounced back to false for them (same treatment as 'sender'), so these
-- leads stay eligible for filters, exports, and future Bison pushes.

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_bounce_type_check;
ALTER TABLE leads ADD CONSTRAINT leads_bounce_type_check
  CHECK (bounce_type = ANY (ARRAY['sender'::text, 'gateway'::text, 'hard'::text, 'unknown'::text]));
