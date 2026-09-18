-- 108: repair the 50 leads whose company 106's backfill turned into NULL.
--
-- 106 cleaned company names with `split_part(company, '|', 1)`, which for the
-- 16 names that START with '|' ("| GrayMatter" — a Bison export artefact) is
-- the empty string, and NULLIF made it NULL. 107 fixed the trigger (first
-- non-empty part); this restores the names from the Bison mirror. Measured
-- 2026-09-18: 50 leads, 16 distinct names. The BEFORE trigger cleans the value
-- again on write, so the mirror's raw text is assigned as is.

BEGIN;
SET LOCAL statement_timeout = '120s';

UPDATE leads l
   SET company = b.company
  FROM (
    SELECT DISTINCT ON (email) email, company
      FROM bison_leads
     WHERE company ~ '^\s*\|'
     ORDER BY email, cv_fetched_at DESC NULLS LAST
  ) b
 WHERE l.email = b.email
   AND l.company IS NULL;

COMMIT;
