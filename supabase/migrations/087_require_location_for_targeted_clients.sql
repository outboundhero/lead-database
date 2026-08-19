-- 087: require_location = true for every client that targets specific locations.
--
-- WHY (performance): /api/clients/availability runs a COUNT over `leads` every
-- time a client is selected on the Leads page. Measured 2026-08-20 in
-- pg_stat_statements: 5 calls, 357s total, MEAN 71,452 ms, max 89,888 ms, with
-- three of them running concurrently. That is what pinned the database at 100%
-- CPU.
--
-- The cost is entirely the require_location=false escapes in
-- fn_client_eligibility_conditions:
--
--     (l.country_code = ANY(...) OR l.country_code IS NULL)
--     ((<117 location_id conditions>) OR l.state_code IS NULL)
--
-- `OR l.state_code IS NULL` admits all 2,835,902 leads with no state code, so
-- the count scans ~2.6M rows instead of ~154k. Measured on BBS:
--
--     require_location = false  ->  58,918 ms
--     require_location = true   ->   1,335 ms      (44x)
--
-- WHY (correctness): the same escape made the UI advertise "2,611,332 available
-- for BBS" when only 154,406 leads are actually inside BBS's 117 target cities
-- -- 94% of that number was leads whose location is simply unknown. It also
-- meant the SEND path considered those leads eligible, which contradicts the
-- client instruction that leads must come from their target locations (the same
-- instruction behind the wrong-state fix in 7d9c4d2).
--
-- WHAT CHANGES: for a client WITH include_locations, eligibility narrows to
-- leads genuinely resolved inside those locations. For a client with none, only
-- the country escape closes. Nothing else in the rule set moves; exclusions,
-- inferred-location policy and commercial-cleaning stay exactly as they were.
--
-- This is a data change, not a schema change, and it is instantly reversible:
--
--     UPDATE client_targeting SET require_location = false;
--
-- Per-client revert, if one client genuinely wants unlocated leads:
--
--     UPDATE client_targeting SET require_location = false WHERE client_tag = 'XXX';

UPDATE client_targeting
   SET require_location = true,
       updated_at = now()
 WHERE require_location IS DISTINCT FROM true;

-- Record what the count looks like afterwards so the effect is auditable.
DO $$
DECLARE n_true int; n_false int;
BEGIN
  SELECT count(*) FILTER (WHERE require_location),
         count(*) FILTER (WHERE NOT require_location)
    INTO n_true, n_false
    FROM client_targeting;
  RAISE NOTICE 'client_targeting.require_location: % true, % false', n_true, n_false;
END $$;
