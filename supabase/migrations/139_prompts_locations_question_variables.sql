-- 139: editable AI prompts per client, location values per client, and
-- question variables (a client's own Bison variable, written by the database).
--
-- 1. enrich_prompt_overrides (+ log): a client's own text for one of the
--    personalisation AI columns (the research step and the question step of the
--    People and General pipelines), typed in the Clay tab. Applied when the
--    client's pipeline tables are compiled; the Clay original in
--    enrich_originals stays untouched, so "Reset to Clay original" deletes the
--    row. prompt_text is what the editor shows (plain text with {{Column}}
--    placeholders), formula is the expression the pipeline runs (generated from
--    it, never typed).
-- 2. client_targeting.locations_locked (+ by, at): set when places are edited
--    by hand. While it is set the onboarding-sheet sync leaves the client's
--    include and exclude places alone; unlocking hands them back to the sheet.
--    client_targeting_log keeps a before/after of every hand edit.
-- 3. client_variables (+ log): named per-client values the pipeline can read,
--    starting with service_area (the client's area in words, for prompts). A
--    missing row means the pipeline falls back to the sheet's text.
-- 4. Question variables: question_variables (+ log) hold a variable's Bison
--    name (lower case, as Bison stores "question"; campaign copy writes it upper
--    case, {ACME-OS QUESTION}), the services and context it is written for, and
--    its research and question prompts. client_question_settings remembers which
--    variable a client uses (no row or NULL = the default QUESTION).
--    question_jobs and question_job_items are the work queue: a person asks, in
--    the export popup, to write the variable for the leads they are about to
--    push. question_research keeps one research answer per company and
--    variable; lead_question_values one question per lead and variable.
-- 5. push_batches.question_variable_id and question_variable_name: the
--    variable a push sends besides the usual ones. NULL (every batch so far)
--    means the push behaves exactly as before.
-- 6. The question_variables switch: off, no client listed.
--
-- Nothing here reads or rewrites leads; every new table starts empty and the
-- new columns are NULL or false. RLS is on with no policies, as in 122 to 138:
-- only DATABASE_URL (the web routes and the workers) reads or writes them.
-- Needs 052, 064, 124 and 125.
--
-- Paste it into the Supabase SQL editor and run it once. It is idempotent: a
-- second run changes nothing and passes its checks. A lock wait over 5
-- seconds aborts it with nothing changed (push_batches is in use while pushes
-- run): run it again later.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.push_batches') IS NULL OR to_regclass('public.client_targeting') IS NULL
     OR to_regclass('public.enrich_settings') IS NULL OR to_regclass('public.enrich_originals') IS NULL
     OR to_regclass('public.enrich_spend_daily') IS NULL
     OR to_regprocedure('public.update_updated_at_column()') IS NULL THEN
    RAISE EXCEPTION '139 needs 052, 064, 124 and 125 applied first';
  END IF;
END $$;

-- 1. Prompt overrides.
CREATE TABLE IF NOT EXISTS enrich_prompt_overrides (
  client_tag     text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  template_kind  text NOT NULL CHECK (template_kind IN ('people', 'inboxes')),
  position       smallint NOT NULL CHECK (position BETWEEN 1 AND 200),
  prompt_text    text NOT NULL CHECK (length(prompt_text) BETWEEN 1 AND 40000),
  formula        text NOT NULL CHECK (length(formula) BETWEEN 1 AND 80000),
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_tag, template_kind, position)
);
CREATE TABLE IF NOT EXISTS enrich_prompt_override_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_tag     text NOT NULL,
  template_kind  text NOT NULL,
  position       smallint NOT NULL,
  action         text NOT NULL CHECK (action IN ('save', 'reset')),
  before_text    text,
  after_text     text,
  by_user        uuid,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enrich_prompt_override_log_idx
  ON enrich_prompt_override_log (client_tag, template_kind, position, at DESC);

-- 2. Hand-edited places win over the sheet sync until unlocked.
ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS locations_locked boolean NOT NULL DEFAULT false;
ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS locations_locked_by uuid;
ALTER TABLE client_targeting ADD COLUMN IF NOT EXISTS locations_locked_at timestamptz;
CREATE TABLE IF NOT EXISTS client_targeting_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_tag  text NOT NULL,
  action      text NOT NULL CHECK (action IN ('save', 'lock', 'unlock')),
  before      jsonb,
  after       jsonb,
  by_user     uuid,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_targeting_log_idx ON client_targeting_log (client_tag, at DESC);

-- 3. Named per-client values.
CREATE TABLE IF NOT EXISTS client_variables (
  client_tag  text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  name        text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  value       text NOT NULL CHECK (length(value) <= 5000),
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sheet', 'scraper')),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_tag, name)
);
CREATE TABLE IF NOT EXISTS client_variables_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_tag    text NOT NULL,
  name          text NOT NULL,
  action        text NOT NULL CHECK (action IN ('save', 'delete')),
  before_value  text,
  after_value   text,
  source        text,
  by_user       uuid,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_variables_log_idx ON client_variables_log (client_tag, name, at DESC);

-- 4. Question variables.
CREATE TABLE IF NOT EXISTS question_variables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9 _-]{0,62}$' AND name = btrim(name) AND name !~ '\s\s'
                                      AND name NOT IN ('question', 'category', 'sub-category', 'additional category', 'city',
                                                       'state', 'domain', 'address', 'company phone', 'google maps url',
                                                       'person linkedin url')),
  created_for_tag  text CHECK (created_for_tag IS NULL OR (created_for_tag = upper(btrim(created_for_tag)) AND created_for_tag <> '')),
  services         text NOT NULL DEFAULT '' CHECK (length(services) <= 2000),
  client_context   text NOT NULL DEFAULT '' CHECK (length(client_context) <= 6000),
  research_prompt  text NOT NULL DEFAULT '' CHECK (length(research_prompt) <= 20000),
  people_prompt    text NOT NULL DEFAULT '' CHECK (length(people_prompt) <= 20000),
  general_prompt   text NOT NULL DEFAULT '' CHECK (length(general_prompt) <= 20000),
  max_words        smallint NOT NULL DEFAULT 16 CHECK (max_words BETWEEN 4 AND 40),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),         -- every save
  prompt_version   integer NOT NULL DEFAULT 1 CHECK (prompt_version >= 1),  -- saves that change what gets written
  archived_at      timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS question_variables_name_uniq ON question_variables (name);

