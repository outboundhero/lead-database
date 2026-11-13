-- 126: fit scoring (phase 3 of the Clay section restart). One score per company
-- for every client (company_fit), every key a company's leads may show
-- (company_fit_keys), the scorer's queue, the scoring of companies already in
-- campaigns, the review list of bad fits, the removal path for bad fits, and
-- the columns that record pipeline emails reaching leads.
--
-- Ships OFF: the scorer waits for OutboundHero's rule (enrich_settings.fit_rule),
-- promotion waits for its switch and covers no client (enrich_settings.promotion),
-- and the gate (enrich_settings.fit_gate, wired in 127) is off and covers no client.
--
-- Removal: approved bad fits are queued as 'fit_held', a status the existing
-- removal worker never reads. Only a fit run of the worker that names a dry run
-- of the same rows, made in the last 24 hours, can act on them (fit_removal_dry_runs).
--
-- Nothing here writes leads or bison_leads. bison_campaign_removals gains three
-- columns (reason with a constant default, so no rewrite) and wider checks,
-- added NOT VALID: all 2.87M existing rows are 'done' and 'misroute'
-- (measured 2026-11-13).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── Keys ────────────────────────────────────────────────────────────────────
-- A bare domain, or NULL: the same rule as bareDomain() in
-- scripts/lib/enrich/domain.mjs, so "acme", "www.acme" and "localhost" are NULL.
CREATE OR REPLACE FUNCTION public.fn_bare_domain(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN s.d ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' THEN s.d END
    FROM (SELECT regexp_replace(regexp_replace(regexp_replace(
                   split_part(split_part(split_part(split_part(
                     regexp_replace(regexp_replace(lower(btrim(coalesce(p, ''))), '^[a-z][a-z0-9+.-]*://', ''), '^[^/@]*@', ''),
                   '/', 1), '?', 1), '#', 1), ' ', 1),
                 ':[0-9]+$', ''), '\.+$', ''), '^www[0-9]?\.', '') AS d) s
$fn$;

CREATE OR REPLACE FUNCTION public.fn_fit_name_key(p_company text, p_city text, p_state_code text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN btrim(coalesce(p_company, '')) = '' OR btrim(coalesce(p_state_code, '')) = '' THEN NULL
              ELSE lower(btrim(p_company)) || '|' || lower(btrim(coalesce(p_city, ''))) || '|' || upper(btrim(p_state_code))
         END
$fn$;

-- Domains that never stand for one company: platforms, directories, site
-- builders and placeholders (phase 1's DIRECTORY_BLOCKLIST and JUNK_DOMAINS,
-- company-template.mjs:42-54 and :79-84). A lead or company on one of these,
-- or on a free-mail domain, is keyed by name, city and state instead.
CREATE TABLE IF NOT EXISTS fit_domain_exclusions (domain text PRIMARY KEY CHECK (domain = lower(btrim(domain))));
INSERT INTO fit_domain_exclusions (domain) VALUES
  ('amazon.com'), ('angi.com'), ('angieslist.com'), ('apartments.com'), ('apollo.io'), ('apple.com'), ('bbb.org'),
  ('beacons.ai'), ('bit.ly'), ('bizapedia.com'), ('booksy.com'), ('business.site'), ('chamberofcommerce.com'),
  ('churchfinder.com'), ('clearbit.com'), ('company.com'), ('crunchbase.com'), ('dnb.com'), ('domain.com'),
  ('doordash.com'), ('ebay.com'), ('email.com'), ('etsy.com'), ('example.com'), ('example.net'), ('example.org'),
  ('facebook.com'), ('find-a-church.com'), ('fiverr.com'), ('forbes.com'), ('glassdoor.com'), ('gmail.com'),
  ('godaddy.com'), ('goo.gl'), ('google.com'), ('grubhub.com'), ('healthgrades.com'), ('homeadvisor.com'),
  ('houzz.com'), ('indeed.com'), ('instagram.com'), ('linkedin.com'), ('linktr.ee'), ('loopnet.com'), ('manta.com'),
  ('mapquest.com'), ('maps.apple.com'), ('menupages.com'), ('microsoft.com'), ('mindbodyonline.com'), ('mysite.com'),
  ('nerdwallet.com'), ('nextdoor.com'), ('opencare.com'), ('opencorporates.com'), ('opentable.com'), ('outlook.com'),
  ('pinterest.com'), ('porch.com'), ('ratemds.com'), ('realself.com'), ('realtor.com'), ('reddit.com'),
  ('restaurantguru.com'), ('sentry.io'), ('sentry.wixpress.com'), ('square.site'), ('squarespace.com'),
  ('squareup.com'), ('test.com'), ('thumbtack.com'), ('tiktok.com'), ('tripadvisor.com'), ('twitter.com'),
  ('ubereats.com'), ('upwork.com'), ('usnews.com'), ('vagaro.com'), ('vitals.com'), ('walmart.com'), ('webmd.com'),
  ('website.com'), ('weebly.com'), ('wikipedia.org'), ('wix.com'), ('wixpress.com'), ('x.com'), ('yellowpages.com'),
  ('yelp.com'), ('yourcompany.com'), ('yourdomain.com'), ('youtube.com'), ('yp.com'), ('zagat.com'), ('zillow.com'),
  ('zocdoc.com'), ('zoominfo.com')
ON CONFLICT (domain) DO NOTHING;

-- The domain key of a lead or company: the email's own domain when it stands
-- for a company, else its website's domain, else NULL (then the name key).
-- Used by the writers (scorer, backfill, push check); the gate itself only
-- looks keys up in company_fit_keys, which never holds a free-mail or
-- excluded domain.
CREATE OR REPLACE FUNCTION public.fn_fit_domain_ok(p_domain text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN d IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM freemail_domains f WHERE f.domain = d)
               AND NOT EXISTS (SELECT 1 FROM fit_domain_exclusions x WHERE x.domain = d)
              THEN d END
    FROM (SELECT public.fn_bare_domain(p_domain) AS d) s
$fn$;

CREATE OR REPLACE FUNCTION public.fn_fit_domain_key(p_email text, p_website text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT coalesce(public.fn_fit_domain_ok(nullif(split_part(coalesce(p_email, ''), '@', 2), '')),
                  public.fn_fit_domain_ok(p_website))
$fn$;

-- The gate's setting, readable by every caller of the eligibility function.
CREATE OR REPLACE FUNCTION public.fn_fit_gate_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT coalesce((SELECT value FROM enrich_settings WHERE key = 'fit_gate'),
                  '{"enabled": false, "tags": [], "threshold": 2, "client_types": [], "require_scored": true}'::jsonb)
$fn$;

-- Is the gate on for this client? On, its client type listed, and its tag
-- listed (["*"] means every client of the listed types).
CREATE OR REPLACE FUNCTION public.fn_fit_gate_applies(p_tag text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce((s.g->>'enabled')::boolean, false)
         AND EXISTS (SELECT 1 FROM client_tags ct
                      WHERE ct.tag = p_tag
                        AND ct.client_type IN (SELECT jsonb_array_elements_text(coalesce(s.g->'client_types', '[]'::jsonb))))
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(s.g->'tags', '[]'::jsonb)) t
                      WHERE t = '*' OR t = p_tag)
    FROM (SELECT public.fn_fit_gate_settings() AS g) s
$fn$;

-- ── Scores ──────────────────────────────────────────────────────────────────
-- One score per company, shared by every client, under its canonical key.
CREATE TABLE IF NOT EXISTS company_fit (
  key_kind     text NOT NULL CHECK (key_kind IN ('domain', 'name')),
  key          text NOT NULL CHECK (key <> ''),
  score        smallint CHECK (score BETWEEN 1 AND 5),
  home_office  boolean,
  reason       text CHECK (char_length(reason) <= 300),
  status       text NOT NULL CHECK (status IN ('scored', 'unscorable', 'manual')),
  blocked      boolean NOT NULL DEFAULT false,  -- set by trg_company_fit_blocked, never by a writer
  model        text,
  rule_version text,
  inputs_hash  text,
  source       text NOT NULL CHECK (source IN ('pipeline', 'campaigns', 'push', 'manual')),
  scored_by    uuid,
  scored_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_kind, key),
  CHECK (status = 'unscorable' OR score IS NOT NULL)
);

-- Every key the gate may read for a scored company: its own key, and aliases
-- (the domains of its contacts' emails, its name key). blocked is copied from
-- the canonical score, so a re-score or a manual score updates every alias.
CREATE TABLE IF NOT EXISTS company_fit_keys (
  key_kind  text NOT NULL CHECK (key_kind IN ('domain', 'name')),
  key       text NOT NULL CHECK (key <> ''),
  fit_kind  text NOT NULL,
  fit_key   text NOT NULL,
  blocked   boolean NOT NULL DEFAULT false,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_kind, key),
  FOREIGN KEY (fit_kind, fit_key) REFERENCES company_fit (key_kind, key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS company_fit_keys_blocked_idx ON company_fit_keys (key_kind, key) WHERE blocked;
CREATE INDEX IF NOT EXISTS company_fit_keys_fit_idx ON company_fit_keys (fit_kind, fit_key);

-- blocked = under the gate's threshold, or unscorable while require_scored.
CREATE OR REPLACE FUNCTION public.fn_company_fit_blocked() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE g jsonb := public.fn_fit_gate_settings();
BEGIN
  NEW.blocked := (NEW.status IN ('scored', 'manual') AND NEW.score < coalesce((g->>'threshold')::integer, 2))
              OR (NEW.status = 'unscorable' AND coalesce((g->>'require_scored')::boolean, true));
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_company_fit_blocked ON company_fit;
CREATE TRIGGER trg_company_fit_blocked BEFORE INSERT OR UPDATE ON company_fit
  FOR EACH ROW EXECUTE FUNCTION public.fn_company_fit_blocked();

-- Its own key always points at itself; every alias follows its blocked flag.
CREATE OR REPLACE FUNCTION public.fn_company_fit_keys_sync() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO company_fit_keys (key_kind, key, fit_kind, fit_key, blocked)
  VALUES (NEW.key_kind, NEW.key, NEW.key_kind, NEW.key, NEW.blocked)
  ON CONFLICT (key_kind, key) DO UPDATE
    SET fit_kind = EXCLUDED.fit_kind, fit_key = EXCLUDED.fit_key, blocked = EXCLUDED.blocked;
  IF TG_OP = 'UPDATE' AND NEW.blocked IS DISTINCT FROM OLD.blocked THEN
    UPDATE company_fit_keys SET blocked = NEW.blocked
     WHERE fit_kind = NEW.key_kind AND fit_key = NEW.key AND blocked IS DISTINCT FROM NEW.blocked;
  END IF;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS trg_company_fit_keys_sync ON company_fit;
CREATE TRIGGER trg_company_fit_keys_sync AFTER INSERT OR UPDATE ON company_fit
  FOR EACH ROW EXECUTE FUNCTION public.fn_company_fit_keys_sync();

-- What the scorer still has to score. 1: a push waits; 2: a pipeline company; 3: existing campaigns.
CREATE TABLE IF NOT EXISTS company_fit_queue (
  key_kind    text NOT NULL CHECK (key_kind IN ('domain', 'name')),
  key         text NOT NULL CHECK (key <> ''),
  priority    smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 3),
  facts       jsonb NOT NULL,       -- name, domain, city, state, industry, description, size, type, titles
  aliases     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{key_kind, key}] to point at this score
  source      text NOT NULL CHECK (source IN ('pipeline', 'campaigns', 'push')),
  attempts    smallint NOT NULL DEFAULT 0,
  last_error  text,
  claim_token uuid,
  claimed_at  timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_kind, key)
);
CREATE INDEX IF NOT EXISTS company_fit_queue_order_idx ON company_fit_queue (priority, enqueued_at)
  WHERE claim_token IS NULL;

