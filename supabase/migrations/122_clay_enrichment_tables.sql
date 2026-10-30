-- 122: the Clay tab — Clay-like enrichment tables inside the lead database.
--
-- Phase 1 of the Clay replacement (TDN-outboundhero-database-enrichment §9).
-- One enrich_tables row per client table (e.g. ABC · Companies). Its columns
-- are enrich_columns rows that hold the SAME formulas, waterfalls and run
-- conditions as the client's Clay table, so the enrichment worker
-- (scripts/enrich-worker.mjs) evaluates Clay's own logic instead of a re-typed
-- copy of it. Rows arrive from the GMaps Scraper (POST /api/enrich/intake) or a
-- CSV import; every value, input or computed, is a cell.
--
-- Nothing here reads or writes `leads`. Finished leads cross into `leads` once,
-- in a later phase, through the existing import engine.
--
-- Deviation from the TDN's data model: rows and cells are generic
-- (enrich_rows + enrich_cells) instead of typed enrich_companies /
-- enrich_people tables, because each client's Clay table has its own column
-- set — the same reason Clay itself stores cells.
--
-- RLS is on with no policies: the Clay tab reads through server routes, and
-- the worker connects as the table owner.

BEGIN;

-- ── Tables and their columns ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enrich_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Plain text, no foreign key: both client sheet syncs delete tags that leave
  -- the sheet, and a client's enrichment history must survive that.
  client_tag  text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  kind        text NOT NULL CHECK (kind IN ('companies', 'people', 'inboxes')),
  name        text NOT NULL,
  source_note text,                       -- where the column definitions were copied from
  is_paused   boolean NOT NULL DEFAULT false,
  row_count   integer NOT NULL DEFAULT 0,  -- kept by trg_enrich_rows_count_*
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_tag, kind, name)
);

CREATE TABLE IF NOT EXISTS enrich_columns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      uuid NOT NULL REFERENCES enrich_tables(id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name          text NOT NULL,             -- Clay's column name, shown in the header
  position      integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('input', 'formula', 'waterfall', 'action')),
  -- kind = action: check_url | normalize_url | lookup_key | domain_from_name | ai_web | later
  action        text,
  formula       text,                      -- kind = formula: a JavaScript expression; {{key}} reads another cell
  waterfall     jsonb,                     -- kind = waterfall: expressions tried in order, first non-empty wins
  inputs        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- kind = action: {input name: expression}
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- kind = action: fixed settings (model, older table …)
  run_if        text,                      -- expression; NULL = always run
  data_type     text NOT NULL DEFAULT 'text' CHECK (data_type IN ('text', 'boolean', 'url', 'json', 'number')),
  description   text,
  provider      text,
  needs_env     text[] NOT NULL DEFAULT '{}',        -- env vars the worker must hold to run this action
  phase         smallint NOT NULL DEFAULT 1 CHECK (phase BETWEEN 1 AND 9), -- a later phase's column is shown, never run
  hidden        boolean NOT NULL DEFAULT false,
  clay_field_id text,                      -- the Clay column this copies (f_…)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, key),
  CHECK ((kind = 'action') = (action IS NOT NULL)),
  CHECK (kind <> 'formula' OR formula IS NOT NULL),
  CHECK (kind <> 'waterfall' OR (waterfall IS NOT NULL AND jsonb_typeof(waterfall) = 'array'))
);
CREATE INDEX IF NOT EXISTS enrich_columns_table_idx ON enrich_columns (table_id, position);