CREATE TABLE IF NOT EXISTS question_variable_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variable_id  uuid NOT NULL,                     -- no FK: the log outlives the variable
  action       text NOT NULL CHECK (action IN ('create', 'save', 'archive', 'restore')),
  before       jsonb,
  after        jsonb,
  by_user      uuid,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_variable_log_idx ON question_variable_log (variable_id, at DESC);

CREATE TABLE IF NOT EXISTS client_question_settings (
  client_tag   text PRIMARY KEY CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  variable_id  uuid REFERENCES question_variables(id) ON DELETE SET NULL,   -- NULL = the default QUESTION
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS question_research (
  variable_id     uuid NOT NULL REFERENCES question_variables(id) ON DELETE CASCADE,
  company_key     text NOT NULL CHECK (company_key <> '' AND length(company_key) <= 300),  -- the domain, else company|city|state
  prompt_version  integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('done', 'error')),
  research        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(research) = 'object'),
  note            text,
  model           text,
  cost_usd        numeric(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variable_id, company_key)
);

CREATE TABLE IF NOT EXISTS lead_question_values (
  variable_id     uuid NOT NULL REFERENCES question_variables(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL,                  -- no FK to leads, as push_items: a deleted lead leaves a harmless row
  status          text NOT NULL CHECK (status IN ('done', 'error', 'skipped')),
  value           text CHECK (value IS NULL OR length(value) <= 600),    -- what Bison gets (first letter lower case, as Clay's "question")
  raw             text CHECK (raw IS NULL OR length(raw) <= 2000),       -- the model's answer as given
  words           smallint,
  prompt_kind     text CHECK (prompt_kind IS NULL OR prompt_kind IN ('people', 'general')),
  prompt_version  integer NOT NULL,
  company_key     text,
  note            text,
  model           text,
  cost_usd        numeric(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  generated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variable_id, lead_id),
  CHECK (status <> 'done' OR (value IS NOT NULL AND btrim(value) <> ''))
);

CREATE TABLE IF NOT EXISTS question_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variable_id   uuid NOT NULL REFERENCES question_variables(id) ON DELETE CASCADE,
  client_tag    text NOT NULL CHECK (client_tag = upper(btrim(client_tag)) AND client_tag <> ''),
  selection     jsonb NOT NULL CHECK (jsonb_typeof(selection) = 'object'),  -- the export popup's selection, as sent to push-batch
  rewrite       boolean NOT NULL DEFAULT false,                             -- also rewrite leads that already have a current value
  max_leads     integer CHECK (max_leads IS NULL OR max_leads BETWEEN 1 AND 250000),
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'gathering', 'running', 'paused', 'done', 'error', 'cancelled')),
  total         integer NOT NULL DEFAULT 0,
  done          integer NOT NULL DEFAULT 0,
  failed        integer NOT NULL DEFAULT 0,
  skipped       integer NOT NULL DEFAULT 0,
  companies     integer NOT NULL DEFAULT 0,
  researched    integer NOT NULL DEFAULT 0,
  spend_usd     numeric(12,6) NOT NULL DEFAULT 0 CHECK (spend_usd >= 0),
  claim_token   uuid,
  claimed_at    timestamptz,
  note          text,                                                       -- why it is paused, in plain words
  error         text,                                                       -- one line, never a lead's email
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_jobs_open_idx ON question_jobs (created_at)
  WHERE status IN ('queued', 'gathering', 'running', 'paused');
