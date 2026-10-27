import { createHash, timingSafeEqual } from "node:crypto";

// Costing feed (ReplyRouter "Costing feed — spec for product endpoints v1.0").
// GET /api/costing returns this product's exact costs for a date range from
// the stored cost table (public.cost_line_items, migration 121).
//
// Exactness: every amount is read as numeric::text and summed in SQL, so no
// figure ever becomes a JavaScript number. Decimal strings in usage /
// allocations / subscription are stored as strings (the table checks the shape
// of every jsonb field: no JSON numbers, no nulls) and passed through as-is.
// Before answering, the feed re-adds the items exactly and checks no money
// field is a number — a feed that does not add up is a 500, never a wrong
// answer.

export type Decimal = string;

export interface CostLineItem {
  id: string;
  date: string;
  category: string;
  vendor: string;
  service?: string;
  model?: string;
  description?: string;
  billing_type: "usage" | "subscription" | "one_time" | "tax" | "fee" | "credit" | "discount" | "refund";
  amount: Decimal;
  currency: string;
  source: "invoice" | "provider_api" | "metered";
  status: "final" | "pending";
  invoice?: { id: string; url?: string };
  usage?: Array<{ metric: string; quantity: Decimal; unit?: string; unit_price?: Decimal; price_per?: Decimal }>;
  subscription?: { plan: string; interval: "month" | "year"; seats?: Decimal; service_from: string; service_to: string };
  allocations?: Array<{ dimension: string; key: string; amount: Decimal }>;
  attributes?: Record<string, string | number | boolean>;
}

export interface CostingFeed {
  schema_version: "1.0";
  product: { id: string; name: string; environment?: string };
  period: { from: string; to: string };
  generated_at: string;
  totals: Array<{ currency: string; amount: Decimal }>;
  line_items: CostLineItem[];
  notes?: string;
}

export const PRODUCT = { id: "lead-database", name: "Lead Database" } as const;
export const MAX_RANGE_DAYS = 92;
export const MIN_KEY_LENGTH = 32;

// Shown on ReplyRouter's product card (spec §4 `notes`), so a partial total is
// never read as complete. Update it as each source comes online (CLAUDE.md
// "Costing feed for ReplyRouter").
export const COVERAGE_NOTES =
  "Exact figures only. Invoice lines appear as they are recorded; daily OpenAI usage is not included yet " +
  "(it needs an OpenAI Admin API key). Bills shared with other products are reported only once their owner is decided.";

export class FeedIntegrityError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEC_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;
const DAY_MS = 86_400_000;

