-- Migration 056: per-client data stats for the Clients analysis page.
-- Cached (the unnest aggregation over leads.tags is ~8s at 2.3M rows) and
-- refreshed on demand from the UI.

CREATE TABLE IF NOT EXISTS client_stats (
  tag          text PRIMARY KEY,
  leads        bigint NOT NULL DEFAULT 0,
  categorized  bigint NOT NULL DEFAULT 0,   -- category IS NOT NULL
  bounced      bigint NOT NULL DEFAULT 0,   -- is_bounced = true
  contactable  bigint NOT NULL DEFAULT 0,   -- not bounced AND (valid/catch_all/unvalidated)
  personal     bigint NOT NULL DEFAULT 0,   -- freemail email (B2C side)
  business     bigint NOT NULL DEFAULT 0,   -- business email (B2B side)
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE client_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read client stats" ON client_stats;
CREATE POLICY "Authenticated read client stats" ON client_stats
  FOR SELECT TO authenticated USING (true);

-- Recompute the whole cache from leads.tags in one pass. SECURITY DEFINER so the
-- API route (service client) and any authorized caller can trigger it.
CREATE OR REPLACE FUNCTION public.fn_refresh_client_stats()
 RETURNS timestamptz
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '120s'
AS $function$
DECLARE ts timestamptz := now();
BEGIN
  CREATE TEMP TABLE _cs ON COMMIT DROP AS
    SELECT trim(t) AS tag,
           count(*) AS leads,
           count(*) FILTER (WHERE l.category IS NOT NULL AND trim(l.category) <> '') AS categorized,
           count(*) FILTER (WHERE l.is_bounced) AS bounced,
           count(*) FILTER (WHERE NOT l.is_bounced AND (l.validation_status IN ('valid','catch_all') OR l.validation_status IS NULL)) AS contactable,
           count(*) FILTER (WHERE split_part(lower(l.email), '@', 2) IN (SELECT domain FROM freemail_domains)) AS personal,
           count(*) FILTER (WHERE split_part(lower(l.email), '@', 2) NOT IN (SELECT domain FROM freemail_domains)) AS business
    FROM leads l, unnest(string_to_array(l.tags, ',')) t
    WHERE l.tags IS NOT NULL AND l.tags <> '' AND trim(t) <> ''
    GROUP BY trim(t);

  DELETE FROM client_stats;
  INSERT INTO client_stats (tag, leads, categorized, bounced, contactable, personal, business, refreshed_at)
  SELECT tag, leads, categorized, bounced, contactable, personal, business, ts FROM _cs;
  RETURN ts;
END;
$function$;
