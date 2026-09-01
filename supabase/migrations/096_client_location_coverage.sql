-- 096: precomputed per-location coverage, one row per client.
--
-- The popup used to compute coverage ON CLIENT SELECT: a grouped scan of the
-- leads table per selection, 7-10s with the state pre-filter and worse without.
-- Client decision 2026-09-02: this belongs on a schedule. A cron recomputes
-- every client's coverage and the UI reads a stored row instantly; the payload
-- carries computed_at so the operator can see how fresh the numbers are.
CREATE TABLE IF NOT EXISTS client_location_coverage (
  client_tag       text PRIMARY KEY,
  threshold        integer NOT NULL DEFAULT 500,
  total_available  bigint,
  -- The full response the UI renders: { locations: [...], low: [...] } exactly
  -- as /api/clients/location-coverage returned it when computed live.
  payload          jsonb NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  compute_ms       integer
);

ALTER TABLE client_location_coverage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read client_location_coverage" ON client_location_coverage;
CREATE POLICY "Anyone can read client_location_coverage" ON client_location_coverage FOR SELECT USING (true);
