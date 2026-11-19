-- 132: churn dates from the Groups tab, and who can receive shares and top-ups.
--
-- The tracker's Groups tab has a Churn Date column beside each group's tag
-- column. The roster sync, "Sync with sheet" and "Sync groups" read that tab;
-- from now on each good read also records, for every client_tags row, whether
-- the tab lists the client (on_groups_tab) and, for a listed client, its churn
-- cell as read (churn_cell), what the cell says (churn_cell_state) and the date
-- (churn_date). fn_client_groups_tab_record() writes all of it in one
-- statement, so the three readers write it the same way and in one
-- transaction. When the tab cannot be read nothing is written, so the last
-- good read stands.
--
-- churn_cell_state, set by the parser (scripts/lib/overlap-topup.mjs,
-- churnCellOf):
--   date        a date (a date cell, or text in M/D/YYYY): churn_date holds it
--   empty       a blank cell: no churn date
--   non_answer  "-", "N/A", "none" and the like: no churn date (and listed)
--   unreadable  any other text, for example "TBD": blocks the client until fixed
--
-- fn_client_receive_block(tag) says why a client cannot receive shared leads,
-- top-up pulls or share pushes; NULL when it can. fn_client_can_receive(tag)
-- is the same as a yes or no. A client can receive when all of these hold:
--   - client_tags.status is Active or Healthy (trimmed, any case);
--   - it has a sending group (group_no);
--   - the Groups tab listed it at the last good read;
--   - its churn cell is readable, and holds no date within the next 15 days
--     (UTC days) and no date in the past;
--   - it has a rules row (client_targeting), with at least one place, and
--     every place names a country and a state. A client with no rules row, no
--     places, or one place with no state would take leads from the whole
--     country, because the rule function ORs its places.
-- fn_client_receive_block_of() holds the rule itself, on plain values, so a
-- check can test it without writing a client.
--
-- Nothing here reads or writes leads. The new columns are empty or false on
-- every client until the first good read of the tab, so until the readers are
-- deployed and have run once, every client reads "not on the Groups tab" and
-- nothing can receive. That is the safe side: sharing and the top-up ship off.
-- Needs 129 (fn_enrich_norm_tag).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regprocedure('public.fn_enrich_norm_tag(text)') IS NULL THEN
    RAISE EXCEPTION '132 needs 129 (fn_enrich_norm_tag) applied first';
  END IF;
END $$;

-- What the Groups tab said about each client at the last good read.
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS churn_date date;
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS churn_cell text;
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS churn_cell_state text;
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS on_groups_tab boolean NOT NULL DEFAULT false;
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS groups_tab_read_at timestamptz;

ALTER TABLE client_tags DROP CONSTRAINT IF EXISTS client_tags_churn_cell_state_check;
ALTER TABLE client_tags ADD CONSTRAINT client_tags_churn_cell_state_check
  CHECK (churn_cell_state IS NULL OR churn_cell_state IN ('date', 'empty', 'non_answer', 'unreadable'));
-- A date is held exactly when the cell says one.
ALTER TABLE client_tags DROP CONSTRAINT IF EXISTS client_tags_churn_date_check;
ALTER TABLE client_tags ADD CONSTRAINT client_tags_churn_date_check
  CHECK ((churn_date IS NOT NULL) = (churn_cell_state IS NOT DISTINCT FROM 'date'));
ALTER TABLE client_tags DROP CONSTRAINT IF EXISTS client_tags_churn_cell_check;
ALTER TABLE client_tags ADD CONSTRAINT client_tags_churn_cell_check
  CHECK (churn_cell IS NULL OR length(churn_cell) <= 200);

