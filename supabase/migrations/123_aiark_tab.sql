-- 123: the AI Ark tab — pull people from AI Ark into a Clay-tab table per run.
--
-- Phase 5 of the Clay replacement (TDN-outboundhero-database-enrichment §4,
-- "AI Ark tab", "Filter mapper", "AI Ark adapter"). An operator picks a client
-- on the AI Ark tab; the client's locations and exclusion terms come from
-- client_targeting (the sheet sync), its people filters (titles, seniority,
-- departments, company size) from client_people_filters below. A run pulls up
-- to 10,000 people; each run gets its own Clay-tab table (enrich_tables kind
-- 'ai_ark'), where the enrichment worker works out every person's outcome.
--
-- Nothing here reads or writes `leads`: a person marked "Ready to add" joins
-- the lead database in Phase 4, through the import engine.
--
-- RLS is on with no policies: the tab reads and writes through server routes,
-- and the worker connects as the table owner.

BEGIN;

-- ── Run tables and run sources are a new kind of Clay-tab table ──────────────

ALTER TABLE enrich_tables DROP CONSTRAINT IF EXISTS enrich_tables_kind_check;
ALTER TABLE enrich_tables ADD CONSTRAINT enrich_tables_kind_check
  CHECK (kind IN ('companies', 'people', 'inboxes', 'ai_ark'));

ALTER TABLE enrich_sources DROP CONSTRAINT IF EXISTS enrich_sources_kind_check;
ALTER TABLE enrich_sources ADD CONSTRAINT enrich_sources_kind_check
  CHECK (kind IN ('maps', 'csv', 'demo', 'api', 'ai_ark'));

-- ── A client's people filters (Q15) ─────────────────────────────────────────
-- The client sheets carry locations and exclusions but no job titles,
-- seniority, departments or company size, which AI Ark's people search needs.
-- They are kept here per client, editable on the tab. Never written to the sheet.

CREATE TABLE IF NOT EXISTS client_people_filters (
  client_tag         text PRIMARY KEY CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  titles             text[] NOT NULL DEFAULT '{}',   -- job titles to include (current role)
  title_mode         text NOT NULL DEFAULT 'SMART' CHECK (title_mode IN ('SMART', 'WORD', 'STRICT')),
  exclude_titles     text[] NOT NULL DEFAULT '{}',
  seniority          text[] NOT NULL DEFAULT '{}',   -- AI Ark's seniority values (owner, director …)
  departments        text[] NOT NULL DEFAULT '{}',   -- AI Ark's department-and-function values
  employee_bands     jsonb  NOT NULL DEFAULT '[]'::jsonb,  -- [{"start": 11, "end": 50}, {"start": 1001}] (end open)
  industries         text[] NOT NULL DEFAULT '{}',   -- AI Ark industry values to include
  exclude_industries text[] NOT NULL DEFAULT '{}',
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(employee_bands) = 'array')
);

-- ── Runs ────────────────────────────────────────────────────────────────────
-- One row per pull. The worker (scripts/enrich-worker.mjs) claims queued and
-- running runs with SKIP LOCKED, works a slice, records its cursor in
-- `progress` and lets go — so a cancel is seen between slices, and a crash
-- resumes from the cursor without buying anyone twice (aiark_people).

CREATE TABLE IF NOT EXISTS aiark_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_tag      text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  -- demo: made-up people from a stand-in for AI Ark that never leaves the
  -- machine; only offered when AIARK_DEMO=1. live: the real API.
  mode            text NOT NULL CHECK (mode IN ('live', 'demo')),
  -- single: page People Preview, drop people already bought, then Export Single
  --         per person (1 credit only when an email is found).
  -- export: one async Export People with Email job (0.5 per person + 0.5 per
  --         email); needs AIARK_WEBHOOK_URL, since AI Ark requires a webhook.
  strategy        text NOT NULL CHECK (strategy IN ('single', 'export')),
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'stopped', 'error', 'cancelled')),
  size_requested  integer NOT NULL CHECK (size_requested BETWEEN 1 AND 10000),
  table_id        uuid REFERENCES enrich_tables(id) ON DELETE SET NULL,
  source_id       uuid REFERENCES enrich_sources(id) ON DELETE SET NULL,
  filters         jsonb NOT NULL,    -- what the tab showed: targeting version, people filters, mapping notes
  requests        jsonb NOT NULL,    -- the AI Ark filter bodies exactly as sent, one per location chunk
  match_count     bigint,            -- People Preview's totalElements from the count before the run, if any
  progress        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the worker's cursor (chunk, page, export job, lists)
  pulled          integer NOT NULL DEFAULT 0,  -- people written to the run's table
  with_email      integer NOT NULL DEFAULT 0,  -- of those, with an email AI Ark marked valid
  skipped_held    integer NOT NULL DEFAULT 0,  -- bought in an earlier run: skipped, not bought again
  credits_used    numeric NOT NULL DEFAULT 0,
  credits_before  numeric,
  credits_after   numeric,
  attempts        smallint NOT NULL DEFAULT 0,
  next_run_at     timestamptz NOT NULL DEFAULT now(),
  claim_token     uuid,
  claimed_at      timestamptz,
  last_error      text,
  stop_reason     text,              -- why a run ended short of its size (no more matches, out of credits …)
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(requests) = 'array' AND jsonb_array_length(requests) BETWEEN 1 AND 50)
);
CREATE INDEX IF NOT EXISTS aiark_runs_client_idx ON aiark_runs (client_tag, created_at DESC);
CREATE INDEX IF NOT EXISTS aiark_runs_queue_idx ON aiark_runs (next_run_at) WHERE status IN ('queued', 'running');

-- ── Everyone ever bought from AI Ark ────────────────────────────────────────
-- Keyed on AI Ark's person id, so no run pays for the same person twice: the
-- next run excludes them in its request (AI Ark Lists) and skips any that come
-- back anyway. Kept when a run's table is deleted — the person was still paid for.

CREATE TABLE IF NOT EXISTS aiark_people (
  person_id    text PRIMARY KEY,
  demo         boolean NOT NULL DEFAULT false,   -- made up by a demo run; never sent to AI Ark
  run_id       uuid REFERENCES aiark_runs(id) ON DELETE SET NULL,
  row_id       bigint,                           -- the row in that run's table (may since be deleted)
  email        text,
  email_status text,
  pulled_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aiark_people_recent_idx ON aiark_people (demo, pulled_at DESC);

DROP TRIGGER IF EXISTS trg_client_people_filters_updated_at ON client_people_filters;
CREATE TRIGGER trg_client_people_filters_updated_at BEFORE UPDATE ON client_people_filters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_aiark_runs_updated_at ON aiark_runs;
CREATE TRIGGER trg_aiark_runs_updated_at BEFORE UPDATE ON aiark_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Access: server-only ─────────────────────────────────────────────────────

ALTER TABLE client_people_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiark_runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiark_people          ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON client_people_filters, aiark_runs, aiark_people FROM anon, authenticated;

COMMENT ON TABLE client_people_filters IS 'AI Ark tab: a client''s people filters — titles, seniority, departments, company size (123).';
COMMENT ON TABLE aiark_runs IS 'AI Ark tab: one row per pull, with the filters exactly as sent and the worker''s cursor (123).';
COMMENT ON TABLE aiark_people IS 'AI Ark tab: every AI Ark person id ever bought, so none is bought twice (123).';

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['client_people_filters', 'aiark_runs', 'aiark_people']) t
   WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '123: missing tables: %', missing;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
