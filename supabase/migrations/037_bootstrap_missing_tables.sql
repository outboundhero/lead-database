-- OutboundHero Database: tables that were missing from Renaissance migrations.
--
-- These three tables existed in Renaissance's production DB but were never
-- captured as migration files — they were created ad-hoc via the Supabase SQL
-- editor. This migration formalizes them so a fresh deploy is one-shot.
-- All CREATE statements are idempotent (IF NOT EXISTS) so re-running is safe.

-- 1. lead_job_titles — junction table for fast job-title filtering.
--    Auto-synced from leads.job_title via the trigger below.
--    fn_filter_leads_v2 and fn_export_leads both JOIN this table.
CREATE TABLE IF NOT EXISTS lead_job_titles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ljt_lead_id ON lead_job_titles (lead_id);
CREATE INDEX IF NOT EXISTS idx_ljt_title ON lead_job_titles (title);
CREATE INDEX IF NOT EXISTS idx_ljt_title_lower ON lead_job_titles (LOWER(title));

CREATE OR REPLACE FUNCTION fn_sync_lead_job_titles()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  raw TEXT;
  parsed JSONB;
  title_text TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.job_title IS NOT DISTINCT FROM OLD.job_title THEN
    RETURN NEW;
  END IF;
  DELETE FROM lead_job_titles WHERE lead_id = NEW.id;
  raw := TRIM(COALESCE(NEW.job_title, ''));
  IF raw = '' THEN
    RETURN NEW;
  END IF;
  -- JSON array form: ["CEO","Founder"]
  IF left(raw, 1) = '[' THEN
    BEGIN
      parsed := raw::jsonb;
      FOR title_text IN SELECT jsonb_array_elements_text(parsed) LOOP
        IF TRIM(title_text) <> '' THEN
          INSERT INTO lead_job_titles (lead_id, title) VALUES (NEW.id, TRIM(title_text));
        END IF;
      END LOOP;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- malformed JSON; fall through to plain insert
    END;
  END IF;
  INSERT INTO lead_job_titles (lead_id, title) VALUES (NEW.id, raw);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_lead_job_titles ON leads;
CREATE TRIGGER trg_sync_lead_job_titles
  AFTER INSERT OR UPDATE OF job_title ON leads
  FOR EACH ROW EXECUTE FUNCTION fn_sync_lead_job_titles();

-- 2. audit_logs — admin action log. Written by src/lib/api/log-audit.ts.
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  performed_by TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);

-- 3. api_logs — API request log for the token-authenticated /api/leads/search/* endpoints.
CREATE TABLE IF NOT EXISTS api_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID REFERENCES api_tokens(id) ON DELETE SET NULL,
  token_name TEXT,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_count INTEGER,
  ip_address TEXT,
  duration_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_token_id ON api_logs (token_id);