-- The rule, on plain values. p_today is the UTC day the check is made on.
-- Every jsonb step is guarded, so no value can make it fail.
CREATE OR REPLACE FUNCTION public.fn_client_receive_block_of(
  p_exists boolean,
  p_status text,
  p_group_no integer,
  p_on_groups_tab boolean,
  p_churn_cell_state text,
  p_churn_date date,
  p_has_rules boolean,
  p_include_locations jsonb,
  p_today date
) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN NOT coalesce(p_exists, false) THEN 'not a client'
    WHEN lower(btrim(coalesce(p_status, ''))) NOT IN ('active', 'healthy')
      THEN 'status ' || coalesce(nullif(btrim(p_status), ''), 'blank')
    WHEN p_group_no IS NULL THEN 'no group'
    WHEN NOT coalesce(p_on_groups_tab, false) THEN 'not on the Groups tab'
    WHEN p_churn_cell_state IS NULL OR p_churn_cell_state NOT IN ('date', 'empty', 'non_answer')
      THEN 'churn cell unreadable'
    WHEN p_churn_cell_state = 'date'
         AND (p_churn_date IS NULL OR p_today IS NULL OR p_churn_date <= p_today + 15)
      THEN 'churn date ' || coalesce(to_char(p_churn_date, 'YYYY-MM-DD'), 'missing')
    WHEN NOT coalesce(p_has_rules, false) THEN 'no rules row'
    WHEN jsonb_typeof(p_include_locations) IS DISTINCT FROM 'array'
         OR jsonb_array_length(CASE WHEN jsonb_typeof(p_include_locations) = 'array'
                                    THEN p_include_locations ELSE '[]'::jsonb END) = 0
      THEN 'no places'
    WHEN EXISTS (SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_include_locations) = 'array'
                                                  THEN p_include_locations ELSE '[]'::jsonb END) AS e(item)
                  WHERE jsonb_typeof(e.item) IS DISTINCT FROM 'object'
                     OR NULLIF(TRIM(COALESCE(e.item ->> 'country', '')), '') IS NULL)
      THEN 'a place with no country'
    WHEN EXISTS (SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_include_locations) = 'array'
                                                  THEN p_include_locations ELSE '[]'::jsonb END) AS e(item)
                  WHERE NULLIF(TRIM(COALESCE(e.item ->> 'state', '')), '') IS NULL)
      THEN 'a country-wide place'
  END
$fn$;

-- Why this client cannot receive; NULL when it can. The tag is trimmed and
-- upper-cased as settings.mjs normTag() does.
CREATE OR REPLACE FUNCTION public.fn_client_receive_block(p_tag text) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT public.fn_client_receive_block_of(
           ct.tag IS NOT NULL, ct.status, ct.group_no, ct.on_groups_tab, ct.churn_cell_state, ct.churn_date,
           t.client_tag IS NOT NULL, t.include_locations, (now() AT TIME ZONE 'UTC')::date)
    FROM (SELECT public.fn_enrich_norm_tag(p_tag) AS tag) x
    LEFT JOIN public.client_tags ct ON ct.tag = x.tag
    LEFT JOIN public.client_targeting t ON t.client_tag = x.tag
$fn$;

