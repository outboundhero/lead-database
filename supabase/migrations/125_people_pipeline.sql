-- 125: people at the pipeline's companies (phase 2 of the Clay section restart),
-- the Clay originals the pipeline's templates are compiled from, and the end
-- of phase 1's own prompts.
--
-- enrich_originals holds the original Clay columns exactly as the Clay CLI
-- exported them, loaded by scripts/enrich-seed-originals.mjs from exports kept
-- out of git. The Companies (companies_v2), General inboxes (inboxes_v1) and
-- People (people_v1) templates are compiled from it when a client's table is
-- made, each with its own reference map, so no prompt or list is in this
-- public repo. companies_v2 is the only template a new pull uses: phase 1's own
-- prompts are gone from the code, and their three model settings go here.
--
-- People come from AI Ark per client (aiark_people_runs). A Look writes the
-- people AI Ark shows into aiark_people_candidates; only people bought, and
-- people another run already bought with an email, become rows of the
-- client's People table. enrich_contacts summarises every inbox and People
-- row; enrich_companies lists a company with a usable general or person email.
--
-- Models: every AI step defaults to gpt-6-luna (decided 2026-11-13), with the
-- original Clay prompts verbatim; each stays one setting in models. The email
-- finders and Enrichley have no setting here: each runs only when its key is
-- on the worker, and without it the step shows "Needs <KEY> (not held)" and
-- never makes a row wait.
--
-- Every paid switch here ships OFF and covers no client (tags []).
-- Nothing here reads or writes leads. RLS is on with no policies, as in 122 to
-- 124: the tabs read through server routes and the worker connects as the owner.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Rows that another table's column writes (Clay's "Write to other table").
ALTER TABLE enrich_sources DROP CONSTRAINT IF EXISTS enrich_sources_kind_check;
ALTER TABLE enrich_sources ADD CONSTRAINT enrich_sources_kind_check
  CHECK (kind IN ('maps', 'csv', 'demo', 'api', 'ai_ark', 'registry', 'write_to'));

-- The original Clay columns, as exported. One variant for all clients
-- ('default'), plus a variant per client whose own tables were exported.
CREATE TABLE IF NOT EXISTS enrich_originals (
  variant       text NOT NULL DEFAULT 'default' CHECK (variant ~ '^[a-z0-9][a-z0-9_]*$'),
  template_kind text NOT NULL CHECK (template_kind IN ('companies', 'people', 'inboxes')),
  position      integer NOT NULL CHECK (position BETWEEN 1 AND 500),
  key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),  -- ORIGINAL_KEYS: the older copy's key
  name          text NOT NULL,                 -- Clay's column name
  clay_field_id text NOT NULL,                 -- f_...
  clay_type     text NOT NULL CHECK (clay_type IN ('source', 'basic', 'action')),
  clay_action   text,                          -- actionKey of an action column
  definition    jsonb NOT NULL,                -- as the Clay CLI exported it, secrets already masked
  unknown_refs  text[] NOT NULL DEFAULT '{}',  -- {{f_...}} ids found in no column of the three exports
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  seeded_by     text,
  seeded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant, template_kind, position),
  UNIQUE (variant, template_kind, key),
  UNIQUE (variant, template_kind, clay_field_id)
);

-- People runs: one row per run, worked a slice at a time, as aiark_company_runs.
CREATE TABLE IF NOT EXISTS aiark_people_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_tag         text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  mode               text NOT NULL CHECK (mode IN ('live', 'demo')),
  source             text NOT NULL DEFAULT 'ai_ark' CHECK (source IN ('ai_ark')),  -- a later source widens this
  status             text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'looked', 'done', 'stopped', 'error', 'cancelled')),
  companies_table_id uuid REFERENCES enrich_tables(id) ON DELETE SET NULL,
  people_table_id    uuid REFERENCES enrich_tables(id) ON DELETE SET NULL,
  source_id          uuid REFERENCES enrich_sources(id) ON DELETE SET NULL,  -- People rows bought
  registry_source_id uuid REFERENCES enrich_sources(id) ON DELETE SET NULL,  -- People rows copied free from the registry
  max_people         integer NOT NULL CHECK (max_people BETWEEN 1 AND 10000),
  filters            jsonb NOT NULL,                 -- what was asked: tracks, titles, excluded titles, versions
  companies          integer NOT NULL DEFAULT 0,
  batches            integer NOT NULL DEFAULT 0,
  progress           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- cursor: batch, page, halvings, lost answers
  pages              integer NOT NULL DEFAULT 0,     -- Preview pages bought
  looked             integer NOT NULL DEFAULT 0,     -- candidates a Look wrote
  copied             integer NOT NULL DEFAULT 0,     -- People rows copied free from the registry
  picked             integer NOT NULL DEFAULT 0,
  bought             integer NOT NULL DEFAULT 0,     -- Export Single calls made
  with_email         integer NOT NULL DEFAULT 0,
  skipped_held       integer NOT NULL DEFAULT 0,     -- companies skipped: someone usable already held
  lost_answers       integer NOT NULL DEFAULT 0,
  credits_used       numeric NOT NULL DEFAULT 0,
  credits_before     numeric,
  credits_after      numeric,
  buy_approved_by    uuid,
  buy_approved_at    timestamptz,
  attempts           smallint NOT NULL DEFAULT 0,
  next_run_at        timestamptz NOT NULL DEFAULT now(),
  claim_token        uuid,
  claimed_at         timestamptz,
  last_error         text,
  stop_reason        text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aiark_people_runs_client_idx ON aiark_people_runs (client_tag, created_at DESC);
