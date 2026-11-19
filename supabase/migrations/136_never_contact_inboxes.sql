-- 136: general inboxes on the Clay General inboxes filter become never contact.
-- Ships OFF (enrich_settings.never_contact_inboxes.enabled false, no filter
-- loaded).
--
-- The client's Clay General inboxes table runs its paid and sending steps only
-- for inboxes its filter does not match, leaving out the kinds of inbox the
-- client never writes to. The client wants those inboxes never contacted,
-- and not counted as good leads. The filter is the client's own text: it lives in
-- the database (enrich_originals, the inboxes kind), is read from there by a
-- seed step (scripts/never-contact-inboxes.mjs), and is never in this repo or
-- in a migration. The seed writes what it read into the setting below:
-- pattern (the filter as a regular expression), source (where it was read),
-- sha256 (of the pattern) and read_at.
--
-- Never contact is the existing global list: an address goes into
-- suppressed_emails with the reason clay_general_filter, its lead gets
-- is_suppressed, and the address is queued for unsubscribe on every Bison
-- install that holds it, as the "Never contact" action does
-- (src/app/api/leads/suppress/route.ts with fn_suppress_emails and
-- fn_enqueue_bison_unsubscribe, 091, 115, 116). Two differences, both on
-- purpose: an address already on the list is left as it is (its reason is
-- never changed, so restoring this reason's group never restores an address
-- someone suppressed for another reason), and the daily cap below is enforced
-- in the same statement.
--
-- What this adds:
--   - the never_contact_inboxes settings row: enabled false, no pattern, at
--     most 5,000 addresses a day (rows_per_day) in chunks of 500 (chunk_rows).
--   - never_contact_inbox_runs: each dry run (how many general inboxes the
--     filter matches that are not on the list yet, with a sample for each
--     part of the filter) and each apply. An apply names a dry run of the same
--     filter that an admin approved; it sweeps leads in (created_at, id) order
--     up to the dry run's bound, then, while the switch is on, keeps following
--     newly imported leads. At most one apply is live at a time.
--   - fn_never_contact_inbox_pattern_value(value) and
--     fn_never_contact_inbox_pattern(): the stored pattern when it is usable,
--     else null ("not loaded"): text of 1 to 4,000 characters made only of
--     letters, digits, @ _ . - and the escape \. , alternatives joined by |
--     with none empty, and a sha256 that matches it. The same check as
--     scripts/lib/enrich/settings.mjs neverContactFrom(), so the coverage
--     count, the share step and this function agree on when it is loaded.
--   - fn_suppress_general_inboxes(lead ids, sha256, run, by, by name): the one
--     writer of this reason. For up to 2,000 lead ids it takes the general
--     inboxes (email_type general) the stored pattern matches and that are not
--     on the list yet, at most what is left of today's cap (UTC day), and
--     suppresses them as described. It refuses while the switch is off, the
--     filter is not loaded, or the filter changed since the run was counted.
--   - an index on suppressed_emails for this reason, for the daily count and
--     the list of what was applied.
--
-- Nothing here writes leads or suppressed_emails: the function does, and only
-- when called. No client data: the setting holds no pattern until the seed
-- runs. RLS is on with no policies on the new table, as in 122 to 135. Needs
-- 091, 115 and 116.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.suppressed_emails') IS NULL
     OR to_regprocedure('public.fn_enqueue_bison_unsubscribe(text[], text, uuid)') IS NULL
     OR to_regclass('public.enrich_settings') IS NULL THEN
    RAISE EXCEPTION '136 needs 091, 116 and 124 (suppressed_emails, fn_enqueue_bison_unsubscribe, enrich_settings) applied first';
  END IF;
END $$;

INSERT INTO enrich_settings (key, value) VALUES
  ('never_contact_inboxes', '{"enabled": false, "pattern": null, "source": null, "sha256": null, "read_at": null,
                              "rows_per_day": 5000, "chunk_rows": 500}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS suppressed_emails_general_filter_idx
  ON suppressed_emails (created_at) WHERE reason = 'clay_general_filter';