CREATE OR REPLACE FUNCTION public.fn_client_can_receive(p_tag text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT public.fn_client_receive_block(p_tag) IS NULL
$fn$;

-- One good read of the Groups tab, written for every client in one statement.
-- p_listed: one object per client the tab lists,
--   {"tag": "AAA", "churn_cell_state": "date", "churn_date": "2026-12-31", "churn_cell": "12/31/2026"}
-- churn_date only with the state "date" (YYYY-MM-DD); churn_cell is the cell
-- as read (at most 200 characters), or null. A tag listed twice is refused:
-- the parser settles duplicates first. Every client_tags row gets
-- on_groups_tab, groups_tab_read_at = now() and its churn fields (cleared for
-- a client the tab does not list). Tags the tab lists that are not clients are
-- only reported. Anything malformed raises, and nothing is written.
-- Returns {"listed": n, "unlisted": n, "not_in_roster": [tags]}.
CREATE OR REPLACE FUNCTION public.fn_client_groups_tab_record(p_listed jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  item jsonb;
  pos bigint;
  t text;
  st text;
  d date;
  cell text;
  tags text[] := '{}';
  states text[] := '{}';
  dates date[] := '{}';
  cells text[] := '{}';
  n_listed integer;
  n_unlisted integer;
  outside text[];
BEGIN
  IF p_listed IS NULL OR jsonb_typeof(p_listed) IS DISTINCT FROM 'array'
     OR jsonb_array_length(CASE WHEN jsonb_typeof(p_listed) = 'array' THEN p_listed ELSE '[]'::jsonb END) = 0 THEN
    RAISE EXCEPTION 'fn_client_groups_tab_record: the read lists no client, so nothing is written'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_listed) > 2000 THEN
    RAISE EXCEPTION 'fn_client_groups_tab_record: more than 2,000 clients in one read' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR item, pos IN SELECT e.item, e.ord FROM jsonb_array_elements(p_listed) WITH ORDINALITY AS e(item, ord) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item -> 'tag') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'fn_client_groups_tab_record: entry % has no tag', pos USING ERRCODE = 'invalid_parameter_value';
    END IF;
    t := public.fn_enrich_norm_tag(item ->> 'tag');
    IF t = '' OR length(t) > 64 THEN
      RAISE EXCEPTION 'fn_client_groups_tab_record: entry % has no usable tag', pos USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF t = ANY (tags) THEN
      RAISE EXCEPTION 'fn_client_groups_tab_record: % is listed twice; settle duplicates before writing', t
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    st := item ->> 'churn_cell_state';
    IF st IS NULL OR st NOT IN ('date', 'empty', 'non_answer', 'unreadable') THEN
      RAISE EXCEPTION 'fn_client_groups_tab_record: % has no known churn_cell_state', t USING ERRCODE = 'invalid_parameter_value';
    END IF;
    d := NULL;
    IF st = 'date' THEN
      IF jsonb_typeof(item -> 'churn_date') IS DISTINCT FROM 'string'
         OR (item ->> 'churn_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'fn_client_groups_tab_record: % says date but has no YYYY-MM-DD churn_date', t
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      BEGIN
        d := (item ->> 'churn_date')::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'fn_client_groups_tab_record: % has a churn_date that is not a calendar date', t
          USING ERRCODE = 'invalid_parameter_value';
      END;
      IF d < DATE '2000-01-01' OR d > DATE '2100-12-31' THEN
        RAISE EXCEPTION 'fn_client_groups_tab_record: % has a churn_date outside 2000 to 2100', t
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    ELSIF jsonb_typeof(item -> 'churn_date') IS NOT NULL AND jsonb_typeof(item -> 'churn_date') <> 'null' THEN
      RAISE EXCEPTION 'fn_client_groups_tab_record: % has a churn_date but the state %', t, st
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_typeof(item -> 'churn_cell') IS NULL OR jsonb_typeof(item -> 'churn_cell') = 'null' THEN
      cell := NULL;
    ELSIF jsonb_typeof(item -> 'churn_cell') = 'string' THEN
      cell := nullif(left(item ->> 'churn_cell', 200), '');
    ELSE
      RAISE EXCEPTION 'fn_client_groups_tab_record: % has a churn_cell that is not text', t USING ERRCODE = 'invalid_parameter_value';
    END IF;
    tags := tags || t;
    states := states || st;
    dates := dates || d;
    cells := cells || cell;
  END LOOP;

  UPDATE public.client_tags ct
     SET on_groups_tab = (l.tag IS NOT NULL),
         groups_tab_read_at = now(),
         churn_date = l.churn_date,
         churn_cell = l.cell,
         churn_cell_state = l.state
    FROM public.client_tags c0
    LEFT JOIN unnest(tags, states, dates, cells) AS l(tag, state, churn_date, cell) ON l.tag = c0.tag
   WHERE ct.tag = c0.tag;

  SELECT count(*) FILTER (WHERE on_groups_tab), count(*) FILTER (WHERE NOT on_groups_tab)
    INTO n_listed, n_unlisted
    FROM public.client_tags;
  SELECT coalesce(array_agg(x.tag ORDER BY x.tag), '{}') INTO outside
    FROM unnest(tags) AS x(tag)
   WHERE NOT EXISTS (SELECT 1 FROM public.client_tags c WHERE c.tag = x.tag);
  RETURN jsonb_build_object('listed', n_listed, 'unlisted', n_unlisted, 'not_in_roster', to_jsonb(outside));
END $fn$;

-- Access: the server only (the web app's admin client and the scripts).
REVOKE ALL ON FUNCTION public.fn_client_receive_block_of(boolean, text, integer, boolean, text, date, boolean, jsonb, date)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_client_receive_block(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_client_can_receive(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_client_groups_tab_record(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_client_receive_block_of(boolean, text, integer, boolean, text, date, boolean, jsonb, date)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_client_receive_block(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_client_can_receive(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_client_groups_tab_record(jsonb) TO service_role;

COMMENT ON COLUMN client_tags.churn_date IS 'The churn date the Groups tab gave at the last good read; set only when churn_cell_state is date (132).';
COMMENT ON COLUMN client_tags.churn_cell IS 'The Groups tab churn cell as read, for display (132).';
COMMENT ON COLUMN client_tags.churn_cell_state IS 'What the churn cell says: date, empty, non_answer or unreadable; null while the tab does not list the client (132).';
COMMENT ON COLUMN client_tags.on_groups_tab IS 'Did the Groups tab list this client at the last good read (132).';
COMMENT ON COLUMN client_tags.groups_tab_read_at IS 'When the Groups tab was last read well, written on every client (132).';
COMMENT ON FUNCTION public.fn_client_receive_block(text) IS 'Why a client cannot receive shared leads, top-up pulls or share pushes; null when it can (132).';
COMMENT ON FUNCTION public.fn_client_can_receive(text) IS 'Can this client receive shared leads, top-up pulls or share pushes (132).';
COMMENT ON FUNCTION public.fn_client_groups_tab_record(jsonb) IS 'Writes one good read of the Groups tab for every client: listed or not, and the churn cell (132).';

-- Checks. The rule is tested on plain values: nothing here writes a client.
DO $$
DECLARE
  bad text;
  today constant date := DATE '2026-11-20';
  places constant jsonb := '[{"country": "US", "state": "AZ"}, {"country": "US", "state": "AZ", "city": "Tucson"}]';
  ok_args text;
BEGIN
  SELECT string_agg(c, ', ') INTO bad
    FROM unnest(ARRAY['churn_date', 'churn_cell', 'churn_cell_state', 'on_groups_tab', 'groups_tab_read_at']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'client_tags' AND column_name = c);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '132: client_tags is missing %', bad;
  END IF;
  SELECT string_agg(f, ', ') INTO bad
    FROM unnest(ARRAY['public.fn_client_receive_block_of(boolean, text, integer, boolean, text, date, boolean, jsonb, date)',
                      'public.fn_client_receive_block(text)', 'public.fn_client_can_receive(text)',
                      'public.fn_client_groups_tab_record(jsonb)']) f
   WHERE to_regprocedure(f) IS NULL
      OR has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '132: missing, or callable by anon or authenticated: %', bad;
  END IF;

  -- A client that passes everything.
  IF public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, true, places, today) IS NOT NULL
     OR public.fn_client_receive_block_of(true, ' healthy ', 2, true, 'non_answer', NULL, true, places, today) IS NOT NULL
     OR public.fn_client_receive_block_of(true, 'ACTIVE', 1, true, 'date', DATE '2026-12-06', true, places, today) IS NOT NULL THEN
    RAISE EXCEPTION '132: a client that should receive is blocked';
  END IF;
  -- Each block, with its reason.
  SELECT string_agg(r.want || ' got ' || coalesce(r.got, 'null'), '; ') INTO bad
    FROM (VALUES
      ('not a client', public.fn_client_receive_block_of(false, 'Active', 1, true, 'empty', NULL, true, places, today)),
      ('status Paused', public.fn_client_receive_block_of(true, 'Paused', 1, true, 'empty', NULL, true, places, today)),
      ('status Good Terms', public.fn_client_receive_block_of(true, 'Good Terms', 1, true, 'empty', NULL, true, places, today)),
      ('status Confirmed Churn', public.fn_client_receive_block_of(true, 'Confirmed Churn', 1, true, 'empty', NULL, true, places, today)),
      ('status blank', public.fn_client_receive_block_of(true, '  ', 1, true, 'empty', NULL, true, places, today)),
      ('status blank', public.fn_client_receive_block_of(true, NULL, 1, true, 'empty', NULL, true, places, today)),
      ('no group', public.fn_client_receive_block_of(true, 'Active', NULL, true, 'empty', NULL, true, places, today)),
      ('not on the Groups tab', public.fn_client_receive_block_of(true, 'Active', 1, false, 'empty', NULL, true, places, today)),
      ('churn cell unreadable', public.fn_client_receive_block_of(true, 'Active', 1, true, 'unreadable', NULL, true, places, today)),
      ('churn cell unreadable', public.fn_client_receive_block_of(true, 'Active', 1, true, NULL, NULL, true, places, today)),
      ('churn date 2026-12-05', public.fn_client_receive_block_of(true, 'Active', 1, true, 'date', DATE '2026-12-05', true, places, today)),
      ('churn date 2026-11-20', public.fn_client_receive_block_of(true, 'Active', 1, true, 'date', DATE '2026-11-20', true, places, today)),
      ('churn date 2026-10-01', public.fn_client_receive_block_of(true, 'Active', 1, true, 'date', DATE '2026-10-01', true, places, today)),
      ('churn date missing', public.fn_client_receive_block_of(true, 'Active', 1, true, 'date', NULL, true, places, today)),
      ('no rules row', public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, false, NULL, today)),
      ('no places', public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, true, '[]', today)),
      ('no places', public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, true, '{"a": 1}', today)),
      ('no places', public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, true, NULL, today)),
      ('a place with no country', public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, true,
         '[{"country": "US", "state": "AZ"}, {"state": "AZ"}]', today)),
      ('a place with no country', public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, true, '["US"]', today)),
      ('a country-wide place', public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, true,
         '[{"country": "US", "state": "AZ"}, {"country": "US"}]', today)),
      ('a country-wide place', public.fn_client_receive_block_of(true, 'Active', 1, true, 'empty', NULL, true,
         '[{"country": "US", "state": " ", "city": "Tucson"}]', today))
    ) AS r(want, got)
   WHERE r.got IS DISTINCT FROM r.want;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '132: the receive rule gives the wrong reason: %', bad;
  END IF;
  -- The order of the checks: status first, then the group, the tab, the cell, the rules.
  IF public.fn_client_receive_block_of(true, 'Paused', NULL, false, NULL, NULL, false, NULL, today) <> 'status Paused'
     OR public.fn_client_receive_block_of(true, 'Active', NULL, false, NULL, NULL, false, NULL, today) <> 'no group'
     OR public.fn_client_receive_block_of(true, 'Active', 1, false, 'unreadable', NULL, false, NULL, today) <> 'not on the Groups tab' THEN
    RAISE EXCEPTION '132: the receive rule checks in the wrong order';
  END IF;
  -- A tag no client holds, an empty one and a null are not clients.
  IF public.fn_client_receive_block('zz132-no-such-client') IS DISTINCT FROM 'not a client'
     OR public.fn_client_receive_block('') IS DISTINCT FROM 'not a client'
     OR public.fn_client_receive_block(NULL) IS DISTINCT FROM 'not a client'
     OR public.fn_client_can_receive('zz132-no-such-client') THEN
    RAISE EXCEPTION '132: a tag that is no client can receive';
  END IF;
  -- The recorder refuses what it cannot write, before writing anything.
  FOR ok_args IN SELECT unnest(ARRAY[
      'null', '[]', '{}', '[{"tag": ""}]', '[{"tag": "ZZ132A", "churn_cell_state": "maybe"}]',
      '[{"tag": "ZZ132A", "churn_cell_state": "date"}]',
      '[{"tag": "ZZ132A", "churn_cell_state": "date", "churn_date": "2026-02-30"}]',
      '[{"tag": "ZZ132A", "churn_cell_state": "empty", "churn_date": "2026-12-01"}]',
      '[{"tag": "ZZ132A", "churn_cell_state": "empty"}, {"tag": " zz132a ", "churn_cell_state": "empty"}]',
      '[{"tag": "ZZ132A", "churn_cell_state": "empty", "churn_cell": 5}]']) LOOP
    BEGIN
      PERFORM public.fn_client_groups_tab_record(ok_args::jsonb);
      RAISE EXCEPTION '132: the recorder took %', ok_args USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Read-only checks after applying (paste and run on their own):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'client_tags' AND column_name IN ('churn_date', 'churn_cell', 'churn_cell_state', 'on_groups_tab', 'groups_tab_read_at');
--   SELECT count(*) FILTER (WHERE on_groups_tab) AS listed, count(*) AS clients FROM client_tags;
--   SELECT fn_client_receive_block(tag) AS why, count(*) FROM client_tags
--    WHERE lower(btrim(coalesce(status, ''))) IN ('active', 'healthy') GROUP BY 1 ORDER BY 2 DESC;
