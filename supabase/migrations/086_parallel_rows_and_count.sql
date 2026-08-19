-- 086: run the rows query and the total count CONCURRENTLY.
--
-- After 085 a heavy client filter is ~9-13s. The plan is already optimal (a
-- parallel bitmap scan on location_id, all buffer hits) and more parallel
-- workers do not help -- the server allows only 4 in total, and raising
-- max_parallel_workers_per_gather measured 4,492ms -> 4,699ms, i.e. nothing.
-- The remaining cost is the exclusion regex over the ~60k matched rows, and
-- fn_filter_leads_v2 paid it TWICE IN SERIES: once for the page of rows, then
-- again for COUNT(*).
--
--   CCGCT: rows 4.8s THEN count 4.5s = ~9.3s sequential
--          max(4.8, 4.5)             = ~4.8s in parallel
--
-- So: fn_filter_leads_v2 gains a `skipCount` flag (read from p_filters, NOT a
-- new parameter -- a new parameter would add an overload instead of replacing
-- the function, the trap CLAUDE.md documents), and fn_filter_leads_count is a
-- new function holding the counting logic alone. /api/leads/filter fires both
-- at once and joins them.
--
-- The count keeps its own bound and degrades to the planner estimate rather
-- than hanging -- the 085 lesson. It is bounded at 15s rather than 8s because
-- it no longer blocks the table from rendering: the rows come back on their own
-- request, so a slow count delays only the header number.
--
-- fn_filter_leads_v2 is rebuilt from pg_get_functiondef() of the LIVE
-- definition. Signature unchanged.

CREATE OR REPLACE FUNCTION public.fn_filter_leads_v2(p_filters jsonb, p_sort_by text DEFAULT ''::text, p_sort_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  data_rows JSONB;
  total_count BIGINT;
  row_count INT;
  is_approximate BOOLEAN := false;
  where_clause TEXT := '';
  conditions TEXT[] := '{}';
  order_clause TEXT := '';
  v TEXT;
  vals TEXT[];
  sql_text TEXT;
BEGIN
  -- ALWAYS produce a deterministic total order (F03/F40): LIMIT/OFFSET without
  -- ORDER BY lets Postgres return rows in any order, so pages could repeat or
  -- skip rows. l.id is the stable tiebreaker for every sort; the default view
  -- sorts by created_at DESC.
  DECLARE sort_col TEXT; dir TEXT := CASE WHEN p_sort_dir = 'asc' THEN 'ASC' ELSE 'DESC' END;
  BEGIN
    sort_col := CASE COALESCE(NULLIF(p_sort_by, ''), 'created_at')
      WHEN 'created_at' THEN 'created_at'
      WHEN 'first_name' THEN 'first_name'
      WHEN 'last_name' THEN 'last_name'
      WHEN 'email' THEN 'email'
      WHEN 'company' THEN 'company'
      WHEN 'general_industry' THEN 'general_industry'
      WHEN 'updated_at' THEN 'updated_at'
      ELSE 'created_at'
    END;
    IF sort_col = 'id' THEN
      order_clause := 'ORDER BY l.id ' || dir;
    ELSE
      order_clause := 'ORDER BY l.' || sort_col || ' ' || dir || ', l.id ' || dir;
    END IF;
  END;

  -- All filter conditions come from the SHARED builder (also used by
  -- fn_export_leads and fn_leads_needing_validation) — new filters are added
  -- there exactly once. This function only adds view-specific bits (bounce
  -- visibility, sort, count).
  conditions := fn_lead_filter_conditions(p_filters);

  -- BOUNCE FILTER (new): default exclude is_bounced=true; admin can include via includeBounced=true
  IF NOT COALESCE((p_filters->>'includeBounced')::boolean, false) THEN
    conditions := array_append(conditions, 'l.is_bounced = false');
  END IF;

  IF array_length(conditions, 1) > 0 THEN
    where_clause := 'WHERE ' || array_to_string(conditions, ' AND ');
  END IF;

  sql_text := format(
    'SELECT jsonb_agg(row_to_json(sub)) FROM (
      SELECT l.*
      FROM leads l %s %s
      LIMIT %s OFFSET %s
    ) sub',
    where_clause, order_clause, p_limit, p_offset
  );
  EXECUTE sql_text INTO data_rows;

  row_count := COALESCE(jsonb_array_length(data_rows), 0);
  -- skipCount: the caller is computing the total CONCURRENTLY via
  -- fn_filter_leads_count, so doing it here would just serialise two expensive
  -- scans (rows 4.8s THEN count 4.5s = 9.3s, versus max(4.8, 4.5) in parallel).
  -- Passed inside p_filters deliberately: adding a parameter would create a
  -- second overload rather than replace this one (see CLAUDE.md).
  IF COALESCE((p_filters->>'skipCount')::boolean, false) THEN
    total_count := -1;
    is_approximate := true;
  ELSIF array_length(conditions, 1) IS NULL OR array_length(conditions, 1) = 0 THEN
    SELECT total_leads INTO total_count
    FROM dashboard_snapshots
    ORDER BY snapshot_date DESC
    LIMIT 1;
    IF total_count IS NULL THEN
      SELECT COUNT(*) INTO total_count FROM leads;
    END IF;
  ELSIF row_count < p_limit THEN
    total_count := p_offset + row_count;
  ELSE
    BEGIN
      DECLARE
        plan_data JSON;
        est_rows BIGINT;
      BEGIN
        EXECUTE 'EXPLAIN (FORMAT JSON) ' ||
          format('SELECT 1 FROM leads l %s', where_clause)
          INTO plan_data;
        est_rows := COALESCE(
          (plan_data::jsonb -> 0 -> 'Plan' ->> 'Plan Rows')::BIGINT,
          p_offset + row_count + 10000
        );
        -- The planner estimate is unreliable for ILIKE/substring filters
        -- (can be off by orders of magnitude: e.g. estimated 3 vs actual 157).
        -- For any result set within a safe threshold, compute an EXACT count so
        -- the header and pagination are correct. Only fall back to the cheap
        -- estimate when the set is genuinely huge -- this protects against a
        -- slow COUNT(*) once the table reaches the 15-20M target scale.
        IF est_rows <= 500000 THEN
          -- Bound the count. CRITICAL: the bound must be honoured here, in its
          -- OWN subtransaction. It previously relied on the outer OTHERS handler
          -- below, which re-ran the SAME count with NO timeout -- so an 8s bound
          -- became a 466s query for client CCGCT and the page never loaded.
          BEGIN
            EXECUTE 'SET LOCAL statement_timeout = 8000';
            EXECUTE format('SELECT COUNT(*) FROM leads l %s', where_clause)
              INTO total_count;
            is_approximate := false;
          EXCEPTION WHEN OTHERS THEN
            -- Degrade to the estimate. NEVER retry the count unbounded.
            total_count := GREATEST(est_rows, p_offset + row_count);
            is_approximate := true;
          END;
        ELSE
          total_count := est_rows;
          is_approximate := true;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- EXPLAIN failed. Try an exact count ONCE, still bounded -- an unbounded
        -- retry here was the other half of the 466s hang.
        BEGIN
          EXECUTE 'SET LOCAL statement_timeout = 8000';
          EXECUTE format('SELECT COUNT(*) FROM leads l %s', where_clause)
            INTO total_count;
          is_approximate := false;
        EXCEPTION WHEN OTHERS THEN
          total_count := p_offset + row_count + 10000;
          is_approximate := true;
        END;
      END;
    END;
  END IF;

  RETURN jsonb_build_object(
    'data', COALESCE(data_rows, '[]'::jsonb),
    'totalCount', total_count,
    'isApproximate', is_approximate
  );