-- ── Existing campaigns ──────────────────────────────────────────────────────
-- 'score': every company in the Email Bison copy, whatever client it maps to.
-- 'review': one client's review list, from its campaigns (push history and
-- live campaign names per install).
CREATE TABLE IF NOT EXISTS fit_backfill_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('score', 'review')),
  client_tag   text CHECK (client_tag IS NULL OR (client_tag = upper(btrim(client_tag)) AND client_tag <> '')),
  status       text NOT NULL DEFAULT 'estimated'
               CHECK (status IN ('estimated', 'queued', 'collecting', 'scoring', 'building', 'done', 'error', 'cancelled')),
  campaigns    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- review: [{instance_url, campaign_id, name, status, from}]
  estimate     jsonb,                                -- {companies, calls, usd, days_at_cap}
  confirmed_by uuid,
  confirmed_at timestamptz,
  progress     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- cursor over the Email Bison copy (instance_url, bison_id)
  leads_seen   integer NOT NULL DEFAULT 0,
  companies    integer NOT NULL DEFAULT 0,
  queued       integer NOT NULL DEFAULT 0,
  items        integer NOT NULL DEFAULT 0,
  claim_token  uuid,
  claimed_at   timestamptz,
  last_error   text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'score' OR client_tag IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS fit_backfill_runs_client_idx ON fit_backfill_runs (client_tag, created_at DESC);
