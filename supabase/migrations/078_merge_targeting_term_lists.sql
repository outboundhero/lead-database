-- 078: merge the four Rules lists into two (data + columns only; the
--      eligibility function is changed separately in 079).
--
-- WHY
-- The Rules dialog had four boxes that behaved differently in ways nobody could
-- see from the UI:
--   exclude_industries : EXACT match, against general_industry / specific_industry / category
--   exclude_keywords   : whole-word + plural-tolerant, against company / category /
--                        subcategory / additional_category
--   include_industries : ignored by the send logic entirely
--   include_keywords   : ignored by the send logic entirely
-- Client request 2026-08-19: one Include box and one Exclude box.
--
-- WHAT THIS ADDS
--   exclude_terms  — the union of exclude_industries + exclude_keywords
--   include_terms  — empty (both include lists were cleared in migration 075)
--
-- The four original columns are LEFT IN PLACE and untouched. Nothing is dropped,
-- so 079 can be rolled back and the old behaviour restored from live data. They
-- become unused once 079 lands.
--
-- MATCHING (implemented in 079): whole-word, plural-tolerant, across
--   category, subcategory, additional_category, company,
--   general_industry, specific_industry
-- Company overview is deliberately NOT searched (client decision).
--
-- ⚠ ONE DELIBERATE BEHAVIOUR CHANGE. The ~53 terms that live only in
-- exclude_industries move from EXACT to whole-word matching, so "General
-- Medical" will also block a company named "General Medical Supplies". The
-- other 118 industry terms are already duplicated in exclude_keywords, where
-- they were whole-word anyway, so for those nothing changes. Contains-matching
-- was considered and REJECTED: measured against production it would have
-- wrongly blocked ~227k leads on "car" alone, and "pub" (used by 93 clients)
-- would have blocked "Public" and "Republic".
--
-- Terms are lower-cased on merge. Matching is case-insensitive either way, and
-- it makes the de-duplication exact — exclude_keywords was already lower-cased
-- by the sync script's cleanList(), while exclude_industries held Title Case
-- taxonomy names, so "Restaurants" and "restaurants" were duplicates in
-- practice but not by string equality.

ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS exclude_terms text[] NOT NULL DEFAULT '{}';
ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS include_terms text[] NOT NULL DEFAULT '{}';

-- Merge + de-duplicate. Ordered so the result is stable and readable in the UI.
UPDATE client_targeting t
   SET exclude_terms = COALESCE((
         SELECT array_agg(term ORDER BY term)
           FROM (
             SELECT DISTINCT lower(btrim(x)) AS term
               FROM unnest(t.exclude_industries || t.exclude_keywords) x
              WHERE btrim(x) <> ''
           ) d
       ), '{}'),
       include_terms = COALESCE((
         SELECT array_agg(term ORDER BY term)
           FROM (
             SELECT DISTINCT lower(btrim(x)) AS term
               FROM unnest(t.include_industries || t.include_keywords) x
              WHERE btrim(x) <> ''
           ) d
       ), '{}'),
       updated_at = now();

DO $$
DECLARE
  n_rows int; n_terms int; n_lost int;
BEGIN
  SELECT count(*) INTO n_rows FROM client_targeting;
  SELECT coalesce(sum(array_length(exclude_terms, 1)), 0) INTO n_terms FROM client_targeting;

  -- Every distinct term from either source list must survive the merge.
  SELECT count(*) INTO n_lost
    FROM client_targeting t,
         LATERAL unnest(t.exclude_industries || t.exclude_keywords) x
   WHERE btrim(x) <> ''
     AND NOT (lower(btrim(x)) = ANY (t.exclude_terms));
  IF n_lost > 0 THEN
    RAISE EXCEPTION '078: % source terms did not survive the merge', n_lost;
  END IF;

  RAISE NOTICE '078: % rows merged, % exclude_terms total, 0 terms lost', n_rows, n_terms;
END $$;
