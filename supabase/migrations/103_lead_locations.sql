-- 103: one lead, many locations.
--
-- Client decision 2026-09-17: a person who covers several offices (a director
-- in Seattle who also runs Dallas and Chicago) must be findable under EACH of
-- those places. Email stays the identity — a second leads row for the same email
-- is impossible (leads_email_key) and every ON CONFLICT (email) in the system
-- depends on that — so extra places become rows in lead_locations, and the
-- lead's PRIMARY location stays in the existing leads columns untouched.
--
-- HOW PREDICATES SEE THEM. A subquery against this table inside an OR with the
-- primary predicate was measured to make the planner abandon the location
-- index and walk 4.2M rows (24 s for one client). So this table is the source
-- of truth, and a trigger keeps small denormalised arrays on leads that the
-- filter functions can probe with `&&` / `@>` via partial GIN indexes (104):
--   alt_location_ids  bigint[]  resolved geoname ids          (targeting, eligibility, coverage)
--   alt_state_keys    text[]    'US|TX'                        (state-level targeting, country gate)
--   alt_cities        text[]    lower-cased city text          (City chip exact, header filters)
--   alt_states        text[]    lower-cased state names+codes  (State chip exact, header filters)
--   alt_location_text text      'Dallas, Texas ; Chicago, IL'  (Contains-mode chips via trigram)
-- The arrays are NULL for the ~9M leads that have no extra location, so the
-- partial indexes stay tiny. No existing row is rewritten by this migration.
--
-- Rules the trigger/import rely on (documented in CLAUDE.md):
--   * exclusions apply if ANY location matches;
--   * the primary is the best-resolved location — a lead is never hidden because
--     one of its extra locations is weak (there is deliberately no 'unresolved'
--     status here: "never unknown");
--   * city_text/state_text hold the text exactly as imported; city/state/…
--     hold what the resolver derived.

BEGIN;

CREATE TABLE IF NOT EXISTS lead_locations (
  id               bigserial PRIMARY KEY,
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  city_text        text,                 -- exactly as imported
  state_text       text,                 -- exactly as imported
  city             text,                 -- canonical, from the resolver
  state            text,
  state_code       text,
  country          text,
  country_code     text,
  location_id      bigint,               -- geo_locations.geoname_id (same convention as leads)
  location_status  text CHECK (location_status IS NULL OR location_status IN ('resolved','partial','unsupported')),
  location_source  text,
  source           text NOT NULL DEFAULT 'upload',   -- upload | api | bison | manual
  upload_batch_id  uuid REFERENCES upload_batches(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- One row per (lead, place-as-written). Case/space-insensitive so "dallas"
  -- and "Dallas " do not become two locations.
  location_key     text GENERATED ALWAYS AS (
                     lower(btrim(coalesce(city_text, ''))) || '|' || upper(btrim(coalesce(state_text, '')))
                   ) STORED,
  UNIQUE (lead_id, location_key)
);
CREATE INDEX IF NOT EXISTS idx_lead_locations_lead ON lead_locations (lead_id);
-- The resolver's cohort: rows whose place is not yet derived. Self-draining.
CREATE INDEX IF NOT EXISTS idx_lead_locations_pending ON lead_locations (id) WHERE state_code IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_locations_location ON lead_locations (location_id) WHERE location_id IS NOT NULL;
ALTER TABLE lead_locations ENABLE ROW LEVEL SECURITY;   -- server-only (097 convention)

-- Denormalised predicate surface on leads. Nullable, no default: metadata-only.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS alt_location_ids  bigint[],
  ADD COLUMN IF NOT EXISTS alt_state_keys    text[],
  ADD COLUMN IF NOT EXISTS alt_cities        text[],
  ADD COLUMN IF NOT EXISTS alt_states        text[],
  ADD COLUMN IF NOT EXISTS alt_location_text text;

-- Recompute the lead's arrays from its side rows. One non-HOT UPDATE of leads
-- per side-row change; bulk loaders must insert sorted by lead_id (deadlock
-- lesson, CLAUDE.md). When the last location is deleted every array goes NULL.
CREATE OR REPLACE FUNCTION fn_lead_locations_sync() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  v_lead uuid := coalesce(NEW.lead_id, OLD.lead_id);
BEGIN
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
                                                 NULLIF(btrim(coalesce(ll.state, ll.state_text, '')), '')), ' ; '), '')            AS txt
    FROM lead_locations ll
    WHERE ll.lead_id = v_lead
  ) s
  WHERE l.id = v_lead;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_lead_locations_sync ON lead_locations;
CREATE TRIGGER trg_lead_locations_sync
  AFTER INSERT OR UPDATE OR DELETE ON lead_locations
  FOR EACH ROW EXECUTE FUNCTION fn_lead_locations_sync();

CREATE OR REPLACE FUNCTION fn_lead_locations_touch() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$function$;
DROP TRIGGER IF EXISTS trg_lead_locations_touch ON lead_locations;
CREATE TRIGGER trg_lead_locations_touch BEFORE UPDATE ON lead_locations
  FOR EACH ROW EXECUTE FUNCTION fn_lead_locations_touch();

COMMIT;

NOTIFY pgrst, 'reload schema';