CREATE INDEX IF NOT EXISTS fit_backfill_runs_work_idx ON fit_backfill_runs (created_at)
  WHERE status IN ('queued', 'collecting', 'scoring', 'building');

-- The review list: one item per client, campaign and blocked company.
CREATE TABLE IF NOT EXISTS fit_review_items (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_tag      text NOT NULL,
  backfill_id     uuid REFERENCES fit_backfill_runs(id) ON DELETE SET NULL,
  instance_url    text NOT NULL,
  campaign_id     text NOT NULL,
  campaign_name   text,
  campaign_status text,
  campaign_from   text CHECK (campaign_from IN ('push_history', 'live_name')),
  key_kind        text NOT NULL CHECK (key_kind IN ('domain', 'name')),
  key             text NOT NULL,
  company         text,
  domain          text,
  city            text,
  state           text,
  score           smallint,
  home_office     boolean,
  reason          text,
  model           text,
  leads           integer NOT NULL DEFAULT 0,
  emails_sent     integer NOT NULL DEFAULT 0,
  replied         integer NOT NULL DEFAULT 0,
  interested      integer NOT NULL DEFAULT 0,
  removable       integer NOT NULL DEFAULT 0,
  oldest_sync     timestamptz,                -- the oldest Email Bison copy row behind these numbers
  decision        text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected')),
  decided_by      uuid,
  decided_at      timestamptz,
  built_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_tag, instance_url, campaign_id, key_kind, key)
);
CREATE INDEX IF NOT EXISTS fit_review_items_client_idx ON fit_review_items (client_tag, decision, campaign_id);

