-- 094: make "is this lead already in that campaign?" a fast question.
--
-- bison_leads.campaigns holds Bison's own lead_campaign_data, which is the only
-- honest answer to whether a push will actually add a lead or silently
-- duplicate one — our push history only knows about leads WE sent, not ones
-- that reached a campaign any other way.
--
-- Querying the jsonb directly is 730ms on 602k rows and gets worse with scale.
-- A flat bigint[] with a GIN index answers the same question in milliseconds,
-- which is what makes a pre-push forecast instant rather than something to
-- watch a spinner for.
--
-- Campaign ids are per-install, so every lookup must pair this with
-- instance_url — id 43 on outboundclean is a different campaign from id 43 on
-- facilityreach.

ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS campaign_ids bigint[];

-- Maintained by trigger rather than by the sync script, so it cannot drift if
-- some other code path writes to this table.
CREATE OR REPLACE FUNCTION public.fn_bison_leads_campaign_ids()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.campaign_ids := (
    SELECT array_agg(DISTINCT (e->>'campaign_id')::bigint)
      FROM jsonb_array_elements(COALESCE(NEW.campaigns, '[]'::jsonb)) e
     WHERE e->>'campaign_id' IS NOT NULL
  );
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_bison_leads_campaign_ids ON bison_leads;
CREATE TRIGGER trg_bison_leads_campaign_ids
  BEFORE INSERT OR UPDATE OF campaigns ON bison_leads
  FOR EACH ROW EXECUTE FUNCTION public.fn_bison_leads_campaign_ids();

-- Backfill what is already mirrored.
UPDATE bison_leads SET campaigns = campaigns WHERE campaign_ids IS NULL;

CREATE INDEX IF NOT EXISTS idx_bison_leads_campaign_ids
  ON bison_leads USING gin (campaign_ids);

-- Email is the join back to our leads, and every forecast pairs the two.
CREATE INDEX IF NOT EXISTS idx_bison_leads_email_instance
  ON bison_leads (email, instance_url);