CREATE INDEX IF NOT EXISTS question_jobs_tag_idx ON question_jobs (client_tag, created_at DESC);

CREATE TABLE IF NOT EXISTS question_job_items (
  job_id       uuid NOT NULL REFERENCES question_jobs(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'done', 'error', 'skipped')),
  attempts     smallint NOT NULL DEFAULT 0,
  claim_token  uuid,
  claimed_at   timestamptz,
  PRIMARY KEY (job_id, lead_id)
);
CREATE INDEX IF NOT EXISTS question_job_items_open_idx ON question_job_items (job_id, status)
  WHERE status IN ('pending', 'working');

-- updated_at triggers.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enrich_prompt_overrides', 'client_variables', 'question_variables',
                           'client_question_settings', 'question_jobs'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ('public.' || t)::regclass
                    AND tgname = 'trg_' || t || '_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
                     'trg_' || t || '_updated_at', t);
    END IF;
  END LOOP;
END $$;

-- 5. The variable a push sends. NULL keeps every push as it is today.
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS question_variable_id uuid;
ALTER TABLE push_batches ADD COLUMN IF NOT EXISTS question_variable_name text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.push_batches'::regclass
                  AND conname = 'push_batches_question_variable_fk') THEN
    ALTER TABLE push_batches ADD CONSTRAINT push_batches_question_variable_fk
      FOREIGN KEY (question_variable_id) REFERENCES question_variables(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.push_batches'::regclass
                  AND conname = 'push_batches_question_variable_check') THEN
    ALTER TABLE push_batches ADD CONSTRAINT push_batches_question_variable_check
      CHECK ((question_variable_id IS NULL OR question_variable_name IS NOT NULL)
             AND (question_variable_name IS NULL OR question_variable_name ~ '^[a-z0-9][a-z0-9 _-]{0,62}$'));
  END IF;
END $$;

