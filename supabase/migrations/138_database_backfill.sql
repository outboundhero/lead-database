-- 138: the database backfill. An hourly firing of the backfill-worker cron
-- finds leads already in the database (untagged, or of other clients of the
-- same sharing pool) that fit a receiving client's rules and places and were
-- never sent, shared or tagged for it, and queues them as shares: lead_shares
-- rows (outcome shared, applied, push_state queued) of one share job per
-- firing. From there the share step's push timer and the share push
-- (src/lib/sharing/push.ts) take them into the client's Active or Draft
-- campaigns, as they take any share. Ships OFF
-- (enrich_settings.database_backfill.enabled false, no client listed, mode
-- preview), and no Railway service runs it yet.
--
-- Why a migration: a share must belong to a share job (lead_shares.batch_id)
-- and a share job to an upload_batches row (share_jobs.batch_id). So:
--   - upload_batches.batch_type takes 'backfill': a firing's own batch, never
--     an upload, kept off the Uploads page. The check is replaced by a wider
--     one; no existing constraint is relaxed for the rows it held.
--   - share_jobs.kind: 'import' (every job so far, the default) or
--     'backfill'. A backfill job's origin is the marker DATABASE, a valid tag
--     text that is no client (the backfill refuses to run while a client is
--     tagged DATABASE).
--   - share_backfill_runs: one row per firing (preview or apply), with its
--     counts per receiving client and how it ended.
--   - share_backfill_cursors: per receiving client and place, how far the
--     current pass through that place's leads has read (the lead id space cut
--     into windows by the first byte of the id).
--   - the database_backfill settings row, everything off.
--
-- Nothing here reads or writes leads. The new tables start empty. RLS is on
-- with no policies, as in 122 to 136: the backfill-worker and the web app's
-- routes read them through DATABASE_URL. Needs 132 and 134.
--
-- Paste it into the Supabase SQL editor and run it once. It is idempotent: a
-- second run changes nothing and passes its checks. A lock wait over 5
-- seconds aborts it with nothing changed: run it again later.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.share_jobs') IS NULL OR to_regclass('public.lead_shares') IS NULL
     OR to_regprocedure('public.fn_client_receive_block(text)') IS NULL
     OR to_regprocedure('public.fn_share_fits(uuid[], text)') IS NULL THEN
    RAISE EXCEPTION '138 needs 132 and 134 applied first';
  END IF;
END $$;

-- 1. A backfill firing's own batch type (never an upload). Replaced only when
--    the check does not take it yet, so a second run leaves it as it is.
DO $$
BEGIN
  IF coalesce((SELECT pg_get_constraintdef(oid) FROM pg_constraint
                WHERE conrelid = 'public.upload_batches'::regclass AND conname = 'upload_batches_batch_type_check'), '')
     NOT LIKE '%''backfill''%' THEN
    ALTER TABLE upload_batches DROP CONSTRAINT IF EXISTS upload_batches_batch_type_check;
    ALTER TABLE upload_batches ADD CONSTRAINT upload_batches_batch_type_check
      CHECK (batch_type IN ('leads', 'bounces', 'backfill'));
  END IF;
END $$;

-- 2. The job kind. Every job so far is an import's.
ALTER TABLE share_jobs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'import';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.share_jobs'::regclass AND conname = 'share_jobs_kind_check') THEN
    ALTER TABLE share_jobs ADD CONSTRAINT share_jobs_kind_check CHECK (kind IN ('import', 'backfill'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS share_jobs_backfill_idx ON share_jobs (created_at DESC) WHERE kind = 'backfill';

-- 3. The runs: one per firing.
CREATE TABLE IF NOT EXISTS share_backfill_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode         text NOT NULL CHECK (mode IN ('preview', 'apply')),
  state        text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'stopped', 'error')),
  stop_reason  text CHECK (stop_reason IS NULL OR stop_reason ~ '^[a-z][a-z0-9_]*$'),   -- time, run_cap
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  batch_id     uuid REFERENCES share_jobs(batch_id) ON DELETE SET NULL,                -- the firing's share job, when it shared something
  receivers    text[] NOT NULL DEFAULT '{}',                                           -- the clients it looked at
  counts       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),  -- per receiving client
  totals       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(totals) = 'object'),
  last_error   text,                                                                   -- one line, never a lead's email
  CHECK (batch_id IS NULL OR mode = 'apply')
);
CREATE INDEX IF NOT EXISTS share_backfill_runs_recent_idx ON share_backfill_runs (started_at DESC);