CREATE TABLE IF NOT EXISTS never_contact_inbox_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('dry_run', 'apply')),
  state              text NOT NULL CHECK (state IN ('done', 'running', 'following', 'stopped', 'error')),
  pattern_sha256     text NOT NULL CHECK (pattern_sha256 ~ '^[0-9a-f]{64}$'),
  dry_run_id         uuid REFERENCES never_contact_inbox_runs(id),  -- an apply names the dry run it was approved on
  bound_at           timestamptz,       -- dry run: leads created up to here were counted; apply: the backlog ends here
  counted            integer CHECK (counted IS NULL OR counted >= 0),
  sample             jsonb CHECK (sample IS NULL OR jsonb_typeof(sample) IN ('object', 'array')),
  cursor_created_at  timestamptz,       -- apply: how far the sweep got, in (created_at, id) order
  cursor_id          uuid,
  suppressed         integer NOT NULL DEFAULT 0 CHECK (suppressed >= 0),
  leads_flagged      integer NOT NULL DEFAULT 0 CHECK (leads_flagged >= 0),
  bison_queued       integer NOT NULL DEFAULT 0 CHECK (bison_queued >= 0),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_error         text,
  CHECK ((kind = 'apply') = (dry_run_id IS NOT NULL)),
  CHECK (kind = 'apply' OR state IN ('done', 'error'))
);
CREATE UNIQUE INDEX IF NOT EXISTS never_contact_inbox_runs_one_live
  ON never_contact_inbox_runs ((true)) WHERE kind = 'apply' AND state IN ('running', 'following');
CREATE INDEX IF NOT EXISTS never_contact_inbox_runs_recent_idx ON never_contact_inbox_runs (created_at DESC);

DROP TRIGGER IF EXISTS trg_never_contact_inbox_runs_updated_at ON never_contact_inbox_runs;
CREATE TRIGGER trg_never_contact_inbox_runs_updated_at BEFORE UPDATE ON never_contact_inbox_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The stored pattern when it is usable, else null.
CREATE OR REPLACE FUNCTION public.fn_never_contact_inbox_pattern_value(p_value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN NULL
    WHEN jsonb_typeof(p_value -> 'pattern') IS DISTINCT FROM 'string' THEN NULL
    WHEN jsonb_typeof(p_value -> 'sha256') IS DISTINCT FROM 'string' THEN NULL
    WHEN length(p_value ->> 'pattern') NOT BETWEEN 1 AND 4000 THEN NULL
    WHEN (p_value ->> 'pattern') !~ '^([A-Za-z0-9@_.-]|\\\.)+(\|([A-Za-z0-9@_.-]|\\\.)+)*$' THEN NULL
    WHEN encode(sha256(convert_to(p_value ->> 'pattern', 'UTF8')), 'hex') IS DISTINCT FROM (p_value ->> 'sha256') THEN NULL
    ELSE p_value ->> 'pattern'
  END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_never_contact_inbox_pattern() RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT public.fn_never_contact_inbox_pattern_value(
    (SELECT s.value FROM public.enrich_settings s WHERE s.key = 'never_contact_inboxes'))
$fn$;

-- The one writer of the clay_general_filter reason (see above). Returns how
-- many addresses went on the list, how many leads were flagged, how many
-- Bison records were queued for unsubscribe, and how many of today's cap are
-- left after this call.
CREATE OR REPLACE FUNCTION public.fn_suppress_general_inboxes(
  p_lead_ids uuid[],
  p_pattern_sha256 text,
  p_run_id uuid,
  p_by uuid DEFAULT NULL,
  p_by_name text DEFAULT NULL
) RETURNS TABLE (suppressed integer, leads_flagged integer, bison_queued integer, cap_left integer)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_set jsonb := (SELECT s.value FROM public.enrich_settings s WHERE s.key = 'never_contact_inboxes');
  v_pattern text := public.fn_never_contact_inbox_pattern_value(v_set);
  v_cap integer;
  v_today integer;
  v_left integer;
  v_emails text[];
  v_new text[];
  v_flagged integer := 0;
  v_queued integer := 0;
BEGIN
  IF v_set IS NULL OR (v_set -> 'enabled') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'never-contact inboxes are switched off' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_pattern IS NULL THEN
    RAISE EXCEPTION 'the Clay General inboxes filter is not loaded' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_pattern_sha256 IS DISTINCT FROM (v_set ->> 'sha256') THEN
    RAISE EXCEPTION 'the filter changed since this run was counted' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'an apply must name its run' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_lead_ids) > 2000 THEN
    RAISE EXCEPTION 'at most 2,000 lead ids a call, got %', cardinality(p_lead_ids) USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The daily cap: rows_per_day, a whole number from 0 to 100,000; 5,000 when not set.
  v_cap := CASE WHEN jsonb_typeof(v_set -> 'rows_per_day') = 'number'
                     AND (v_set ->> 'rows_per_day')::numeric BETWEEN 0 AND 100000
                     AND (v_set ->> 'rows_per_day')::numeric = trunc((v_set ->> 'rows_per_day')::numeric)
                THEN (v_set ->> 'rows_per_day')::numeric::integer ELSE 5000 END;
  SELECT count(*) INTO v_today
    FROM public.suppressed_emails s
   WHERE s.reason = 'clay_general_filter'
     AND s.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_left := greatest(v_cap - v_today, 0);
  IF p_lead_ids IS NULL OR cardinality(p_lead_ids) = 0 OR v_left = 0 THEN
    RETURN QUERY SELECT 0, 0, 0, v_left;
    RETURN;
  END IF;

  SELECT array_agg(x.e ORDER BY x.e) INTO v_emails
    FROM (SELECT DISTINCT lower(btrim(l.email)) AS e
            FROM public.leads l
           WHERE l.id = ANY (p_lead_ids)
             AND l.email_type = 'general'
             AND btrim(coalesce(l.email, '')) <> ''
             AND l.email ~* v_pattern
             AND NOT EXISTS (SELECT 1 FROM public.suppressed_emails s WHERE s.email = lower(btrim(l.email)))
           ORDER BY 1
           LIMIT v_left) x;
  IF v_emails IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, v_left;
    RETURN;
  END IF;

  WITH ins AS (
    INSERT INTO public.suppressed_emails (email, reason, notes, suppressed_by, suppressed_by_name)
    SELECT e, 'clay_general_filter',
           format('General inbox on the Clay General inboxes filter (run %s, filter %s)', p_run_id, left(p_pattern_sha256, 12)),
           p_by, p_by_name
      FROM unnest(v_emails) AS e
    ON CONFLICT (email) DO NOTHING
    RETURNING email
  )
  SELECT array_agg(ins.email ORDER BY ins.email) INTO v_new FROM ins;
  IF v_new IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, v_left;
    RETURN;
  END IF;

  UPDATE public.leads l SET is_suppressed = true
   WHERE (l.email = ANY (v_new) OR (l.id = ANY (p_lead_ids) AND lower(btrim(l.email)) = ANY (v_new)))
     AND l.is_suppressed = false;
  GET DIAGNOSTICS v_flagged = ROW_COUNT;
  v_queued := public.fn_enqueue_bison_unsubscribe(v_new, 'unsubscribe', p_by);
  RETURN QUERY SELECT cardinality(v_new), v_flagged, coalesce(v_queued, 0), v_left - cardinality(v_new);
