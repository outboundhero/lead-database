-- 095: keep Bison's custom_variables — it carries the enrichment.
--
-- 089 deliberately dropped custom_variables to save ~5 GB, on the reasoning that
-- it was "merge data WE send to Bison". That was wrong. Measured on 120 newly
-- imported leads:
--
--     city                 100%      <- the entire location gap
--     state                100%
--     domain               100%
--     address              100%
--     company phone        100%
--     google maps url      100%
--     question             100%
--     category               5%
--     sub-category           5%
--     additional category    4%
--
-- The 368,907 leads imported from Bison arrived with NO location and NO
-- category, which makes them invisible to client targeting — and Bison had the
-- city and state for every one of them the whole time.
--
-- Stored as FLATTENED COLUMNS rather than the raw jsonb: the raw blob averages
-- 471 bytes/lead (~1.8 GB across the mirror) and most of it is repetition of
-- the variable names. The fields below are what anything actually reads.
--
-- Bison's names are lowercase with mixed separators — "sub-category" is
-- hyphenated, "additional category" is spaced. Clay's CSV headers for the same
-- three are title-cased ("Category", "Sub-Category", "Additional Category"),
-- and Clay ALSO has an unrelated "Call Category" column that must not be
-- confused with them.
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_city                text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_state               text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_category            text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_subcategory         text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_additional_category text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_domain              text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_address             text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_phone               text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_google_maps_url     text;
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_question            text;
-- When the variables were last read from Bison, so a backfill can resume and
-- skip what it has already done.
ALTER TABLE bison_leads ADD COLUMN IF NOT EXISTS cv_fetched_at timestamptz;

-- Finding what still needs fetching. Partial, so it shrinks to nothing as the
-- backfill completes rather than indexing all 3.9M rows forever.
CREATE INDEX IF NOT EXISTS idx_bison_leads_cv_pending
  ON bison_leads (instance_url, bison_id)
  WHERE cv_fetched_at IS NULL;