CREATE INDEX IF NOT EXISTS aiark_people_runs_queue_idx ON aiark_people_runs (next_run_at)
  WHERE status IN ('queued', 'running');

-- The companies of a people run, in batches of ids, with their state per track.
CREATE TABLE IF NOT EXISTS aiark_people_run_companies (
  run_id         uuid NOT NULL REFERENCES aiark_people_runs(id) ON DELETE CASCADE,
  company_row_id bigint NOT NULL REFERENCES enrich_rows(id) ON DELETE CASCADE,
  company_id     text NOT NULL,                      -- AI Ark's company id
  batch          integer NOT NULL CHECK (batch >= 0),
  state          text NOT NULL DEFAULT 'waiting'
                 CHECK (state IN ('waiting', 'skipped_held', 'looked', 'picked', 'buying', 'settled')),
  tracks         jsonb NOT NULL DEFAULT '{}'::jsonb, -- {operations: {tried, found, settled}, facility_office: ..., ceo: ...}
  found          integer NOT NULL DEFAULT 0,
  picked         integer NOT NULL DEFAULT 0,
  with_email     integer NOT NULL DEFAULT 0,
  looked_at      timestamptz,
  settled_at     timestamptz,
  PRIMARY KEY (run_id, company_row_id)
);
CREATE INDEX IF NOT EXISTS aiark_people_run_companies_batch_idx ON aiark_people_run_companies (run_id, batch, state);
CREATE INDEX IF NOT EXISTS aiark_people_run_companies_row_idx ON aiark_people_run_companies (company_row_id, settled_at DESC);

-- The people a Look saw, screened for free. Narrow on purpose: only the
-- people bought (and copies with an email) become People rows.
CREATE TABLE IF NOT EXISTS aiark_people_candidates (
  run_id         uuid NOT NULL REFERENCES aiark_people_runs(id) ON DELETE CASCADE,
  person_id      text NOT NULL,                      -- AI Ark's person id
  company_row_id bigint NOT NULL REFERENCES enrich_rows(id) ON DELETE CASCADE,
  company_id     text NOT NULL,
  first_name     text,
  last_name      text,                               -- masked by the Preview ("Ba***e")
  title          text,
  city           text,
  region         text,
  country        text,
  seniority      text,
  department     text,
  track          text CHECK (track IN ('operations', 'facility_office', 'ceo')),
  rank           smallint,
  verdict        text NOT NULL
                 CHECK (verdict IN ('candidate', 'held', 'never_contact', 'bounced', 'outside', 'excluded', 'no_track', 'bought_before')),
  held_lead_id   uuid,
  pick           text NOT NULL DEFAULT 'none' CHECK (pick IN ('none', 'picked', 'reserve', 'bought', 'no_email', 'lost')),
  row_id         bigint,                             -- the People row, once bought or copied
  looked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, person_id)
);
CREATE INDEX IF NOT EXISTS aiark_people_candidates_pick_idx
  ON aiark_people_candidates (run_id, company_row_id, track, rank) WHERE verdict = 'candidate';

-- The registry keeps the company and the record of people the pipeline buys,
-- so another client's run copies them free. Metadata-only on a small table.
ALTER TABLE aiark_people ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE aiark_people ADD COLUMN IF NOT EXISTS record jsonb;
ALTER TABLE aiark_people ADD COLUMN IF NOT EXISTS people_run_id uuid
  REFERENCES aiark_people_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS aiark_people_company_idx ON aiark_people (company_id) WHERE company_id IS NOT NULL;

