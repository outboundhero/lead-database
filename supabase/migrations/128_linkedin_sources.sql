-- 128: LinkedIn sources rebuilt on AI Ark (phase 4 of the Clay section restart).
--
-- In Clay each client had two LinkedIn searches: "Find companies" (its company
-- tables' imported companies) and "Find people" (its people tables' people
-- search). Here they become AI Ark searches with the source 'linkedin': company
-- pulls (aiark_company_runs.source) and people runs (aiark_people_runs.source),
-- worked by the same engine as the AI Ark ones.
--
-- What every client shares: the standard AI Ark filters
-- (scripts/lib/aiark/cleaning-filters.mjs: job titles, excluded titles,
-- excluded industries, employee bands, excluded company types and keywords),
-- whatever the client's type, or the client's own saved AI Ark people filters
-- (client_people_filters) when it has them. What each client has of its own:
-- places (include and exclude) and excluded keywords, kept apart for its
-- people search and its company search in client_linkedin_settings. They are
-- seeded from the client's newest Clay search of each kind by
-- scripts/linkedin-seed.mjs (the Clay copy stays out of this public repo) and
-- edited by a manager on the AI Ark tab. Every save and every seed write is
-- logged in client_linkedin_settings_log with the lists before and after.
--
-- A client with no row (no Clay search) searches its database rules' places
-- (client_targeting, read live) and the shared starter list of excluded
-- keywords (enrich_settings.linkedin_starter_keywords, written by the seed,
-- empty until then). Its first save on the AI Ark tab creates its own row.
-- client_targeting is not touched here: its exclusion terms gate sends and the
-- onboarding-sheet sync rewrites it.
--
-- LinkedIn company rows keep only companies whose head office is in the
-- client's places (aiark_companies.hq_keys, and the row input hq_only). A
-- LinkedIn person's company is brought into the client's Companies table when
-- the person is bought, so a LinkedIn candidate may have no company row yet;
-- a Look keeps the order AI Ark gave its people in (aiark_people_candidates.seq)
-- and the Preview's company objects (aiark_people_preview_companies, server-only).
--
-- Ships OFF: linkedin_sources is disabled with an empty client list, so no
-- LinkedIn pull or run can start; viewing and editing the settings spends
-- nothing. No client data: both new tables start empty and so does the
-- starter list. Nothing here reads or writes leads. RLS is on with no policies,
-- as in 122 to 127: the tabs read through server routes and the worker
-- connects as the owner.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Rows a LinkedIn pull or a LinkedIn people run bought.
ALTER TABLE enrich_sources DROP CONSTRAINT IF EXISTS enrich_sources_kind_check;
ALTER TABLE enrich_sources ADD CONSTRAINT enrich_sources_kind_check
  CHECK (kind IN ('maps', 'csv', 'demo', 'api', 'ai_ark', 'registry', 'write_to', 'linkedin'));

-- Company pulls gain their source. Every pull before 128 is an AI Ark pull.
ALTER TABLE aiark_company_runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ai_ark';
ALTER TABLE aiark_company_runs DROP CONSTRAINT IF EXISTS aiark_company_runs_source_check;
ALTER TABLE aiark_company_runs ADD CONSTRAINT aiark_company_runs_source_check
  CHECK (source IN ('ai_ark', 'linkedin'));

-- People runs: 125 allowed 'ai_ark' only and said a later source widens it.
ALTER TABLE aiark_people_runs DROP CONSTRAINT IF EXISTS aiark_people_runs_source_check;
ALTER TABLE aiark_people_runs ADD CONSTRAINT aiark_people_runs_source_check
  CHECK (source IN ('ai_ark', 'linkedin'));

-- A LinkedIn Look searches an area, so the people it sees are at companies
-- the client's table may not hold yet: the company row is set when the person
-- is bought and the company brought in. A person AI Ark gives no company is
-- never picked (verdict no_company).
ALTER TABLE aiark_people_candidates ALTER COLUMN company_row_id DROP NOT NULL;
ALTER TABLE aiark_people_candidates ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE aiark_people_candidates DROP CONSTRAINT IF EXISTS aiark_people_candidates_verdict_check;
ALTER TABLE aiark_people_candidates ADD CONSTRAINT aiark_people_candidates_verdict_check
  CHECK (verdict IN ('candidate', 'held', 'never_contact', 'bounced', 'outside', 'excluded', 'no_track', 'bought_before', 'no_company'));
