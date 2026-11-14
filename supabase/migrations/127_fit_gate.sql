-- 127: the fit gate (phase 3 of the Clay section restart), shipped OFF.
--
-- While enrich_settings.fit_gate is on for a client (fn_fit_gate_applies:
-- enabled, its client type listed, its tag on fit_gate.tags):
--   fn_client_eligibility_conditions(tag) appends one condition: the lead's
--     company must not be blocked in company_fit_keys (by its email's domain,
--     its website's domain, or its name, city and state);
-- and while fit_gate.enabled is true, fn_export_leads appends the same
-- condition for every filtered export (exports have no client), unless the
-- export route passes includeBadFits for an owner or admin.
-- While the gate is off, both return exactly what they returned before. The
-- migration checks that the live bodies are the expected 093 and 050 bodies
-- before it replaces them, and that every client's conditions are unchanged
-- after it, before it commits.
--
-- push_batches gains the 'scoring' status: a push of a gated client waits
-- there until its companies are scored (scripts/lib/enrich/fit-push.mjs). The
-- push-worker never claims it.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- The two bodies this migration replaces must be the ones it was written
-- from (093's and 050's), so a production hotfix is never silently reverted.
-- The hash is of the body with runs of white space collapsed.
DO $$
DECLARE h_elig text; h_export text;
BEGIN
  SELECT md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) INTO h_elig
    FROM pg_proc p WHERE p.oid = 'public.fn_client_eligibility_conditions(text)'::regprocedure;
  SELECT md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) INTO h_export
    FROM pg_proc p WHERE p.oid = 'public.fn_export_leads(jsonb,text,integer,integer)'::regprocedure;
  -- First hash of each pair: the 093 or 050 body (measured on the local
  -- database, 2026-11-13). Second: this migration's own body, so a re-run passes.
  IF h_elig IN ('e92f35174fffba3e39c910703afdc9f2', '99f93d5a8d5c99d5a3f3444f5d355f4a')
     AND h_export IN ('958d632657b43ad4d784c9ea5f254162', '08834bd85c6e12bdf9e2b9ab208cf3b6') THEN
    RETURN;
  END IF;
  RAISE EXCEPTION '127: the live bodies differ from 093/050 (eligibility %, export %); rebase 127 on pg_get_functiondef first',
    h_elig, h_export;
END $$;

-- Every client's eligibility conditions before this migration.
CREATE TEMP TABLE _fit_gate_before ON COMMIT DROP AS
  SELECT t.tag, public.fn_client_eligibility_conditions(t.tag) AS conds
    FROM (SELECT tag FROM client_tags UNION SELECT client_tag FROM client_targeting) t;

-- The condition, on alias l (leads), as text for the condition arrays.
-- company_fit_keys never holds a free-mail or excluded domain, so the lead's
-- email domain and website domain are looked up as they are, each with an
-- equality the partial index serves.
CREATE OR REPLACE FUNCTION public.fn_fit_condition() RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT '(NOT EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.blocked AND k.key_kind = ''domain'' '
      || 'AND k.key = lower(split_part(l.email, ''@'', 2))) '
      || 'AND NOT EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.blocked AND k.key_kind = ''domain'' '
      || 'AND k.key = public.fn_bare_domain(l.domain)) '
      || 'AND NOT EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.blocked AND k.key_kind = ''name'' '
      || 'AND k.key = public.fn_fit_name_key(l.company, l.city, l.state_code)))'
$fn$;

