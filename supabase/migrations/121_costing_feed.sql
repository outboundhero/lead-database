-- 121: costing feed — the stored cost tables behind GET /api/costing
-- (ReplyRouter "Costing feed — spec for product endpoints v1.0", 2026-10-27).
--
-- cost_line_items: one row per spec line item, keyed by the item's stable id.
-- Amounts are kept EXACTLY as the source gave them: unconstrained numeric keeps
-- the given scale ("3.36750000" comes back as "3.36750000"), capped at the
-- spec's 12 decimals. Totals are summed here in numeric and leave as text, so no
-- figure ever passes through a floating-point number. usage / subscription /
-- allocations / invoice hold decimal STRINGS inside jsonb (a JSON number there
-- would come back through node-postgres as a float, so it is refused).
--
-- cost_invoices: one row per provider invoice whose lines are in the feed, with
-- the invoice total. A deferred check makes each invoice's lines add up EXACTLY
-- to that total at commit (spec §3.6), so the header and its lines are written
-- in one transaction (scripts/costing-import.mjs).
--
-- Writers go through scripts/lib/costing-store.mjs, which validates every item
-- against the spec first; the constraints below repeat every rule SQL can check
-- — the shape of each jsonb field (no nulls inside, real calendar dates), the
-- exact metered sum, no blank text — so a row written by hand cannot make
-- ReplyRouter reject the feed either. A row that is final cannot change its
-- amount, currency, date or status unless the writer sets
-- costing.allow_final_edit = 'on' (SET LOCAL) for a deliberate correction.
--
-- Only the server reads these, over DATABASE_URL (never through PostgREST /
-- supabase-js: PostgREST sends numeric as a bare JSON number). RLS on with no
-- policies, and the anon / authenticated grants this project's default
-- privileges hand every new table and function are revoked explicitly.
--
-- The jsonb checks below use CASE, not AND / OR, wherever a later test would
-- fail on the wrong type (jsonb_array_elements on an object, jsonb - text[] on a
-- scalar): SQL does not promise to evaluate AND / OR left to right.

-- allocations (spec §7): {dimension, key, amount} objects, each (dimension, key)
-- once, and per dimension the amounts add up EXACTLY to the item amount.
CREATE OR REPLACE FUNCTION public.fn_cost_allocations_exact(p_allocations jsonb, p_amount numeric)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_allocations IS NULL THEN true
              WHEN jsonb_typeof(p_allocations) <> 'array' THEN false
              WHEN EXISTS (
                     SELECT 1 FROM jsonb_array_elements(p_allocations) AS e
                      WHERE CASE WHEN jsonb_typeof(e) <> 'object' THEN true
                                 ELSE jsonb_typeof(e->'dimension') IS DISTINCT FROM 'string'
                                   OR (e->>'dimension') !~ '^[a-z0-9_]+$'
                                   OR jsonb_typeof(e->'key') IS DISTINCT FROM 'string'
                                   OR e->>'key' = ''
                                   OR jsonb_typeof(e->'amount') IS DISTINCT FROM 'string'
                                   OR (e->>'amount') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'
                                   OR (e - ARRAY['dimension', 'key', 'amount']) <> '{}'::jsonb END) THEN false
              WHEN EXISTS (
                     SELECT 1 FROM jsonb_array_elements(p_allocations) AS e
                      GROUP BY e->>'dimension', e->>'key' HAVING count(*) > 1) THEN false
              -- every element is a valid object by now; the regex keeps the cast safe regardless
              ELSE NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(p_allocations) AS e
                      WHERE (e->>'amount') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'
                      GROUP BY e->>'dimension'
                     HAVING sum((e->>'amount')::numeric) <> p_amount)
         END
$function$;

