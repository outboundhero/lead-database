-- 133: which leads each import touched, which AI Ark run an add came from, and
-- when the location backfill last ran.
--
-- Overlap sharing (134) works per finished import. Three things it needs:
--   - upload_batch_leads: the leads one import inserted (outcome new) or
--     updated (outcome updated). The import engine (src/lib/uploads/
--     import-rows.ts) writes it in the same transaction as each chunk, from
--     the ids its statements already return: one extra insert a chunk and none
--     on leads. It writes it only while enrich_settings.overlap_sharing is on
--     (read once per import), so with sharing off nothing is written here. No
--     foreign key to leads, so deleting a lead stays cheap. Lists are pruned
--     30 days after their share job is done.
--   - upload_batches.aiark_run_id: the AI Ark run an "Add to the database"
--     batch came from, so a share job can tell a top-up batch (the run's
--     filters hold "topup"). Null for every other batch, and for every batch
--     made before 133.
--   - cron_runs: one row per scheduled job that records its runs. The location
--     backfill (scripts/backfill-lead-locations.mjs, name location_backfill)
--     writes started_at when it starts and, when it finishes,
--     finished_run_started_at = the start of the run that finished. A share
--     job waits until a location run that started after its import finished
--     has finished, so new leads have their place before they are matched.
--
-- Nothing here reads or writes leads, and nothing changes an existing row: the
-- new column is null on every batch already there. RLS is on with no policies
-- on the new tables, as in 122 to 130. Needs 130 and 123.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.upload_people') IS NULL OR to_regclass('public.aiark_runs') IS NULL THEN
    RAISE EXCEPTION '133 needs 130 (upload_people) and 123 (aiark_runs) applied first';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS upload_batch_leads (
  batch_id  uuid NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  lead_id   uuid NOT NULL,
  outcome   text NOT NULL CHECK (outcome IN ('new', 'updated')),
  PRIMARY KEY (batch_id, lead_id)
);

ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS aiark_run_id uuid
  REFERENCES aiark_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS upload_batches_aiark_run_idx
  ON upload_batches (aiark_run_id) WHERE aiark_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cron_runs (
  name                     text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  started_at               timestamptz,   -- the last run that started
  finished_at              timestamptz,   -- when the last run finished
  finished_run_started_at  timestamptz,   -- the start of the latest run that finished
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Access: server-only.
ALTER TABLE upload_batch_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON upload_batch_leads, cron_runs FROM anon, authenticated;

COMMENT ON TABLE upload_batch_leads IS 'The leads one import inserted (new) or updated (updated), written while overlap sharing is on (133).';
COMMENT ON COLUMN upload_batches.aiark_run_id IS 'The AI Ark run an "Add to the database" batch came from; null for every other batch (133).';
COMMENT ON TABLE cron_runs IS 'When each scheduled job that records its runs last started and finished; location_backfill is the location cron (133).';

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(t, ', ') INTO bad
    FROM unnest(ARRAY['upload_batch_leads', 'cron_runs']) t
   WHERE to_regclass('public.' || t) IS NULL
      OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR has_table_privilege('anon', 'public.' || t, 'SELECT')
      OR has_table_privilege('authenticated', 'public.' || t, 'SELECT')
      OR has_table_privilege('anon', 'public.' || t, 'INSERT')
      OR has_table_privilege('authenticated', 'public.' || t, 'INSERT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '133: missing or not server-only: %', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'upload_batches' AND column_name = 'aiark_run_id') THEN
    RAISE EXCEPTION '133: upload_batches.aiark_run_id is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.upload_batch_leads'::regclass AND contype = 'f'
                    AND confrelid = 'public.upload_batches'::regclass AND confdeltype = 'c') THEN
    RAISE EXCEPTION '133: upload_batch_leads does not go with its batch';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.upload_batch_leads'::regclass AND contype = 'f'
                AND confrelid = 'public.leads'::regclass) THEN
    RAISE EXCEPTION '133: upload_batch_leads must not reference leads';
  END IF;
  IF to_regclass('public.upload_batches_aiark_run_idx') IS NULL THEN
    RAISE EXCEPTION '133: the index on upload_batches.aiark_run_id is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.upload_batches'::regclass AND contype = 'f'
                    AND confrelid = 'public.aiark_runs'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION '133: upload_batches.aiark_run_id does not let go of a deleted run';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Read-only checks after applying (paste and run on their own):
--   SELECT to_regclass('public.upload_batch_leads'), to_regclass('public.cron_runs');
--   SELECT count(*) AS lead_list_rows FROM upload_batch_leads;            -- 0 until sharing is switched on
--   SELECT count(*) FILTER (WHERE aiark_run_id IS NOT NULL) AS batches_with_run FROM upload_batches;
--   SELECT * FROM cron_runs;                                               -- empty until the location cron runs the new code
