-- 081: let a rules sync be undone.
--
-- WHY (measured, not theoretical)
-- Re-parsing a client whose onboarding text had NOT changed produced materially
-- different rules. Client Q, byte-identical sheet text, run twice:
--     include_locations   8  ->  18
--     exclude_industries  2  ->  16
-- It went from excluding medical/dental only, to also excluding Manufacturing,
-- Shipping & Logistics, Dealerships, Religious, Fitness Centers and Veterinary.
-- That is a large, silent change to who a client gets contacted about.
--
-- The models run at temperature 0, but the location and exclusion prompts are
-- long free-text ones and the output still varies run to run. The scheduled
-- 6-hourly sync has always had this property; the new "Sync rules" button just
-- makes it easy to trigger on demand, so it needs an undo.
--
-- Each job stores the FULL client_targeting rows it is about to overwrite, so
-- /api/clients/sync-rules/revert can put them back exactly.

ALTER TABLE targeting_sync_jobs ADD COLUMN IF NOT EXISTS snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE targeting_sync_jobs ADD COLUMN IF NOT EXISTS reverted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='targeting_sync_jobs' AND column_name='snapshot') THEN
    RAISE EXCEPTION '081: snapshot column missing';
  END IF;
  RAISE NOTICE '081: rules syncs are now revertible';
END $$;
