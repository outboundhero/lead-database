-- 117: take misrouted leads back out of the wrong campaigns.
--
-- The 2026-09-24 audit found 3,072,334 wrong attachments across 58 clients:
-- 2,699,290 company addresses sitting in B2C campaigns and 373,044 freemail
-- addresses in B2B campaigns. Causes (both fixed in 7d7e5d9): the push worker
-- chose a side from `email_type` (person-vs-role mailbox) instead of the
-- address DOMAIN, and a batch whose campaigns carried no `side` attached every
-- lead on BOTH installs.
--
-- Removal only, for now: `DELETE /api/campaigns/{campaign_id}/leads`
-- {lead_ids:[...]}. Whether the leads are then re-added to the correct campaign
-- is a separate decision — re-pushing them through the corrected pipeline is
-- safer than moving them, because a push re-checks suppression, eligibility
-- and dedupe.
--
-- One row per (campaign, lead) to remove. The Bison lead id is per INSTALL —
-- the same person has a different id on each — so it is recorded per row
-- rather than looked up later.

CREATE TABLE IF NOT EXISTS bison_campaign_removals (
  id             bigserial PRIMARY KEY,
  client_tag     text,
  instance_url   text NOT NULL,
  campaign_id    text NOT NULL,
  bison_lead_id  bigint NOT NULL,
  email          text,
  address_side   text,          -- what the address actually is: b2b | b2c
  campaign_side  text,          -- the side of the campaign it was wrongly put in
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'done', 'failed')),
  attempts       int  NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  UNIQUE (instance_url, campaign_id, bison_lead_id)
);

-- The worker drains per (install, campaign) so it can send one DELETE with many
-- lead_ids; the partial index keeps that scan cheap as rows complete.
CREATE INDEX IF NOT EXISTS idx_campaign_removals_pending
  ON bison_campaign_removals (instance_url, campaign_id, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_campaign_removals_tag ON bison_campaign_removals (client_tag);
ALTER TABLE bison_campaign_removals ENABLE ROW LEVEL SECURITY;   -- server-only (097 convention)

-- Queue every wrong attachment for one client tag (or all, when null).
-- Reads what we RECORDED at push time: push_items.attached_ids says which
-- campaigns a lead actually attached to, and bison_ids maps install -> lead id.
CREATE OR REPLACE FUNCTION public.fn_queue_campaign_removals(p_client_tag text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE v_n integer;
BEGIN
  INSERT INTO bison_campaign_removals
    (client_tag, instance_url, campaign_id, bison_lead_id, email, address_side, campaign_side)
  SELECT camp.client_tag, camp.inst, camp.cid,
         (i.bison_ids ->> camp.inst)::bigint,
         i.email, addr.side, camp.side
    FROM push_batches b
    JOIN LATERAL (
      SELECT b.client_tag,
             cc->>'id'            AS cid,
             cc->>'instance_url'  AS inst,
             COALESCE(cc->>'side',
                      CASE WHEN cc->>'instance_url' = ct.b2b_instance THEN 'b2b'
                           WHEN cc->>'instance_url' = ct.b2c_instance THEN 'b2c' END) AS side
        FROM jsonb_array_elements(b.campaigns) cc
        LEFT JOIN client_tags ct ON ct.tag = b.client_tag
    ) camp ON true
    JOIN push_items i ON i.batch_id = b.id AND i.status = 'sent'
    JOIN LATERAL (
      SELECT CASE WHEN split_part(lower(i.email), '@', 2)
                       IN (SELECT domain FROM freemail_domains) THEN 'b2c' ELSE 'b2b' END AS side
    ) addr ON true
   WHERE b.client_tag IS NOT NULL
     AND (p_client_tag IS NULL OR b.client_tag = p_client_tag)
     AND camp.side IS NOT NULL
     AND camp.side <> addr.side                      -- the wrong workspace
     AND camp.cid = ANY (i.attached_ids)             -- it really did attach there
     AND i.bison_ids ? camp.inst                     -- and we know its id on that install
  ON CONFLICT (instance_url, campaign_id, bison_lead_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

NOTIFY pgrst, 'reload schema';
