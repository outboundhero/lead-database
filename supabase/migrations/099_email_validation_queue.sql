-- 099: background email validation on Reoon DAILY credits.
--
-- The account is on a daily-credit plan (balance API on 2026-09-14: 84,698 daily,
-- 0 instant), and 8.96M of 8.97M leads have never been validated. Validating at
-- export time blocked downloads for ~20 min and never scaled. Instead an hourly
-- worker (scripts/validation-worker.mjs) spends whatever daily credits remain,
-- then waits for them to replenish, until every address has been checked.
--
-- ⚠ RESULTS DO NOT TOUCH leads.validation_status — BY CLIENT DECISION (2026-09-14).
-- The push and export gates read that column (valid/catch_all/NULL pass), so
-- writing 'invalid'/'unknown' there would silently change who gets emailed while
-- the backfill is still running. Campaign logic stays exactly as it is until the
-- backfill finishes; switching the gate to read email_validations is then one
-- deliberate change. Keeping results here also avoids rewriting the 40-index
-- leads table 85k times a day.
--
-- Keyed on the ADDRESS, not the lead row (same reasoning as suppressed_emails in
-- 091): a verdict belongs to the mailbox, so it survives a lead being deleted
-- and re-imported by the Bison sync.

BEGIN;

-- One verdict per address. status uses the same vocabulary as
-- leads.validation_status so the eventual gate switch is a straight swap.
CREATE TABLE IF NOT EXISTS email_validations (
  email         text PRIMARY KEY,
  status        text NOT NULL CHECK (status IN ('valid','catch_all','invalid','risky','unknown')),
  native_status text,                         -- Reoon's own word: safe, disabled, inbox_full…
  provider      text NOT NULL DEFAULT 'reoon',
  task_id       bigint,                       -- validation_tasks.id that produced it
  validated_at  timestamptz NOT NULL DEFAULT now()
);

-- Priority work waiting for credits. 1 = an export asked for it, 2 = eligible
-- for an active client, 3 = requeued retry. The bulk backfill (everything else,
-- priority 4 on task items) is NOT materialised here — it walks leads by id with
-- a cursor, so this table stays small instead of holding 8M rows.
CREATE TABLE IF NOT EXISTS validation_queue (
  email        text PRIMARY KEY,
  priority     smallint NOT NULL DEFAULT 3,
  source       text,
  attempts     smallint NOT NULL DEFAULT 0,
  enqueued_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_validation_queue_order
  ON validation_queue (priority, enqueued_at);

-- One row per Reoon bulk task. 'claimed' = items reserved but not yet accepted
-- by Reoon (a crash here is recovered by requeueing); 'submitted' = Reoon has it.
CREATE TABLE IF NOT EXISTS validation_tasks (
  id                   bigserial PRIMARY KEY,
  reoon_task_id        bigint,
  status               text NOT NULL
                       CHECK (status IN ('claimed','submitted','applied','failed','abandoned')),
  count_items          integer NOT NULL DEFAULT 0,
  count_submitted      integer,
  count_checked        integer,
  result_counts        jsonb,
  daily_credits_before integer,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  submitted_at         timestamptz,
  completed_at         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_validation_tasks_open
  ON validation_tasks (status) WHERE status IN ('claimed','submitted');

-- The addresses inside a task. Deleted once the task's results are applied.
CREATE TABLE IF NOT EXISTS validation_task_items (
  task_id   bigint NOT NULL REFERENCES validation_tasks(id) ON DELETE CASCADE,
  email     text NOT NULL,
  priority  smallint,
  source    text,
  attempts  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, email)
);
CREATE INDEX IF NOT EXISTS idx_validation_task_items_email
  ON validation_task_items (email);

-- Backfill cursor, client-refill progress, full-pass markers.
CREATE TABLE IF NOT EXISTS validation_worker_state (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every balance reading. Reoon does not document when daily credits reset or
-- how large the allotment is; this history answers both from observation.
CREATE TABLE IF NOT EXISTS validation_balance_log (
  id               bigserial PRIMARY KEY,
  observed_at      timestamptz NOT NULL DEFAULT now(),
  daily_credits    integer,
  instant_credits  integer
);

-- Server-only tables: RLS on with no policies (see 097).
ALTER TABLE email_validations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_queue        ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_tasks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_task_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_worker_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_balance_log  ENABLE ROW LEVEL SECURITY;

-- Seed with the ~2,700 addresses already validated at export time, so no credit
-- is spent re-checking them.
INSERT INTO email_validations (email, status, native_status, provider, validated_at)
SELECT lower(btrim(email)), validation_status, validation_response->>'status',
       coalesce(validation_provider, 'reoon'), validated_at
  FROM leads
 WHERE validated_at IS NOT NULL
   AND email IS NOT NULL AND btrim(email) <> ''
   AND validation_status IN ('valid','catch_all','invalid','risky','unknown')
ON CONFLICT (email) DO NOTHING;

COMMIT;
