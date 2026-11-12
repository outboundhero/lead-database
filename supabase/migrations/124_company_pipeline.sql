-- 124: the company pipeline, phase 1 of the Clay section restart.
--
-- For any client tag, companies come from AI Ark's Company Search
-- (aiark_company_runs, worked by scripts/enrich-worker.mjs through
-- scripts/lib/aiark/company-runs.mjs) into that client's template Companies
-- table on the Clay tab (enrich_tables.template = 'companies_v1', columns from
-- scripts/lib/enrich/company-template.mjs). There they are enriched (website,
-- then the office's general email) and summarised into enrich_companies, which
-- the Companies tab lists when a usable general email was found.
--
-- Nothing here reads or writes leads. Nothing from this pipeline reaches a
-- campaign before fit scoring (phase 3).
--
-- RLS is on with no policies, as in 122 and 123: the tabs read through server
-- routes and the worker connects as the table owner.

BEGIN;

-- Template tables: one per client and template, made on the client's first pull.
ALTER TABLE enrich_tables ADD COLUMN IF NOT EXISTS template text;
ALTER TABLE enrich_tables DROP CONSTRAINT IF EXISTS enrich_tables_template_check;
ALTER TABLE enrich_tables ADD CONSTRAINT enrich_tables_template_check
  CHECK (template IS NULL OR template ~ '^[a-z][a-z0-9_]*$');
CREATE UNIQUE INDEX IF NOT EXISTS enrich_tables_template_uniq
  ON enrich_tables (client_tag, kind, template) WHERE template IS NOT NULL;

-- Companies copied free from the registry are their own kind of delivery.
ALTER TABLE enrich_sources DROP CONSTRAINT IF EXISTS enrich_sources_kind_check;
ALTER TABLE enrich_sources ADD CONSTRAINT enrich_sources_kind_check
  CHECK (kind IN ('maps', 'csv', 'demo', 'api', 'ai_ark', 'registry'));

-- Company pulls: one row per pull, worked a slice at a time, as aiark_runs.
CREATE TABLE IF NOT EXISTS aiark_company_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_tag         text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  mode               text NOT NULL CHECK (mode IN ('live', 'demo')),
  status             text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'done', 'stopped', 'error', 'cancelled')),
  size_requested     integer NOT NULL CHECK (size_requested BETWEEN 1 AND 10000),
  table_id           uuid REFERENCES enrich_tables(id) ON DELETE SET NULL,   -- the client's template Companies table
  source_id          uuid REFERENCES enrich_sources(id) ON DELETE SET NULL,  -- rows this pull bought
  registry_source_id uuid REFERENCES enrich_sources(id) ON DELETE SET NULL,  -- rows it copied free from the registry
  filters            jsonb NOT NULL,     -- what the tab showed: versions, report, notes
  requests           jsonb NOT NULL,     -- Company Search bodies, one per group of places
  match_count        bigint,             -- the count's total before the pull
  progress           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- cursor: registry copy, lists, search, page, lost pages
  pulled             integer NOT NULL DEFAULT 0,  -- new rows in the client's table, bought or copied
  from_registry      integer NOT NULL DEFAULT 0,  -- of those, copied free
  bought_before      integer NOT NULL DEFAULT 0,  -- returned and paid again although already in the registry
  credits_used       numeric NOT NULL DEFAULT 0,
  credits_before     numeric,
  credits_after      numeric,
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
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(requests) = 'array' AND jsonb_array_length(requests) BETWEEN 1 AND 50)
);
CREATE INDEX IF NOT EXISTS aiark_company_runs_client_idx ON aiark_company_runs (client_tag, created_at DESC);
CREATE INDEX IF NOT EXISTS aiark_company_runs_queue_idx ON aiark_company_runs (next_run_at)
  WHERE status IN ('queued', 'running');

