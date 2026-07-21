-- Migration 052: queued Bison pushes (corofy enrich-worker pattern, simplified —
-- no enrichment stage; leads come straight from our DB).
--
-- Flow: POST /api/bison/push-batch inserts a push_batches row (instant).
-- scripts/push-worker.mjs (always-on Railway service) claims it:
--   gather   -> resolve the filtered/selected lead ids into push_items
--   push     -> per item: create the lead on each target instance (id persisted
--               BEFORE attach, crash-safe), attach per campaign in chunks,
--               'sent' once attached to ALL target campaigns
--   refresh  -> recompute batch counters/status from item states (self-healing)
--
-- Multi-instance: campaigns may span the 4 Bison installs; a lead is created
-- separately on every instance involved (Bison lead ids are per-workspace),
-- tracked in push_items.bison_ids (instance_url -> lead id).

BEGIN;

CREATE TABLE IF NOT EXISTS push_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- [{ id, name, instance_url, workspace_name }] — every campaign gets every lead
  campaigns jsonb NOT NULL,
  -- exactly one of filters / selected_ids drives the gather
  filters jsonb,
  selected_ids uuid[],
  range_from integer,
  range_to integer,
  max_leads integer,          -- optional cap (UI "To" without "From")
  total integer,              -- set once gathering completes
  processed integer NOT NULL DEFAULT 0,
  sent integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','gathering','processing','complete','error','cancelled')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_push_batches_updated_at ON push_batches;
CREATE TRIGGER trg_push_batches_updated_at BEFORE UPDATE ON push_batches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS push_items (
  batch_id uuid NOT NULL REFERENCES push_batches(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','pushing','sent','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  bison_ids jsonb,            -- instance_url -> Bison lead id (persisted BEFORE attach)
  target_campaigns jsonb,     -- [{ id, instance_url }] decided once, reused on retry
  attached_ids text[] NOT NULL DEFAULT '{}',  -- campaign ids successfully attached
  error text,
  claim_token uuid,
  claimed_at timestamptz,
  PRIMARY KEY (batch_id, lead_id)
);

-- Worker claim scan + batch progress rollups.
CREATE INDEX IF NOT EXISTS idx_push_items_claim ON push_items (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_push_items_stale ON push_items (claimed_at) WHERE status = 'pushing';

-- Service-role only (worker + API routes use the admin client / direct pool).
ALTER TABLE push_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_items ENABLE ROW LEVEL SECURITY;

COMMIT;
