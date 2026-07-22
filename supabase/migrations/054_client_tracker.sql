-- Migration 054: client_tags gains the full roster from the Client Tracker sheet.
-- Churned clients have no B2B/B2C instance mapping (they aren't sent to), so the
-- instance columns become nullable; add company name + a source marker.
ALTER TABLE client_tags ALTER COLUMN group_no DROP NOT NULL;
ALTER TABLE client_tags ALTER COLUMN b2b_instance DROP NOT NULL;
ALTER TABLE client_tags ALTER COLUMN b2c_instance DROP NOT NULL;
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS source text; -- 'groups_sheet' | 'tracker'