ALTER TABLE aiark_people_candidates DROP CONSTRAINT IF EXISTS aiark_people_candidates_company_check;
ALTER TABLE aiark_people_candidates ADD CONSTRAINT aiark_people_candidates_company_check
  CHECK (company_id IS NOT NULL OR verdict = 'no_company');
-- The order AI Ark gave a LinkedIn Look's people in (search, page, position):
-- the pick takes the people with a track phrase first, then the others in
-- this order. Null for people runs by company id.
ALTER TABLE aiark_people_candidates ADD COLUMN IF NOT EXISTS seq integer;

-- The company object a LinkedIn Look's Preview gave for each company it met
-- (name, industry, description, offices; no domain), once per run and
-- company: a person bought with no email has their company brought into the
-- client's Companies table from it. Removed with the run.
CREATE TABLE IF NOT EXISTS aiark_people_preview_companies (
  run_id     uuid NOT NULL REFERENCES aiark_people_runs(id) ON DELETE CASCADE,
  company_id text NOT NULL,
  record     jsonb NOT NULL,
  PRIMARY KEY (run_id, company_id)
);

-- The head office's place keys ('US', 'US|IL', 'US|IL|springfield'), so a
-- LinkedIn pull copies from the registry only companies headquartered in the
-- client's places. Null on rows bought before 128: filled when first read.
-- Every row is null here, so the partial index starts empty.
ALTER TABLE aiark_companies ADD COLUMN IF NOT EXISTS hq_keys text[];
CREATE INDEX IF NOT EXISTS aiark_companies_hq_idx ON aiark_companies USING gin (hq_keys) WHERE hq_keys IS NOT NULL;

-- People already in the pipeline, by their LinkedIn URL (D23).
CREATE INDEX IF NOT EXISTS enrich_contacts_linkedin_idx ON enrich_contacts (lower(linkedin)) WHERE linkedin IS NOT NULL;

-- Each client's own LinkedIn places and excluded keywords, one row per kind.
-- Places use client_targeting's format ({country, state, city} codes, the geo
-- reference's city spelling), so the same place resolver reads them. A Clay
-- value the seed could not place is kept in unplaced with why and the places
-- it may mean: shown on the AI Ark tab, never searched. source says who wrote
-- the lists last: 'clay' (the seed, which never overwrites a person's save)
-- or 'manual' (a manager on the AI Ark tab). The Clay columns say which search
-- the row was seeded from and stay after a person's save.
CREATE TABLE IF NOT EXISTS client_linkedin_settings (
  client_tag        text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  kind              text NOT NULL CHECK (kind IN ('people', 'companies')),
  include_locations jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{"country": "US", "state": "WA", "city": "Spokane"}]
  exclude_locations jsonb NOT NULL DEFAULT '[]'::jsonb,
  unplaced          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{"side", "field", "value", "why", "suggestions": [entries]}]
  exclude_keywords  text[] NOT NULL DEFAULT '{}',
  notes             text[] NOT NULL DEFAULT '{}',        -- how the seed read the Clay search, shown read only
  flags             text[] NOT NULL DEFAULT '{}',        -- review, company_list, whole_countries, include_style, unconfirmed_match, campaigns_not_seeded
  source            text NOT NULL CHECK (source IN ('clay', 'manual')),
  copied_from       text CHECK (copied_from IN ('people', 'companies')),  -- no Clay search of this kind: copied from the other kind
  clay_source_id    text,
  clay_campaign     text,
  clay_set_up_at    timestamptz,                         -- the Clay search's set-up date (its settings' last save)
  clay_fingerprint  text,
  seed_sha256       text CHECK (seed_sha256 ~ '^[0-9a-f]{64}$'),  -- the seed file the row was written from
  seeded_at         timestamptz,
  updated_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_tag, kind),
  CHECK (jsonb_typeof(include_locations) = 'array' AND jsonb_typeof(exclude_locations) = 'array' AND jsonb_typeof(unplaced) = 'array'),
  CHECK (copied_from IS DISTINCT FROM kind),
  CHECK (source = 'manual' OR seeded_at IS NOT NULL)
);