-- One summary per inbox row and per People row: what the Companies tab lists
-- under each company, and what the listing rule counts.
CREATE TABLE IF NOT EXISTS enrich_contacts (
  row_id         bigint PRIMARY KEY REFERENCES enrich_rows(id) ON DELETE CASCADE,  -- the inbox or People row
  company_row_id bigint NOT NULL REFERENCES enrich_rows(id) ON DELETE CASCADE,
  table_id       uuid NOT NULL,
  client_tag     text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('general', 'person')),
  email          text,
  verdict        text CHECK (verdict IN ('approved', 'enrichley', 'rejected', 'unchecked', 'held', 'never_contact', 'bounced')),
  usable         boolean NOT NULL DEFAULT false,   -- counts toward listing
  held           boolean NOT NULL DEFAULT false,   -- already a lead, or in the Email Bison copy
  held_lead_id   uuid,
  has_question   boolean NOT NULL DEFAULT false,   -- P#62 or G#50 filled (personalisation, phase 3)
  full_name      text,
  title          text,
  linkedin       text,
  track          text CHECK (track IN ('operations', 'facility_office', 'ceo')),
  found_by       text,     -- inbox: database, aiark, claygent_1, claygent_2; person: aiark, facilities_1, facilities_2, ceo
  stage          text CHECK (stage IN ('bought', 'no_email', 'copied', 'found')),
  rank           smallint,
  city           text,
  state          text,
  outcome        text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enrich_contacts_company_idx ON enrich_contacts (company_row_id, kind);
CREATE INDEX IF NOT EXISTS enrich_contacts_usable_idx ON enrich_contacts (client_tag, kind) WHERE usable;
CREATE INDEX IF NOT EXISTS enrich_contacts_email_idx ON enrich_contacts (email) WHERE email IS NOT NULL;

-- The listing now counts inboxes and people. Small table; constant defaults.
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS template text;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS passes boolean;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS never_contact boolean NOT NULL DEFAULT false;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS general_emails integer NOT NULL DEFAULT 0;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS general_waiting integer NOT NULL DEFAULT 0;  -- waiting for Enrichley
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS people_held integer NOT NULL DEFAULT 0;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS people_total integer NOT NULL DEFAULT 0;
ALTER TABLE enrich_companies ADD COLUMN IF NOT EXISTS people_settled_at timestamptz;
ALTER TABLE enrich_companies DROP CONSTRAINT IF EXISTS enrich_companies_found_by_check;
ALTER TABLE enrich_companies ADD CONSTRAINT enrich_companies_found_by_check
  CHECK (found_by IN ('database', 'aiark', 'search_1', 'search_2', 'claygent_1', 'claygent_2'));
CREATE INDEX IF NOT EXISTS enrich_companies_people_idx
  ON enrich_companies (client_tag, found_at DESC, row_id DESC) WHERE listed AND people_emails + people_held > 0;

-- What the pipeline spent today, per kind (UTC day): Reoon checks and OpenAI
-- dollars. Checked before each paid call against enrich_settings.spend_caps.
CREATE TABLE IF NOT EXISTS enrich_spend_daily (
  day        date NOT NULL,
  kind       text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),  -- reoon_checks, openai_usd_pipeline, openai_usd_fit
  used       numeric NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, kind)
);

-- Settings. A stored value always wins over a default here ('{defaults}' || value).
-- openai_prices are dollars per 1M tokens (in, out) and per web search call;
-- what the daily caps count. gpt-6-luna is every step's default; gpt-4o-mini
-- stays priced so that a step swapped back to it is still counted.
INSERT INTO enrich_settings (key, value) VALUES
  ('people_pipeline', '{"enabled": false, "tags": [], "auto_buy": false, "ai_searches": false,
                        "ids_per_search": 50, "pages_per_search": 5, "tries_per_track": 1,
                        "max_people_per_run": 300, "recheck_days": 90, "skip_company_when_held": true,
                        "min_balance": 500}'::jsonb),
  ('personalisation', '{"enabled": false, "tags": [], "shared_text_ok": false}'::jsonb),
  ('spend_caps',      '{"reoon_checks_per_day": 1500,
                        "openai_usd_per_day": {"pipeline": 20, "fit": 25},
                        "openai_prices": {"gpt-4o-mini": {"in": 0.15, "out": 0.60, "search_tokens": 8000},
                                          "gpt-6-luna":  {"in": 0.10, "out": 0.50},
                                          "web_search_call": 0.01}}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Phase 1's per-company Reoon cap belonged to its own email steps, now gone.
UPDATE enrich_settings
   SET value = '{"tags": [], "linkedin_profile_reads": false, "inboxes_per_company": 5, "min_balance": 500}'::jsonb
               || (value - 'email_checks_per_company'),
       updated_at = now()
 WHERE key = 'company_pipeline';