-- Every AI Ark company bought, by any pull for any client. Later pulls leave
-- these out (AI Ark lists) and copy the ones in their own places for free.
CREATE TABLE IF NOT EXISTS aiark_companies (
  company_id    text PRIMARY KEY,                     -- AI Ark's company id
  demo          boolean NOT NULL DEFAULT false,       -- made up by a demo run; never sent to AI Ark
  run_id        uuid REFERENCES aiark_company_runs(id) ON DELETE SET NULL,
  name          text,
  domain        text,                                 -- bare, lower case
  place_keys    text[] NOT NULL DEFAULT '{}',         -- 'US', 'US|IL', 'US|IL|springfield' for the HQ and each office
  record        jsonb NOT NULL,                       -- the record, trimmed: no technologies, funding or logo
  aiark_updated date,                                 -- AI Ark's last_updated
  pulled_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aiark_companies_recent_idx ON aiark_companies (demo, pulled_at DESC);
CREATE INDEX IF NOT EXISTS aiark_companies_places_idx ON aiark_companies USING gin (place_keys);
CREATE INDEX IF NOT EXISTS aiark_companies_domain_idx ON aiark_companies (domain) WHERE domain IS NOT NULL;

-- Paid answers shared by every row, table and client: a company's website,
-- an office's email search. "Nothing found" is kept too, for less time.
CREATE TABLE IF NOT EXISTS enrich_memory (
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),  -- website_v1, email_search_first_v1, ...
  key         text NOT NULL CHECK (key <> ''),
  status      text NOT NULL CHECK (status IN ('done', 'empty')),
  value       jsonb,
  display     text,
  provider    text,
  model       text,
  client_tag  text,             -- whose row paid for it
  table_id    uuid,
  row_id      bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS enrich_memory_expiry_idx ON enrich_memory (expires_at);

-- The Companies tab: one row per template-table row, written by the worker
-- when the row finishes. listed = shown on the tab.
CREATE TABLE IF NOT EXISTS enrich_companies (
  row_id        bigint PRIMARY KEY REFERENCES enrich_rows(id) ON DELETE CASCADE,
  table_id      uuid NOT NULL,
  client_tag    text NOT NULL,
  source        text NOT NULL,              -- 'AI Ark' in phase 1
  aiark_id      text,
  company       text,
  domain        text,
  website       text,
  city          text,
  state         text,
  country       text,
  address       text,
  phone         text,
  industry      text,
  employees     text,
  general_email text,
  email_status  text CHECK (email_status IN ('valid', 'catch_all')),
  held          boolean NOT NULL DEFAULT false,   -- the inbox was already in the database
  found_by      text CHECK (found_by IN ('database', 'aiark', 'search_1', 'search_2')),
  email_kind    text CHECK (email_kind IN ('general', 'named')),
  people_emails integer NOT NULL DEFAULT 0,       -- phase 2
  fit_score     smallint CHECK (fit_score BETWEEN 1 AND 5),  -- phase 3
  home_office   boolean,                          -- phase 3
  outcome       text NOT NULL,
  listed        boolean NOT NULL DEFAULT false,
  company_key   text,                             -- domain|state|city: the same company is listed once
  search_text   text NOT NULL DEFAULT '',
  found_at      timestamptz,                      -- when it was first listed
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT listed OR found_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS enrich_companies_newest_idx
  ON enrich_companies (client_tag, found_at DESC, row_id DESC) WHERE listed;
CREATE INDEX IF NOT EXISTS enrich_companies_name_idx
  ON enrich_companies (client_tag, lower(company), row_id) WHERE listed;
CREATE INDEX IF NOT EXISTS enrich_companies_outcome_idx ON enrich_companies (client_tag, outcome);
CREATE INDEX IF NOT EXISTS enrich_companies_search_trgm
  ON enrich_companies USING gin (search_text gin_trgm_ops) WHERE listed;
CREATE UNIQUE INDEX IF NOT EXISTS enrich_companies_key_uniq
  ON enrich_companies (client_tag, company_key) WHERE listed AND company_key IS NOT NULL;

-- Settings the worker and the tab read at run time: the switch, the caps, and
-- the model for each AI step, so a model is swapped without a deploy.
CREATE TABLE IF NOT EXISTS enrich_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  value       jsonb NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO enrich_settings (key, value) VALUES
  ('company_pipeline', '{"enabled": false, "max_pull_size": 1000, "email_checks_per_company": 3,
                         "memory_days": {"website": 365, "email": 90, "nothing_found": 30}}'::jsonb),
  ('models', '{"website_search":      {"model": "gpt-4o-mini", "max_searches": 2},
               "email_search_first":  {"model": "gpt-5-nano", "reasoning_effort": "low", "max_searches": 3},
               "email_search_second": {"model": "gpt-4o-mini", "max_searches": 2},
               "fit_score": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS trg_aiark_company_runs_updated_at ON aiark_company_runs;
CREATE TRIGGER trg_aiark_company_runs_updated_at BEFORE UPDATE ON aiark_company_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_enrich_settings_updated_at ON enrich_settings;
CREATE TRIGGER trg_enrich_settings_updated_at BEFORE UPDATE ON enrich_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Access: server-only.
ALTER TABLE aiark_company_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiark_companies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_memory      ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_companies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_settings    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON aiark_company_runs, aiark_companies, enrich_memory, enrich_companies, enrich_settings
  FROM anon, authenticated;

COMMENT ON TABLE aiark_company_runs IS 'Companies tab: one row per AI Ark company pull, with its search bodies and the worker''s cursor (124).';
COMMENT ON TABLE aiark_companies IS 'Companies tab: every AI Ark company bought, so no pull buys it again (124).';
COMMENT ON TABLE enrich_memory IS 'Clay tab: paid answers shared across rows, tables and clients (124).';
COMMENT ON TABLE enrich_companies IS 'Companies tab: one summary row per template Companies row; listed rows are shown (124).';
COMMENT ON TABLE enrich_settings IS 'Clay tab: run-time settings, the company pipeline switch and the model per AI step (124).';

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['aiark_company_runs', 'aiark_companies', 'enrich_memory', 'enrich_companies', 'enrich_settings']) t
   WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '124: missing tables: %', missing;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'enrich_tables' AND column_name = 'template') THEN
    RAISE EXCEPTION '124: enrich_tables.template is missing';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
