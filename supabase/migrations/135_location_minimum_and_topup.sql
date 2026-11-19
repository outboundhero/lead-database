-- 135: a minimum of good leads per place for each client, and the weekly
-- top-up that flags low places and can find more data for them. Ships OFF
-- (enrich_settings.weekly_topup.enabled false, pull_mode off, no client on
-- pull_tags).
--
-- What this adds:
--   - client_targeting.min_leads_per_place: the client's own minimum, 1 to
--     100,000. Empty means weekly_topup.default_minimum (500). The sheet sync
--     never writes it (its update names its own columns); the Rules dialog
--     edits it. The coverage refresh writes the number it used into
--     client_location_coverage.threshold, as before.
--   - topup_passes: one row per weekly pass of the topup-worker (requested by
--     "Run now", running, done or error), with the clients it has done, so a
--     pass that runs past one hourly firing carries on at the next. At most
--     one pass is requested or running at a time.
--   - topup_flags: one row per low place per pass (kind low, or unresolved
--     for a place the geo reference does not know), and one row per client
--     that has none, saying why (all_ok, no_places, no_rules, not_covered).
--     receive_block holds fn_client_receive_block() at pass time; action and
--     reason say what the pass did about it. This is the history the coverage
--     table lacks: that table is overwritten on every refresh.
--   - topup_pulls: the AI Ark people pull a pass prepared or started for a
--     client: its low places, size, requests, brake (its worst-case credits)
--     and the credits its counts cost, so the weekly budget counts them. A
--     pull started becomes an aiark_runs row whose filters hold "topup".
--   - the weekly_topup settings row, everything off; the budget is 25,000
--     credits a week in all and for each client, and spends nothing while
--     pull_mode is off.
--
-- Nothing here reads or writes leads, and nothing changes an existing row: the
-- new column is empty on every client. RLS is on with no policies on the new
-- tables, as in 122 to 134. Needs 132.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regprocedure('public.fn_client_receive_block(text)') IS NULL OR to_regclass('public.aiark_runs') IS NULL THEN
    RAISE EXCEPTION '135 needs 132 (fn_client_receive_block) and 123 (aiark_runs) applied first';
  END IF;
END $$;

ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS min_leads_per_place integer;
ALTER TABLE client_targeting DROP CONSTRAINT IF EXISTS client_targeting_min_leads_per_place_check;
ALTER TABLE client_targeting ADD CONSTRAINT client_targeting_min_leads_per_place_check
  CHECK (min_leads_per_place IS NULL OR min_leads_per_place BETWEEN 1 AND 100000);

CREATE TABLE IF NOT EXISTS topup_passes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state         text NOT NULL CHECK (state IN ('requested', 'running', 'done', 'error')),
  trigger       text NOT NULL CHECK (trigger IN ('schedule', 'button', 'manual')),
  requested_by  uuid,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  settings      jsonb,                                  -- the weekly_topup values the pass ran with
  clients_done  text[] NOT NULL DEFAULT '{}',           -- where a pass carries on from
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS topup_passes_one_open ON topup_passes ((true)) WHERE state IN ('requested', 'running');
CREATE INDEX IF NOT EXISTS topup_passes_recent_idx ON topup_passes (requested_at DESC);