-- ── Where rows came from ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enrich_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    uuid NOT NULL REFERENCES enrich_tables(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('maps', 'csv', 'demo', 'api')),
  external_id text,                        -- Maps: the GMaps chunk id, so a re-delivery adds nothing
  label       text,
  received    integer NOT NULL DEFAULT 0,  -- places / rows in the delivery
  created     integer NOT NULL DEFAULT 0,  -- rows it added
  duplicates  integer NOT NULL DEFAULT 0,  -- already in the table, or twice in the delivery
  skipped     integer NOT NULL DEFAULT 0,  -- unusable: no place id and no name
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS enrich_sources_external_uniq
  ON enrich_sources (table_id, kind, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS enrich_sources_table_idx ON enrich_sources (table_id, created_at DESC);

-- ── Rows (also the work queue) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enrich_rows (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id    uuid NOT NULL REFERENCES enrich_tables(id) ON DELETE CASCADE,
  source_id   uuid REFERENCES enrich_sources(id) ON DELETE SET NULL,
  row_key     text NOT NULL,               -- dedupe key in the table: the Google place_id for Maps rows
  search_text text NOT NULL DEFAULT '',    -- lower-cased name, address, website, domain, place id
  reference   jsonb,                       -- the client's own Clay values for this row (CSV import), for side-by-side checks
  -- The worker claims queued rows with SKIP LOCKED and fences every write on
  -- claim_token, as push-worker does.
  run_status  text NOT NULL DEFAULT 'queued'
              CHECK (run_status IN ('queued', 'running', 'done', 'waiting', 'error')),
  run_force   text[],                      -- columns to re-run even when their inputs are unchanged ('*' = all)
  attempts    smallint NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at  timestamptz,
  last_error  text,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, row_key)
);
CREATE INDEX IF NOT EXISTS enrich_rows_table_id_idx ON enrich_rows (table_id, id);
CREATE INDEX IF NOT EXISTS enrich_rows_status_idx ON enrich_rows (table_id, run_status);
CREATE INDEX IF NOT EXISTS enrich_rows_queue_idx ON enrich_rows (next_run_at, id) WHERE run_status = 'queued';
CREATE INDEX IF NOT EXISTS enrich_rows_running_idx ON enrich_rows (claimed_at) WHERE run_status = 'running';
CREATE INDEX IF NOT EXISTS enrich_rows_search_trgm ON enrich_rows USING gin (search_text gin_trgm_ops);

-- ── Cells ───────────────────────────────────────────────────────────────────
-- A queued row has no cells for its computed columns yet; the grid shows those
-- as queued. Columns from a later phase never get cells.

CREATE TABLE IF NOT EXISTS enrich_cells (
  row_id      bigint NOT NULL REFERENCES enrich_rows(id) ON DELETE CASCADE,
  column_key  text NOT NULL,
  table_id    uuid NOT NULL,               -- copied from the row: per-column filters and counts need no join
  status      text NOT NULL CHECK (status IN ('done', 'empty', 'skipped', 'error', 'needs_key', 'running')),
  value       jsonb,                       -- as Clay holds it: text, boolean, or an action's JSON
  display     text,                        -- the short text the grid shows
  note        text,                        -- why: the waterfall step that won, a skipped run condition, an error
  input_hash  text,                        -- action cells: hash of the inputs the value came from (same inputs = no new call)
  runs        integer NOT NULL DEFAULT 0,  -- provider calls made for this cell
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (row_id, column_key)
);
CREATE INDEX IF NOT EXISTS enrich_cells_filter_idx ON enrich_cells (table_id, column_key, status, row_id);

-- Every provider call, kept: the detail panel shows a cell's full history.
CREATE TABLE IF NOT EXISTS enrich_cell_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  row_id      bigint NOT NULL REFERENCES enrich_rows(id) ON DELETE CASCADE,
  column_key  text NOT NULL,
  status      text NOT NULL,
  provider    text,
  request     jsonb,                       -- the bound inputs, never a key
  response    jsonb,                       -- the provider's answer, cut to 32 KB
  error       text,
  http_status integer,
  duration_ms integer,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enrich_cell_runs_cell_idx ON enrich_cell_runs (row_id, column_key, id DESC);

-- ── Counts for the column headers (never a COUNT at page load) ──────────────
-- bucket splits boolean cells into 'true' / 'false' so a filter column's
-- header can say how many passed.

