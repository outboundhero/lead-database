-- 107: fixes from the stage-1 import-engine review (2026-09-18), applied before
-- the first real CSV upload through the new engine.
--
-- (a) companies.category_source CHECK lacked 'upload'. 105 added it to leads,
--     and fn_sync_companies copies leads.category_source into companies, so the
--     first categorize-worker run after an upload would have raised a CHECK
--     violation and aborted every call (the 2026-08-17 crash-loop shape). Added
--     NOT VALID (instant, no scan under the lock) and validated in a second
--     transaction (SHARE UPDATE EXCLUSIVE — does not block writers).
-- (b) lead_locations.location_key collapsed only case/space, so "Lincoln|CA" and
--     "Lincoln|CALIFORNIA" were two locations. The import fills state_code at
--     insert time (normalizeStateValue), so the key now prefers the code. The
--     stage-3 resolver, when it fills state_code on a row that had none, must
--     dedupe against a sibling with the same resulting key (unique violation
--     otherwise). The table is empty, so DROP/ADD is instant.
-- (c) A side row needs a place: CHECK city_text or state_text non-blank (the
--     import already refuses such rows; this stops alt_location_text getting a
--     leading ' ; ' from the string_agg).
-- (d) The pending index keyed on state_code, but the resolver's cohort is rows
--     without a geoname id (a state-only row keeps state_code forever).
-- (e) fn_lead_locations_sync: lock the leads row BEFORE the aggregate so two
--     concurrent inserts for the same lead cannot lose the first one's row
--     (the FROM subquery keeps the statement snapshot under READ COMMITTED even
--     after EvalPlanQual re-checks the target row).
-- (f) fn_clean_company_name: a company that STARTS with '|' ("| Acme") lost its
--     name entirely; take the first non-empty part instead.

BEGIN;

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_category_source_check;
ALTER TABLE companies ADD CONSTRAINT companies_category_source_check
  CHECK (category_source IS NULL OR category_source = ANY (ARRAY['keyword','ai','manual','bison','clay','upload']::text[]))
  NOT VALID;

ALTER TABLE lead_locations DROP COLUMN IF EXISTS location_key;   -- drops the UNIQUE with it
ALTER TABLE lead_locations ADD COLUMN location_key text GENERATED ALWAYS AS (
  lower(btrim(coalesce(city_text, ''))) || '|' ||
  coalesce(NULLIF(upper(btrim(state_code)), ''), upper(btrim(coalesce(state_text, ''))))
) STORED;
ALTER TABLE lead_locations ADD CONSTRAINT lead_locations_lead_id_location_key_key UNIQUE (lead_id, location_key);
ALTER TABLE lead_locations ADD CONSTRAINT lead_locations_has_place
  CHECK (btrim(coalesce(city_text, '')) <> '' OR btrim(coalesce(state_text, '')) <> '');

DROP INDEX IF EXISTS idx_lead_locations_pending;
CREATE INDEX idx_lead_locations_pending ON lead_locations (id) WHERE location_id IS NULL;

CREATE OR REPLACE FUNCTION fn_lead_locations_sync() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  v_lead uuid := coalesce(NEW.lead_id, OLD.lead_id);
BEGIN
  -- Serialise concurrent side-row writers on the lead first, so the aggregate
  -- below runs on a snapshot taken AFTER any competing transaction committed.
  PERFORM 1 FROM leads WHERE id = v_lead FOR NO KEY UPDATE;
  UPDATE leads l SET
    alt_location_ids  = s.ids,
    alt_state_keys    = s.keys,
    alt_cities        = s.cities,
    alt_states        = s.states,
    alt_location_text = s.txt
  FROM (
    SELECT
      NULLIF(array_agg(DISTINCT ll.location_id) FILTER (WHERE ll.location_id IS NOT NULL), '{}')                              AS ids,
      NULLIF(array_agg(DISTINCT ll.country_code || '|' || ll.state_code)
               FILTER (WHERE ll.country_code IS NOT NULL AND ll.state_code IS NOT NULL), '{}')                                  AS keys,
      NULLIF(array_agg(DISTINCT lower(btrim(coalesce(ll.city, ll.city_text))))
               FILTER (WHERE btrim(coalesce(ll.city, ll.city_text, '')) <> ''), '{}')                                             AS cities,
      (SELECT NULLIF(array_agg(DISTINCT v), '{}')
         FROM lead_locations ll2,
              LATERAL unnest(ARRAY[lower(btrim(ll2.state)), lower(btrim(ll2.state_code)), lower(btrim(ll2.state_text))]) AS v
        WHERE ll2.lead_id = v_lead AND v IS NOT NULL AND v <> '')                                                                  AS states,
      NULLIF(string_agg(DISTINCT concat_ws(', ', NULLIF(btrim(coalesce(ll.city, ll.city_text, '')), ''),
                                                 NULLIF(btrim(coalesce(ll.state, ll.state_text, '')), '')), ' ; ')
               FILTER (WHERE btrim(coalesce(ll.city, ll.city_text, ll.state, ll.state_text, '')) <> ''), '')                       AS txt
    FROM lead_locations ll
    WHERE ll.lead_id = v_lead
  ) s
  WHERE l.id = v_lead;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_clean_company_name()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.company IS NOT NULL AND position('|' in NEW.company) > 0 THEN
    NEW.company := (SELECT NULLIF(btrim(p), '') FROM regexp_split_to_table(NEW.company, '\|') AS p
                     WHERE btrim(p) <> '' LIMIT 1);
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;

-- Validate the widened CHECK without blocking writers (scan of ~4.7M rows).
BEGIN;
SET LOCAL statement_timeout = '300s';
ALTER TABLE companies VALIDATE CONSTRAINT companies_category_source_check;
COMMIT;

NOTIFY pgrst, 'reload schema';