END $fn$;

-- Access: server-only.
ALTER TABLE never_contact_inbox_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON never_contact_inbox_runs FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_never_contact_inbox_pattern_value(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_never_contact_inbox_pattern() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_suppress_general_inboxes(uuid[], text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_never_contact_inbox_pattern_value(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_never_contact_inbox_pattern() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_suppress_general_inboxes(uuid[], text, uuid, uuid, text) TO service_role;

COMMENT ON TABLE never_contact_inbox_runs IS 'Never-contact inboxes: each dry run of the Clay General inboxes filter and each approved apply (136).';
COMMENT ON FUNCTION public.fn_never_contact_inbox_pattern() IS 'The Clay General inboxes filter as the seed stored it, when usable; null when not loaded (136).';
COMMENT ON FUNCTION public.fn_suppress_general_inboxes(uuid[], text, uuid, uuid, text) IS 'The one writer of the clay_general_filter reason: general inboxes the filter matches go on the never-contact list, within the daily cap (136).';
COMMENT ON COLUMN suppressed_emails.reason IS 'Why the address is never contacted, free text; clay_general_filter is a general inbox on the Clay General inboxes filter (136).';

DO $$
DECLARE
  bad text;
  p constant text := 'shtestbox@|shtest-dept|shtestzone\.test|shtest.quiet';
  sha text := encode(sha256(convert_to('shtestbox@|shtest-dept|shtestzone\.test|shtest.quiet', 'UTF8')), 'hex');
BEGIN
  IF to_regclass('public.never_contact_inbox_runs') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.never_contact_inbox_runs'::regclass)
     OR has_table_privilege('anon', 'public.never_contact_inbox_runs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.never_contact_inbox_runs', 'SELECT') THEN
    RAISE EXCEPTION '136: never_contact_inbox_runs is missing or not server-only';
  END IF;
  SELECT string_agg(f, ', ') INTO bad
    FROM unnest(ARRAY['public.fn_never_contact_inbox_pattern_value(jsonb)', 'public.fn_never_contact_inbox_pattern()',
                      'public.fn_suppress_general_inboxes(uuid[], text, uuid, uuid, text)']) f
   WHERE to_regprocedure(f) IS NULL
      OR has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '136: missing, or callable by anon or authenticated: %', bad;
  END IF;
  IF to_regclass('public.suppressed_emails_general_filter_idx') IS NULL
     OR to_regclass('public.never_contact_inbox_runs_one_live') IS NULL THEN
    RAISE EXCEPTION '136: an index is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enrich_settings WHERE key = 'never_contact_inboxes') THEN
    RAISE EXCEPTION '136: the never_contact_inboxes setting is missing';
  END IF;
  IF coalesce((SELECT value -> 'enabled' = 'true'::jsonb FROM enrich_settings WHERE key = 'never_contact_inboxes'), false) THEN
    RAISE NOTICE '136: note, never-contact inboxes is ON';
  END IF;

  -- The pattern check, on a made-up stand-in (never the client's filter).
  IF public.fn_never_contact_inbox_pattern_value(jsonb_build_object('pattern', p, 'sha256', sha)) IS DISTINCT FROM p THEN
    RAISE EXCEPTION '136: a usable made-up pattern reads as not loaded';
  END IF;
  SELECT string_agg(r.label, ', ') INTO bad
    FROM (VALUES
      ('no value', public.fn_never_contact_inbox_pattern_value(NULL)),
      ('not an object', public.fn_never_contact_inbox_pattern_value('[]')),
      ('null pattern', public.fn_never_contact_inbox_pattern_value('{"pattern": null, "sha256": null}')),
      ('wrong sha', public.fn_never_contact_inbox_pattern_value(jsonb_build_object('pattern', p, 'sha256', repeat('0', 64)))),
      ('empty alternative', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', p || '|', 'sha256', encode(sha256(convert_to(p || '|', 'UTF8')), 'hex')))),
      ('leading bar', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', '|' || p, 'sha256', encode(sha256(convert_to('|' || p, 'UTF8')), 'hex')))),
      ('double bar', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', 'zza||zzb', 'sha256', encode(sha256(convert_to('zza||zzb', 'UTF8')), 'hex')))),
      ('a quantifier', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', 'zz.*', 'sha256', encode(sha256(convert_to('zz.*', 'UTF8')), 'hex')))),
      ('a group', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', '(zz)', 'sha256', encode(sha256(convert_to('(zz)', 'UTF8')), 'hex')))),
      ('another escape', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', 'zz\d', 'sha256', encode(sha256(convert_to('zz\d', 'UTF8')), 'hex')))),
      ('a lone backslash', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', 'zz\', 'sha256', encode(sha256(convert_to('zz\', 'UTF8')), 'hex')))),
      ('a space', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', 'zz a', 'sha256', encode(sha256(convert_to('zz a', 'UTF8')), 'hex')))),
      ('too long', public.fn_never_contact_inbox_pattern_value(jsonb_build_object(
         'pattern', repeat('a', 4001), 'sha256', encode(sha256(convert_to(repeat('a', 4001), 'UTF8')), 'hex'))))
    ) AS r(label, got)
   WHERE r.got IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '136: the pattern check takes what it should refuse: %', bad;
  END IF;
  -- The stand-in matches as the Clay filter's JavaScript test would (/.../i).
  IF NOT ('ShTestBox@acme.test' ~* p) OR NOT ('office@shtest-dept.test' ~* p) OR NOT ('a@shtestzone.test' ~* p)
     OR ('a@shtestzoneXtest.test' ~* p) OR NOT ('a@shtestXquiet.test' ~* p) OR ('office@acme.test' ~* p) THEN
    RAISE EXCEPTION '136: the stand-in does not match as a JavaScript /.../i test would';
  END IF;
  -- As seeded, nothing is loaded and the writer refuses.
  IF public.fn_never_contact_inbox_pattern() IS NOT NULL
     AND (SELECT value ->> 'pattern' FROM enrich_settings WHERE key = 'never_contact_inboxes') IS NULL THEN
    RAISE EXCEPTION '136: a pattern reads as loaded with none stored';
  END IF;
  IF coalesce((SELECT value -> 'enabled' = 'true'::jsonb FROM enrich_settings WHERE key = 'never_contact_inboxes'), false) = false THEN
    BEGIN
      PERFORM * FROM public.fn_suppress_general_inboxes(ARRAY[gen_random_uuid()], sha, gen_random_uuid());
      RAISE EXCEPTION '136: the writer ran with the switch off' USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN object_not_in_prerequisite_state THEN NULL;
    END;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Read-only checks after applying (paste and run on their own):
--   SELECT value - 'pattern' AS setting, value ->> 'pattern' IS NOT NULL AS has_pattern
--     FROM enrich_settings WHERE key = 'never_contact_inboxes';           -- enabled false, no pattern until the seed
--   SELECT fn_never_contact_inbox_pattern() IS NOT NULL AS loaded;          -- false until the seed runs
--   SELECT count(*) FROM suppressed_emails WHERE reason = 'clay_general_filter';   -- 0 until an approved apply runs