CREATE OR REPLACE FUNCTION public.fn_client_eligibility_conditions(p_tag text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  t RECORD;
  conds text[] := '{}';
  inc text[] := '{}';
  exc text;
  entry jsonb;
  c text;
BEGIN
  SELECT * INTO t FROM client_targeting WHERE client_tag = p_tag;
  IF NOT FOUND THEN
    -- no targeting config: only the global unsupported-country gate applies
    -- (and, from 127, the fit gate while it is on for this client)
    IF public.fn_fit_gate_applies(p_tag) THEN
      RETURN ARRAY['(l.location_status IS DISTINCT FROM ''unsupported'')', public.fn_fit_condition()];
    END IF;
    RETURN ARRAY['(l.location_status IS DISTINCT FROM ''unsupported'')'];
  END IF;

  -- supported/targeted countries (unknown-location leads pass unless require_location)
  IF t.require_location THEN
    conds := array_append(conds, format('l.country_code = ANY(%L::text[])', t.countries));
  ELSE
    conds := array_append(conds, format('(l.country_code = ANY(%L::text[]) OR l.country_code IS NULL)', t.countries));
  END IF;
  conds := array_append(conds, '(l.location_status IS DISTINCT FROM ''unsupported'')');
  conds := array_append(conds, '(l.location_status IS DISTINCT FROM ''unresolved'')');

  -- inferred-location policy
  IF NOT t.allow_inferred_location THEN
    conds := array_append(conds, '(l.location_source IS NULL OR l.location_source NOT LIKE ''company-%'')');
  END IF;

  -- include locations (OR of entries; leads with unknown location pass only
  -- when require_location is false AND no include list is set)
  IF jsonb_array_length(t.include_locations) > 0 THEN
    FOR entry IN SELECT jsonb_array_elements(t.include_locations) LOOP
      c := fn_location_entry_condition(entry, false);
      IF c IS NOT NULL THEN inc := array_append(inc, c); END IF;
    END LOOP;
    IF array_length(inc, 1) > 0 THEN
      IF t.require_location THEN
        conds := array_append(conds, '(' || array_to_string(inc, ' OR ') || ')');
      ELSE
        conds := array_append(conds, '((' || array_to_string(inc, ' OR ') || ') OR l.state_code IS NULL)');
      END IF;
    END IF;
  END IF;

  -- exclude locations (every exclusion is a hard AND; it overrides inclusions)
  IF jsonb_array_length(t.exclude_locations) > 0 THEN
    FOR entry IN SELECT jsonb_array_elements(t.exclude_locations) LOOP
      exc := fn_location_entry_condition(entry, true);
      IF exc IS NOT NULL THEN conds := array_append(conds, exc); END IF;
    END LOOP;
  END IF;

  -- Unified term exclusions (migration 079): the two old lists are merged into
  -- exclude_terms, matched whole-word and plural-tolerant across six columns.
  --
  -- ONE alternation regex per column rather than one condition per term - the
  -- same shape fn_commercial_cleaning_condition uses for its 230 titles. Client
  -- HS previously generated 201 separate conditions (53,635 characters of SQL);
  -- it now generates 1. Company overview is deliberately NOT searched.
  IF array_length(t.exclude_terms, 1) > 0 THEN
    DECLARE ex_rx text; BEGIN
      -- CONTAINS, not whole-word (client decision 2026-08-27). fn_regex_escape
      -- alone is a substring match; fn_whole_term_regex wrapped it in \m..\M.
      -- This is the same construction the browse filter uses for its "Contains"
      -- mode, so what the Leads view shows and what the push actually sends can
      -- no longer disagree.
      --
      -- Deliberately broader: "cleaning" now also catches "drycleaning" and
      -- "CleaningCo", which is the point for competitor exclusion. It equally
      -- means a short term matches inside longer words -- "bar" hits
      -- "Barbershop" -- so short generic terms exclude more than they used to.
      SELECT string_agg('(' || fn_regex_escape(x) || ')', '|') INTO ex_rx
      FROM unnest(t.exclude_terms) x WHERE btrim(x) <> '';
      IF ex_rx IS NOT NULL THEN
        conds := array_append(conds, format(
          '(COALESCE(l.category, '''') !~* %L AND COALESCE(l.subcategory, '''') !~* %L AND COALESCE(l.additional_category, '''') !~* %L AND COALESCE(l.company, '''') !~* %L AND COALESCE(l.general_industry, '''') !~* %L AND COALESCE(l.specific_industry, '''') !~* %L)',
          ex_rx, ex_rx, ex_rx, ex_rx, ex_rx, ex_rx));
      END IF;
    END;
  END IF;


  IF t.commercial_cleaning THEN
    conds := array_append(conds, fn_commercial_cleaning_condition());
  END IF;

  -- SUPPRESSED ADDRESSES (091): never eligible for any client, on any campaign,
  -- with no override. This is the point of the list: a deleted lead comes back
  -- on the next Bison sync, so the gate has to be on the address, permanently.
  conds := array_append(conds, '(l.is_suppressed = false)');

  -- FIT GATE (127): a company scored under the threshold, or unscorable while
  -- require_scored is on, is never eligible for a client the gate covers
  -- (fn_fit_gate_applies: on, its client type listed, its tag listed). Off,
  -- the array is exactly as before.
  IF public.fn_fit_gate_applies(p_tag) THEN
    conds := array_append(conds, public.fn_fit_condition());
  END IF;

  RETURN conds;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_export_leads(p_filters jsonb, p_cursor text DEFAULT NULL::text, p_limit integer DEFAULT 10000, p_skip integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  data_rows JSONB;
  where_clause TEXT := '';
  conditions TEXT[];
  sql_text TEXT;
BEGIN
  -- Canonical, deterministic order for the WHOLE export is l.id (PK index).
  -- Range anchors (skip-cursor) and continuation cursors BOTH use l.id, so a
  -- ranged export can never mix orderings and duplicate/skip rows (F11). The
  -- previous composite-(created_at,id) path is gone; a bare uuid cursor is used.
  conditions := fn_lead_filter_conditions(p_filters);

  IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
    -- Tolerate a legacy composite "ts|uuid" cursor by taking its uuid part.
    conditions := array_append(conditions, format('l.id > %L',
      CASE WHEN position('|' in p_cursor) > 0 THEN split_part(p_cursor, '|', 2) ELSE p_cursor END));
  END IF;

  -- HARD VALIDATION + BOUNCE GATES (export-only). NULL validation_status is
  -- allowed through (exports work before validation is configured); known
  -- invalid/risky/unknown/pending and bounced rows are excluded.
  conditions := array_append(conditions, '(l.validation_status IN (''valid'', ''catch_all'') OR l.validation_status IS NULL)');
  conditions := array_append(conditions, 'l.is_bounced = false');

  -- FIT GATE (127): while enrich_settings.fit_gate is on, every export leaves
  -- out bad fits (exports have no client). Owners and admins may pass
  -- includeBadFits, which the export routes add after buildRpcFilters for
  -- them only (it is never read from the request's filter state).
  IF coalesce((public.fn_fit_gate_settings()->>'enabled')::boolean, false)
     AND NOT coalesce((p_filters->>'includeBadFits')::boolean, false) THEN
    conditions := array_append(conditions, public.fn_fit_condition());
  END IF;

  IF array_length(conditions, 1) > 0 THEN
    where_clause := 'WHERE ' || array_to_string(conditions, ' AND ');
  END IF;

  sql_text := format(
    'SELECT jsonb_build_object(''data'', COALESCE(jsonb_agg(row_to_json(sub)), ''[]''::jsonb)) FROM (
      SELECT l.*
      FROM leads l %s
      ORDER BY l.id
      LIMIT %s OFFSET %s
    ) sub',
    where_clause, p_limit, p_skip
  );
  EXECUTE sql_text INTO data_rows;

  RETURN data_rows;
END;
$function$;

-- Selected-row exports have no filters: their routes ask this, per chunk of
-- ids, for the fit columns and for the ids to leave out while the gate is on.
CREATE OR REPLACE FUNCTION public.fn_fit_for_leads(p_ids uuid[])
RETURNS TABLE (lead_id uuid, score smallint, home_office boolean, blocked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT l.id,
         coalesce(fd.score, fn.score),
         coalesce(fd.home_office, fn.home_office),
         coalesce(kd.blocked, false) OR coalesce(kn.blocked, false)
    FROM leads l
    LEFT JOIN LATERAL (SELECT k.* FROM company_fit_keys k
                        WHERE k.key_kind = 'domain' AND k.key = lower(split_part(l.email, '@', 2))
                        UNION ALL
                        SELECT k.* FROM company_fit_keys k
                        WHERE k.key_kind = 'domain' AND k.key = public.fn_bare_domain(l.domain)
                        ORDER BY blocked DESC LIMIT 1) kd ON true
    LEFT JOIN company_fit fd ON fd.key_kind = kd.fit_kind AND fd.key = kd.fit_key
    LEFT JOIN company_fit_keys kn ON kn.key_kind = 'name' AND kn.key = public.fn_fit_name_key(l.company, l.city, l.state_code)
    LEFT JOIN company_fit fn ON fn.key_kind = kn.fit_kind AND fn.key = kn.fit_key
   WHERE l.id = ANY (p_ids)
$fn$;
REVOKE ALL ON FUNCTION public.fn_fit_for_leads(uuid[]) FROM PUBLIC, anon, authenticated;

-- Pushes of gated clients wait in 'scoring' until their companies are scored.
-- The status check was declared inline in 052; drop it whatever its name, and
-- add the new one NOT VALID first, so the table lock is brief.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.push_batches'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%''gathering''%' AND pg_get_constraintdef(oid) NOT LIKE '%''scoring''%'
  LOOP
    EXECUTE format('ALTER TABLE push_batches DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE push_batches DROP CONSTRAINT IF EXISTS push_batches_status_check;
ALTER TABLE push_batches ADD CONSTRAINT push_batches_status_check
  CHECK (status IN ('pending', 'gathering', 'processing', 'complete', 'error', 'cancelled', 'scoring')) NOT VALID;
ALTER TABLE push_batches VALIDATE CONSTRAINT push_batches_status_check;
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS fit_total integer;        -- companies found unscored on the first pass
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS fit_scored integer;       -- of those, scored or unscorable since
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS fit_cursor jsonb;         -- the fit loop's place in the batch's leads
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS fit_claim_token uuid;
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS fit_claimed_at timestamptz;
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS fit_released_by uuid;     -- an owner or admin let it go unscored

-- With the gate off, nothing may have changed.
DO $$
DECLARE bad text;
BEGIN
  IF coalesce((public.fn_fit_gate_settings()->>'enabled')::boolean, false) THEN
    RAISE NOTICE '127: the fit gate is ON, so the before-and-after check is skipped';
  ELSE
    SELECT string_agg(b.tag, ', ') INTO bad
      FROM _fit_gate_before b
     WHERE array_to_string(b.conds, ' AND ')
           IS DISTINCT FROM array_to_string(public.fn_client_eligibility_conditions(b.tag), ' AND ');
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION '127: with the gate off, eligibility changed for: %', bad;
    END IF;
  END IF;
  IF to_regprocedure('public.fn_fit_condition()') IS NULL OR to_regprocedure('public.fn_fit_gate_applies(text)') IS NULL
     OR to_regprocedure('public.fn_fit_for_leads(uuid[])') IS NULL THEN
    RAISE EXCEPTION '127: the gate functions are missing (is 126 applied?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.push_batches'::regclass
                  AND conname = 'push_batches_status_check' AND pg_get_constraintdef(oid) LIKE '%''scoring''%') THEN
    RAISE EXCEPTION '127: push_batches does not allow scoring';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
