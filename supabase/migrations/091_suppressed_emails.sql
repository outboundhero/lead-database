-- 091: a permanent do-not-contact list.
--
-- Deleting a lead is not enough. The Bison sync (089/090) adds addresses Bison
-- holds that we do not, so a deleted lead comes straight back on the next run
-- and lands in a client campaign again. The address itself has to be
-- remembered, independently of whether any lead row exists.
--
-- Two pieces, deliberately:
--   suppressed_emails  — the durable record, keyed on the ADDRESS. Survives the
--                        lead being deleted, and is what the Bison import
--                        checks before creating anything.
--   leads.is_suppressed — a flag on the row, so browse, exports and the push
--                        gate can exclude it with a plain boolean instead of a
--                        subquery against 8.2M rows on every filter.

CREATE TABLE IF NOT EXISTS suppressed_emails (
  email        text PRIMARY KEY,
  reason       text,
  notes        text,
  suppressed_by uuid,
  suppressed_by_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE suppressed_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read suppressed_emails" ON suppressed_emails;
CREATE POLICY "Anyone can read suppressed_emails" ON suppressed_emails FOR SELECT USING (true);

-- NOT NULL with a constant default is metadata-only in modern Postgres, so this
-- does not rewrite the 8.4 GB leads table.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_suppressed boolean NOT NULL DEFAULT false;

-- Partial: only the suppressed rows are indexed, so it stays tiny rather than
-- carrying all 8.2M.
CREATE INDEX IF NOT EXISTS idx_leads_suppressed ON leads (id) WHERE is_suppressed;

-- Keep the flag and the list in step, including for rows created later by the
-- Bison import — belt and braces behind the import's own check, so an address
-- can never be resurrected by a code path that forgets to look.
CREATE OR REPLACE FUNCTION public.fn_apply_suppression()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM suppressed_emails s WHERE s.email = NEW.email) THEN
    NEW.is_suppressed := true;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_leads_apply_suppression ON leads;
CREATE TRIGGER trg_leads_apply_suppression
  BEFORE INSERT OR UPDATE OF email ON leads
  FOR EACH ROW EXECUTE FUNCTION public.fn_apply_suppression();

-- Suppress an address: record it, and flag any lead that already carries it.
-- Idempotent, so re-suppressing is harmless.
CREATE OR REPLACE FUNCTION public.fn_suppress_email(
  p_email text, p_reason text DEFAULT NULL, p_notes text DEFAULT NULL,
  p_by uuid DEFAULT NULL, p_by_name text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_email text := lower(btrim(p_email));
  v_rows integer;
BEGIN
  IF v_email = '' OR v_email IS NULL THEN RETURN 0; END IF;
  INSERT INTO suppressed_emails (email, reason, notes, suppressed_by, suppressed_by_name)
  VALUES (v_email, p_reason, p_notes, p_by, p_by_name)
  ON CONFLICT (email) DO UPDATE SET
    reason = COALESCE(EXCLUDED.reason, suppressed_emails.reason),
    notes  = COALESCE(EXCLUDED.notes,  suppressed_emails.notes);
  UPDATE leads SET is_suppressed = true WHERE email = v_email AND is_suppressed = false;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_unsuppress_email(p_email text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_email text := lower(btrim(p_email));
  v_rows integer;
BEGIN
  DELETE FROM suppressed_emails WHERE email = v_email;
  UPDATE leads SET is_suppressed = false WHERE email = v_email AND is_suppressed = true;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_suppress_email(text, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_unsuppress_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_suppress_email(text, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_unsuppress_email(text) TO service_role;