-- Every change to a client's LinkedIn settings: who, when, the lists before
-- and after. Server-only (audit_logs is readable by every signed-in user and
-- holds text only).
CREATE TABLE IF NOT EXISTS client_linkedin_settings_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_tag  text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  kind        text NOT NULL CHECK (kind IN ('people', 'companies')),
  action      text NOT NULL CHECK (action IN ('save', 'seed')),
  changed_by  uuid,      -- the person who saved (save)
  seeded_by   text,      -- who ran the seed, user@host (seed)
  seed_sha256 text CHECK (seed_sha256 ~ '^[0-9a-f]{64}$'),
  before      jsonb,     -- null when there was nothing before (a seed's first write)
  after       jsonb NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'save') = (changed_by IS NOT NULL)),
  CHECK ((action = 'seed') = (seeded_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS client_linkedin_settings_log_client_idx
  ON client_linkedin_settings_log (client_tag, kind, changed_at DESC);

DROP TRIGGER IF EXISTS trg_client_linkedin_settings_updated_at ON client_linkedin_settings;
CREATE TRIGGER trg_client_linkedin_settings_updated_at BEFORE UPDATE ON client_linkedin_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The switch: off, no client, at most 13 people a company (the newest Clay
-- template's limit). The starter list: empty until the seed writes it.
INSERT INTO enrich_settings (key, value) VALUES
  ('linkedin_sources', '{"enabled": false, "tags": [], "people_per_company": 13}'::jsonb),
  ('linkedin_starter_keywords', '{"items": [], "version": null, "source": null, "sha256": null, "seeded_at": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Access: server-only.
ALTER TABLE client_linkedin_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_linkedin_settings_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiark_people_preview_companies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON client_linkedin_settings, client_linkedin_settings_log, aiark_people_preview_companies FROM anon, authenticated;
REVOKE ALL ON SEQUENCE client_linkedin_settings_log_id_seq FROM anon, authenticated;

COMMENT ON TABLE client_linkedin_settings IS 'AI Ark tab: each client''s own LinkedIn places and excluded keywords, per kind (people, companies), seeded from its newest Clay search (128).';
COMMENT ON TABLE client_linkedin_settings_log IS 'AI Ark tab: every save and seed write of client_linkedin_settings, with the lists before and after (128).';
COMMENT ON TABLE aiark_people_preview_companies IS 'LinkedIn people runs: the Preview''s company object of each company a Look met, for bringing in the company of a person bought with no email (128).';

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['client_linkedin_settings', 'client_linkedin_settings_log', 'aiark_people_preview_companies']) t
   WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '128: missing tables: %', missing;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'aiark_company_runs' AND column_name = 'source') THEN
    RAISE EXCEPTION '128: aiark_company_runs.source is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'aiark_companies' AND column_name = 'hq_keys') THEN
    RAISE EXCEPTION '128: aiark_companies.hq_keys is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrich_sources_kind_check'
                  AND pg_get_constraintdef(oid) LIKE '%''linkedin''%' AND pg_get_constraintdef(oid) LIKE '%''write_to''%') THEN
    RAISE EXCEPTION '128: enrich_sources does not allow linkedin and write_to (is 125 applied?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aiark_people_runs_source_check'
                  AND pg_get_constraintdef(oid) LIKE '%''linkedin''%') THEN
    RAISE EXCEPTION '128: aiark_people_runs does not allow the linkedin source';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.aiark_people_candidates'::regclass
              AND attname = 'company_row_id' AND attnotnull) THEN
    RAISE EXCEPTION '128: aiark_people_candidates.company_row_id is still NOT NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'aiark_people_candidates' AND column_name = 'seq') THEN
    RAISE EXCEPTION '128: aiark_people_candidates.seq is missing';
  END IF;
  IF (SELECT count(*) FROM enrich_settings WHERE key IN ('linkedin_sources', 'linkedin_starter_keywords')) <> 2 THEN
    RAISE EXCEPTION '128: a LinkedIn setting is missing';
  END IF;
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['client_linkedin_settings', 'client_linkedin_settings_log', 'aiark_people_preview_companies']) t
   WHERE NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR has_table_privilege('anon', 'public.' || t, 'SELECT')
      OR has_table_privilege('authenticated', 'public.' || t, 'SELECT');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '128: not server-only: %', missing;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