CREATE TABLE IF NOT EXISTS fit_review_leads (
  item_id           bigint NOT NULL REFERENCES fit_review_items(id) ON DELETE CASCADE,
  instance_url      text NOT NULL,
  campaign_id       text NOT NULL,
  bison_lead_id     bigint NOT NULL,
  email             text,
  membership_status text,
  replied           boolean NOT NULL DEFAULT false,
  interested        boolean NOT NULL DEFAULT false,
  in_nurture        boolean NOT NULL DEFAULT false,  -- also in a Nurture campaign on this install: never removed
  synced_at         timestamptz,                     -- when the Email Bison copy last read this lead
  PRIMARY KEY (item_id, instance_url, campaign_id, bison_lead_id)
);

-- A dry run of fit removals: what it read live, and the exact rows. The real
-- run must name one made in the last 24 hours whose rows still match.
CREATE TABLE IF NOT EXISTS fit_removal_dry_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_tag     text NOT NULL,
  instance_url   text,
  row_ids        bigint[] NOT NULL,
  rows_sha256    text NOT NULL CHECK (rows_sha256 ~ '^[0-9a-f]{64}$'),
  would_remove   integer NOT NULL DEFAULT 0,
  would_skip     integer NOT NULL DEFAULT 0,   -- replied or interested, read live
  cannot_confirm integer NOT NULL DEFAULT 0,   -- Bison's answer lacked the campaign data
  run_by         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  used_at        timestamptz
);

