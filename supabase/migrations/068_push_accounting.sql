-- 068: per-client-tag export accounting (client req #8).
--
-- push_options on push_batches: {"includeAlreadyPushed": bool,
-- "onlyNewSinceLast": bool, "retryFailed": bool} — applied by the push-worker
-- gather stage. Dedupe/"already pushed" is defined per CLIENT TAG (every batch
-- carrying the same client_tag), not per campaign.
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS push_options jsonb;

-- Cross-batch "was this lead ever pushed for this tag" lookups.
CREATE INDEX IF NOT EXISTS idx_push_items_lead ON push_items (lead_id);
CREATE INDEX IF NOT EXISTS idx_push_batches_tag ON push_batches (client_tag) WHERE client_tag IS NOT NULL;
