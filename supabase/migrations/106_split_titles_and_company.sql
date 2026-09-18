-- 106: multi-titles become several searchable titles; company names lose the tagline.
--
-- Client decision 2026-09-17, applying to EVERY write path (upload, Bison CSV,
-- Bison mirror import, API, manual edit) — hence triggers, not import code:
--   * "President | CEO" / "Founder | CEO | Chief HubSpot Nerd" / "VP Sales; Sales
--     Manager" are several titles on ONE lead. leads.title keeps the readable
--     text (exports and Bison pushes stay human); lead_job_titles — what the
--     Title chip, its search box and the filter cache read — gets one row per
--     part. Separators: '|' and ';' only. NOT '/' or '&': 52,039 titles contain
--     '/' and 64,673 ' & ', and those are single roles ("Owner/Operator",
--     "Founder & CEO" — see title-aliases.ts).
--   * Company names keep the part before the first '|': "Valpro Attorney
--     Services | California Attorney Service Providers" -> "Valpro Attorney
--     Services". Law-firm names like "Radoslovich | Shapiro, PC" lose the
--     partner half — the client chose this knowing that.
--
-- fn_sync_lead_job_titles is rebuilt from pg_get_functiondef of the LIVE body
-- (2026-09-18); the only change is the plain-text branch. Measured cohort for
-- the backfill: 3,567 titles with ' | ', 685 with unspaced '|', 343 with ';'
-- (≤ ~4,595 leads). The backfill rewrites lead_job_titles rows only — it must
-- NOT touch leads.title (an UPDATE leads ... SET title = title short-circuits in
-- the trigger and would still rewrite ~48 index entries per row).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_sync_lead_job_titles()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  raw TEXT;
  parsed JSONB;
  title_text TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title THEN
    RETURN NEW;
  END IF;
  DELETE FROM lead_job_titles WHERE lead_id = NEW.id;
  raw := TRIM(COALESCE(NEW.title, ''));
  IF raw = '' THEN
    RETURN NEW;
  END IF;
  -- Try to parse as JSON array first
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
      NULL; -- fall through to plain insert
    END;
  END IF;
  -- Plain text: one row per '|' / ';' separated part (106). A title with no
  -- separator is exactly one row, as before.
  FOR title_text IN SELECT regexp_split_to_table(raw, '\s*[|;]\s*') LOOP
    IF TRIM(title_text) <> '' THEN
      INSERT INTO lead_job_titles (lead_id, title) VALUES (NEW.id, TRIM(title_text));
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

-- Company: strip everything from the first '|' onward, on every write path.
CREATE OR REPLACE FUNCTION public.fn_clean_company_name()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.company IS NOT NULL AND position('|' in NEW.company) > 0 THEN
    NEW.company := NULLIF(btrim(split_part(NEW.company, '|', 1)), '');
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_clean_company_name ON leads;
CREATE TRIGGER trg_clean_company_name
  BEFORE INSERT OR UPDATE OF company ON leads
  FOR EACH ROW EXECUTE FUNCTION fn_clean_company_name();

-- Backfill titles: rewrite lead_job_titles for the multi-title cohort only.
SET LOCAL statement_timeout = '300s';
WITH cohort AS (
  SELECT id, title FROM leads
   WHERE title ~ '[|;]' AND title !~ '^\s*\['
), del AS (
  DELETE FROM lead_job_titles t USING cohort c WHERE t.lead_id = c.id
)
INSERT INTO lead_job_titles (lead_id, title)
SELECT c.id, btrim(part)
  FROM cohort c, LATERAL regexp_split_to_table(c.title, '\s*[|;]\s*') AS part
 WHERE btrim(part) <> '';

-- Backfill companies: the ~1k rows carrying a '|' (57 of 500k sampled).
UPDATE leads SET company = NULLIF(btrim(split_part(company, '|', 1)), '')
 WHERE company LIKE '%|%';

COMMIT;

NOTIFY pgrst, 'reload schema';