END;
$function$

;

-- Counting alone, so it can run beside the rows query instead of after it.
CREATE OR REPLACE FUNCTION public.fn_filter_leads_count(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  conditions TEXT[] := '{}';
  where_clause TEXT := '';
  total_count BIGINT;
  is_approximate BOOLEAN := false;
  plan_data JSON;
  est_rows BIGINT := 0;
BEGIN
  -- Same shared builder and same bounce default as fn_filter_leads_v2, so the
  -- two always agree on WHAT is being counted.
  conditions := fn_lead_filter_conditions(p_filters);
  IF NOT COALESCE((p_filters->>'includeBounced')::boolean, false) THEN
    conditions := array_append(conditions, 'l.is_bounced = false');
  END IF;

  -- No filters: the dashboard snapshot already knows the answer.
  IF array_length(conditions, 1) IS NULL OR array_length(conditions, 1) = 0 THEN
    SELECT total_leads INTO total_count
      FROM dashboard_snapshots ORDER BY snapshot_date DESC LIMIT 1;
    IF total_count IS NULL THEN SELECT COUNT(*) INTO total_count FROM leads; END IF;
    RETURN jsonb_build_object('totalCount', total_count, 'isApproximate', false);
  END IF;

  where_clause := 'WHERE ' || array_to_string(conditions, ' AND ');

  -- Estimate first, purely as the fallback if the exact count runs long.
  BEGIN
    EXECUTE 'EXPLAIN (FORMAT JSON) ' || format('SELECT 1 FROM leads l %s', where_clause)
      INTO plan_data;
    est_rows := COALESCE((plan_data::jsonb -> 0 -> 'Plan' ->> 'Plan Rows')::BIGINT, 0);
  EXCEPTION WHEN OTHERS THEN
    est_rows := 0;
  END;

  BEGIN
    EXECUTE 'SET LOCAL statement_timeout = 15000';
    EXECUTE format('SELECT COUNT(*) FROM leads l %s', where_clause) INTO total_count;
    is_approximate := false;
  EXCEPTION WHEN OTHERS THEN
    -- NEVER retry unbounded here (that was the 466s bug in 085).
    total_count := est_rows;
    is_approximate := true;
  END;

  RETURN jsonb_build_object('totalCount', total_count, 'isApproximate', is_approximate);
END;
$function$;

NOTIFY pgrst, 'reload schema';
