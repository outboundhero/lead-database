-- 076: drop un-split comma lists from client_targeting exclusion arrays.
--
-- CAUSE: src/components/ui/ios/tag-input.tsx handled the "," KEYPRESS but not
-- PASTE, and its onBlur committed the whole draft as one chip. Pasting a comma
-- list therefore stored it as a single array element. Fixed in the component
-- (it now splits on , ; newline and tab, including on paste).
--
-- In production this produced exactly one bad row: JPNW.exclude_industries held
-- a single 588-character entry — "restaurant, restaurants, eatery, eateries,
-- diner, …" — alongside 4 legitimate entries.
--
-- WHY DELETE RATHER THAN SPLIT: exclude_industries is matched by EXACT,
-- case-insensitive equality against general_industry / specific_industry /
-- category (see fn_client_eligibility_conditions). A 588-character string
-- equals no category, so the entry is inert today. Splitting it into ~30 live
-- exclusions would silently NARROW JPNW's targeting. Those same terms are
-- already present individually in JPNW.exclude_keywords (56 entries, verified),
-- where whole-term matching actually applies them — so dropping the malformed
-- entry restores the intended behaviour and changes nothing operationally.
--
-- Written generically so it also cleans any future/other row; safe to re-run.

UPDATE client_targeting
   SET exclude_industries = ARRAY(
         SELECT x FROM unnest(exclude_industries) x WHERE x NOT LIKE '%,%'
       ),
       updated_at = now()
 WHERE EXISTS (SELECT 1 FROM unnest(exclude_industries) x WHERE x LIKE '%,%');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM client_targeting t
   WHERE EXISTS (SELECT 1 FROM unnest(t.exclude_industries) x WHERE x LIKE '%,%');
  IF n <> 0 THEN
    RAISE EXCEPTION '076: % rows still hold comma lists in exclude_industries', n;
  END IF;
  RAISE NOTICE '076: no comma lists remain in exclude_industries';
END $$;
