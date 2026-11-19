-- 131: Bison lead-sync run log (2026-11-20).
--
-- The top bar shows "Last Bison sync: <time PST> · N new leads" and a "Sync now"
-- button. The button inserts a 'requested' row (POST /api/bison/sync); the
-- bison-sync cron (every 30 minutes, scripts/bison-sync-cron.mjs) claims it —
-- or starts its regular 3-day slot — runs the incremental sync and records the
-- outcome here. Only the server reads or writes this table.

CREATE TABLE IF NOT EXISTS bison_sync_runs (
  id            bigserial PRIMARY KEY,
  trigger       text NOT NULL CHECK (trigger IN ('button', 'schedule', 'manual')),
  status        text NOT NULL CHECK (status IN ('requested', 'running', 'done', 'failed')),
  requested_by  text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  rows_fetched  bigint,
  new_leads     bigint,
  error         text
);

-- At most one waiting request and one running sync at a time. The second index
-- is what stops two syncs from overlapping.
CREATE UNIQUE INDEX IF NOT EXISTS bison_sync_runs_one_requested ON bison_sync_runs ((true)) WHERE status = 'requested';
CREATE UNIQUE INDEX IF NOT EXISTS bison_sync_runs_one_running   ON bison_sync_runs ((true)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS bison_sync_runs_recent ON bison_sync_runs (requested_at DESC);

ALTER TABLE bison_sync_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE bison_sync_runs FROM anon, authenticated;
REVOKE ALL ON SEQUENCE bison_sync_runs_id_seq FROM anon, authenticated;

COMMENT ON TABLE bison_sync_runs IS
  'Bison lead-sync runs: top-bar "Sync now" requests and every run of scripts/bison-sync-cron.mjs (migration 131).';
COMMENT ON COLUMN bison_sync_runs.trigger IS
  'button = top-bar "Sync now"; schedule = the regular slot (03:00 UTC on days 1,4,7…31); manual = run by hand.';
COMMENT ON COLUMN bison_sync_runs.error IS
  'Why a run failed, or which shards failed in a run that otherwise finished (their ids are skipped by later incremental runs).';
