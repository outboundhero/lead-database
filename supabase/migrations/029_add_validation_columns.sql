-- OutboundHero Database: email validation tracking on leads
-- Records the most recent validation outcome for each lead so the export
-- pre-pass can skip re-validating anything done within the last 45 days.
-- Populated by src/lib/validation/validate-leads.ts (Reoon primary, FindEmail fallback).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS validation_status TEXT
  CHECK (validation_status IS NULL OR validation_status IN ('valid', 'catch_all', 'invalid', 'pending'));

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS validation_provider TEXT
  CHECK (validation_provider IS NULL OR validation_provider IN ('reoon', 'findemail'));

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;

-- Raw API response stored for audit / debugging. Trimmed to provider-relevant fields by the client.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS validation_response JSONB;
