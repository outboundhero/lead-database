-- 134: overlap sharing. A finished import's new leads are checked against
-- every other client that can receive, and each lead that fits one is shared
-- to it: logged, and once applied pushed into its campaigns behind a switch.
-- Ships OFF (enrich_settings.overlap_sharing.enabled false, no client listed).
--
-- What this adds:
--   - share_jobs: one row per finished import batch the share step found,
--     with its state. The enrich-worker's share step makes and works them
--     (scripts/lib/share/). States:
--       waiting       waiting for a location run that started after the import
--                     finished, or for the wait limit (place_wait_until)
--       deciding      receivers being decided, one transaction each
--                     (receivers_done says how far it got)
--       previewed     decided; waiting for an admin to apply (preview mode, or
--                     a receiver over a cap: receivers_over_cap)
--       applied       every receiver with shares is applied
--       skipped       nothing to share; reason says why (no client tag,
--                     several client tags, the origin not on the switch list,
--                     the origin isolated, no new leads)
--       no_lead_list  the import inserted leads but wrote no lead list (an old
--                     copy of the code, or sharing was off at the time)
--       error         gave up after its tries; an admin can retry it
--       undone        an admin undid the whole job
--   - lead_shares: one row per (batch, lead, receiver) for each new lead that
--     fits a receiver: the outcome (shared, own_topup, or why not), the place
--     it matched, whether it was applied, pushed, tagged or undone. This is
--     the record dedupe and undo read.
--   - fn_share_rule_fits(ids, tag): which of the given leads fit a client's
--     own push rules (fn_client_eligibility_conditions) plus the share extras:
--     contactable, not on the never-contact list, a known place (location
--     status resolved or partial), not Mimecast. At most 2,000 ids a call,
--     always anchored on the ids. fn_share_fits(ids, tag) is the same, but
--     only for a client that can receive (132); for any other client it
--     returns nothing.
--   - fn_remove_tag(tags, tag): a tag list without one tag (exact, any case);
--     the list as it was when it does not hold that tag.
--   - fn_client_pool_value(settings, tag, type) and fn_client_pool(tag): the
--     sharing pool of a client, read from overlap_sharing.pools and
--     overlap_sharing.isolated_tag_suffixes exactly as scripts/lib/enrich/
--     settings.mjs clientPool() reads them. Sharing happens only inside a
--     pool. Null means isolated: such a client never receives a share and its
--     imports are never shared.
--   - fn_overlap_sharing_on(tag): flagOn("overlap_sharing", tag) in SQL.
--   - the overlap_sharing settings row, everything off.
--
-- Nothing here reads or writes leads (the functions only read). No client
-- data: the new tables start empty. RLS is on with no policies, as in 122 to
-- 133. Needs 132 and 133.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regprocedure('public.fn_client_can_receive(text)') IS NULL
     OR to_regclass('public.upload_batch_leads') IS NULL
     OR to_regprocedure('public.fn_client_eligibility_conditions(text)') IS NULL
     OR to_regprocedure('public.fn_enrich_switch_value_on(jsonb, text)') IS NULL THEN
    RAISE EXCEPTION '134 needs 132 (fn_client_can_receive), 133 (upload_batch_leads) and 129 applied first';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS share_jobs (
  batch_id            uuid PRIMARY KEY REFERENCES upload_batches(id) ON DELETE CASCADE,
  -- Plain text, no foreign key, as enrich_tables.client_tag: the sheet syncs delete tags.
  origin_tag          text CHECK (origin_tag IS NULL OR (origin_tag = upper(btrim(origin_tag)) AND origin_tag <> '')),
  origin_pool         text,
  state               text NOT NULL
                      CHECK (state IN ('waiting', 'deciding', 'previewed', 'applied', 'skipped', 'no_lead_list', 'error', 'undone')),
  reason              text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]*$'),
  topup               boolean NOT NULL DEFAULT false,      -- the batch came from a top-up run (filters.topup)
  mode                text CHECK (mode IS NULL OR mode IN ('preview', 'apply')),
  batch_done_at       timestamptz NOT NULL,                -- when the import finished (or was taken as dead)
  place_wait_until    timestamptz,                         -- the place wait limit
  place_wait_hit_at   timestamptz,                         -- set when the job decided at the limit (a red notice)
  new_leads           integer NOT NULL DEFAULT 0 CHECK (new_leads >= 0),
  leads_no_place      integer NOT NULL DEFAULT 0 CHECK (leads_no_place >= 0),
  receivers           text[] NOT NULL DEFAULT '{}',        -- the candidates chosen when deciding
  receivers_done      text[] NOT NULL DEFAULT '{}',
  receivers_applied   text[] NOT NULL DEFAULT '{}',
  receivers_over_cap  text[] NOT NULL DEFAULT '{}',
  counts              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_try_at         timestamptz NOT NULL DEFAULT now(),
  recheck_until       timestamptz,                         -- leads with no usable place are looked at again until then
  next_recheck_at     timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  applied_at          timestamptz,
  applied_by          uuid,                                -- null when the step applied it in apply mode
  undone_at           timestamptz,
  undone_by           uuid,
  CHECK (origin_tag IS NOT NULL OR state IN ('skipped', 'no_lead_list'))
);
CREATE INDEX IF NOT EXISTS share_jobs_due_idx ON share_jobs (next_try_at) WHERE state IN ('waiting', 'deciding');
CREATE INDEX IF NOT EXISTS share_jobs_recheck_idx ON share_jobs (next_recheck_at) WHERE next_recheck_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS share_jobs_recent_idx ON share_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS share_jobs_origin_idx ON share_jobs (origin_tag, created_at DESC) WHERE origin_tag IS NOT NULL;

