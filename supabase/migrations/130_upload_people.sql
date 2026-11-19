-- 130: an upload's no-email rows go to the client's People table.
--
-- Until now an upload's rows with no usable email were only kept back
-- (upload_holdbacks, 105) for the "No-email rows" CSV download. From now on
-- they also go into the client's People (pipeline) table as held rows: the
-- email finders look for their emails once the client is on the
-- people_pipeline switch, within the daily caps. A person whose email is found
-- and approved is added to leads through the Uploads page's own import, with
-- the upload's duplicate rule, its tags and its fields. The download keeps
-- every row, as before.
--
-- What this adds:
--   - upload_batches.add_tags and override_fields: the tags an upload stamped
--     on its rows and the fields its replace rule chose, stored when the batch
--     is made (both null for a batch made before 130: unknown, never guessed
--     from a file name). source_batch_id: on a batch of found emails, the
--     upload whose no-email rows they were.
--   - upload_people: one row per upload that had no-email rows, saying where
--     they went (the client's People table and how far the copy got) or why
--     they did not go. Server-only.
--   - enrich_sources kind 'upload': one source row per upload and People table.
--   - The release guard reads the switch of the row's own table: a held row of
--     a Companies (pipeline) table (companies_v2) is released only under
--     company_pipeline, as in 129; a held row of a People (pipeline) table
--     (people_v1) only under people_pipeline; a held row of any other table
--     never. In 129 every held row answered to company_pipeline, whatever its
--     table; only companies_v2 tables ever held rows, so nothing changes for
--     them.
--   - Two indexes for the Uploads page and the found-email hand-off: rows by
--     source and status, and the People rows whose Outcome is "Approved email".
--
-- The switch check reads enrich_settings.people_pipeline exactly as
-- scripts/lib/enrich/settings.mjs reads it (settingsFrom, then
-- flagOn("people_pipeline", tag)): the same rules as company_pipeline in 129,
-- through 129's fn_enrich_switch_value_on().
--
-- Nothing here reads or writes leads, and nothing changes an existing row: the
-- new columns are null or empty on every batch already there. No client data:
-- the new table starts empty. RLS is on with no policies, as in 122 to 129.
-- Needs 129.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regprocedure('public.fn_enrich_switch_value_on(jsonb, text)') IS NULL
     OR to_regclass('public.enrich_inbound_urls') IS NULL THEN
    RAISE EXCEPTION '130 needs 129 (inbound URLs) applied first';
  END IF;
END $$;

-- What an upload stamped and chose, as the import got them. Null: a batch made
-- before 130, or by a writer that does not record them (the AI Ark add, promotion).
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS add_tags text[];
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS override_fields text[];
-- A batch of found emails points at the upload whose no-email rows they were.
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS source_batch_id uuid
  REFERENCES upload_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS upload_batches_source_batch_idx
  ON upload_batches (source_batch_id, created_at DESC) WHERE source_batch_id IS NOT NULL;

-- Where each upload's no-email rows went.
--   moving    rows are being copied into the client's People table, from
--             next_seq on; reason says what stops it for now, if anything
--   moved     every no-email row is in the table
--   not_sent  the upload names no single client (reason says why); an admin
--             can still send it to a client's table by hand
CREATE TABLE IF NOT EXISTS upload_people (
  batch_id    uuid PRIMARY KEY REFERENCES upload_batches(id) ON DELETE CASCADE,
  state       text NOT NULL CHECK (state IN ('moving', 'moved', 'not_sent')),
  reason      text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]*$'),
  -- Plain text, no foreign key, as enrich_tables.client_tag: the sheet syncs delete tags.
  client_tag  text CHECK (client_tag IS NULL OR (client_tag = upper(btrim(client_tag)) AND client_tag <> '')),
  table_id    uuid REFERENCES enrich_tables(id) ON DELETE SET NULL,
  source_id   uuid REFERENCES enrich_sources(id) ON DELETE SET NULL,
  next_seq    integer NOT NULL DEFAULT 0 CHECK (next_seq >= 0),
  moved_rows  integer NOT NULL DEFAULT 0 CHECK (moved_rows >= 0),
  next_try_at timestamptz NOT NULL DEFAULT now(),
  sent_by     uuid,              -- the admin who sent it by hand; null when the upload's own tag decided
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  moved_at    timestamptz,       -- when the last no-email row went in
  CHECK ((state = 'not_sent') = (client_tag IS NULL))
);
CREATE INDEX IF NOT EXISTS upload_people_moving_idx ON upload_people (next_try_at, batch_id) WHERE state = 'moving';
CREATE INDEX IF NOT EXISTS upload_people_source_idx ON upload_people (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS upload_people_client_idx ON upload_people (client_tag, created_at DESC) WHERE client_tag IS NOT NULL;

-- Rows an upload's no-email rows became.
ALTER TABLE enrich_sources DROP CONSTRAINT IF EXISTS enrich_sources_kind_check;
ALTER TABLE enrich_sources ADD CONSTRAINT enrich_sources_kind_check
  CHECK (kind IN ('maps', 'csv', 'demo', 'api', 'ai_ark', 'registry', 'write_to', 'linkedin', 'upload'));

-- An upload's rows by status (the Uploads page counts them), and the People
-- rows whose Outcome is "Approved email" (the found-email hand-off looks for
-- the ones not added yet). A query uses the second only with these exact
-- terms: column_key = 'person_outcome' AND status = 'done' AND
-- value = '"Approved email"'::jsonb.
CREATE INDEX IF NOT EXISTS enrich_rows_source_status_idx
  ON enrich_rows (source_id, run_status) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS enrich_cells_approved_idx
  ON enrich_cells (table_id, row_id)
  WHERE column_key = 'person_outcome' AND status = 'done' AND value = '"Approved email"'::jsonb;

-- The people_pipeline switch for one client: flagOn("people_pipeline", tag).
CREATE OR REPLACE FUNCTION public.fn_enrich_people_switch_on(p_tag text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT public.fn_enrich_switch_value_on(
    (SELECT s.value FROM public.enrich_settings s WHERE s.key = 'people_pipeline'), p_tag)
$fn$;

-- The switch a held row of this table is released under: companies_v2 under
-- company_pipeline, people_v1 under people_pipeline, for the table's client.
-- Any other table, or no table, is never on.
CREATE OR REPLACE FUNCTION public.fn_enrich_held_switch_on(p_table uuid) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce((
    SELECT CASE t.template
             WHEN 'companies_v2' THEN public.fn_enrich_company_switch_on(t.client_tag)
             WHEN 'people_v1' THEN public.fn_enrich_people_switch_on(t.client_tag)
             ELSE false
           END
      FROM public.enrich_tables t
     WHERE t.id = p_table), false)
$fn$;

-- The guard (129's trigger, unchanged): a held row becomes anything else only
-- while the switch of its table is on for its client (the table it was held
-- in, and the table it ends up in). Deleting a held row is allowed. The words
-- name the switch that stopped it.
CREATE OR REPLACE FUNCTION public.fn_enrich_rows_release_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  stopped uuid;
  tpl text;
BEGIN
  IF NOT public.fn_enrich_held_switch_on(OLD.table_id) THEN
    stopped := OLD.table_id;
  ELSIF NEW.table_id IS DISTINCT FROM OLD.table_id AND NOT public.fn_enrich_held_switch_on(NEW.table_id) THEN
    stopped := NEW.table_id;
  ELSE
    RETURN NEW;
  END IF;
  SELECT t.template INTO tpl FROM public.enrich_tables t WHERE t.id = stopped;
  RAISE EXCEPTION 'enrich row % stays held: %', OLD.id,
    CASE tpl
      WHEN 'companies_v2' THEN 'its client is not on the company_pipeline switch'
      WHEN 'people_v1' THEN 'its client is not on the people_pipeline switch'
      ELSE 'only a Companies (pipeline) or People (pipeline) row is ever released'
    END
    USING ERRCODE = 'check_violation';
END $fn$;
DROP TRIGGER IF EXISTS trg_enrich_rows_release_guard ON enrich_rows;
CREATE TRIGGER trg_enrich_rows_release_guard
  BEFORE UPDATE ON enrich_rows
  FOR EACH ROW WHEN (OLD.run_status = 'held' AND NEW.run_status IS DISTINCT FROM 'held')
  EXECUTE FUNCTION public.fn_enrich_rows_release_guard();

-- Access: server-only.
ALTER TABLE upload_people ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON upload_people FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enrich_people_switch_on(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enrich_held_switch_on(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enrich_rows_release_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_enrich_people_switch_on(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_enrich_held_switch_on(uuid) TO service_role;

COMMENT ON TABLE upload_people IS 'Where an upload''s no-email rows went: the client''s People (pipeline) table and how far the copy got, or why not (130).';
COMMENT ON COLUMN upload_batches.add_tags IS 'The tags the upload stamped on its rows, as the import got them; null before 130 (unknown).';
COMMENT ON COLUMN upload_batches.override_fields IS 'The fields the upload''s replace rule chose; null before 130 (unknown).';
COMMENT ON COLUMN upload_batches.source_batch_id IS 'On a batch of found emails: the upload whose no-email rows they were (130).';
COMMENT ON FUNCTION public.fn_enrich_people_switch_on(text) IS 'Is the people_pipeline switch on for this client, as flagOn("people_pipeline", tag) reads it (130).';
COMMENT ON FUNCTION public.fn_enrich_held_switch_on(uuid) IS 'Is the switch a held row of this table answers to on for its client: company_pipeline for companies_v2, people_pipeline for people_v1, never for any other table (130).';

DO $$
DECLARE
  bad text;
  on_p constant jsonb := '{"enabled": true, "tags": ["zz_people_a", " ZZ_PEOPLE_B\t", 7, "*", ""]}';
BEGIN
  IF to_regclass('public.upload_people') IS NULL THEN
    RAISE EXCEPTION '130: upload_people is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.upload_people'::regclass)
     OR has_table_privilege('anon', 'public.upload_people', 'SELECT')
     OR has_table_privilege('authenticated', 'public.upload_people', 'SELECT') THEN
    RAISE EXCEPTION '130: upload_people is not server-only';
  END IF;
  SELECT string_agg(c, ', ') INTO bad
    FROM unnest(ARRAY['add_tags', 'override_fields', 'source_batch_id']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'upload_batches' AND column_name = c);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '130: upload_batches is missing %', bad;
  END IF;
  SELECT string_agg(k, ', ') INTO bad
    FROM unnest(ARRAY['maps', 'csv', 'demo', 'api', 'ai_ark', 'registry', 'write_to', 'linkedin', 'upload']) k
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.enrich_sources'::regclass AND conname = 'enrich_sources_kind_check'
                        AND pg_get_constraintdef(oid) LIKE '%''' || k || '''%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '130: enrich_sources refuses the kinds %', bad;
  END IF;
  SELECT string_agg(i, ', ') INTO bad
    FROM unnest(ARRAY['enrich_rows_source_status_idx', 'enrich_cells_approved_idx', 'upload_batches_source_batch_idx',
                      'upload_people_moving_idx', 'upload_people_source_idx', 'upload_people_client_idx']) i
   WHERE to_regclass('public.' || i) IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '130: missing indexes: %', bad;
  END IF;
  SELECT string_agg(f, ', ') INTO bad
    FROM unnest(ARRAY['public.fn_enrich_people_switch_on(text)', 'public.fn_enrich_held_switch_on(uuid)']) f
   WHERE has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '130: callable by anon or authenticated: %', bad;
  END IF;
  IF pg_get_functiondef('public.fn_enrich_rows_release_guard()'::regprocedure) NOT LIKE '%fn_enrich_held_switch_on(OLD.table_id)%'
     OR pg_get_functiondef('public.fn_enrich_rows_release_guard()'::regprocedure) NOT LIKE '%fn_enrich_held_switch_on(NEW.table_id)%' THEN
    RAISE EXCEPTION '130: the release guard does not read the switch of each row''s table';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_enrich_rows_release_guard' AND tgrelid = 'public.enrich_rows'::regclass) THEN
    RAISE EXCEPTION '130: the release guard is missing';
  END IF;
  -- The people switch reads a value as settingsFrom() and flagOn() do (made-up tags; the value check is 129's).
  IF NOT (public.fn_enrich_switch_value_on(on_p, 'ZZ_PEOPLE_A') AND public.fn_enrich_switch_value_on(on_p, ' zz_people_b ')) THEN
    RAISE EXCEPTION '130: the switch check misses a listed tag';
  END IF;
  IF public.fn_enrich_people_switch_on('') OR public.fn_enrich_people_switch_on(NULL) OR public.fn_enrich_people_switch_on('*')
     OR public.fn_enrich_held_switch_on(NULL) OR public.fn_enrich_held_switch_on(gen_random_uuid()) THEN
    RAISE EXCEPTION '130: a switch check is on where flagOn() is off (or for a table that does not exist)';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
