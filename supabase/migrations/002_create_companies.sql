-- Renaissance Database: Companies table (normalized entity)

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  domain TEXT UNIQUE,
  size TEXT,
  annual_revenue TEXT,
  general_industry TEXT,
  specific_industry TEXT,
  overview TEXT,
  linkedin TEXT,
  technologies TEXT[],
  created_at TIMESTAMPTZ DEFAULT now()
);
