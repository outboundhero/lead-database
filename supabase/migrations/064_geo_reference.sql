-- 064: Location intelligence foundation.
--
-- A comprehensive geographic reference (GeoNames-sourced) for the supported
-- countries, a resolution/alias cache that improves with every import, a
-- company-location inference cache, per-client targeting rules, and the
-- normalized location columns on leads.
--
-- Display conventions (per client spec):
--   leads.state        = full name ("Washington", "Ontario", "Victoria")
--   leads.state_code   = code      ("WA", "ON", "VIC")
--   leads.country      = display   ("USA", "Canada", "Australia")
--   leads.country_code = ISO       ("US", "CA", "AU")
-- "Washington" (WA) and "District of Columbia" (DC) are distinct entities.

-- ── Supported countries (extend by inserting a row + loading its dump) ──
CREATE TABLE IF NOT EXISTS supported_countries (
  code text PRIMARY KEY,          -- ISO-3166 alpha-2
  name text NOT NULL,             -- official-ish name
  display_name text NOT NULL,     -- what the UI shows ("USA")
  enabled boolean NOT NULL DEFAULT true
);
INSERT INTO supported_countries (code, name, display_name) VALUES
  ('US', 'United States', 'USA'),
  ('CA', 'Canada', 'Canada'),
  ('AU', 'Australia', 'Australia'),
  ('NZ', 'New Zealand', 'New Zealand'),
  ('GB', 'United Kingdom', 'United Kingdom'),
  ('IE', 'Ireland', 'Ireland')
ON CONFLICT (code) DO NOTHING;

-- ── States / provinces / regions ──
CREATE TABLE IF NOT EXISTS geo_admin1 (
  country_code text NOT NULL REFERENCES supported_countries(code),
  admin1_code text NOT NULL,      -- GeoNames admin1 ("WA", "08", "E7")
  name text NOT NULL,             -- "Washington", "Ontario", "Auckland"
  state_code text NOT NULL,       -- display/postal code ("WA", "ON", "AUK")
  PRIMARY KEY (country_code, admin1_code)
);
CREATE INDEX IF NOT EXISTS idx_geo_admin1_state_code ON geo_admin1 (country_code, state_code);

-- ── Cities / towns / municipalities (GeoNames populated places) ──
CREATE TABLE IF NOT EXISTS geo_locations (
  geoname_id bigint PRIMARY KEY,
  city text NOT NULL,             -- canonical display name
  city_key text NOT NULL,         -- accent-folded letters-only match key
  alternate_names text,           -- comma-separated GeoNames variants
  country_code text NOT NULL REFERENCES supported_countries(code),
  admin1_code text NOT NULL,
  population bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_geo_locations_lookup ON geo_locations (city_key, country_code, admin1_code);
CREATE INDEX IF NOT EXISTS idx_geo_locations_admin ON geo_locations (country_code, admin1_code);

-- ── Resolution cache: any raw variation ever resolved ──
-- level 'city' rows point at a geoname; 'state'/'country' rows resolve
-- partially (state_code/country_code only).
CREATE TABLE IF NOT EXISTS location_aliases (
  alias_key text PRIMARY KEY,     -- folded key of the raw variation
  level text NOT NULL CHECK (level IN ('city', 'state', 'country')),
  country_code text REFERENCES supported_countries(code),
  state_code text,
  geoname_id bigint REFERENCES geo_locations(geoname_id),
  source text NOT NULL CHECK (source IN ('reference', 'manual', 'ai', 'import')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Company-location inference cache (AI answers cost once, ever) ──
CREATE TABLE IF NOT EXISTS company_locations (
  company_key text PRIMARY KEY,   -- lower(btrim(company))
  geoname_id bigint REFERENCES geo_locations(geoname_id),
  city text,
  state_code text,
  country_code text,
  granularity text NOT NULL CHECK (granularity IN ('city', 'state', 'country')),
  source text NOT NULL CHECK (source IN ('propagation', 'area-code', 'cctld', 'ai', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Per-client targeting rules ──
-- include/exclude entries: [{"country":"US","state":"WA","city":"Spokane"}]
-- (state/city optional -> state-wide / country-wide). Explicit exclusions
-- override broader inclusions.
CREATE TABLE IF NOT EXISTS client_targeting (
  client_tag text PRIMARY KEY,
  countries text[] NOT NULL DEFAULT '{US}',
  include_locations jsonb NOT NULL DEFAULT '[]',
  exclude_locations jsonb NOT NULL DEFAULT '[]',
  exclude_industries text[] NOT NULL DEFAULT '{}',
  exclude_keywords text[] NOT NULL DEFAULT '{}',
  require_location boolean NOT NULL DEFAULT false,   -- true = unknown-location leads ineligible
  allow_inferred_location boolean NOT NULL DEFAULT true, -- false = company-inferred locations ineligible
  commercial_cleaning boolean NOT NULL DEFAULT false,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Normalized location columns on leads ──
-- location_status: resolved (city-level entity), partial (state/country only),
-- unresolved (location text present but unrecognized -> review queue),
-- unsupported (confidently outside supported countries), NULL (no location data).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS state_code text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS country_code text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_id bigint;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_source text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_status text
  CHECK (location_status IN ('resolved', 'partial', 'unresolved', 'unsupported'));

CREATE INDEX IF NOT EXISTS idx_leads_state_code ON leads (state_code) WHERE state_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_country_code ON leads (country_code) WHERE country_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_location_id ON leads (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_location_status ON leads (location_status) WHERE location_status IS NOT NULL;

-- ── RLS (read-only to app users; writes via service role) ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supported_countries','geo_admin1','geo_locations','location_aliases','company_locations','client_targeting'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "read %s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "read %s" ON %I FOR SELECT USING (true)', t, t);
  END LOOP;
END $$;
