-- 115: suppress / restore a whole SET of addresses in one statement.
--
-- fn_suppress_email and fn_unsuppress_email take ONE address, and the API
-- looped them — one round trip per address, Railway (US) → Supabase (Sydney),
-- ~1 s each. 5,000 addresses (the route's own cap) would have taken well over
-- an hour, which is why "Never contact" could only ever be used on the handful
-- of rows checked on one page. Set-based, the same 5,000 is a single statement.
--
-- The per-address functions stay: they are the readable form and nothing else
-- has to change. These are exactly their bulk twins — same upsert (a repeat
-- suppression keeps the original reason/notes unless new ones are given), same
-- leads.is_suppressed flip, same "rows newly flagged" return.
--
-- Returns both numbers because they answer different questions: `suppressed`
-- is how many addresses are now blocked, `leads_flagged` how many lead rows
-- actually changed state (an address can be blocked with no lead row at all —
-- that is the point of keying suppression on the address).

CREATE OR REPLACE FUNCTION public.fn_suppress_emails(
  p_emails  text[],
  p_reason  text DEFAULT NULL,
  p_notes   text DEFAULT NULL,
  p_by      uuid DEFAULT NULL,
  p_by_name text DEFAULT NULL
) RETURNS TABLE (suppressed integer, leads_flagged integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_emails text[];
  v_flagged integer;
BEGIN
  SELECT array_agg(DISTINCT lower(btrim(e)))
    INTO v_emails
    FROM unnest(coalesce(p_emails, '{}')) AS e
   WHERE btrim(coalesce(e, '')) <> '';

  IF v_emails IS NULL THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  INSERT INTO suppressed_emails (email, reason, notes, suppressed_by, suppressed_by_name)
  SELECT e, p_reason, p_notes, p_by, p_by_name FROM unnest(v_emails) AS e
  ON CONFLICT (email) DO UPDATE SET
    reason = COALESCE(EXCLUDED.reason, suppressed_emails.reason),
    notes  = COALESCE(EXCLUDED.notes,  suppressed_emails.notes);

  UPDATE leads SET is_suppressed = true
   WHERE email = ANY (v_emails) AND is_suppressed = false;
  GET DIAGNOSTICS v_flagged = ROW_COUNT;

  RETURN QUERY SELECT coalesce(array_length(v_emails, 1), 0), v_flagged;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_unsuppress_emails(p_emails text[])
RETURNS TABLE (unsuppressed integer, leads_restored integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_emails text[];
  v_removed integer;
  v_restored integer;
BEGIN
  SELECT array_agg(DISTINCT lower(btrim(e)))
    INTO v_emails
    FROM unnest(coalesce(p_emails, '{}')) AS e
   WHERE btrim(coalesce(e, '')) <> '';

  IF v_emails IS NULL THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  DELETE FROM suppressed_emails WHERE email = ANY (v_emails);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  -- Lifting the block also brings the lead back into play. A lead deleted at
  -- suppression time cannot be resurrected here — the row is gone — which is
  -- why the UI says "restores the lead row if it still exists".
  UPDATE leads SET is_suppressed = false
   WHERE email = ANY (v_emails) AND is_suppressed = true;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  RETURN QUERY SELECT v_removed, v_restored;
END;
$function$;

NOTIFY pgrst, 'reload schema';
