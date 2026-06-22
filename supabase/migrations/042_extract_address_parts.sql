-- OutboundHero Database: extract postal_code + street from the address field.
--
-- ~43% of Email Bison addresses are full US street addresses
-- ("19590 Mainstreet Suite 202, Parker, CO 80138") — we can pull out the ZIP
-- and street line. The other ~52% are just "City, State" (already covered by the
-- city/state columns) and yield NULL here, which is correct.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS street TEXT;

-- Backfill from existing addresses.
--   ZIP: first 5-digit (optionally ZIP+4) token in the address.
--   street: text before the first comma, only when the address starts with a digit
--           (i.e. it's a real street line, not "City, State").
UPDATE leads
SET
  postal_code = substring(address FROM '\d{5}(?:-\d{4})?'),
  street = CASE WHEN address ~ '^\s*\d' THEN trim(split_part(address, ',', 1)) END
WHERE address IS NOT NULL
  AND (postal_code IS NULL AND street IS NULL);

-- ZIP-prefix filtering / radius grouping benefits from an index.
CREATE INDEX IF NOT EXISTS idx_leads_postal_code ON leads (postal_code) WHERE postal_code IS NOT NULL;