-- 4. The cursors: one per receiving client and place.
CREATE TABLE IF NOT EXISTS share_backfill_cursors (
  receiver_tag     text NOT NULL CHECK (receiver_tag = upper(btrim(receiver_tag)) AND receiver_tag <> ''),
  place_key        text NOT NULL CHECK (place_key <> ''),     -- "US|AZ|tucson" (a city) or "US|AZ" (state-wide)
  windows          smallint NOT NULL CHECK (windows BETWEEN 1 AND 256),
  next_window      smallint NOT NULL DEFAULT 0,
  place_rows       integer,                                   -- leads in the place when the pass began
  rules_at         timestamptz,                               -- client_targeting.updated_at when the pass began
  pass_started_at  timestamptz NOT NULL DEFAULT now(),
  pass_done_at     timestamptz,
  checked          bigint NOT NULL DEFAULT 0,
  fits             bigint NOT NULL DEFAULT 0,
  shared           bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receiver_tag, place_key),
  CHECK (next_window BETWEEN 0 AND windows)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.share_backfill_cursors'::regclass AND tgname = 'trg_share_backfill_cursors_updated_at') THEN
    CREATE TRIGGER trg_share_backfill_cursors_updated_at BEFORE UPDATE ON share_backfill_cursors
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- 5. The switch: off, no client, preview only.
INSERT INTO enrich_settings (key, value) VALUES
  ('database_backfill', '{"enabled": false, "tags": [], "mode": "preview", "max_per_run": 5000, "max_minutes": 40,
                          "recheck_days": 7, "untagged": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 6. Access: server-only.
ALTER TABLE share_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_backfill_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON share_backfill_runs, share_backfill_cursors FROM anon, authenticated;

-- 7. What each part is.
COMMENT ON TABLE share_backfill_runs IS 'Database backfill: one row per firing of the backfill-worker (preview or apply), its counts per receiving client and how it ended (138).';
COMMENT ON TABLE share_backfill_cursors IS 'Database backfill: per receiving client and place, how far the current pass through the place''s leads has read, a window of lead ids at a time (138).';
COMMENT ON COLUMN share_jobs.kind IS 'import: the share job of a finished import (134). backfill: the job of one database backfill firing, origin DATABASE (138).';

-- 8. After-checks: anything missing aborts the whole run.
DO $$
DECLARE
  bad text;
  def text;
BEGIN
  SELECT string_agg(t, ', ') INTO bad
    FROM unnest(ARRAY['share_backfill_runs', 'share_backfill_cursors']) t
   WHERE to_regclass('public.' || t) IS NULL
      OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR has_table_privilege('anon', 'public.' || t, 'SELECT')
      OR has_table_privilege('authenticated', 'public.' || t, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '138: missing or not server-only: %', bad;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'public.upload_batches'::regclass AND conname = 'upload_batches_batch_type_check';
  IF def IS NULL OR def NOT LIKE '%''leads''%' OR def NOT LIKE '%''bounces''%' OR def NOT LIKE '%''backfill''%' THEN
    RAISE EXCEPTION '138: upload_batches_batch_type_check does not take leads, bounces and backfill: %', coalesce(def, 'missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'share_jobs' AND column_name = 'kind'
                    AND is_nullable = 'NO' AND column_default LIKE '''import''%') THEN
    RAISE EXCEPTION '138: share_jobs.kind is missing, nullable, or not defaulted to import';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.share_jobs'::regclass AND conname = 'share_jobs_kind_check') THEN
    RAISE EXCEPTION '138: share_jobs_kind_check is missing';
  END IF;
  SELECT string_agg(i, ', ') INTO bad
    FROM unnest(ARRAY['share_jobs_backfill_idx', 'share_backfill_runs_recent_idx']) i
   WHERE to_regclass('public.' || i) IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '138: missing indexes: %', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.share_backfill_cursors'::regclass AND tgname = 'trg_share_backfill_cursors_updated_at') THEN
    RAISE EXCEPTION '138: the cursors'' updated_at trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enrich_settings WHERE key = 'database_backfill') THEN
    RAISE EXCEPTION '138: the database_backfill setting is missing';
  END IF;
  -- Notes only, never a stop, so a second run passes.
  IF coalesce((SELECT value -> 'enabled' = 'true'::jsonb FROM enrich_settings WHERE key = 'database_backfill'), false) THEN
    RAISE NOTICE '138: note, database_backfill is ON';
  END IF;
  RAISE NOTICE '138: % backfill job(s) and % backfill run(s) already here',
    (SELECT count(*) FROM share_jobs WHERE kind = 'backfill'), (SELECT count(*) FROM share_backfill_runs);
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Read-only checks after applying (paste and run on their own), each with its expected answer:
--   SELECT value FROM enrich_settings WHERE key = 'database_backfill';                      -- enabled false, tags []
--   SELECT kind, count(*) FROM share_jobs GROUP BY 1;                                        -- import only
--   SELECT count(*) FROM share_backfill_runs;                                                -- 0
--   SELECT count(*) FROM share_backfill_cursors;                                             -- 0
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'upload_batches_batch_type_check';
--                                                                                            -- leads, bounces, backfill
--
-- Back-out (a write; only while the backfill is off; it fails while a backfill batch exists, by design):
--   BEGIN;
--   DELETE FROM enrich_settings WHERE key = 'database_backfill';
--   DROP TABLE IF EXISTS share_backfill_cursors;
--   DROP TABLE IF EXISTS share_backfill_runs;
--   DROP INDEX IF EXISTS share_jobs_backfill_idx;
--   ALTER TABLE share_jobs DROP COLUMN IF EXISTS kind;
--   ALTER TABLE upload_batches DROP CONSTRAINT upload_batches_batch_type_check;
--   ALTER TABLE upload_batches ADD CONSTRAINT upload_batches_batch_type_check CHECK (batch_type IN ('leads', 'bounces'));
--   COMMIT;
--   (To remove what a switched-on backfill wrote first: undo its jobs on the Sharing page, then
--    DELETE FROM upload_batches WHERE batch_type = 'backfill'; the jobs, shares and run links cascade.)