-- ── Pipeline emails into leads ──────────────────────────────────────────────
ALTER TABLE enrich_contacts ADD COLUMN IF NOT EXISTS promote_state text;
ALTER TABLE enrich_contacts DROP CONSTRAINT IF EXISTS enrich_contacts_promote_state_check;
ALTER TABLE enrich_contacts ADD CONSTRAINT enrich_contacts_promote_state_check
  CHECK (promote_state IN ('running', 'added', 'in_database', 'in_bison', 'never_contact', 'not_added', 'refused'));
ALTER TABLE enrich_contacts ADD COLUMN IF NOT EXISTS lead_id uuid;       -- no foreign key: deleting leads must not reach here
ALTER TABLE enrich_contacts ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE enrich_contacts ADD COLUMN IF NOT EXISTS promoted_at timestamptz;
CREATE INDEX IF NOT EXISTS enrich_contacts_promote_idx ON enrich_contacts (client_tag, kind, promote_state) WHERE usable;
CREATE INDEX IF NOT EXISTS enrich_contacts_lead_idx ON enrich_contacts (lead_id) WHERE lead_id IS NOT NULL;

ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS fit_reason text;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS fit_key_kind text;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS fit_key text;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS fit_scored_at timestamptz;
CREATE INDEX IF NOT EXISTS enrich_companies_fit_key_idx ON enrich_companies (fit_key_kind, fit_key) WHERE fit_key IS NOT NULL;

-- ── Removal from campaigns for a bad fit ────────────────────────────────────
ALTER TABLE bison_campaign_removals ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT 'misroute';
ALTER TABLE bison_campaign_removals ADD COLUMN IF NOT EXISTS review_item_id bigint;
ALTER TABLE bison_campaign_removals ADD COLUMN IF NOT EXISTS dry_run_id uuid;
ALTER TABLE bison_campaign_removals DROP CONSTRAINT IF EXISTS bison_campaign_removals_reason_check;
ALTER TABLE bison_campaign_removals ADD CONSTRAINT bison_campaign_removals_reason_check
  CHECK (reason IN ('misroute', 'fit')) NOT VALID;