CREATE TABLE IF NOT EXISTS enrich_counters (
  table_id   uuid NOT NULL,
  column_key text NOT NULL,
  status     text NOT NULL,
  bucket     text NOT NULL DEFAULT '',
  n          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (table_id, column_key, status, bucket)
);

CREATE OR REPLACE FUNCTION fn_enrich_cells_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- One statement-level pass per write; deltas are grouped and applied in key
  -- order so concurrent writers always lock counter rows in the same order.
  IF TG_OP = 'INSERT' THEN
    INSERT INTO enrich_counters AS c (table_id, column_key, status, bucket, n)
    SELECT table_id, column_key, status, bucket, count(*)
      FROM (SELECT table_id, column_key, status,
                   CASE WHEN jsonb_typeof(value) = 'boolean' THEN value #>> '{}' ELSE '' END AS bucket
              FROM new_cells) s
     GROUP BY 1, 2, 3, 4
     ORDER BY 1, 2, 3, 4
    ON CONFLICT (table_id, column_key, status, bucket) DO UPDATE SET n = c.n + EXCLUDED.n;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO enrich_counters AS c (table_id, column_key, status, bucket, n)
    SELECT table_id, column_key, status, bucket, -count(*)
      FROM (SELECT table_id, column_key, status,
                   CASE WHEN jsonb_typeof(value) = 'boolean' THEN value #>> '{}' ELSE '' END AS bucket
              FROM old_cells) s
     GROUP BY 1, 2, 3, 4
     ORDER BY 1, 2, 3, 4
    ON CONFLICT (table_id, column_key, status, bucket) DO UPDATE SET n = c.n + EXCLUDED.n;
  ELSE
    INSERT INTO enrich_counters AS c (table_id, column_key, status, bucket, n)
    SELECT table_id, column_key, status, bucket, sum(delta)
      FROM (SELECT table_id, column_key, status,
                   CASE WHEN jsonb_typeof(value) = 'boolean' THEN value #>> '{}' ELSE '' END AS bucket,
                   1 AS delta
              FROM new_cells
            UNION ALL
            SELECT table_id, column_key, status,
                   CASE WHEN jsonb_typeof(value) = 'boolean' THEN value #>> '{}' ELSE '' END,
                   -1
              FROM old_cells) s
     GROUP BY 1, 2, 3, 4
    HAVING sum(delta) <> 0
     ORDER BY 1, 2, 3, 4
    ON CONFLICT (table_id, column_key, status, bucket) DO UPDATE SET n = c.n + EXCLUDED.n;
  END IF;
  RETURN NULL;
END $$;

-- Transition tables allow one event per trigger, hence three triggers.
DROP TRIGGER IF EXISTS trg_enrich_cells_count_ins ON enrich_cells;
CREATE TRIGGER trg_enrich_cells_count_ins AFTER INSERT ON enrich_cells
  REFERENCING NEW TABLE AS new_cells FOR EACH STATEMENT EXECUTE FUNCTION fn_enrich_cells_count();
DROP TRIGGER IF EXISTS trg_enrich_cells_count_upd ON enrich_cells;
CREATE TRIGGER trg_enrich_cells_count_upd AFTER UPDATE ON enrich_cells
  REFERENCING OLD TABLE AS old_cells NEW TABLE AS new_cells FOR EACH STATEMENT EXECUTE FUNCTION fn_enrich_cells_count();
DROP TRIGGER IF EXISTS trg_enrich_cells_count_del ON enrich_cells;
CREATE TRIGGER trg_enrich_cells_count_del AFTER DELETE ON enrich_cells
  REFERENCING OLD TABLE AS old_cells FOR EACH STATEMENT EXECUTE FUNCTION fn_enrich_cells_count();

CREATE OR REPLACE FUNCTION fn_enrich_rows_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE enrich_tables t SET row_count = t.row_count + d.n
      FROM (SELECT table_id, count(*) AS n FROM new_rows GROUP BY 1) d
     WHERE t.id = d.table_id;
  ELSE
    UPDATE enrich_tables t SET row_count = greatest(0, t.row_count - d.n)
      FROM (SELECT table_id, count(*) AS n FROM old_rows GROUP BY 1) d
     WHERE t.id = d.table_id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_enrich_rows_count_ins ON enrich_rows;