/** A real UTC calendar date in YYYY-MM-DD form, as epoch ms; null otherwise. */
function parseDay(s: string): number | null {
  if (!DATE_RE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? t : null;
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * from / to: UTC dates, both inclusive (spec §1). Neither given = month to
 * date. One without the other, either given twice, a malformed or impossible
 * date, from after to, or more than 92 days = 400.
 */
export function parsePeriod(params: URLSearchParams, now: Date): { from: string; to: string } | { error: string } {
  if (params.getAll("from").length > 1 || params.getAll("to").length > 1) return { error: "from and to may each be given once" };
  const rawFrom = params.get("from"), rawTo = params.get("to");
  if (rawFrom == null && rawTo == null) {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return { from: isoDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: isoDay(today) };
  }
  if (rawFrom == null || rawTo == null) return { error: "from and to must be given together (YYYY-MM-DD, UTC, inclusive)" };
  const f = parseDay(rawFrom), t = parseDay(rawTo);
  if (f == null) return { error: `from is not a valid YYYY-MM-DD date: ${JSON.stringify(rawFrom)}` };
  if (t == null) return { error: `to is not a valid YYYY-MM-DD date: ${JSON.stringify(rawTo)}` };
  if (f > t) return { error: "from is after to" };
  const days = Math.round((t - f) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) return { error: `range is ${days} days; the maximum is ${MAX_RANGE_DAYS}` };
  return { from: rawFrom, to: rawTo };
}

/**
 * Bearer COSTING_API_KEY, compared in constant time (sha256 of both, so no
 * length leak). The configured value is trimmed — pasted Railway values often
 * end in a newline. Unset or shorter than 32 characters = not configured,
 * which fails closed.
 */
export function costingKeyStatus(authorization: string | null, configured: string | undefined): "ok" | "unauthorized" | "not_configured" {
  const expected = configured?.trim() ?? "";
  if (expected.length < MIN_KEY_LENGTH) return "not_configured";
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization?.trim() ?? "");
  if (!m) return "unauthorized";
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? "ok" : "unauthorized";
}

/** Anything with pg's query(): a client inside the route's read-only transaction, or a test client. */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

// Unqualified table name on purpose: production resolves it to public, and the
// tests shadow it with a pg_temp table inside a rolled-back transaction.
const ITEMS_SQL = `
  SELECT id, to_char(date, 'YYYY-MM-DD') AS date, category, vendor, service, model, description,
         billing_type, amount::text AS amount, currency, source, status,
         invoice, usage, subscription, allocations, attributes
    FROM cost_line_items
   WHERE date BETWEEN $1::date AND $2::date
   ORDER BY date, id`;
// Exact sum per currency, written with trailing zeros trimmed but at least two
// decimals ("40.0595", "52.20") — the same value, the form ReplyRouter shows.
// round(s, 2) only runs when the trimmed scale is under 2, so it drops nothing.
const TOTALS_SQL = `
  SELECT currency,
         (CASE WHEN scale(trim_scale(s)) < 2 THEN round(s, 2) ELSE trim_scale(s) END)::text AS amount
    FROM (SELECT currency, sum(amount) AS s
            FROM cost_line_items
           WHERE date BETWEEN $1::date AND $2::date
           GROUP BY currency) t
   ORDER BY currency`;

const ITEM_KEYS = [
  "id", "date", "category", "vendor", "service", "model", "description", "billing_type", "amount",
  "currency", "source", "status", "invoice", "usage", "subscription", "allocations", "attributes",
] as const;

/** One stored row as a spec line item: spec key order, absent optional fields omitted (never null). */
function toItem(row: Record<string, unknown>): CostLineItem {
  const out: Record<string, unknown> = {};
  for (const k of ITEM_KEYS) if (row[k] !== null && row[k] !== undefined) out[k] = row[k];
  return out as unknown as CostLineItem;
}

/** Exact decimal string -> BigInt count of 1e-12 units. */
function toUnits(s: string): bigint {
  if (!DEC_RE.test(s)) throw new FeedIntegrityError(`not an exact decimal: ${JSON.stringify(s)}`);
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(i) * BigInt("1000000000000") + BigInt(f.padEnd(12, "0"));
  return neg ? -v : v;
}

/** Backstops for what the table already enforces: money as strings, totals = exact sum of items. */
export function assertFeedIntegrity(feed: CostingFeed): void {
  const notString = (where: string, v: unknown) => {
    if (v !== undefined && typeof v !== "string") throw new FeedIntegrityError(`${where} is not a decimal string`);
  };
  const sums = new Map<string, bigint>();
  for (const it of feed.line_items) {
    notString(`${it.id}.amount`, it.amount);
    for (const u of it.usage ?? []) { notString(`${it.id}.usage.quantity`, u.quantity); notString(`${it.id}.usage.unit_price`, u.unit_price); notString(`${it.id}.usage.price_per`, u.price_per); }
    for (const a of it.allocations ?? []) notString(`${it.id}.allocations.amount`, a.amount);
    notString(`${it.id}.subscription.seats`, it.subscription?.seats);
    sums.set(it.currency, (sums.get(it.currency) ?? BigInt(0)) + toUnits(it.amount));
  }
  if (feed.totals.length !== sums.size) throw new FeedIntegrityError("totals do not list exactly the currencies of the items");
  for (const t of feed.totals) {
    notString(`total ${t.currency}`, t.amount);
    if (sums.get(t.currency) !== toUnits(t.amount)) throw new FeedIntegrityError(`total ${t.currency} ${t.amount} is not the exact sum of its items`);
  }
}

/** Read the feed for a validated period. The caller owns the transaction. */
export async function queryFeed(db: Queryable, period: { from: string; to: string }, now: Date, environment = "production"): Promise<CostingFeed> {
  const items = await db.query(ITEMS_SQL, [period.from, period.to]);
  const totals = await db.query(TOTALS_SQL, [period.from, period.to]);
  const feed: CostingFeed = {
    schema_version: "1.0",
    product: { ...PRODUCT, environment },
    period: { from: period.from, to: period.to },
    generated_at: now.toISOString(),
    totals: totals.rows.map((r) => ({ currency: String(r.currency), amount: String(r.amount) })),
    line_items: items.rows.map(toItem),
    notes: COVERAGE_NOTES,
  };
  assertFeedIntegrity(feed);
  return feed;
}