-- usage[] (spec §6): {metric, quantity, unit?, unit_price?, price_per?} objects
-- of decimal strings; unit_price and price_per together, price_per never 0.
CREATE OR REPLACE FUNCTION public.fn_cost_usage_ok(p_usage jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_usage IS NULL THEN true
              WHEN jsonb_typeof(p_usage) <> 'array' THEN false
              ELSE NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(p_usage) AS e
                      WHERE CASE WHEN jsonb_typeof(e) <> 'object' THEN true
                                 ELSE jsonb_typeof(e->'metric') IS DISTINCT FROM 'string'
                                   OR (e->>'metric') !~ '^[a-z0-9_]+$'
                                   OR jsonb_typeof(e->'quantity') IS DISTINCT FROM 'string'
                                   OR (e->>'quantity') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'
                                   OR (e ? 'unit' AND jsonb_typeof(e->'unit') IS DISTINCT FROM 'string')
                                   OR (e ? 'unit_price') <> (e ? 'price_per')
                                   OR (e ? 'unit_price' AND (jsonb_typeof(e->'unit_price') IS DISTINCT FROM 'string'
                                        OR (e->>'unit_price') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'))
                                   OR (e ? 'price_per' AND (jsonb_typeof(e->'price_per') IS DISTINCT FROM 'string'
                                        OR (e->>'price_per') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'
                                        OR (e->>'price_per') ~ '^0(\.0+)?$'))
                                   OR (e - ARRAY['metric', 'quantity', 'unit', 'unit_price', 'price_per']) <> '{}'::jsonb END)
         END
$function$;

-- A real calendar date written YYYY-MM-DD, year 0001 or later ("2026-02-29" and
-- "2026-04-31" are not). Worked out from the digits, not with a ::date cast, so
-- a malformed string is false, never an error.
CREATE OR REPLACE FUNCTION public.fn_cost_is_date(p text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p IS NULL OR p !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN false
              ELSE substr(p, 1, 4)::int >= 1
               AND substr(p, 9, 2)::int <= CASE substr(p, 6, 2)::int
                     WHEN 2 THEN CASE WHEN substr(p, 1, 4)::int % 4 = 0
                                           AND (substr(p, 1, 4)::int % 100 <> 0 OR substr(p, 1, 4)::int % 400 = 0)
                                      THEN 29 ELSE 28 END
                     WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
                     ELSE 31 END
         END
$function$;

-- subscription (spec §4): {plan, interval month|year, seats?, service_from,
-- service_to}, real dates. COLLATE "C": the dates compare character by character.
CREATE OR REPLACE FUNCTION public.fn_cost_subscription_ok(p_subscription jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_subscription IS NULL THEN true
              WHEN jsonb_typeof(p_subscription) <> 'object' THEN false
              ELSE coalesce(
                     jsonb_typeof(p_subscription->'plan') = 'string' AND p_subscription->>'plan' <> ''
                     AND jsonb_typeof(p_subscription->'interval') = 'string'
                     AND p_subscription->>'interval' IN ('month', 'year')
                     AND (NOT p_subscription ? 'seats'
                          OR (jsonb_typeof(p_subscription->'seats') = 'string'
                              AND (p_subscription->>'seats') ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'))
                     AND jsonb_typeof(p_subscription->'service_from') = 'string'
                     AND jsonb_typeof(p_subscription->'service_to') = 'string'
                     AND public.fn_cost_is_date(p_subscription->>'service_from')
                     AND public.fn_cost_is_date(p_subscription->>'service_to')
                     AND (p_subscription->>'service_from') COLLATE "C" <= (p_subscription->>'service_to') COLLATE "C"
                     AND (p_subscription - ARRAY['plan', 'interval', 'seats', 'service_from', 'service_to']) = '{}'::jsonb,
                     false)
         END
$function$;

-- attributes (spec §4): a flat object of string / number / boolean values
-- ("never summed"). Numbers stay under 1e15: node-postgres parses jsonb into
-- JavaScript numbers, and a huge one would come out as Infinity, then null.
CREATE OR REPLACE FUNCTION public.fn_cost_attributes_ok(p_attributes jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_attributes IS NULL THEN true
              WHEN jsonb_typeof(p_attributes) <> 'object' THEN false
              ELSE NOT EXISTS (
                     SELECT 1 FROM jsonb_each(p_attributes) AS a
                      WHERE CASE jsonb_typeof(a.value)
                              WHEN 'string' THEN false
                              WHEN 'boolean' THEN false
                              WHEN 'number' THEN abs(a.value::numeric) >= 1e15
                              ELSE true END)
         END
$function$;

-- spec §3.3 / §6: a metered amount is EXACTLY Σ quantity × unit_price ÷ price_per
-- over its priced usage, and it has some. The sum is kept as one fraction
-- (num / den), so no division ever rounds. As in the writer, only well-formed
-- priced elements count; cost_usage_shape refuses the rest.
CREATE OR REPLACE FUNCTION public.fn_cost_metered_exact(p_usage jsonb, p_amount numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  e jsonb; num numeric := 0; den numeric := 1; n int := 0;
BEGIN
  IF jsonb_typeof(p_usage) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_usage) LOOP
    CONTINUE WHEN jsonb_typeof(e) <> 'object';
    CONTINUE WHEN jsonb_typeof(e->'quantity') IS DISTINCT FROM 'string'
               OR jsonb_typeof(e->'unit_price') IS DISTINCT FROM 'string'
               OR jsonb_typeof(e->'price_per') IS DISTINCT FROM 'string';
    CONTINUE WHEN (e->>'quantity') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'
               OR (e->>'unit_price') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'
               OR (e->>'price_per') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$'
               OR (e->>'price_per') ~ '^0(\.0+)?$';
    num := num * (e->>'price_per')::numeric + (e->>'quantity')::numeric * (e->>'unit_price')::numeric * den;
    den := den * (e->>'price_per')::numeric;
    n := n + 1;
  END LOOP;
  RETURN n > 0 AND num = p_amount * den;
END;
$function$;

CREATE TABLE IF NOT EXISTS public.cost_invoices (
  vendor        text NOT NULL CHECK (vendor ~ '^[a-z0-9][a-z0-9-]*$'),
  invoice_id    text NOT NULL CHECK (invoice_id <> ''),
  invoice_date  date NOT NULL,                     -- the charge day; every line of the invoice is dated this day
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total         numeric NOT NULL CHECK (abs(total) < 1e15 AND scale(total) <= 12),  -- abs(): NaN / Infinity fail
  url           text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor, invoice_id)
);

CREATE TABLE IF NOT EXISTS public.cost_line_items (
  id            text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9:._@/+-]{0,199}$'),
  date          date NOT NULL,
  category      text NOT NULL CHECK (category ~ '^[a-z0-9_]+$'),
  vendor        text NOT NULL CHECK (vendor ~ '^[a-z0-9][a-z0-9-]*$'),
  service       text,
  model         text,
  description   text,
  billing_type  text NOT NULL CHECK (billing_type IN ('usage','subscription','one_time','tax','fee','credit','discount','refund')),
  -- abs() first: scale(NaN) is NULL and NaN >= 0 is true, so without it NaN and Infinity would pass.
  amount        numeric NOT NULL CHECK (abs(amount) < 1e15 AND scale(amount) <= 12),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source        text NOT NULL CHECK (source IN ('invoice','provider_api','metered')),
  status        text NOT NULL CHECK (status IN ('final','pending')),
  invoice       jsonb,
  usage         jsonb,
  subscription  jsonb,
  allocations   jsonb,
  attributes    jsonb,
  origin        text NOT NULL,                      -- which writer owns the row, e.g. 'invoice-import'
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- spec §3.6: negative only for credits / discounts / refunds, and those are negative
  CONSTRAINT cost_sign_matches_type CHECK (
    CASE WHEN billing_type IN ('credit','discount','refund') THEN amount <= 0 ELSE amount >= 0 END),
  -- spec §4: model is required for AI items
  CONSTRAINT cost_ai_has_model CHECK (category <> 'ai' OR (model IS NOT NULL AND model <> '')),
  -- service / model / description: absent, or text with something in it
  CONSTRAINT cost_text_not_blank CHECK (
    (service IS NULL OR service ~ '\S') AND (model IS NULL OR model ~ '\S') AND (description IS NULL OR description ~ '\S')),
  -- spec §4: an invoice line names its invoice — and only issued invoices are
  -- entered, so it is final. (A CHECK that evaluates to NULL passes; neither
  -- side here can be NULL.)
  CONSTRAINT cost_invoice_named CHECK (source <> 'invoice' OR (invoice IS NOT NULL AND status = 'final')),
  -- invoice is { id, url? } on every source
  CONSTRAINT cost_invoice_shape CHECK (
    CASE WHEN invoice IS NULL THEN true
         WHEN jsonb_typeof(invoice) <> 'object' THEN false
         ELSE coalesce(jsonb_typeof(invoice->'id') = 'string' AND invoice->>'id' <> ''
                       AND (NOT invoice ? 'url' OR jsonb_typeof(invoice->'url') = 'string')
                       AND (invoice - ARRAY['id', 'url']) = '{}'::jsonb, false) END),
  -- spec §4: a subscription item says what it pays for
  CONSTRAINT cost_subscription_required CHECK (billing_type <> 'subscription' OR subscription IS NOT NULL),
  CONSTRAINT cost_subscription_shape CHECK (public.fn_cost_subscription_ok(subscription)),
  CONSTRAINT cost_usage_shape CHECK (public.fn_cost_usage_ok(usage)),
  CONSTRAINT cost_metered_exact CHECK (source <> 'metered' OR public.fn_cost_metered_exact(usage, amount)),
  CONSTRAINT cost_attributes_flat CHECK (public.fn_cost_attributes_ok(attributes)),
  -- money inside jsonb travels as strings only (attributes may hold numbers: spec §4, never summed)
  CONSTRAINT cost_money_as_strings CHECK (
    NOT jsonb_path_exists(jsonb_build_array(usage, subscription, allocations, invoice), '$.** ? (@.type() == "number")')),
  CONSTRAINT cost_allocations_exact CHECK (public.fn_cost_allocations_exact(allocations, amount))
);

CREATE INDEX IF NOT EXISTS idx_cost_line_items_date ON public.cost_line_items (date);
CREATE INDEX IF NOT EXISTS idx_cost_line_items_invoice ON public.cost_line_items (vendor, (invoice->>'id')) WHERE source = 'invoice';

-- A final figure is the provider's last word: changing it is a deliberate
-- correction (SET LOCAL costing.allow_final_edit = 'on'), never a side effect.
CREATE OR REPLACE FUNCTION public.fn_cost_line_items_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status = 'final'
     AND (NEW.amount::text IS DISTINCT FROM OLD.amount::text OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.date IS DISTINCT FROM OLD.date OR NEW.status IS DISTINCT FROM OLD.status)
     AND current_setting('costing.allow_final_edit', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'cost item % is final; a correction needs SET LOCAL costing.allow_final_edit = on', OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_cost_line_items_guard ON public.cost_line_items;
CREATE TRIGGER trg_cost_line_items_guard BEFORE UPDATE ON public.cost_line_items
  FOR EACH ROW EXECUTE FUNCTION public.fn_cost_line_items_guard();

-- One invoice: its lines (source 'invoice') exist only with a header, are in the
-- header's currency, and add up EXACTLY to its total.
CREATE OR REPLACE FUNCTION public.fn_cost_check_invoice(p_vendor text, p_invoice_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  h_currency text; h_total numeric; h_date date;
  n int; s numeric; wrong_currency int; wrong_date int;
BEGIN
  SELECT currency, total, invoice_date INTO h_currency, h_total, h_date
    FROM public.cost_invoices WHERE vendor = p_vendor AND invoice_id = p_invoice_id;
  SELECT count(*), coalesce(sum(amount), 0),
         count(*) FILTER (WHERE currency IS DISTINCT FROM h_currency),
         count(*) FILTER (WHERE date IS DISTINCT FROM h_date)
    INTO n, s, wrong_currency, wrong_date
    FROM public.cost_line_items
   WHERE vendor = p_vendor AND source = 'invoice' AND invoice->>'id' = p_invoice_id;
  IF h_currency IS NULL THEN
    IF n > 0 THEN
      RAISE EXCEPTION 'invoice %/% has % line(s) but no cost_invoices row (its total is needed)', p_vendor, p_invoice_id, n;
    END IF;
    RETURN;
  END IF;
  IF wrong_currency > 0 THEN
    RAISE EXCEPTION 'invoice %/%: % line(s) are not in %', p_vendor, p_invoice_id, wrong_currency, h_currency;
  END IF;
  IF wrong_date > 0 THEN
    RAISE EXCEPTION 'invoice %/%: % line(s) are not dated the invoice day %', p_vendor, p_invoice_id, wrong_date, h_date;
  END IF;
  IF s <> h_total THEN
    RAISE EXCEPTION 'invoice %/%: lines add up to %, the invoice total is %', p_vendor, p_invoice_id, s, h_total;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cost_invoice_balanced()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'cost_invoices' THEN
    IF TG_OP <> 'DELETE' THEN PERFORM public.fn_cost_check_invoice(NEW.vendor, NEW.invoice_id); END IF;
    IF TG_OP <> 'INSERT' THEN PERFORM public.fn_cost_check_invoice(OLD.vendor, OLD.invoice_id); END IF;
  ELSE
    IF TG_OP <> 'DELETE' AND NEW.source = 'invoice' THEN PERFORM public.fn_cost_check_invoice(NEW.vendor, NEW.invoice->>'id'); END IF;
    IF TG_OP <> 'INSERT' AND OLD.source = 'invoice' THEN PERFORM public.fn_cost_check_invoice(OLD.vendor, OLD.invoice->>'id'); END IF;
  END IF;
  RETURN NULL;
END;
$function$;

-- Deferred to COMMIT, so a header and its lines can be written in one transaction.
DROP TRIGGER IF EXISTS trg_cost_line_items_invoice_balanced ON public.cost_line_items;
CREATE CONSTRAINT TRIGGER trg_cost_line_items_invoice_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.cost_line_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_cost_invoice_balanced();
DROP TRIGGER IF EXISTS trg_cost_invoices_balanced ON public.cost_invoices;
CREATE CONSTRAINT TRIGGER trg_cost_invoices_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.cost_invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_cost_invoice_balanced();

ALTER TABLE public.cost_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_line_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cost_invoices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.cost_line_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_allocations_exact(jsonb, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_usage_ok(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_is_date(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_subscription_ok(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_attributes_ok(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_metered_exact(jsonb, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_line_items_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_check_invoice(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cost_invoice_balanced() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.cost_line_items IS
  'Costing feed line items (ReplyRouter spec v1.0), keyed by the stable item id. Exact amounts only — see migration 121 and GET /api/costing.';
COMMENT ON TABLE public.cost_invoices IS
  'Provider invoices whose lines are in cost_line_items; each invoice''s lines must add up exactly to total (deferred check).';