-- The status check was declared inline in 117; drop whatever check holds the
-- old list, whatever its name.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.bison_campaign_removals'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%''failed''%' AND pg_get_constraintdef(oid) NOT LIKE '%''fit_held''%'
  LOOP
    EXECUTE format('ALTER TABLE bison_campaign_removals DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE bison_campaign_removals DROP CONSTRAINT IF EXISTS bison_campaign_removals_status_check;
ALTER TABLE bison_campaign_removals ADD CONSTRAINT bison_campaign_removals_status_check
  CHECK (status IN ('pending', 'done', 'failed', 'skipped', 'fit_held')) NOT VALID;
-- fit rows are only ever 'fit_held', then 'done', 'skipped' or 'failed'.
ALTER TABLE bison_campaign_removals DROP CONSTRAINT IF EXISTS bison_campaign_removals_fit_status_check;
ALTER TABLE bison_campaign_removals ADD CONSTRAINT bison_campaign_removals_fit_status_check
  CHECK (reason <> 'fit' OR status <> 'pending') NOT VALID;
CREATE INDEX IF NOT EXISTS idx_campaign_removals_fit_held
  ON bison_campaign_removals (client_tag, instance_url, campaign_id, id) WHERE status = 'fit_held';

-- Approved review items to the removal queue, as 'fit_held'. Refuses for a
-- client the gate does not cover (so removed leads can't be pushed back). Leaves
-- out any lead that replied or is interested anywhere in the Email Bison copy,
-- any lead also in a Nurture campaign, and any company no longer blocked. The
-- worker checks each lead again, live, before its DELETE.
CREATE OR REPLACE FUNCTION public.fn_queue_fit_removals(p_client_tag text, p_item_ids bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE n integer;
BEGIN
  IF NOT public.fn_fit_gate_applies(p_client_tag) THEN
    RAISE EXCEPTION 'The fit gate does not cover %: put the client on fit_gate.tags first', p_client_tag;
  END IF;
  INSERT INTO bison_campaign_removals (client_tag, instance_url, campaign_id, bison_lead_id, email, reason, review_item_id, status)
  SELECT i.client_tag, l.instance_url, l.campaign_id, l.bison_lead_id, l.email, 'fit', i.id, 'fit_held'
    FROM fit_review_items i
    JOIN fit_review_leads l ON l.item_id = i.id
   WHERE i.client_tag = p_client_tag AND i.id = ANY (p_item_ids) AND i.decision = 'approved'
     AND NOT l.replied AND NOT l.interested AND NOT l.in_nurture
     AND EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.key_kind = i.key_kind AND k.key = i.key AND k.blocked)
     AND NOT EXISTS (
       SELECT 1 FROM bison_leads b
        WHERE lower(b.email) = lower(l.email)
          AND (coalesce(b.replies, 0) > 0
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(b.campaigns, '[]'::jsonb)) c
                           WHERE coalesce((c->>'replies')::int, 0) > 0
                              OR coalesce((c->>'interested')::boolean, false)
                              OR c->>'status' = 'replied')))
  ON CONFLICT (instance_url, campaign_id, bison_lead_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_queue_fit_removals(text, bigint[]) FROM PUBLIC, anon, authenticated;

-- Brings company_fit.blocked up to date after a threshold or require_scored
-- change, a batch at a time (the trigger recomputes each row touched). The fit
-- loop calls it while enrich_settings.fit_gate_refresh says pending, until 0.
CREATE OR REPLACE FUNCTION public.fn_fit_refresh_blocked(p_limit integer DEFAULT 20000)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE g jsonb := public.fn_fit_gate_settings(); th integer; rs boolean; n integer;
BEGIN
  th := coalesce((g->>'threshold')::integer, 2);
  rs := coalesce((g->>'require_scored')::boolean, true);
  WITH c AS (
    SELECT key_kind, key FROM company_fit
     WHERE blocked IS DISTINCT FROM ((status IN ('scored', 'manual') AND score < th) OR (status = 'unscorable' AND rs))
     LIMIT p_limit
  )
  UPDATE company_fit f SET scored_at = f.scored_at
    FROM c WHERE f.key_kind = c.key_kind AND f.key = c.key;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_fit_refresh_blocked(integer) FROM PUBLIC, anon, authenticated;

-- ── Settings, all off ───────────────────────────────────────────────────────
INSERT INTO enrich_settings (key, value) VALUES
  ('fit_rule',         '{"prompt": null, "version": null}'::jsonb),
  ('fit_scoring',      '{"enabled": false, "batch_size": 25, "calls_in_flight": 2}'::jsonb),
  ('promotion',        '{"promote_to_leads": false, "tags": [], "min_fit_score": 2, "batch_max": 1000,
                         "require_question": true, "source_label": "Companies (AI Ark)"}'::jsonb),
  ('fit_gate',         '{"enabled": false, "tags": [], "threshold": 2, "client_types": ["Cleaning", "Canada Cleaning"],
                         "require_scored": true}'::jsonb),
  ('fit_gate_refresh', '{"pending": false, "since": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;

UPDATE enrich_settings
   SET value = jsonb_set(value, '{fit_score}', '{"model": "gpt-6-luna", "reasoning_effort": "low"}'::jsonb),
       updated_at = now()
 WHERE key = 'models' AND (NOT (value ? 'fit_score') OR value->'fit_score' = 'null'::jsonb);

DROP TRIGGER IF EXISTS trg_fit_backfill_runs_updated_at ON fit_backfill_runs;
CREATE TRIGGER trg_fit_backfill_runs_updated_at BEFORE UPDATE ON fit_backfill_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE fit_domain_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_fit           ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_fit_keys      ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_fit_queue     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fit_backfill_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fit_review_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fit_review_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fit_removal_dry_runs  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fit_domain_exclusions, company_fit, company_fit_keys, company_fit_queue, fit_backfill_runs,
              fit_review_items, fit_review_leads, fit_removal_dry_runs
  FROM anon, authenticated;

COMMENT ON TABLE company_fit IS 'Fit scoring: one 1 to 5 score and home-office flag per company, shared by every client (126).';
COMMENT ON TABLE company_fit_keys IS 'Fit scoring: every key the gate reads for a scored company, with the score''s blocked flag (126).';
COMMENT ON TABLE fit_domain_exclusions IS 'Fit scoring: platform, directory and placeholder domains never used as a company key (126).';
COMMENT ON TABLE company_fit_queue IS 'Fit scoring: companies waiting for the scorer, by priority (126).';
COMMENT ON TABLE fit_backfill_runs IS 'Fit scoring: scoring the companies in the Email Bison copy, and building one client''s review list (126).';
COMMENT ON TABLE fit_review_items IS 'Fit scoring: bad fits already in campaigns, per client, campaign and company; removal only after a person approves (126).';
COMMENT ON TABLE fit_review_leads IS 'Fit scoring: the leads under a review item (126).';
COMMENT ON TABLE fit_removal_dry_runs IS 'Fit scoring: the dry run a real fit removal run must name (126).';

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['company_fit', 'company_fit_keys', 'fit_domain_exclusions', 'company_fit_queue', 'fit_backfill_runs',
                      'fit_review_items', 'fit_review_leads', 'fit_removal_dry_runs']) t
   WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '126: missing tables: %', missing;
  END IF;
  IF public.fn_fit_name_key('Acme Office', 'Springfield', 'il') IS DISTINCT FROM 'acme office|springfield|IL'
     OR public.fn_bare_domain('https://www.Example.com/about?x') IS DISTINCT FROM 'example.com'
     OR public.fn_bare_domain('acme') IS NOT NULL
     OR public.fn_bare_domain('http://localhost:3000') IS NOT NULL
     OR public.fn_fit_domain_key('jo@gmail.com', 'https://facebook.com/acme') IS NOT NULL
     OR public.fn_fit_domain_key('jo@gmail.com', 'www.acme.com/contact') IS DISTINCT FROM 'acme.com'
     OR public.fn_fit_domain_key('office@acme-services.net', 'acme.com') IS DISTINCT FROM 'acme-services.net' THEN
    RAISE EXCEPTION '126: the key functions do not give the expected keys';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'bison_campaign_removals' AND column_name = 'reason') THEN
    RAISE EXCEPTION '126: bison_campaign_removals.reason is missing';
  END IF;
  IF (SELECT count(*) FROM enrich_settings WHERE key IN ('fit_rule', 'fit_scoring', 'promotion', 'fit_gate', 'fit_gate_refresh')) <> 5 THEN
    RAISE EXCEPTION '126: a fit setting is missing';
  END IF;
  IF coalesce((public.fn_fit_gate_settings()->>'enabled')::boolean, false) THEN
    RAISE NOTICE '126: note, the fit gate setting is ON';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