CREATE TABLE IF NOT EXISTS lead_shares (
  id              bigserial PRIMARY KEY,
  batch_id        uuid NOT NULL REFERENCES share_jobs(batch_id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL,                           -- no foreign key, so lead deletes stay cheap
  origin_tag      text NOT NULL CHECK (origin_tag = upper(btrim(origin_tag)) AND origin_tag <> ''),
  receiver_tag    text NOT NULL CHECK (receiver_tag = upper(btrim(receiver_tag)) AND receiver_tag <> ''),
  outcome         text NOT NULL CHECK (outcome IN ('shared', 'own_topup', 'filtered_inbox', 'already_sent', 'in_flight',
                                                   'already_shared', 'already_tagged', 'same_install', 'also_fits')),
  matched_place   jsonb CHECK (matched_place IS NULL OR jsonb_typeof(matched_place) = 'object'),
  decided_at      timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  applied_by      uuid,
  push_state      text CHECK (push_state IS NULL OR push_state IN ('queued', 'pushed', 'held', 'dropped')),
  push_note       text,                                    -- why held or dropped, in plain words
  held_since      timestamptz,                             -- first time the pick held it
  held_at         timestamptz,                             -- last pick that held it
  push_batch_id   uuid,                                    -- push_batches.id, no foreign key
  pushed_at       timestamptz,
  tag_added       boolean NOT NULL DEFAULT false,
  tag_added_at    timestamptz,
  tag_removed_at  timestamptz,
  undone_at       timestamptz,
  undone_by       uuid,
  UNIQUE (batch_id, lead_id, receiver_tag),
  CHECK (outcome <> 'own_topup' OR receiver_tag = origin_tag),
  CHECK (outcome <> 'shared' OR receiver_tag <> origin_tag),
  CHECK (push_state IS NULL OR (applied_at IS NOT NULL AND outcome IN ('shared', 'own_topup'))),
  CHECK (NOT tag_added OR (outcome = 'shared' AND applied_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS lead_shares_push_idx ON lead_shares (receiver_tag, push_state, id) WHERE push_state IN ('queued', 'held');
CREATE INDEX IF NOT EXISTS lead_shares_receiver_applied_idx ON lead_shares (receiver_tag, applied_at) WHERE applied_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_shares_lead_idx ON lead_shares (lead_id, receiver_tag);
-- The paced tag writer's work (scripts/lib/share/upkeep.mjs): applied, live
-- shares it has not looked at yet (a row leaves this index once looked at,
-- tag_added_at), and undone shares whose tag it wrote and has not taken off.
CREATE INDEX IF NOT EXISTS lead_shares_tag_todo_idx ON lead_shares (id)
  WHERE outcome = 'shared' AND applied_at IS NOT NULL AND undone_at IS NULL AND NOT tag_added AND tag_added_at IS NULL;
CREATE INDEX IF NOT EXISTS lead_shares_untag_todo_idx ON lead_shares (id)
  WHERE tag_added AND undone_at IS NOT NULL AND tag_removed_at IS NULL;

DROP TRIGGER IF EXISTS trg_share_jobs_updated_at ON share_jobs;
CREATE TRIGGER trg_share_jobs_updated_at BEFORE UPDATE ON share_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Which of the given leads fit this client's own rules plus the share extras.
-- The receive rule is not checked here (the same-group check reads the
-- origin's own rules with it off). At most 2,000 ids a call.
CREATE OR REPLACE FUNCTION public.fn_share_rule_fits(p_ids uuid[], p_tag text)
RETURNS TABLE (lead_id uuid)
LANGUAGE plpgsql STABLE SET search_path = public AS $fn$
DECLARE
  v_conds text[];
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_ids) > 2000 THEN
    RAISE EXCEPTION 'fn_share_rule_fits: at most 2,000 ids a call, got %', cardinality(p_ids)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_conds := public.fn_client_eligibility_conditions(public.fn_enrich_norm_tag(p_tag));
  RETURN QUERY EXECUTE format(
    'SELECT l.id FROM public.leads l
      WHERE l.id = ANY ($1)
        AND l.email IS NOT NULL AND l.email <> '''' AND l.is_bounced = false AND l.is_suppressed = false
        AND (l.validation_status IN (''valid'', ''catch_all'') OR l.validation_status IS NULL)
        AND l.location_status IN (''resolved'', ''partial'')
        AND (l.esp IS NULL OR l.esp <> ALL (ARRAY[''Mimecast'']::text[]))
        AND %s',
    coalesce(nullif(array_to_string(v_conds, ' AND '), ''), 'true'))
  USING p_ids;
END $fn$;

-- The same, for a client that can receive (132); nothing for any other.
CREATE OR REPLACE FUNCTION public.fn_share_fits(p_ids uuid[], p_tag text)
RETURNS TABLE (lead_id uuid)
LANGUAGE plpgsql STABLE SET search_path = public AS $fn$
BEGIN
  IF NOT public.fn_client_can_receive(p_tag) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT f.lead_id FROM public.fn_share_rule_fits(p_ids, p_tag) AS f;
END $fn$;

-- A tag list without one tag: exact, any case, the others kept in order and
-- trimmed (as fn_merge_tags joins them). Unchanged when the tag is not there.
CREATE OR REPLACE FUNCTION public.fn_remove_tag(a text, b text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN a IS NULL OR btrim(coalesce(b, '')) = '' THEN a
    WHEN NOT EXISTS (SELECT 1 FROM unnest(string_to_array(a, ',')) AS u(t) WHERE lower(btrim(u.t)) = lower(btrim(b))) THEN a
    ELSE (SELECT NULLIF(string_agg(btrim(u.t), ',' ORDER BY u.ord), '')
            FROM unnest(string_to_array(a, ',')) WITH ORDINALITY AS u(t, ord)
           WHERE btrim(u.t) <> '' AND lower(btrim(u.t)) <> lower(btrim(b)))
  END
$fn$;

-- The pool of a client, from the overlap_sharing value given (settings.mjs
-- clientPool()). A tag that ends in one of isolated_tag_suffixes is isolated
-- (null). Otherwise the client's type is matched, trimmed and in any case,
-- against each pool's types, pools taken by name in code point order; the
-- first pool that lists it wins. No type, or a type in no pool: isolated.
-- Defaults when the value lacks them, or holds them in the wrong shape: pools
-- {"cleaning": ["Cleaning", "Canada Cleaning"]}, suffixes ["-OS"].
CREATE OR REPLACE FUNCTION public.fn_client_pool_value(p_settings jsonb, p_tag text, p_type text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  t text := public.fn_enrich_norm_tag(p_tag);
  ty text := public.fn_enrich_norm_tag(p_type);
  s jsonb := CASE WHEN jsonb_typeof(p_settings) = 'object' THEN p_settings ELSE '{}'::jsonb END;
  sfx jsonb;
  pools jsonb;
  pool_name text;
BEGIN
  IF t = '' THEN
    RETURN NULL;
  END IF;
  sfx := CASE WHEN jsonb_typeof(s -> 'isolated_tag_suffixes') = 'array' THEN s -> 'isolated_tag_suffixes' ELSE '["-OS"]'::jsonb END;
  IF EXISTS (SELECT 1
               FROM (SELECT public.fn_enrich_norm_tag(e.item #>> '{}') AS x
                       FROM jsonb_array_elements(sfx) AS e(item)
                      WHERE jsonb_typeof(e.item) = 'string') v
              WHERE v.x <> '' AND right(t, length(v.x)) = v.x) THEN
    RETURN NULL;
  END IF;
  IF ty = '' THEN
    RETURN NULL;
  END IF;
  pools := CASE WHEN jsonb_typeof(s -> 'pools') = 'object' THEN s -> 'pools'
                ELSE '{"cleaning": ["Cleaning", "Canada Cleaning"]}'::jsonb END;
  FOR pool_name IN SELECT k FROM jsonb_object_keys(pools) AS k WHERE k ~ '^[a-z][a-z0-9_]{0,31}$' ORDER BY k COLLATE "C" LOOP
    IF jsonb_typeof(pools -> pool_name) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(pools -> pool_name) AS e(item)
                    WHERE jsonb_typeof(e.item) = 'string' AND public.fn_enrich_norm_tag(e.item #>> '{}') = ty) THEN
      RETURN pool_name;
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_client_pool(p_tag text) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT public.fn_client_pool_value(
           (SELECT s.value FROM public.enrich_settings s WHERE s.key = 'overlap_sharing'), ct.tag, ct.client_type)
    FROM public.client_tags ct
   WHERE ct.tag = public.fn_enrich_norm_tag(p_tag)
$fn$;

-- The overlap_sharing switch for one client: flagOn("overlap_sharing", tag).
CREATE OR REPLACE FUNCTION public.fn_overlap_sharing_on(p_tag text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT public.fn_enrich_switch_value_on(
    (SELECT s.value FROM public.enrich_settings s WHERE s.key = 'overlap_sharing'), p_tag)
$fn$;

-- The switch: off, no client, preview only, nothing pushed or tagged.
INSERT INTO enrich_settings (key, value) VALUES
  ('overlap_sharing', '{"enabled": false, "tags": [], "mode": "preview",
                        "pools": {"cleaning": ["Cleaning", "Canada Cleaning"]}, "isolated_tag_suffixes": ["-OS"],
                        "push_tags": [], "push_every_minutes": 15, "push_max_per_job": 1000, "push_max_per_day": 2000,
                        "held_retry_days": 7, "write_tags": false, "tag_rows_per_day": 20000, "since": null,
                        "wait_location_minutes": 180, "recheck_days": 7}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Access: server-only.
ALTER TABLE share_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON share_jobs, lead_shares FROM anon, authenticated;
REVOKE ALL ON SEQUENCE lead_shares_id_seq FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_share_rule_fits(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_share_fits(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_remove_tag(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_client_pool_value(jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_client_pool(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_overlap_sharing_on(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_share_rule_fits(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_share_fits(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_remove_tag(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_client_pool_value(jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_client_pool(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_overlap_sharing_on(text) TO service_role;

COMMENT ON TABLE share_jobs IS 'Overlap sharing: one row per finished import batch the share step found, with its state (134).';
COMMENT ON TABLE lead_shares IS 'Overlap sharing: one row per new lead and receiving client it fits; the outcome, and whether it was applied, pushed, tagged or undone (134).';
COMMENT ON FUNCTION public.fn_share_rule_fits(uuid[], text) IS 'Which of up to 2,000 leads fit a client''s push rules plus the share extras, without the receive rule (134).';
COMMENT ON FUNCTION public.fn_share_fits(uuid[], text) IS 'Which of up to 2,000 leads a client could receive as a share: the receive rule, its push rules and the share extras (134).';
COMMENT ON FUNCTION public.fn_remove_tag(text, text) IS 'A comma-separated tag list without one tag, exact and in any case; unchanged when it is not there (134).';
COMMENT ON FUNCTION public.fn_client_pool(text) IS 'The sharing pool of a client as settings.mjs clientPool() reads it; null when the client is isolated (134).';
COMMENT ON FUNCTION public.fn_overlap_sharing_on(text) IS 'Is the overlap_sharing switch on for this client, as flagOn("overlap_sharing", tag) reads it (134).';

DO $$
DECLARE
  bad text;
  d constant jsonb := '{}';
  custom constant jsonb := '{"pools": {"zeta": ["Cleaning"], "alpha": [" cleaning ", "Other Kind"], "Bad Name": ["Thing"]},
                             "isolated_tag_suffixes": ["-zz"]}';
  ids uuid[];
BEGIN
  SELECT string_agg(t, ', ') INTO bad
    FROM unnest(ARRAY['share_jobs', 'lead_shares']) t
   WHERE to_regclass('public.' || t) IS NULL
      OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR has_table_privilege('anon', 'public.' || t, 'SELECT')
      OR has_table_privilege('authenticated', 'public.' || t, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '134: missing or not server-only: %', bad;
  END IF;
  SELECT string_agg(f, ', ') INTO bad
    FROM unnest(ARRAY['public.fn_share_rule_fits(uuid[], text)', 'public.fn_share_fits(uuid[], text)',
                      'public.fn_remove_tag(text, text)', 'public.fn_client_pool_value(jsonb, text, text)',
                      'public.fn_client_pool(text)', 'public.fn_overlap_sharing_on(text)']) f
   WHERE to_regprocedure(f) IS NULL
      OR has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '134: missing, or callable by anon or authenticated: %', bad;
  END IF;
  SELECT string_agg(i, ', ') INTO bad
    FROM unnest(ARRAY['share_jobs_due_idx', 'share_jobs_recheck_idx', 'share_jobs_recent_idx', 'share_jobs_origin_idx',
                      'lead_shares_push_idx', 'lead_shares_receiver_applied_idx', 'lead_shares_lead_idx',
                      'lead_shares_tag_todo_idx', 'lead_shares_untag_todo_idx']) i
   WHERE to_regclass('public.' || i) IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '134: missing indexes: %', bad;
  END IF;
  -- The writer's index drops a row once looked at (an older copy of this file did not).
  IF pg_get_indexdef('public.lead_shares_tag_todo_idx'::regclass) NOT LIKE '%tag_added_at IS NULL%' THEN
    RAISE EXCEPTION '134: lead_shares_tag_todo_idx is an older version; drop it and run this file again';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enrich_settings WHERE key = 'overlap_sharing') THEN
    RAISE EXCEPTION '134: the overlap_sharing setting is missing';
  END IF;
  IF coalesce((SELECT value -> 'enabled' = 'true'::jsonb FROM enrich_settings WHERE key = 'overlap_sharing'), false) THEN
    RAISE NOTICE '134: note, overlap_sharing is ON';
  END IF;

  -- Removing a tag (made-up tags).
  IF public.fn_remove_tag('Outlook,ZZA,ZZB', 'zzb') IS DISTINCT FROM 'Outlook,ZZA'
     OR public.fn_remove_tag('Outlook, ZZA ,ZZB', 'ZZA') IS DISTINCT FROM 'Outlook,ZZB'
     OR public.fn_remove_tag('ZZB', 'ZZB') IS NOT NULL
     OR public.fn_remove_tag('Outlook, ZZA', 'ZZC') IS DISTINCT FROM 'Outlook, ZZA'
     OR public.fn_remove_tag('ZZAB,ZZA', 'ZZA') IS DISTINCT FROM 'ZZAB'
     OR public.fn_remove_tag(NULL, 'ZZA') IS NOT NULL
     OR public.fn_remove_tag('ZZA', '') IS DISTINCT FROM 'ZZA'
     OR public.fn_merge_tags(public.fn_remove_tag(public.fn_merge_tags('Outlook,ZZA', 'ZZB'), 'ZZB'), NULL) IS DISTINCT FROM 'Outlook,ZZA' THEN
    RAISE EXCEPTION '134: fn_remove_tag removes the wrong tags';
  END IF;

  -- Pools, by the defaults and by a made-up setting.
  SELECT string_agg(r.label || ' got ' || coalesce(r.got, 'null'), '; ') INTO bad
    FROM (VALUES
      ('cleaning', public.fn_client_pool_value(d, 'ZZA', 'Cleaning'), 'cleaning'),
      ('cleaning any case', public.fn_client_pool_value(d, 'ZZA', ' canada CLEANING '), 'cleaning'),
      ('isolated non-cleaning', public.fn_client_pool_value(d, 'ZZA', 'Non-Cleaning'), NULL),
      ('isolated blank type', public.fn_client_pool_value(d, 'ZZA', ' '), NULL),
      ('isolated null type', public.fn_client_pool_value(d, 'ZZA', NULL), NULL),
      ('isolated -OS tag', public.fn_client_pool_value(d, 'ZZA-OS', 'Cleaning'), NULL),
      ('isolated -os tag', public.fn_client_pool_value(d, ' zza-os ', 'Cleaning'), NULL),
      ('no tag', public.fn_client_pool_value(d, '', 'Cleaning'), NULL),
      ('null settings', public.fn_client_pool_value(NULL, 'ZZA', 'Cleaning'), 'cleaning'),
      ('bad shapes take the defaults', public.fn_client_pool_value('{"pools": [], "isolated_tag_suffixes": "x"}', 'ZZA-OS', 'Cleaning'), NULL),
      ('bad pools take the defaults', public.fn_client_pool_value('{"pools": "x"}', 'ZZA', 'Cleaning'), 'cleaning'),
      ('custom: first pool by name', public.fn_client_pool_value(custom, 'ZZA', 'cleaning'), 'alpha'),
      ('custom: other type', public.fn_client_pool_value(custom, 'ZZA', 'OTHER KIND'), 'alpha'),
      ('custom: bad pool name skipped', public.fn_client_pool_value(custom, 'ZZA', 'Thing'), NULL),
      ('custom: -OS not isolated', public.fn_client_pool_value(custom, 'ZZA-OS', 'Cleaning'), 'alpha'),
      ('custom: -ZZ isolated', public.fn_client_pool_value(custom, 'ZZA-ZZ', 'Cleaning'), NULL),
      ('empty pools isolate all', public.fn_client_pool_value('{"pools": {}}', 'ZZA', 'Cleaning'), NULL),
      ('empty suffixes isolate none', public.fn_client_pool_value('{"isolated_tag_suffixes": []}', 'ZZA-OS', 'Cleaning'), 'cleaning')
    ) AS r(label, got, want)
   WHERE r.got IS DISTINCT FROM r.want;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '134: the pool rule is wrong: %', bad;
  END IF;
  IF public.fn_client_pool('zz134-no-such-client') IS NOT NULL THEN
    RAISE EXCEPTION '134: a tag that is no client has a pool';
  END IF;

  -- The switch reads as flagOn() does, and is off as seeded.
  IF public.fn_overlap_sharing_on('zz134-no-such-client') OR public.fn_overlap_sharing_on('') OR public.fn_overlap_sharing_on(NULL) THEN
    RAISE EXCEPTION '134: the overlap_sharing switch reads on';
  END IF;

  -- The fit functions: nothing for no ids or a client that cannot receive; more than 2,000 ids refused.
  IF EXISTS (SELECT 1 FROM public.fn_share_rule_fits('{}'::uuid[], 'ZZA'))
     OR EXISTS (SELECT 1 FROM public.fn_share_rule_fits(NULL, 'ZZA'))
     OR EXISTS (SELECT 1 FROM public.fn_share_fits(ARRAY[gen_random_uuid()], 'zz134-no-such-client')) THEN
    RAISE EXCEPTION '134: a fit function returned a lead it should not';
  END IF;
  SELECT array_agg(gen_random_uuid()) INTO ids FROM generate_series(1, 2001);
  BEGIN
    PERFORM count(*) FROM public.fn_share_rule_fits(ids, 'ZZA');
    RAISE EXCEPTION '134: fn_share_rule_fits took 2,001 ids' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;
  -- 2,000 made-up ids that are no lead: runs, finds nothing.
  IF EXISTS (SELECT 1 FROM public.fn_share_rule_fits(ids[1:2000], 'zz134-no-such-client')) THEN
    RAISE EXCEPTION '134: fn_share_rule_fits found a lead among made-up ids';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Read-only checks after applying (paste and run on their own):
--   SELECT value FROM enrich_settings WHERE key = 'overlap_sharing';      -- enabled false, tags []
--   SELECT fn_client_pool(tag) AS pool, count(*) FROM client_tags
--    WHERE lower(btrim(coalesce(status, ''))) IN ('active', 'healthy') GROUP BY 1 ORDER BY 2 DESC;
--   SELECT count(*) AS jobs FROM share_jobs;                                -- 0 while sharing is off
