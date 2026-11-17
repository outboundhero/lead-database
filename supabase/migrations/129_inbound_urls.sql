-- 129: per-client inbound URLs for the Clay section.
--
-- Each client gets its own address for the GMaps Scraper app's chunks:
-- POST /api/enrich/intake/<token>. The token decides the client: no shared
-- key, no client header, no environment variable. Tokens are made on the
-- server (32 random bytes, base64url, 43 characters) and kept in plain text
-- (the owner's choice, as for api_tokens), so the Clay tab can show a URL
-- again. One live URL per client and target; a rotation revokes the old one
-- at once.
--
-- Places land in the client's Companies (pipeline) table as held rows. The
-- worker claims queued rows only. It turns held rows into queued ones only for
-- clients on the company_pipeline switch, and the guard trigger below refuses
-- any other change to a held row while its client is off, whatever code sends
-- it.
--
-- The switch check reads enrich_settings.company_pipeline exactly as
-- scripts/lib/enrich/settings.mjs reads it (settingsFrom, then
-- flagOn("company_pipeline", tag)): enabled must be the JSON value true; each
-- listed tag is trimmed and upper-cased as normTag() does, and only text tags
-- count, never an empty one, "*" or one over 64 characters, and only the first
-- 2,000 distinct ones; the tag asked about is trimmed and upper-cased too.
-- fn_enrich_switch_value_on() does it on a given value, so a test can compare
-- it with flagOn() without writing the settings.
--
-- The daily caps for Enrichley and the email finders need no change here:
-- enrich_spend_daily.kind takes any lower-case key (125), and the caps
-- themselves live in enrich_settings.spend_caps, read with their defaults.
--
-- Nothing here reads or writes leads, and nothing changes an existing row.
-- No client data: the new table starts empty. RLS is on with no policies, as
-- in 122 to 128: the routes read through the server and the worker connects
-- as the owner.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS enrich_inbound_urls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Plain text, no foreign key, as enrich_tables.client_tag: the sheet syncs delete tags.
  client_tag      text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  target          text NOT NULL DEFAULT 'companies' CHECK (target IN ('companies')),
  token           text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  -- Scraper app client names a manager accepted for this URL: trimmed, upper case, at most 20.
  accepted_names  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(accepted_names) <= 20),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,                   -- last stored delivery, written at most once a minute
  last_test_at    timestamptz,
  last_test_name  text,                          -- the client name the scraper app's Test sent, if any
  last_refused_at timestamptz,
  last_refused    text,                          -- why, in plain words; never a body, a token or a URL
  refused_name    text,                          -- the client name of the last chunk refused for its name
  revoked_at      timestamptz,
  revoked_by      uuid,
  replaced_by     uuid REFERENCES enrich_inbound_urls(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS enrich_inbound_urls_live_uniq
  ON enrich_inbound_urls (client_tag, target) WHERE revoked_at IS NULL;

-- Held rows: stored, never claimed, released only while the client is switched on.
ALTER TABLE enrich_rows DROP CONSTRAINT IF EXISTS enrich_rows_run_status_check;
ALTER TABLE enrich_rows ADD CONSTRAINT enrich_rows_run_status_check
  CHECK (run_status IN ('queued', 'running', 'done', 'waiting', 'error', 'held'));
CREATE INDEX IF NOT EXISTS enrich_rows_held_idx ON enrich_rows (table_id, id) WHERE run_status = 'held';

-- Which URL a delivery came through.
ALTER TABLE enrich_sources ADD COLUMN IF NOT EXISTS inbound_url_id uuid
  REFERENCES enrich_inbound_urls(id) ON DELETE SET NULL;

-- A tag as settings.mjs normTag() makes it: what JavaScript's trim() removes
-- taken off both ends (tab to carriage return, the space, the no-break and
-- other Unicode spaces, the line and paragraph separators, the byte order
-- mark), then upper case. A null is the empty text.
CREATE OR REPLACE FUNCTION public.fn_enrich_norm_tag(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT upper(regexp_replace(
    coalesce(p, ''),
    '^[\u0009-\u000D    -     　﻿]+|[\u0009-\u000D    -     　﻿]+$',
    '', 'g'))
$fn$;

-- Is a switch with a client list ({"enabled": ..., "tags": [...]}) on for
-- this tag, as settingsFrom() and flagOn() read it? A tag's length is counted
-- as JavaScript counts it (a character past U+FFFF counts twice).
CREATE OR REPLACE FUNCTION public.fn_enrich_switch_value_on(p_value jsonb, p_tag text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
  t text := public.fn_enrich_norm_tag(p_tag);
BEGIN
  IF t = '' OR t = '*'
     OR length(t) + length(regexp_replace(t, '[^\U00010000-\U0010FFFF]', '', 'g')) > 64 THEN
    RETURN false;
  END IF;
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object'
     OR (p_value -> 'enabled') IS DISTINCT FROM 'true'::jsonb
     OR jsonb_typeof(p_value -> 'tags') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  -- Up to 2,000 entries, no 2,000 limit can leave a tag out: any entry that reads as t counts.
  IF jsonb_array_length(p_value -> 'tags') <= 2000 THEN
    RETURN EXISTS (SELECT 1 FROM jsonb_array_elements(p_value -> 'tags') AS e(item)
                    WHERE jsonb_typeof(e.item) = 'string' AND public.fn_enrich_norm_tag(e.item #>> '{}') = t);
  END IF;
  -- A longer list: only the first 2,000 distinct tags that settingsFrom() keeps.
  RETURN EXISTS (
    SELECT 1
      FROM (SELECT d.tag
              FROM (SELECT public.fn_enrich_norm_tag(e.item #>> '{}') AS tag, min(e.ord) AS first
                      FROM jsonb_array_elements(p_value -> 'tags') WITH ORDINALITY AS e(item, ord)
                     WHERE jsonb_typeof(e.item) = 'string'
                     GROUP BY 1) d
             WHERE d.tag <> '' AND d.tag <> '*'
               AND length(d.tag) + length(regexp_replace(d.tag, '[^\U00010000-\U0010FFFF]', '', 'g')) <= 64
             ORDER BY d.first
             LIMIT 2000) kept
     WHERE kept.tag = t);
END $fn$;

-- The company_pipeline switch for one client: flagOn("company_pipeline", tag).
CREATE OR REPLACE FUNCTION public.fn_enrich_company_switch_on(p_tag text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT public.fn_enrich_switch_value_on(
    (SELECT s.value FROM public.enrich_settings s WHERE s.key = 'company_pipeline'), p_tag)
$fn$;

-- The guard: a held row becomes anything else only while its client is
-- switched on (the client of the table it was held in, and of the table it
-- ends up in). Deleting a held row is allowed.
CREATE OR REPLACE FUNCTION public.fn_enrich_rows_release_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT public.fn_enrich_company_switch_on((SELECT t.client_tag FROM public.enrich_tables t WHERE t.id = OLD.table_id))
     OR (NEW.table_id IS DISTINCT FROM OLD.table_id
         AND NOT public.fn_enrich_company_switch_on((SELECT t.client_tag FROM public.enrich_tables t WHERE t.id = NEW.table_id))) THEN
    RAISE EXCEPTION 'enrich row % stays held: its client is not on the company_pipeline switch', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_enrich_rows_release_guard ON enrich_rows;
CREATE TRIGGER trg_enrich_rows_release_guard
  BEFORE UPDATE ON enrich_rows
  FOR EACH ROW WHEN (OLD.run_status = 'held' AND NEW.run_status IS DISTINCT FROM 'held')
  EXECUTE FUNCTION public.fn_enrich_rows_release_guard();

-- Access: server-only.
ALTER TABLE enrich_inbound_urls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON enrich_inbound_urls FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enrich_norm_tag(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enrich_switch_value_on(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enrich_company_switch_on(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enrich_rows_release_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_enrich_norm_tag(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_enrich_switch_value_on(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_enrich_company_switch_on(text) TO service_role;

COMMENT ON TABLE enrich_inbound_urls IS 'Clay section: each client''s inbound URL token for the GMaps Scraper app''s chunks (129).';
COMMENT ON FUNCTION public.fn_enrich_company_switch_on(text) IS 'Is the company_pipeline switch on for this client, as flagOn("company_pipeline", tag) reads it (129).';

DO $$
DECLARE
  bad text;
  on_a constant jsonb := '{"enabled": true, "tags": ["zz_switch_a", " ZZ_SWITCH_B\t", 7, "*", ""]}';
BEGIN
  IF to_regclass('public.enrich_inbound_urls') IS NULL THEN
    RAISE EXCEPTION '129: enrich_inbound_urls is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.enrich_inbound_urls'::regclass)
     OR has_table_privilege('anon', 'public.enrich_inbound_urls', 'SELECT')
     OR has_table_privilege('authenticated', 'public.enrich_inbound_urls', 'SELECT') THEN
    RAISE EXCEPTION '129: enrich_inbound_urls is not server-only';
  END IF;
  SELECT string_agg(f, ', ') INTO bad
    FROM unnest(ARRAY['public.fn_enrich_norm_tag(text)', 'public.fn_enrich_switch_value_on(jsonb, text)',
                      'public.fn_enrich_company_switch_on(text)']) f
   WHERE has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '129: callable by anon or authenticated: %', bad;
  END IF;
  SELECT string_agg(conname, ', ') INTO bad FROM pg_constraint
   WHERE conrelid = 'public.enrich_rows'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%run_status%'
     AND pg_get_constraintdef(oid) NOT LIKE '%''held''%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '129: a check on enrich_rows.run_status still refuses held: %', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_enrich_rows_release_guard' AND tgrelid = 'public.enrich_rows'::regclass) THEN
    RAISE EXCEPTION '129: the release guard is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'enrich_sources' AND column_name = 'inbound_url_id') THEN
    RAISE EXCEPTION '129: enrich_sources.inbound_url_id is missing';
  END IF;
  -- The switch check reads a value as settingsFrom() and flagOn() do (made-up tags).
  IF NOT (public.fn_enrich_switch_value_on(on_a, 'ZZ_SWITCH_A')
          AND public.fn_enrich_switch_value_on(on_a, ' zz_switch_a ')
          AND public.fn_enrich_switch_value_on(on_a, 'zz_switch_b')) THEN
    RAISE EXCEPTION '129: the switch check misses a listed tag (tags are trimmed and upper-cased)';
  END IF;
  IF public.fn_enrich_switch_value_on(on_a, 'ZZ_SWITCH_C')
     OR public.fn_enrich_switch_value_on(on_a, '*')
     OR public.fn_enrich_switch_value_on(on_a, '')
     OR public.fn_enrich_switch_value_on(on_a, NULL)
     OR public.fn_enrich_switch_value_on(on_a, '7')
     OR public.fn_enrich_switch_value_on('{"enabled": "true", "tags": ["ZZ_SWITCH_A"]}', 'ZZ_SWITCH_A')
     OR public.fn_enrich_switch_value_on('{"enabled": false, "tags": ["ZZ_SWITCH_A"]}', 'ZZ_SWITCH_A')
     OR public.fn_enrich_switch_value_on('{"enabled": true, "tags": "ZZ_SWITCH_A"}', 'ZZ_SWITCH_A')
     OR public.fn_enrich_switch_value_on('[]', 'ZZ_SWITCH_A')
     OR public.fn_enrich_switch_value_on(NULL, 'ZZ_SWITCH_A')
     OR public.fn_enrich_company_switch_on('') THEN
    RAISE EXCEPTION '129: the switch check is on where flagOn() is off';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
