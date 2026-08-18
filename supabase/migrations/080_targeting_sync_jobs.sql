-- 080: queue for on-demand client-rules (targeting) syncs.
--
-- WHY A QUEUE
-- Re-parsing a client's onboarding text costs several AI calls and takes
-- ~10-30s per client; 24 changed clients is well past the ~60s a web request
-- gets. The client asked for a button that starts the work and keeps running if
-- the tab is closed — same durability model as push_batches: the API only
-- inserts a row, a worker does the work, the UI polls this table for progress.
--
-- COST CONTROL
-- The API takes a preview first (which clients' sheet text actually changed) and
-- only queues after the operator confirms, so AI spend is always deliberate.
-- Clients whose sheet_raw is unchanged are skipped by the sync itself and cost
-- nothing, which is why re-clicking is safe.

CREATE TABLE IF NOT EXISTS targeting_sync_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','complete','error','cancelled')),
  -- Client tags this job should re-parse. Empty = whatever the sync finds changed.
  client_tags  text[] NOT NULL DEFAULT '{}',
  total        integer NOT NULL DEFAULT 0,   -- work units (2 per client + 1 write)
  processed    integer NOT NULL DEFAULT 0,
  synced       integer NOT NULL DEFAULT 0,   -- clients actually written
  failed       integer NOT NULL DEFAULT 0,   -- clients whose passes failed (values kept)
  ai_calls     integer NOT NULL DEFAULT 0,
  ai_cost_usd  numeric(10,4) NOT NULL DEFAULT 0,
  phase        text,                          -- human-readable current step
  error        text,
  log          text[] NOT NULL DEFAULT '{}',  -- per-client outcome lines for the UI
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  completed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The worker claims the oldest pending job; this keeps that lookup trivial.
CREATE INDEX IF NOT EXISTS idx_targeting_sync_jobs_pending
  ON targeting_sync_jobs (created_at) WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_targeting_sync_jobs_recent
  ON targeting_sync_jobs (created_at DESC);

ALTER TABLE targeting_sync_jobs ENABLE ROW LEVEL SECURITY;
-- Reads/writes go through the service-role API routes, same as push_batches.
DROP POLICY IF EXISTS targeting_sync_jobs_select ON targeting_sync_jobs;
CREATE POLICY targeting_sync_jobs_select ON targeting_sync_jobs
  FOR SELECT TO authenticated USING (true);

-- Keep updated_at honest so a stalled job is detectable.
CREATE OR REPLACE FUNCTION public.fn_touch_targeting_sync_job()
 RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_targeting_sync_jobs_updated_at ON targeting_sync_jobs;
CREATE TRIGGER trg_targeting_sync_jobs_updated_at
  BEFORE UPDATE ON targeting_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_targeting_sync_job();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='targeting_sync_jobs') THEN
    RAISE EXCEPTION '080: targeting_sync_jobs was not created';
  END IF;
  RAISE NOTICE '080: targeting_sync_jobs ready';
END $$;