-- 6. The switch: off, no client. usd_per_day caps the question writer's own
--    OpenAI spend (enrich_spend_daily kind openai_usd_questions); the models
--    default to the pipeline's research and question models when null.
INSERT INTO enrich_settings (key, value) VALUES
  ('question_variables', '{"enabled": false, "tags": [], "max_words": 16, "research_model": null, "question_model": null,
                           "max_searches": 2, "usd_per_day": 10, "concurrency": 4}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 7. Access: server-only.
ALTER TABLE enrich_prompt_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrich_prompt_override_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_targeting_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_variables_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_variable_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_question_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_research ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_question_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_job_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON enrich_prompt_overrides, enrich_prompt_override_log, client_targeting_log, client_variables,
              client_variables_log, question_variables, question_variable_log, client_question_settings,
              question_research, lead_question_values, question_jobs, question_job_items
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE enrich_prompt_override_log_id_seq, client_targeting_log_id_seq, client_variables_log_id_seq,
                       question_variable_log_id_seq
  FROM anon, authenticated;

-- 8. What each part is.
COMMENT ON TABLE enrich_prompt_overrides IS 'A client''s own text for one personalisation AI column (People P#60/P#61, General G#48/G#49), typed in the Clay tab. Applied when the client''s pipeline tables compile; the Clay original stays in enrich_originals (139).';
COMMENT ON TABLE enrich_prompt_override_log IS 'Before/after of every prompt save and reset in the Clay tab (139).';
COMMENT ON COLUMN client_targeting.locations_locked IS 'True after places were edited by hand: the onboarding-sheet sync leaves include_locations and exclude_locations alone until unlocked (139).';
COMMENT ON TABLE client_targeting_log IS 'Before/after of every hand edit of a client''s places, and each lock and unlock (139).';
COMMENT ON TABLE client_variables IS 'Named per-client values the pipeline reads at run time, e.g. service_area (the client''s area in words, for prompts) (139).';
COMMENT ON TABLE client_variables_log IS 'Before/after of every client variable save and delete (139).';
COMMENT ON TABLE question_variables IS 'A Bison custom variable the database writes per lead (stored lower case as Bison does; copy writes it upper case), with the services, context and prompts it is written from (139).';
COMMENT ON TABLE question_variable_log IS 'Before/after of every question variable create, save, archive and restore (139).';
COMMENT ON TABLE client_question_settings IS 'Which question variable a client''s pushes use; no row or NULL = the default QUESTION (139).';
COMMENT ON TABLE question_research IS 'One research answer per company and question variable, reused by every lead of that company (139).';
COMMENT ON TABLE lead_question_values IS 'One written question per lead and question variable: what a push sends under the variable''s name (139).';
COMMENT ON TABLE question_jobs IS 'A request from the export popup to write a question variable for the leads about to be pushed (139).';
COMMENT ON TABLE question_job_items IS 'The leads of a question job, gathered once when the job starts (139).';
COMMENT ON COLUMN push_batches.question_variable_id IS 'The question variable this push sends besides the usual variables; NULL = none, as every push before 139 (139).';