CREATE TRIGGER trg_enrich_rows_count_ins AFTER INSERT ON enrich_rows
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION fn_enrich_rows_count();
DROP TRIGGER IF EXISTS trg_enrich_rows_count_del ON enrich_rows;
CREATE TRIGGER trg_enrich_rows_count_del AFTER DELETE ON enrich_rows
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION fn_enrich_rows_count();

-- Rebuilds one table's counts from its cells, in case a count ever drifts.
CREATE OR REPLACE FUNCTION fn_enrich_recount(p_table uuid) RETURNS void
LANGUAGE sql AS $$
  DELETE FROM enrich_counters WHERE table_id = p_table;
  INSERT INTO enrich_counters (table_id, column_key, status, bucket, n)
  SELECT table_id, column_key, status,
         CASE WHEN jsonb_typeof(value) = 'boolean' THEN value #>> '{}' ELSE '' END, count(*)
    FROM enrich_cells WHERE table_id = p_table
   GROUP BY 1, 2, 3, 4;
  UPDATE enrich_tables SET row_count = (SELECT count(*) FROM enrich_rows WHERE table_id = p_table)
   WHERE id = p_table;
$$;

-- ── Older Clay company keys, for "already worked" ───────────────────────────
-- A client's older Clay company tables are imported once (their CHECK values),
-- so DUPE CHECK can find them the way Clay's lookup did.

CREATE TABLE IF NOT EXISTS imported_company_keys (
  client_tag   text NOT NULL,
  source_table text NOT NULL,              -- the older Clay table, e.g. 'Company - ABC'
  company_key  text NOT NULL,              -- that table's CHECK value (usually the Google place_id)
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_tag, source_table, company_key)
);

-- ── Worker heartbeat, for the tab's "worker running / offline" pill ─────────

CREATE TABLE IF NOT EXISTS enrich_worker_state (
  id         text PRIMARY KEY,
  started_at timestamptz,
  last_seen  timestamptz NOT NULL DEFAULT now(),
  info       jsonb NOT NULL DEFAULT '{}'::jsonb   -- concurrency, rows in flight, which provider keys are set
);

DROP TRIGGER IF EXISTS trg_enrich_tables_updated_at ON enrich_tables;
CREATE TRIGGER trg_enrich_tables_updated_at BEFORE UPDATE ON enrich_tables
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_enrich_columns_updated_at ON enrich_columns;
CREATE TRIGGER trg_enrich_columns_updated_at BEFORE UPDATE ON enrich_columns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Access: server-only ─────────────────────────────────────────────────────

ALTER TABLE enrich_tables         ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_columns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_sources        ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_rows           ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_cells          ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_cell_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_counters       ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_company_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_worker_state   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON enrich_tables, enrich_columns, enrich_sources, enrich_rows, enrich_cells,
              enrich_cell_runs, enrich_counters, imported_company_keys, enrich_worker_state
  FROM anon, authenticated;

REVOKE ALL ON FUNCTION fn_enrich_recount(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_enrich_recount(uuid) TO service_role;

COMMENT ON TABLE enrich_tables IS 'Clay tab: one Clay-like table per client (122).';
COMMENT ON TABLE enrich_columns IS 'Clay tab: a table''s columns, with the client''s Clay formulas and run conditions verbatim (122).';
COMMENT ON TABLE enrich_rows IS 'Clay tab: rows, and the enrichment worker''s queue (122).';
COMMENT ON TABLE enrich_cells IS 'Clay tab: one cell per (row, column) (122).';

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['enrich_tables', 'enrich_columns', 'enrich_sources', 'enrich_rows', 'enrich_cells',
                      'enrich_cell_runs', 'enrich_counters', 'imported_company_keys', 'enrich_worker_state']) t
   WHERE to_regclass('public.' || t) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '122: missing tables: %', missing;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