CREATE TABLE IF NOT EXISTS topup_flags (
  id             bigserial PRIMARY KEY,
  pass_id        uuid NOT NULL REFERENCES topup_passes(id) ON DELETE CASCADE,
  -- Plain text, no foreign key, as enrich_tables.client_tag: the sheet syncs delete tags.
  client_tag     text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  kind           text NOT NULL CHECK (kind IN ('low', 'unresolved', 'no_places', 'no_rules', 'not_covered', 'all_ok')),
  place_key      text,                                  -- "US|AZ|tucson" or "US|AZ" (low and unresolved rows)
  label          text,
  place          jsonb CHECK (place IS NULL OR jsonb_typeof(place) = 'object'),
  available      integer,
  minimum        integer,
  resolved       boolean,
  receive_block  text,                                  -- fn_client_receive_block() at pass time; null when it can receive
  action         text NOT NULL DEFAULT 'none'
                 CHECK (action IN ('none', 'prepared', 'started', 'budget', 'pulls_per_day', 'run_active', 'not_on_pull_list',
                                   'pull_mode_off', 'cannot_receive', 'no_people_filters', 'blocked', 'error')),
  pull_id        uuid,                                  -- topup_pulls.id
  run_id         uuid,                                  -- aiark_runs.id
  reason         text,                                  -- in plain words
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('low', 'unresolved') OR place_key IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS topup_flags_one_uniq ON topup_flags (pass_id, client_tag, kind, coalesce(place_key, ''));
CREATE INDEX IF NOT EXISTS topup_flags_client_idx ON topup_flags (client_tag, created_at DESC);

CREATE TABLE IF NOT EXISTS topup_pulls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id        uuid REFERENCES topup_passes(id) ON DELETE SET NULL,
  client_tag     text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  mode           text NOT NULL CHECK (mode IN ('prepare', 'auto')),
  state          text NOT NULL CHECK (state IN ('prepared', 'started', 'skipped', 'expired', 'error')),
  places         jsonb NOT NULL CHECK (jsonb_typeof(places) = 'array' AND jsonb_array_length(places) BETWEEN 1 AND 200),
  size           integer NOT NULL CHECK (size BETWEEN 1 AND 10000),
  requests       jsonb NOT NULL CHECK (jsonb_typeof(requests) = 'array' AND jsonb_array_length(requests) BETWEEN 1 AND 50),
  brake          numeric NOT NULL CHECK (brake >= 0),   -- credits: ceil(size x 1.25) + 5 x searches + 10 (runs.mjs)
  count_credits  numeric NOT NULL DEFAULT 0 CHECK (count_credits >= 0),
  match_count    bigint,
  counted_at     timestamptz,
  run_id         uuid REFERENCES aiark_runs(id) ON DELETE SET NULL,
  note           text,                                  -- why skipped or expired, in plain words
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  started_by     uuid,                                  -- null when the worker started it (auto)
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS topup_pulls_pass_client_uniq ON topup_pulls (pass_id, client_tag) WHERE pass_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS topup_pulls_client_idx ON topup_pulls (client_tag, created_at DESC);
CREATE INDEX IF NOT EXISTS topup_pulls_started_idx ON topup_pulls (started_at) WHERE started_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS topup_pulls_counted_idx ON topup_pulls (counted_at) WHERE counted_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_topup_passes_updated_at ON topup_passes;
CREATE TRIGGER trg_topup_passes_updated_at BEFORE UPDATE ON topup_passes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_topup_pulls_updated_at ON topup_pulls;
CREATE TRIGGER trg_topup_pulls_updated_at BEFORE UPDATE ON topup_pulls
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The switch: off. Cleaning and Canada Cleaning clients when on. No pulls
-- until pull_mode is prepare or auto and a client is on pull_tags.
INSERT INTO enrich_settings (key, value) VALUES
  ('weekly_topup', '{"enabled": false, "client_types": ["Cleaning", "Canada Cleaning"], "default_minimum": 500,
                     "pull_mode": "off", "pull_tags": [], "weekly_credits": 25000, "client_weekly_credits": 25000,
                     "max_pull_size": 1000, "pulls_per_day": 3}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Access: server-only.
ALTER TABLE topup_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE topup_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE topup_pulls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON topup_passes, topup_flags, topup_pulls FROM anon, authenticated;
REVOKE ALL ON SEQUENCE topup_flags_id_seq FROM anon, authenticated;

COMMENT ON COLUMN client_targeting.min_leads_per_place IS 'The client''s minimum of good leads per place; empty means weekly_topup.default_minimum (135).';
COMMENT ON TABLE topup_passes IS 'Weekly top-up: one row per pass of the topup-worker (135).';
COMMENT ON TABLE topup_flags IS 'Weekly top-up: each low place per pass, or why a client has none, and what the pass did about it (135).';
COMMENT ON TABLE topup_pulls IS 'Weekly top-up: the AI Ark people pull a pass prepared or started for a client, with its brake and count credits (135).';

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(t, ', ') INTO bad
    FROM unnest(ARRAY['topup_passes', 'topup_flags', 'topup_pulls']) t
   WHERE to_regclass('public.' || t) IS NULL
      OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR has_table_privilege('anon', 'public.' || t, 'SELECT')
      OR has_table_privilege('authenticated', 'public.' || t, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '135: missing or not server-only: %', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'client_targeting' AND column_name = 'min_leads_per_place') THEN
    RAISE EXCEPTION '135: client_targeting.min_leads_per_place is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'client_targeting_min_leads_per_place_check'
                    AND pg_get_constraintdef(oid) LIKE '%100000%') THEN
    RAISE EXCEPTION '135: the minimum is not limited to 1 to 100,000';
  END IF;
  SELECT string_agg(i, ', ') INTO bad
    FROM unnest(ARRAY['topup_passes_one_open', 'topup_passes_recent_idx', 'topup_flags_one_uniq', 'topup_flags_client_idx',
                      'topup_pulls_pass_client_uniq', 'topup_pulls_client_idx', 'topup_pulls_started_idx',
                      'topup_pulls_counted_idx']) i
   WHERE to_regclass('public.' || i) IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '135: missing indexes: %', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enrich_settings WHERE key = 'weekly_topup') THEN
    RAISE EXCEPTION '135: the weekly_topup setting is missing';
  END IF;
  IF coalesce((SELECT value -> 'enabled' = 'true'::jsonb OR value ->> 'pull_mode' IN ('prepare', 'auto')
                 FROM enrich_settings WHERE key = 'weekly_topup'), false) THEN
    RAISE NOTICE '135: note, the weekly top-up is ON or its pulls are';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Read-only checks after applying (paste and run on their own):
--   SELECT value FROM enrich_settings WHERE key = 'weekly_topup';         -- enabled false, pull_mode off
--   SELECT count(*) FILTER (WHERE min_leads_per_place IS NOT NULL) AS own_minimum FROM client_targeting;   -- 0
--   SELECT count(*) AS passes FROM topup_passes;                           -- 0 until the topup-worker runs a pass
