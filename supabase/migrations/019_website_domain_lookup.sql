-- Add website_domain stored column + index for fast enrich_email lookups.
-- Strips protocol, www, and path so "https://www.example.com/about" → "example.com".
-- This allows exact-match queries instead of slow ILIKE on 6M rows.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS website_domain TEXT
  GENERATED ALWAYS AS (
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(website, ''), '^https?://', '', 'i'),
          '^www\.', '', 'i'
        ),
        '/.*$', ''
      )
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_leads_website_domain ON leads(website_domain);

-- RPC for enrich_email — exact domain match, uses the index
CREATE OR REPLACE FUNCTION fn_enrich_email(p_domain TEXT)
RETURNS TABLE(email TEXT, first_name TEXT, last_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT email, first_name, last_name
  FROM leads
  WHERE website_domain = lower(trim(p_domain))
    AND email IS NOT NULL
  ORDER BY created_at DESC
  LIMIT 100;
$$;