-- 9. After-checks: anything missing aborts the whole run.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(t, ', ') INTO bad
    FROM unnest(ARRAY['enrich_prompt_overrides', 'enrich_prompt_override_log', 'client_targeting_log', 'client_variables',
                      'client_variables_log', 'question_variables', 'question_variable_log', 'client_question_settings',
                      'question_research', 'lead_question_values', 'question_jobs', 'question_job_items']) t
   WHERE to_regclass('public.' || t) IS NULL
      OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
      OR has_table_privilege('anon', 'public.' || t, 'SELECT')
      OR has_table_privilege('authenticated', 'public.' || t, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '139: missing or not server-only: %', bad;
  END IF;
  SELECT string_agg(c, ', ') INTO bad
    FROM unnest(ARRAY['locations_locked', 'locations_locked_by', 'locations_locked_at']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'client_targeting' AND column_name = c);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '139: client_targeting lacks %', bad;
  END IF;
  SELECT string_agg(c, ', ') INTO bad
    FROM unnest(ARRAY['question_variable_id', 'question_variable_name']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'push_batches' AND column_name = c);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '139: push_batches lacks %', bad;
  END IF;
  SELECT string_agg(c, ', ') INTO bad
    FROM unnest(ARRAY['push_batches_question_variable_fk', 'push_batches_question_variable_check']) c
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.push_batches'::regclass AND conname = c);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '139: push_batches lacks %', bad;
  END IF;
  SELECT string_agg(i, ', ') INTO bad
    FROM unnest(ARRAY['enrich_prompt_override_log_idx', 'client_targeting_log_idx', 'client_variables_log_idx',
                      'question_variables_name_uniq', 'question_variable_log_idx', 'question_jobs_open_idx',
                      'question_jobs_tag_idx', 'question_job_items_open_idx']) i
   WHERE to_regclass('public.' || i) IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '139: missing indexes: %', bad;
  END IF;
  SELECT string_agg(t, ', ') INTO bad
    FROM unnest(ARRAY['enrich_prompt_overrides', 'client_variables', 'question_variables', 'client_question_settings',
                      'question_jobs']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ('public.' || t)::regclass
                      AND tgname = 'trg_' || t || '_updated_at');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '139: missing updated_at triggers on %', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enrich_settings WHERE key = 'question_variables') THEN
    RAISE EXCEPTION '139: the question_variables setting is missing';
  END IF;
  -- Notes only, never a stop, so a second run passes.
  IF coalesce((SELECT value -> 'enabled' = 'true'::jsonb FROM enrich_settings WHERE key = 'question_variables'), false) THEN
    RAISE NOTICE '139: note, question_variables is ON';
  END IF;
  RAISE NOTICE '139: % prompt override(s), % question variable(s), % locked client(s), % push batch(es) naming a variable',
    (SELECT count(*) FROM enrich_prompt_overrides), (SELECT count(*) FROM question_variables),
    (SELECT count(*) FROM client_targeting WHERE locations_locked),
    (SELECT count(*) FROM push_batches WHERE question_variable_id IS NOT NULL);
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Read-only checks after applying (paste and run on their own), each with its expected answer:
--   SELECT value FROM enrich_settings WHERE key = 'question_variables';                    -- enabled false, tags []
--   SELECT count(*) FROM enrich_prompt_overrides;                                          -- 0
--   SELECT count(*) FROM question_variables;                                               -- 0
--   SELECT count(*) FROM client_targeting WHERE locations_locked;                          -- 0
--   SELECT count(*) FROM push_batches WHERE question_variable_id IS NOT NULL;              -- 0
--
-- Back-out (a write; only while the switch is off and no push batch names a variable):
--   BEGIN;
--   DELETE FROM enrich_settings WHERE key = 'question_variables';
--   ALTER TABLE push_batches DROP CONSTRAINT IF EXISTS push_batches_question_variable_check;
--   ALTER TABLE push_batches DROP CONSTRAINT IF EXISTS push_batches_question_variable_fk;
--   ALTER TABLE push_batches DROP COLUMN IF EXISTS question_variable_name;
--   ALTER TABLE push_batches DROP COLUMN IF EXISTS question_variable_id;
--   DROP TABLE IF EXISTS question_job_items, question_jobs, lead_question_values, question_research,
--                        client_question_settings, question_variable_log, question_variables,
--                        client_variables_log, client_variables, client_targeting_log,
--                        enrich_prompt_override_log, enrich_prompt_overrides;
--   ALTER TABLE client_targeting DROP COLUMN IF EXISTS locations_locked_at;
--   ALTER TABLE client_targeting DROP COLUMN IF EXISTS locations_locked_by;
--   ALTER TABLE client_targeting DROP COLUMN IF EXISTS locations_locked;
--   COMMIT;
