-- 116: push a never-contact decision into Email Bison.
--
-- Suppression was local to this database: it stopped OUR exports and pushes but
-- never touched Bison, where the lead often sits in a live sequence. Measured
-- 2026-09-23: of 1,067 suppressed addresses, 1,358 lead records still existed
-- across the four installs and 542 were `in_sequence` — i.e. 542 people we had
-- promised never to contact were still being emailed.
--
-- Client decision 2026-09-23: **unsubscribe only**, no blacklisting.
--   PATCH /api/leads/{lead_id}/unsubscribe   — "Unsubscribe a lead from
--   scheduled emails" (verified against a live install: 200, status becomes
--   'unsubscribed'). Its documented response returns lead_campaign_data: [],
--   so it also drops the lead out of its campaigns.
--
-- ⚠ ONE-WAY. Bison has no resubscribe endpoint (180 operations in its spec;
-- the only two mentioning it are unsubscribe itself). Reactivating can set the
-- status back — PATCH /api/leads/{lead_id}/update-status {status:'unverified'}
-- — but NOTHING puts a lead back into the sequences it was removed from. A
-- reactivated lead is contactable and eligible for a FRESH push; it does not
-- resume where it left off. The Admin copy says exactly that.
--
-- Work is queued rather than done inline: a suppression can cover tens of
-- thousands of addresses across four installs, and Bison answers one lead per
-- request and 429s hard under sustained load (a blanket 429 once killed the
-- mirror sync at 188,761 of 8.05M rows). The worker paces itself.

CREATE TABLE IF NOT EXISTS bison_unsubscribe_queue (
  id             bigserial PRIMARY KEY,
  email          text NOT NULL,
  instance_url   text NOT NULL,
  bison_lead_id  bigint,                    -- from the mirror; re-resolved if stale
  action         text NOT NULL CHECK (action IN ('unsubscribe', 'reactivate')),
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'done', 'failed', 'gone')),
  attempts       int  NOT NULL DEFAULT 0,
  last_error     text,
  requested_by   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);

-- The worker's cohort, and it drains: only pending rows are indexed.
CREATE INDEX IF NOT EXISTS idx_bison_unsub_pending
  ON bison_unsubscribe_queue (id) WHERE status = 'pending';
-- One outstanding job per address per install. Suppressing twice, or
-- suppressing something already queued, must not double the work; a LATER
-- reactivate supersedes a pending unsubscribe (and vice versa) — the API
-- deletes the opposite pending row before enqueuing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bison_unsub_one_pending
  ON bison_unsubscribe_queue (email, instance_url) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_bison_unsub_email ON bison_unsubscribe_queue (email);
ALTER TABLE bison_unsubscribe_queue ENABLE ROW LEVEL SECURITY;   -- server-only (097 convention)

-- Queue every install where an address actually exists. Reads the mirror, so it
-- costs no API calls; a lead deleted in Bison since the last sync is caught by
-- the worker (404 -> 'gone'), and one created since is picked up the next time
-- the address is suppressed or by the catch-up script.
CREATE OR REPLACE FUNCTION public.fn_enqueue_bison_unsubscribe(
  p_emails text[],
  p_action text DEFAULT 'unsubscribe',
  p_by     uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_emails text[];
  v_queued integer;
BEGIN
  IF p_action NOT IN ('unsubscribe', 'reactivate') THEN
    RAISE EXCEPTION 'unknown action %', p_action;
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(e)))
    INTO v_emails
    FROM unnest(coalesce(p_emails, '{}')) AS e
   WHERE btrim(coalesce(e, '')) <> '';
  IF v_emails IS NULL THEN RETURN 0; END IF;

  -- A pending job for the OPPOSITE action is stale intent: the operator has
  -- changed their mind before the worker got there.
  DELETE FROM bison_unsubscribe_queue
   WHERE status = 'pending' AND action <> p_action AND email = ANY (v_emails);

  INSERT INTO bison_unsubscribe_queue (email, instance_url, bison_lead_id, action, requested_by)
  SELECT DISTINCT ON (b.email, b.instance_url)
         b.email, b.instance_url, b.bison_id, p_action, p_by
    FROM bison_leads b
   WHERE b.email = ANY (v_emails)
   ORDER BY b.email, b.instance_url, b.bison_id DESC
  ON CONFLICT DO NOTHING;      -- the partial unique index keeps one per address+install
  GET DIAGNOSTICS v_queued = ROW_COUNT;
  RETURN v_queued;
END;
$function$;

NOTIFY pgrst, 'reload schema';