-- One model setting per original AI column, every one gpt-6-luna (decided
-- 2026-11-13; the originals' own prompts stay verbatim). gpt-6-luna is a
-- reasoning model, so the web search tool can open the pages these prompts name.
-- max_searches is sent as max_tool_calls: never below the steps the prompt names.
-- No reasoning effort is set, so Luna's default applies.
-- Phase 1's three settings (our own prompts, and gpt-5-nano) are removed.
UPDATE enrich_settings
   SET value = '{"companys_website":                              {"model": "gpt-6-luna", "max_searches": 3},
                 "email_extraction_claygent":                     {"model": "gpt-6-luna", "max_searches": 2},
                 "email_extraction_claygent_2":                   {"model": "gpt-6-luna", "max_searches": 2},
                 "company_decision_maker_facilities_1_claygent":  {"model": "gpt-6-luna", "max_searches": 2},
                 "company_decision_maker_facilities_2_claygent":  {"model": "gpt-6-luna", "max_searches": 3},
                 "company_decision_maker_location_company_check": {"model": "gpt-6-luna", "max_searches": 1},
                 "company_decision_maker_ceo_claygent":           {"model": "gpt-6-luna", "max_searches": 2},
                 "current_employer":                              {"model": "gpt-6-luna", "max_searches": 2},
                 "people_claygent":                               {"model": "gpt-6-luna", "max_searches": 2},
                 "people_question_ai":                            {"model": "gpt-6-luna"},
                 "inbox_claygent":                                {"model": "gpt-6-luna", "max_searches": 3},
                 "inbox_question_ai":                             {"model": "gpt-6-luna"}}'::jsonb
               || (value - 'website_search' - 'email_search_first' - 'email_search_second'),
       updated_at = now()
 WHERE key = 'models';

DROP TRIGGER IF EXISTS trg_aiark_people_runs_updated_at ON aiark_people_runs;
CREATE TRIGGER trg_aiark_people_runs_updated_at BEFORE UPDATE ON aiark_people_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Access: server-only.
ALTER TABLE enrich_originals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiark_people_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiark_people_run_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiark_people_candidates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_contacts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_spend_daily         ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON enrich_originals, aiark_people_runs, aiark_people_run_companies, aiark_people_candidates,
              enrich_contacts, enrich_spend_daily
  FROM anon, authenticated;

COMMENT ON TABLE enrich_originals IS 'Clay tab: the original Clay columns as the Clay CLI exported them; the pipeline templates are compiled from them (125).';
COMMENT ON TABLE aiark_people_runs IS 'Companies tab: one row per AI Ark people run for a client''s pipeline companies (125).';
COMMENT ON TABLE aiark_people_run_companies IS 'Companies tab: the companies of a people run, their batch and their state per track (125).';
COMMENT ON TABLE aiark_people_candidates IS 'Companies tab: the people a Look saw, screened for free; only those bought become People rows (125).';
COMMENT ON TABLE enrich_contacts IS 'Companies tab: one summary per inbox row and People row of the pipeline templates (125).';
COMMENT ON TABLE enrich_spend_daily IS 'Clay tab: what the pipeline spent per UTC day (Reoon checks, OpenAI dollars), against enrich_settings.spend_caps (125).';

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['enrich_originals', 'aiark_people_runs', 'aiark_people_run_companies', 'aiark_people_candidates',
                      'enrich_contacts', 'enrich_spend_daily']) t
   WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '125: missing tables: %', missing;
  END IF;
  SELECT string_agg(c, ', ') INTO missing
    FROM unnest(ARRAY['template', 'passes', 'never_contact', 'general_emails', 'general_waiting',
                      'people_held', 'people_total', 'people_settled_at']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'enrich_companies' AND column_name = c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '125: enrich_companies lacks: %', missing;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'aiark_people' AND column_name = 'people_run_id') THEN
    RAISE EXCEPTION '125: aiark_people.people_run_id is missing';
  END IF;
  IF (SELECT count(*) FROM enrich_settings WHERE key IN ('people_pipeline', 'personalisation', 'spend_caps')) <> 3 THEN
    RAISE EXCEPTION '125: a new setting is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enrich_settings WHERE key = 'models' AND value ? 'email_extraction_claygent') THEN
    RAISE EXCEPTION '125: the original columns'' model settings are missing (is the models row there? migration 124)';
  END IF;
  IF EXISTS (SELECT 1 FROM enrich_settings WHERE key = 'models'
              AND value ?| ARRAY['website_search', 'email_search_first', 'email_search_second']) THEN
    RAISE EXCEPTION '125: phase 1''s own model settings are still there';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
