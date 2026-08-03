-- 067: onboarding-sheet sync provenance + include-side targeting.
--
-- include_industries / include_keywords are browse/preview aids (auto-applied
-- to the filter bar when a client tag is selected) — fn_client_eligibility_conditions
-- is deliberately unchanged for includes: many leads have no category yet, and
-- include-gating would silently block them all from pushes. Excludes already gate.
--
-- sheet_raw stores the verbatim L/M/O cell text from the onboarding sheet; the
-- sync script re-parses a client only when that text changes, so manual Rules-
-- dialog edits survive until the client's sheet row is actually edited.

ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS include_industries text[] NOT NULL DEFAULT '{}';
ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS include_keywords  text[] NOT NULL DEFAULT '{}';
ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';  -- 'manual' | 'sheet'
ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS sheet_raw jsonb;        -- {"target": L, "exclusion": M, "locations": O}
ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS sheet_synced_at timestamptz;
