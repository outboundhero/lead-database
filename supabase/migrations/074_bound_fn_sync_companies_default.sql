-- 074: make the NO-ARGUMENT call to fn_sync_companies bounded by default.
--
-- WHY
-- Two production callers invoke this function with no arguments:
--   * src/app/api/uploads/process/route.ts:303  (after every CSV import)
--   * scripts/categorize-worker.mjs:368         (twice per run)
-- With DEFAULT NULL they took the UNBOUNDED propagation branch: a single
-- UPDATE joining leads (8.19M rows / 13 GB) against companies (1.32M rows) on
-- a computed expression key, rewriting every match across ~48 indexes. That is
-- the workload most likely responsible for exhausting the Supabase disk-I/O
-- budget. (CLAUDE.md predicted "<=50k companies"; production has 1.32M.)
--
-- Until migration 073 the duplicate-overload error was accidentally blocking
-- these calls. Removing that ambiguity made the unbounded path reachable, so
-- this migration bounds it.
--
-- WHAT CHANGES
-- Only the DEFAULT: NULL -> 50000. The signature is unchanged, so this is a
-- true CREATE OR REPLACE (no second overload — the 073 problem is not
-- reintroduced). Callers that pass p_propagate_limit explicitly
-- (import-bison-csv.mjs, import-clay-categories.mjs) are unaffected.
--
-- The body below was captured from the LIVE database with pg_get_functiondef,
-- not from migration 050, because production had drifted: statement_timeout
-- had been raised 600s -> 3600s directly in the database. Rebuilding from the
-- repo file would have silently reverted that.
--
-- CONSEQUENCE: one call now propagates at most 50k leads instead of all of
-- them, so a full catch-up takes several passes. The categorize-worker runs
-- hourly and calls it twice per run (~100k/hour), so the backlog still drains
-- — just gradually, and without a single multi-million-row rewrite.

CREATE OR REPLACE FUNCTION public.fn_sync_companies(p_propagate_limit integer DEFAULT 50000)
 RETURNS TABLE(companies_inserted integer, companies_seeded integer, leads_propagated integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET statement_timeout TO '3600s'
AS $function$
DECLARE
  v_inserted INT;
  v_seeded INT;
  v_propagated INT;
BEGIN
  INSERT INTO companies (name, city, state, domain)
  SELECT src.name, src.city, src.state, src.domain FROM (
    SELECT DISTINCT ON (lower(TRIM(company)) || '|' || lower(TRIM(COALESCE(city, ''))) || '|' || upper(TRIM(COALESCE(state, ''))))
      TRIM(company) AS name, city, state, domain
    FROM leads
    WHERE company IS NOT NULL AND TRIM(company) <> ''
    ORDER BY lower(TRIM(company)) || '|' || lower(TRIM(COALESCE(city, ''))) || '|' || upper(TRIM(COALESCE(state, ''))), created_at DESC
  ) src
  ON CONFLICT (company_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE companies c SET
    category = s.category,
    subcategory = COALESCE(c.subcategory, s.subcategory),
    additional_category = COALESCE(c.additional_category, s.additional_category),
    category_source = s.category_source,
    categorized_at = now()
  FROM (
    SELECT DISTINCT ON (lower(TRIM(company)) || '|' || lower(TRIM(COALESCE(city, ''))) || '|' || upper(TRIM(COALESCE(state, ''))))
      lower(TRIM(company)) || '|' || lower(TRIM(COALESCE(city, ''))) || '|' || upper(TRIM(COALESCE(state, ''))) AS key,
      category, subcategory, additional_category, COALESCE(category_source, 'bison') AS category_source
    FROM leads
    WHERE category IS NOT NULL AND company IS NOT NULL AND TRIM(company) <> ''
    ORDER BY lower(TRIM(company)) || '|' || lower(TRIM(COALESCE(city, ''))) || '|' || upper(TRIM(COALESCE(state, ''))), categorized_at DESC NULLS LAST
  ) s
  WHERE c.company_key = s.key AND c.category IS NULL;
  GET DIAGNOSTICS v_seeded = ROW_COUNT;

  -- Propagation: optionally bounded so a 2.4M-row rewrite can be driven in
  -- batches by the caller (loops until a round returns < p_propagate_limit).
  -- Never overwrites a 'manual' assignment.
  IF p_propagate_limit IS NULL THEN
    UPDATE leads l SET
      category = c.category,
      subcategory = COALESCE(l.subcategory, c.subcategory),
      additional_category = COALESCE(l.additional_category, c.additional_category),
      category_source = c.category_source,
      category_confidence = CASE WHEN c.category_source = 'ai' THEN 0.8 ELSE 0.9 END,
      categorized_at = now(),
      updated_at = now()
    FROM companies c
    WHERE l.category IS NULL
      AND l.company IS NOT NULL AND TRIM(l.company) <> ''
      AND c.company_key = lower(TRIM(l.company)) || '|' || lower(TRIM(COALESCE(l.city, ''))) || '|' || upper(TRIM(COALESCE(l.state, '')))
      AND c.category IS NOT NULL;
    GET DIAGNOSTICS v_propagated = ROW_COUNT;
  ELSE
    WITH batch AS (
      SELECT l.id, c.category, c.subcategory, c.additional_category, c.category_source
      FROM leads l
      JOIN companies c
        ON c.company_key = lower(TRIM(l.company)) || '|' || lower(TRIM(COALESCE(l.city, ''))) || '|' || upper(TRIM(COALESCE(l.state, '')))
      WHERE l.category IS NULL
        AND l.company IS NOT NULL AND TRIM(l.company) <> ''
        AND c.category IS NOT NULL
      LIMIT p_propagate_limit
    )
    UPDATE leads l SET
      category = b.category,
      subcategory = COALESCE(l.subcategory, b.subcategory),
      additional_category = COALESCE(l.additional_category, b.additional_category),
      category_source = b.category_source,
      category_confidence = CASE WHEN b.category_source = 'ai' THEN 0.8 ELSE 0.9 END,
      categorized_at = now(),
      updated_at = now()
    FROM batch b
    WHERE l.id = b.id;
    GET DIAGNOSTICS v_propagated = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_inserted, v_seeded, v_propagated;
END;
$function$

;

DO $$
DECLARE n int; dflt text;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE p.proname='fn_sync_companies' AND ns.nspname='public';
  IF n <> 1 THEN RAISE EXCEPTION '074: expected 1 fn_sync_companies, found %', n; END IF;
  SELECT pg_get_function_arguments(p.oid) INTO dflt FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE p.proname='fn_sync_companies' AND ns.nspname='public';
  IF dflt NOT LIKE '%DEFAULT 50000%' THEN RAISE EXCEPTION '074: default not applied, got %', dflt; END IF;
  RAISE NOTICE '074: fn_sync_companies default is now 50000 (bounded)';
END $$;
