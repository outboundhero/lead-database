-- Renaissance Database: Core leads table
-- This is the primary table (~10-20M rows)

CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,

  -- Professional
  job_title TEXT,
  job_title_normalized TEXT,
  seniority TEXT,

  -- Company
  company_name TEXT,
  company_size TEXT,
  annual_revenue TEXT,

  -- Industry
  general_industry TEXT,
  specific_industry TEXT,

  -- Contact
  phone_number TEXT,
  website TEXT,
  person_linkedin TEXT,
  company_linkedin TEXT,

  -- Classification
  source TEXT,
  status TEXT,
  esp TEXT,

  -- Extra
  raw_data JSONB,
  city TEXT,
  state TEXT,
  country TEXT,
  domain TEXT,
  company_overview TEXT,
  technologies TEXT[],

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
