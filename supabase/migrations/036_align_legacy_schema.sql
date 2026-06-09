-- OutboundHero Database: align leads schema with what the code expects
--
-- The Renaissance source repo's migrations (001-027) defined the table with
-- legacy column names + types, then renamed/converted them ad-hoc via the
-- Supabase SQL editor. Those changes were never captured as migration files.
-- This migration codifies them so a fresh deploy works without manual steps.

-- Rename phone_number → phone (every RPC SELECTs l.phone)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='leads' AND column_name='phone_number'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='leads' AND column_name='phone'
  ) THEN
    ALTER TABLE leads RENAME COLUMN phone_number TO phone;
  END IF;
END $$;

-- Rename company_name → company_name_raw (lead-detail-panel, sort options,
-- API docs all reference company_name_raw)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='leads' AND column_name='company_name'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='leads' AND column_name='company_name_raw'
  ) THEN
    ALTER TABLE leads RENAME COLUMN company_name TO company_name_raw;
  END IF;
END $$;

-- Add missing keywords column (RPC keyword-search clause expects it)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS keywords TEXT;

-- Convert company_size TEXT → BIGINT (UI calls .toLocaleString())
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='leads' AND column_name='company_size') = 'text' THEN
    ALTER TABLE leads
      ALTER COLUMN company_size TYPE BIGINT
      USING NULLIF(regexp_replace(company_size, '[^0-9]', '', 'g'), '')::BIGINT;
  END IF;
END $$;

-- Convert annual_revenue TEXT → NUMERIC (UI formats it as currency)
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='leads' AND column_name='annual_revenue') = 'text' THEN
    ALTER TABLE leads
      ALTER COLUMN annual_revenue TYPE NUMERIC
      USING NULLIF(regexp_replace(annual_revenue, '[^0-9.]', '', 'g'), '')::NUMERIC;
  END IF;
END $$;
