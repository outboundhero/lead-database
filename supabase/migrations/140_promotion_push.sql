-- 140: the leads promotion adds are pushed into the client's campaigns with no
-- button, as Clay's General table pushed each approved inbox (2026-11-24).
-- Ships OFF: enrich_settings.promotion.auto_push is false (absent reads as
-- false) until an admin switches it on in the Companies tab's settings sheet,
-- and it covers only the clients on promotion.tags. The sheet refuses to
-- switch it on until this is applied, and no code reads these columns before.
--
-- enrich_contacts gains the push of each promoted contact's lead:
--   auto_push_state     NULL     never queued: settled while the switch was
--                                off, or its lead was there first
--                                (in_database, in_bison, never_contact), or
--                                not added (not_added, refused)
--                       queued   a lead its round made while the switch was
--                                on; waits for the location backfill to place
--                                it (at most 180 minutes after its round)
--                       pushed   in an automatic push batch, once
--                       held     not pushed, with the reason (no campaign
--                                could be picked as the export popup picks
--                                them, none on its B2B or B2C side, a Mimecast
--                                address, the client's question variable):
--                                left for a push from Leads, Export, never
--                                taken again
--                       dropped  not pushed, with the reason: the lead is
--                                gone, or it is in one of the client's pushes
--                                already
--   auto_push_note      why it was held or dropped, in plain words
--   auto_push_batch_id  the push_batches row it went into (no foreign key, as
--                       lead_shares.push_batch_id)
--   auto_push_at        when auto_push_state was last set
-- Only an 'added' contact carries a state (a CHECK; nothing ever moves an
-- added contact's promote_state), and a pushed one names its batch.
--
-- Nothing here pushes, and no row is written: every existing contact keeps
-- NULL, so nothing promoted before the switch is ever pushed by it. Needs 052
-- (push_batches), 126 (the promotion columns) and 133 (cron_runs: the push
-- waits for a location run that started after the round finished).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.enrich_contacts') AND attname = 'promote_state' AND NOT attisdropped)
     OR to_regclass('public.push_batches') IS NULL
     OR to_regclass('public.cron_runs') IS NULL THEN
    RAISE EXCEPTION '140 needs 052, 126 and 133 (push_batches, enrich_contacts.promote_state, cron_runs) applied first';
  END IF;
END $$;

ALTER TABLE enrich_contacts ADD COLUMN IF NOT EXISTS auto_push_state text;
ALTER TABLE enrich_contacts ADD COLUMN IF NOT EXISTS auto_push_note text;
ALTER TABLE enrich_contacts ADD COLUMN IF NOT EXISTS auto_push_batch_id uuid;   -- no foreign key: deleting a push batch must not reach here
ALTER TABLE enrich_contacts ADD COLUMN IF NOT EXISTS auto_push_at timestamptz;

-- Added NOT VALID, then validated: the check scans the table under a lock that lets reads and writes go on.
ALTER TABLE enrich_contacts DROP CONSTRAINT IF EXISTS enrich_contacts_auto_push_state_check;
ALTER TABLE enrich_contacts ADD CONSTRAINT enrich_contacts_auto_push_state_check
  CHECK (auto_push_state IS NULL OR (auto_push_state IN ('queued', 'pushed', 'held', 'dropped') AND promote_state = 'added')) NOT VALID;
ALTER TABLE enrich_contacts VALIDATE CONSTRAINT enrich_contacts_auto_push_state_check;
ALTER TABLE enrich_contacts DROP CONSTRAINT IF EXISTS enrich_contacts_auto_push_batch_check;
ALTER TABLE enrich_contacts ADD CONSTRAINT enrich_contacts_auto_push_batch_check
  CHECK (auto_push_state IS DISTINCT FROM 'pushed' OR auto_push_batch_id IS NOT NULL) NOT VALID;
ALTER TABLE enrich_contacts VALIDATE CONSTRAINT enrich_contacts_auto_push_batch_check;

-- The worker's look for a client's queued contacts, and the Companies tab's counts.
CREATE INDEX IF NOT EXISTS enrich_contacts_auto_push_idx ON enrich_contacts (client_tag, auto_push_state) WHERE auto_push_state IS NOT NULL;

COMMENT ON COLUMN enrich_contacts.auto_push_state IS 'The automatic push of a promoted lead into its client''s campaigns (140): queued, pushed, held or dropped; NULL when never queued.';
COMMENT ON COLUMN enrich_contacts.auto_push_note IS 'Why the automatic push held or dropped this contact (140).';
COMMENT ON COLUMN enrich_contacts.auto_push_batch_id IS 'The push_batches row the automatic push queued this lead in (140), no foreign key.';
COMMENT ON COLUMN enrich_contacts.auto_push_at IS 'When auto_push_state was last set (140).';

-- The check: every column, both checks validated, the index; then notes only, so a second run passes.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c, ', ') INTO bad
    FROM unnest(ARRAY['auto_push_state', 'auto_push_note', 'auto_push_batch_id', 'auto_push_at']) c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.enrich_contacts'::regclass AND attname = c AND NOT attisdropped);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '140: enrich_contacts is missing %', bad;
  END IF;
  SELECT string_agg(n, ', ') INTO bad
    FROM unnest(ARRAY['enrich_contacts_auto_push_state_check', 'enrich_contacts_auto_push_batch_check']) n
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.enrich_contacts'::regclass AND conname = n AND convalidated);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '140: the check(s) % are missing or not validated', bad;
  END IF;
  IF to_regclass('public.enrich_contacts_auto_push_idx') IS NULL THEN
    RAISE EXCEPTION '140: the index enrich_contacts_auto_push_idx is missing';
  END IF;
  IF coalesce((SELECT value -> 'auto_push' = 'true'::jsonb FROM enrich_settings WHERE key = 'promotion'), false) THEN
    RAISE NOTICE '140: note, promotion.auto_push is ON';
  END IF;
  RAISE NOTICE '140: % contact(s) carry a push state', (SELECT count(*) FROM enrich_contacts WHERE auto_push_state IS NOT NULL);
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Read-only checks after applying (paste and run on their own), each with its expected answer:
--   SELECT count(*) FROM enrich_contacts WHERE auto_push_state IS NOT NULL;                       -- 0 until the switch is on
--   SELECT value -> 'auto_push' FROM enrich_settings WHERE key = 'promotion';                 -- null or false
--   SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'public.enrich_contacts'::regclass
--      AND conname LIKE 'enrich_contacts_auto_push%';                                              -- the two checks, validated
--
-- Back-out (a write; only while promotion.auto_push is off everywhere):
--   BEGIN;
--   DROP INDEX IF EXISTS enrich_contacts_auto_push_idx;
--   ALTER TABLE enrich_contacts DROP CONSTRAINT IF EXISTS enrich_contacts_auto_push_batch_check;
--   ALTER TABLE enrich_contacts DROP CONSTRAINT IF EXISTS enrich_contacts_auto_push_state_check;
--   ALTER TABLE enrich_contacts DROP COLUMN IF EXISTS auto_push_at;
--   ALTER TABLE enrich_contacts DROP COLUMN IF EXISTS auto_push_batch_id;
--   ALTER TABLE enrich_contacts DROP COLUMN IF EXISTS auto_push_note;
--   ALTER TABLE enrich_contacts DROP COLUMN IF EXISTS auto_push_state;
--   COMMIT;
