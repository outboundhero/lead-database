-- 069: campaign-selection presets (client req #7) + user-editable named lists
-- (client req #4 — titles/keywords/domains presets editable without dev work).

CREATE TABLE IF NOT EXISTS campaign_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  campaign_keys text[] NOT NULL DEFAULT '{}',  -- "<instance_url>#<campaign_id>"
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE campaign_presets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read campaign_presets" ON campaign_presets;
CREATE POLICY "read campaign_presets" ON campaign_presets FOR SELECT USING (true);

-- Named, user-editable term lists. kind drives which filter field an "apply"
-- targets: titles -> jobTitle.exclude, keywords -> keyword.exclude,
-- domains -> website.exclude, gateways -> esp.exclude.
CREATE TABLE IF NOT EXISTS custom_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'keywords'
    CHECK (kind IN ('titles', 'keywords', 'domains', 'gateways', 'competitors')),
  items text[] NOT NULL DEFAULT '{}',
  description text,
  built_in boolean NOT NULL DEFAULT false,
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE custom_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read custom_lists" ON custom_lists;
CREATE POLICY "read custom_lists" ON custom_lists FOR SELECT USING (true);

-- Seed the lists the client named, from what's already in the system.
INSERT INTO custom_lists (name, kind, items, description, built_in)
VALUES
  ('Commercial cleaning titles', 'titles',
   (SELECT COALESCE(array_agg(term ORDER BY term), '{}') FROM commercial_cleaning_excluded_titles),
   'Job titles excluded for commercial-cleaning clients (mirrors the Commercial Cleaning toggle list).', true),
  ('Janitorial & facility-service competitors', 'competitors',
   ARRAY['janitorial', 'commercial cleaning', 'cleaning service', 'cleaning services', 'facility service', 'facility services', 'building maintenance', 'building services', 'custodial', 'janitor', 'maid service', 'housekeeping service', 'porter service', 'day porter', 'floor care', 'carpet cleaning', 'window cleaning', 'pressure washing', 'power washing', 'sanitation service', 'disinfection service'],
   'Company/industry keywords identifying cleaning competitors — apply to Keywords exclude.', true),
  ('Large companies & website domains', 'domains',
   ARRAY['weebly.com', 'squarespace.com', 'wixsite.com', 'wix.com', 'godaddysites.com', 'walmart.com', 'amazon.com', 'target.com', 'costco.com', 'homedepot.com', 'lowes.com', 'kroger.com', 'walgreens.com', 'cvs.com', 'mcdonalds.com', 'starbucks.com', 'subway.com', 'ups.com', 'fedex.com', 'usps.com'],
   'Site-builder and big-brand domains — apply to Website/Domain exclude.', true),
  ('Security email gateways', 'gateways',
   ARRAY['Mimecast', 'Proofpoint', 'Barracuda'],
   'ESP values that are security gateways — apply to ESP exclude when a send must avoid SEGs.', true)
ON CONFLICT (name) DO NOTHING;
