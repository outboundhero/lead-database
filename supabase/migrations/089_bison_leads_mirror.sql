-- 089: a local mirror of what Email Bison holds.
--
-- WHY A MIRROR AND NOT A MERGE INTO leads:
--   * leads is 8.4 GB of an 11 GB database and this instance is disk-IO bound.
--     Rewriting 8.2M rows to fold in Bison state would be the single most
--     expensive thing we could do to it.
--   * Bison's copy and ours are different facts. Ours is "who exists and who
--     may be contacted"; Bison's is "who it holds, in which campaign, and how
--     they responded". Keeping them apart means a re-sync can never damage the
--     lead database, and the two can disagree visibly instead of silently.
--
-- WHAT IS DELIBERATELY NOT STORED:
--   custom_variables — 471 of the 1,190 bytes each lead returns, and it is the
--   merge data WE send to Bison. Mirroring it back would add roughly 5 GB to
--   store what we already have. lead_campaign_data (campaign membership) and
--   overall_stats (engagement) are the parts only Bison knows.
--
-- Scale: ~11.1M rows across four installs
--   app.outboundhero.co            7,930,933
--   app.facilityreach.com          2,615,159
--   personal.outboundclean.com       286,811
--   personal.cleaningoutbound.com    271,972

CREATE TABLE IF NOT EXISTS bison_leads (
  instance_url      text   NOT NULL,
  bison_id          bigint NOT NULL,
  email             text,
  status            text,
  -- lead_campaign_data verbatim: [{campaign_id, status, emails_sent, replies,
  -- opens, interested}]. THE answer to "which campaigns is this lead in",
  -- straight from Bison rather than inferred from our own push history.
  campaigns         jsonb,
  emails_sent       integer,
  opens             integer,
  replies           integer,
  bison_created_at  timestamptz,
  bison_updated_at  timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_url, bison_id)
);

-- The join back to our own leads. Bison matches addresses case-insensitively
-- (verified on all four installs), so the mirror is indexed the same way.
CREATE INDEX IF NOT EXISTS idx_bison_leads_email ON bison_leads (lower(email));

-- Sharded, resumable ingest bookkeeping: one row per (instance, shard), holding
-- the lowest id that shard has reached. The API's cursor is just a base64
-- {"id":N} walking DOWNWARD, so a shard can restart exactly where it stopped
-- rather than from the top — which matters when a full pass is hours long.
CREATE TABLE IF NOT EXISTS bison_sync_state (
  instance_url text    NOT NULL,
  shard        integer NOT NULL,
  from_id      bigint,          -- where this shard started (exclusive upper bound)
  to_id        bigint,          -- where it must stop (lower bound)
  cursor_id    bigint,          -- lowest id reached so far
  rows_seen    bigint  NOT NULL DEFAULT 0,
  done         boolean NOT NULL DEFAULT false,
  started_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_url, shard)
);

ALTER TABLE bison_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bison_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read bison_leads" ON bison_leads;
CREATE POLICY "Anyone can read bison_leads" ON bison_leads FOR SELECT USING (true);
DROP POLICY IF EXISTS "Anyone can read bison_sync_state" ON bison_sync_state;
CREATE POLICY "Anyone can read bison_sync_state" ON bison_sync_state FOR SELECT USING (true);
