// Costing feed tests (migration 121, GET /api/costing, scripts/lib/costing-store.mjs,
// scripts/costing-import.mjs).
//
//   npx tsx --env-file=.env.local scripts/test-costing-feed.mts
//
// Pure checks (dates, key, validation, exact arithmetic, integrity backstop);
// a database pass that runs migration 121 itself — every table, check, function
// and trigger — as pg_temp copies inside ONE transaction that is always rolled
// back (nothing is written); then the route's and the importer's database paths
// against a local fake Postgres (scripts/lib/fake-pg.mjs), including
// connections that never answer, answer slowly or drop mid-query.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { assertFeedIntegrity, costingKeyStatus, parsePeriod, queryFeed, type CostingFeed } from "../src/lib/costing/feed";
import { GET } from "../src/app/api/costing/route";
import { fromUnits, isRealDate, toUnits, upsertInvoices, upsertItems, validateBatch, validateInvoice, validateItem } from "./lib/costing-store.mjs";
import { JSONB, TEXT, startFakePg } from "./lib/fake-pg.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
let failed = 0, passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); }
};
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const DAY_MS = 86_400_000;
const utcDay = (offsetDays: number) => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + offsetDays * DAY_MS).toISOString().slice(0, 10);
};

// ── dates (spec §1) ──────────────────────────────────────────────────────────
const now = new Date("2026-10-09T20:15:00Z");
const P = (q: string) => parsePeriod(new URLSearchParams(q), now);
check("no params = month to date", JSON.stringify(P("")) === JSON.stringify({ from: "2026-10-01", to: "2026-10-09" }), P(""));
check("inclusive range echoes", JSON.stringify(P("from=2026-10-01&to=2026-10-09")) === JSON.stringify({ from: "2026-10-01", to: "2026-10-09" }));
check("one day", "from" in P("from=2026-10-05&to=2026-10-05"));
check("92 days allowed", "from" in P("from=2026-01-01&to=2026-04-02"), P("from=2026-01-01&to=2026-04-02"));
check("93 days refused", "error" in P("from=2026-01-01&to=2026-04-03"));
check("from after to refused", "error" in P("from=2026-10-09&to=2026-10-01"));
check("only from refused", "error" in P("from=2026-10-01"));
check("from given twice refused", "error" in P("from=2026-10-01&from=2026-10-02&to=2026-10-09"));
check("impossible date refused", "error" in P("from=2026-02-29&to=2026-03-01"));
check("leap day accepted", "from" in P("from=2028-02-29&to=2028-03-01"));
check("bad format refused", "error" in P("from=2026-1-01&to=2026-10-09"));
check("year 0050 refused", "error" in P("from=0050-01-01&to=0050-01-02"));
check("month to date on the 1st", JSON.stringify(parsePeriod(new URLSearchParams(""), new Date("2026-11-01T00:00:00Z"))) === JSON.stringify({ from: "2026-11-01", to: "2026-11-01" }));

// ── key (spec §1) ────────────────────────────────────────────────────────────
const K = "k".repeat(20) + "-0123456789abcdef";
check("unset key = not configured", costingKeyStatus(`Bearer ${K}`, undefined) === "not_configured");
check("short key = not configured", costingKeyStatus("Bearer short", "short") === "not_configured");
check("right key accepted", costingKeyStatus(`Bearer ${K}`, K) === "ok");
check("configured key with a trailing newline still matches", costingKeyStatus(`Bearer ${K}`, `${K}\n`) === "ok");
check("case-insensitive scheme", costingKeyStatus(`bearer ${K}`, K) === "ok");
check("wrong key refused", costingKeyStatus(`Bearer ${K.slice(0, -1)}x`, K) === "unauthorized");
check("missing header refused", costingKeyStatus(null, K) === "unauthorized");
check("Basic scheme refused", costingKeyStatus(`Basic ${K}`, K) === "unauthorized");

// ── exact arithmetic ─────────────────────────────────────────────────────────
check("toUnits/fromUnits round trip", fromUnits(toUnits("3.36750000")) === "3.3675" && fromUnits(toUnits("20")) === "20.00" && fromUnits(toUnits("-10.5")) === "-10.50");
check("12 decimals exact", fromUnits(toUnits("0.000000000001") + toUnits("0.000000000002")) === "0.000000000003");
check("0.1 + 0.2 is exactly 0.3", fromUnits(toUnits("0.1") + toUnits("0.2")) === "0.30");
check("13 decimals rejected", throws(() => toUnits("1.0000000000001")));
check("exponent form rejected", throws(() => toUnits("1e-5")));

// ── validation (spec §2–§7) ──────────────────────────────────────────────────
const ai = {
  id: "2026-10-08:openai:gpt-4o-mini:enrichment", date: "2026-10-08", category: "ai", vendor: "openai",
  service: "chat.completions", model: "gpt-4o-mini", description: "Company enrichment summaries", billing_type: "usage",
  amount: "3.36750000", currency: "USD", source: "provider_api", status: "final",
  usage: [
    { metric: "requests", quantity: "5210" },
    { metric: "input_tokens", quantity: "9450000", unit_price: "0.15", price_per: "1000000" },
    { metric: "cached_input_tokens", quantity: "1200000", unit_price: "0.075", price_per: "1000000" },
    { metric: "output_tokens", quantity: "3100000", unit_price: "0.60", price_per: "1000000" },
  ],
  allocations: [
    { dimension: "client", key: "DBSM", amount: "1.20412500" },
    { dimension: "client", key: "CCGEN", amount: "0.84937500" },
    { dimension: "client", key: "unattributed", amount: "1.31400000" },
  ],
};
const sub = {
  id: "vercel:inv_8F2KQ1:pro-plan", date: "2026-10-01", category: "hosting", vendor: "vercel", description: "Vercel Pro plan — October",
  billing_type: "subscription", amount: "20.00", currency: "USD", source: "invoice", status: "final",
  invoice: { id: "inv_8F2KQ1", url: "https://vercel.com/x/invoices/inv_8F2KQ1" },
  subscription: { plan: "Pro", interval: "month", seats: "1", service_from: "2026-10-01", service_to: "2026-10-31" },
};
const metered = {
  id: "2026-10-08:vercel:function-duration", date: "2026-10-08", category: "hosting", vendor: "vercel", service: "functions",
  billing_type: "usage", amount: "1.6920", currency: "USD", source: "provider_api", status: "pending",
  usage: [{ metric: "compute_gb_hours", quantity: "9.4", unit_price: "0.18", price_per: "1" }], attributes: { region: "sin1" },
};
const plan = {
  id: "supabase:inv_00231:pro-plan", date: "2026-10-03", category: "database", vendor: "supabase", billing_type: "subscription",
  amount: "25.00", currency: "USD", source: "invoice", status: "final", invoice: { id: "inv_00231" },
  subscription: { plan: "Pro", interval: "month", service_from: "2026-10-03", service_to: "2026-11-02" },
};
const credit = {
  id: "supabase:inv_00231:credit", date: "2026-10-03", category: "database", vendor: "supabase", billing_type: "credit",
  amount: "-10.00", currency: "USD", source: "invoice", status: "final", invoice: { id: "inv_00231" }, description: "Compute credit",
};
const tax = {
  id: "google-workspace:inv_7781:tax", date: "2026-10-01", category: "email_infrastructure", vendor: "google-workspace",
  billing_type: "tax", amount: "52.20", currency: "INR", source: "invoice", status: "final", invoice: { id: "inv_7781" }, description: "GST 18%",
};
const SPEC_ITEMS = [ai, sub, metered, plan, credit, tax];
const SPEC_INVOICES = [
  { vendor: "vercel", id: "inv_8F2KQ1", date: "2026-10-01", currency: "USD", total: "20.00", url: "https://vercel.com/x/invoices/inv_8F2KQ1" },
  { vendor: "supabase", id: "inv_00231", date: "2026-10-03", currency: "USD", total: "15.00" },
  { vendor: "google-workspace", id: "inv_7781", date: "2026-10-01", currency: "INR", total: "52.20" },
];
check("spec example items are valid", validateBatch(SPEC_ITEMS).length === 0, validateBatch(SPEC_ITEMS));
check("spec example invoices are valid", SPEC_INVOICES.every((i) => validateInvoice(i).length === 0));
const bad = (patch: Record<string, unknown>, base: Record<string, unknown> = metered) => validateItem({ ...base, ...patch }).length > 0;
check("JSON number amount refused", bad({ amount: 1.692 }));
check("13-decimal amount refused", bad({ amount: "1.6920000000001" }));
check("amount at 1e15 refused", bad({ amount: "1000000000000000" }));
check("negative usage refused", bad({ amount: "-1.00" }));
check("positive credit refused", bad({ amount: "10.00" }, credit));
check("ai without model refused", bad({ model: undefined }, ai));
check("invoice source without invoice refused", bad({ invoice: undefined }, plan));
check("pending invoice line refused", bad({ status: "pending" }, plan));
check("subscription without details refused", bad({ subscription: undefined }, plan));
check("unknown field refused", bad({ amount_usd: "1" }));
check("bad currency refused", bad({ currency: "usd" }));
check("impossible date refused", bad({ date: "2026-02-30" }));
check("allocations off by 1e-12 refused", bad({ allocations: [{ dimension: "client", key: "A", amount: "3.367499999999" }] }, { ...ai, allocations: undefined }));
check("duplicate allocation key refused", bad({ allocations: [{ dimension: "client", key: "A", amount: "1.6920" }, { dimension: "client", key: "A", amount: "0" }] }));
check("quantity as number refused", bad({ usage: [{ metric: "compute_gb_hours", quantity: 9.4, unit_price: "0.18", price_per: "1" }] }));
// An explicit null nested in invoice / usage / subscription would be stored and
// served as null (or fail the feed's own check): it is a wrong type, not "absent".
check("null invoice.url refused", bad({ invoice: { id: "inv_8F2KQ1", url: null } }, sub));
check("null usage unit refused", bad({ usage: [{ metric: "compute_gb_hours", quantity: "9.4", unit: null, unit_price: "0.18", price_per: "1" }] }));
check("null unit_price and price_per refused", bad({ usage: [{ metric: "requests", quantity: "5210", unit_price: null, price_per: null }] }));
check("null subscription.seats refused", bad({ subscription: { ...sub.subscription, seats: null } }, sub));
check("top-level null optional fields still mean absent", validateItem({ ...plan, service: null, description: null }).length === 0);
// RegExp.test() coerces: a number must not pass a string rule.
check("numeric id refused", bad({ id: 123 }));
check("numeric ids are no silent duplicate", validateBatch([{ ...metered, id: 123 }, { ...metered, id: "123" }]).length > 0);
check("numeric vendor refused", bad({ vendor: 5 }));
check("array currency refused", bad({ currency: ["USD"] }));
check("numeric usage metric refused", bad({ usage: [{ metric: 7, quantity: "1" }] }));
check("infinite attribute refused", bad({ attributes: { gb: Infinity } }));
check("numeric invoice vendor refused", validateInvoice({ vendor: 5, id: "1", date: "2026-10-01", currency: "USD", total: "1.00" }).length > 0);
const m = { ...metered, source: "metered" };
check("exact metered accepted", validateItem(m).length === 0, validateItem(m));
check("metered off by 1e-12 refused", bad({ amount: "1.692000000001" }, m));
check("metered without prices refused", bad({ usage: [{ metric: "invocations", quantity: "10" }] }, m));
// 9.45M × 0.15/1M + 1.2M × 0.075/1M + 3.1M × 0.60/1M = 1.4175 + 0.09 + 1.86 = 3.3675
check("metered AI tokens exact", validateItem({ ...ai, source: "metered", amount: "3.3675", allocations: undefined }).length === 0);
check("duplicate ids in a batch refused", validateBatch([metered, metered]).length > 0);
check("invoice without date refused", validateInvoice({ vendor: "x", id: "1", currency: "USD", total: "1.00" }).length > 0);
check("invoice total as number refused", validateInvoice({ vendor: "x", id: "1", date: "2026-10-01", currency: "USD", total: 1 }).length > 0);

// ── integrity backstop (feed.ts) ─────────────────────────────────────────────
const baseFeed = (): CostingFeed => ({
  schema_version: "1.0", product: { id: "lead-database", name: "Lead Database" }, period: { from: "2026-10-01", to: "2026-10-09" },
  generated_at: now.toISOString(), totals: [{ currency: "USD", amount: "21.6920" }], line_items: [sub as never, metered as never],
});
check("integrity passes on an exact feed", !throws(() => assertFeedIntegrity(baseFeed())));
check("integrity refuses a total that is off", throws(() => assertFeedIntegrity({ ...baseFeed(), totals: [{ currency: "USD", amount: "21.69" }] })));
check("integrity refuses a missing currency", throws(() => assertFeedIntegrity({ ...baseFeed(), totals: [] })));
check("integrity refuses a money number", throws(() => assertFeedIntegrity({ ...baseFeed(), line_items: [{ ...(sub as object), amount: 20 } as never, metered as never] })));

// ── route: key and range errors (these return before any database work) ────
const call = (q: string, auth?: string) => GET(new NextRequest(`http://localhost/api/costing${q}`, { headers: auth ? { authorization: auth } : {} }));
delete process.env.COSTING_API_KEY;
const logError = console.error;
console.error = () => {}; // the route logs the missing key; expected here
const r500 = await call("?from=2026-10-01&to=2026-10-09", `Bearer ${K}`);
console.error = logError;
check("route 500 when the server key is unset", r500.status === 500 && /not configured/.test((await r500.json()).error));
process.env.COSTING_API_KEY = K;
const r401 = await call("?from=2026-10-01&to=2026-10-09");
check("route 401 without key", r401.status === 401 && r401.headers.get("www-authenticate") === "Bearer");
check("route 401 wrong key", (await call("?from=2026-10-01&to=2026-10-09", "Bearer nope")).status === 401);
const r400 = await call("?from=2026-01-01&to=2026-06-01", `Bearer ${K}`);
check("route 400 over 92 days", r400.status === 400 && typeof (await r400.json()).error === "string");
check("route 400 bad date", (await call("?from=2026-13-01&to=2026-12-01", `Bearer ${K}`)).status === 400);
check("route 400 repeated param", (await call("?from=2026-10-01&to=2026-10-02&to=2026-10-03", `Bearer ${K}`)).status === 400);

// Raw rows for the database's own refusals (inserts that bypass the validator).
// Each breaks ONE rule and names the constraint that must refuse it; the
// validator must refuse the same row too, so the two layers cannot drift apart.
type Row = Record<string, unknown>;
const RAW: Row = { date: "2026-10-01", category: "hosting", vendor: "x", billing_type: "usage", amount: "1", currency: "USD", source: "provider_api", status: "final" };
const SUB_OK = { plan: "Pro", interval: "month", service_from: "2026-10-01", service_to: "2026-10-31" };
const SUB = (patch: Row): Row => ({ billing_type: "subscription", subscription: { ...SUB_OK, ...patch } });
const ALLOC = (...a: Row[]): Row => ({ allocations: a });
const REFUSED: Array<[string, Row, RegExp]> = [
  ["13 decimals", { amount: "1.0000000000001" }, /cost_line_items_amount_check/],
  ["NaN", { amount: "NaN" }, /cost_line_items_amount_check/],
  ["Infinity", { amount: "Infinity" }, /cost_line_items_amount_check/],
  ["-Infinity credit", { billing_type: "credit", amount: "-Infinity" }, /cost_line_items_amount_check/],
  ["amount at 1e15", { amount: "1000000000000000" }, /cost_line_items_amount_check/],
  ["negative usage", { amount: "-1" }, /cost_sign_matches_type/],
  ["positive credit", { billing_type: "credit", amount: "1" }, /cost_sign_matches_type/],
  ["ai without model", { category: "ai" }, /cost_ai_has_model/],
  ["ai with an empty model", { category: "ai", model: "" }, /cost_ai_has_model/],
  ["invoice source without invoice", { source: "invoice" }, /cost_invoice_named/],
  ["pending invoice line", { source: "invoice", status: "pending", invoice: { id: "Q" } }, /cost_invoice_named/],
  ["invoice without an id", { invoice: { url: "x" } }, /cost_invoice_shape/],
  ["invoice with an empty id", { invoice: { id: "" } }, /cost_invoice_shape/],
  ["invoice that is a bare string", { invoice: "INV-1" }, /cost_invoice_shape/],
  ["invoice url null", { invoice: { id: "Q", url: null } }, /cost_invoice_shape/],
  ["invoice with an extra field", { invoice: { id: "Q", note: "x" } }, /cost_invoice_shape/],
  ["invoice id as a number", { invoice: { id: 5 } }, /cost_invoice_shape|cost_money_as_strings/],
  ["subscription item without subscription", { billing_type: "subscription" }, /cost_subscription_required/],
  ["weekly subscription", SUB({ interval: "week" }), /cost_subscription_shape/],
  ["subscription seats null", SUB({ seats: null }), /cost_subscription_shape/],
  ["subscription seats as a number", SUB({ seats: 2 }), /cost_money_as_strings|cost_subscription_shape/],
  ["subscription without a plan", SUB({ plan: undefined }), /cost_subscription_shape/],
  ["subscription period reversed", SUB({ service_from: "2026-10-31", service_to: "2026-10-01" }), /cost_subscription_shape/],
  ["subscription month 13", SUB({ service_to: "2026-13-01" }), /cost_subscription_shape/],
  ["subscription ending on 31 April", SUB({ service_to: "2026-04-31" }), /cost_subscription_shape/],
  ["subscription from 29 February of a common year", SUB({ service_from: "2026-02-29" }), /cost_subscription_shape/],
  ["subscription from year 0000", SUB({ service_from: "0000-01-01" }), /cost_subscription_shape/],
  ["subscription seats in words", SUB({ seats: "two" }), /cost_subscription_shape/],
  ["subscription with an extra field", SUB({ price: "20" }), /cost_subscription_shape/],
  ["subscription that is an array", { subscription: [] }, /cost_subscription_shape/],
  ["usage that is not an array", { usage: {} }, /cost_usage_shape/],
  ["a number inside usage", { usage: [{ metric: "x", quantity: 9.4 }] }, /cost_money_as_strings|cost_usage_shape/],
  ["usage quantity in exponent form", { usage: [{ metric: "x", quantity: "1e5" }] }, /cost_usage_shape/],
  ["negative usage quantity", { usage: [{ metric: "x", quantity: "-1" }] }, /cost_usage_shape/],
  ["a null usage element", { usage: [null] }, /cost_usage_shape/],
  ["an array usage element", { usage: [["x"]] }, /cost_usage_shape/],
  ["usage unit null", { usage: [{ metric: "x", quantity: "1", unit: null }] }, /cost_usage_shape/],
  ["usage price without price_per", { usage: [{ metric: "x", quantity: "1", unit_price: "0.1" }] }, /cost_usage_shape/],
  ["usage price_per of zero", { usage: [{ metric: "x", quantity: "1", unit_price: "0.1", price_per: "0.00" }] }, /cost_usage_shape/],
  ["usage with an extra field", { usage: [{ metric: "x", quantity: "1", cost: "2" }] }, /cost_usage_shape/],
  ["usage metric not snake_case", { usage: [{ metric: "Requests", quantity: "1" }] }, /cost_usage_shape/],
  ["usage unit_price in exponent form", { usage: [{ metric: "x", quantity: "1", unit_price: "1e-6", price_per: "1" }] }, /cost_usage_shape/],
  ["negative usage unit_price", { usage: [{ metric: "x", quantity: "1", unit_price: "-0.1", price_per: "1" }] }, /cost_usage_shape/],
  ["usage price_per in words", { usage: [{ metric: "x", quantity: "1", unit_price: "0.1", price_per: "one" }] }, /cost_usage_shape/],
  ["usage unit_price as a number", { usage: [{ metric: "x", quantity: "1", unit_price: 0.18, price_per: "1" }] }, /cost_money_as_strings|cost_usage_shape/],
  ["usage price_per as a number", { usage: [{ metric: "x", quantity: "1", unit_price: "0.18", price_per: 1 }] }, /cost_money_as_strings|cost_usage_shape/],
  ["metered without usage", { source: "metered" }, /cost_metered_exact/],
  ["metered with unpriced usage only", { source: "metered", usage: [{ metric: "x", quantity: "1" }] }, /cost_metered_exact/],
  ["metered amount that is not its usage", { source: "metered", amount: "2.00",
    usage: [{ metric: "input_tokens", quantity: "1000000", unit_price: "0.15", price_per: "1000000" }] }, /cost_metered_exact/],
  ["metered amount off by 1e-12", { source: "metered", amount: "0.150000000001",
    usage: [{ metric: "input_tokens", quantity: "1000000", unit_price: "0.15", price_per: "1000000" }] }, /cost_metered_exact/],
  ["allocations that are not an array", { allocations: {} }, /cost_allocations_exact/],
  ["allocations that do not add up", ALLOC({ dimension: "client", key: "A", amount: "0.5" }), /cost_allocations_exact/],
  ["allocations off by 1e-12 on a second dimension",
    ALLOC({ dimension: "client", key: "A", amount: "1" }, { dimension: "feature", key: "f", amount: "0.999999999999" }), /cost_allocations_exact/],
  ["allocation amount as a number", ALLOC({ dimension: "client", key: "A", amount: 1 }), /cost_allocations_exact|cost_money_as_strings/],
  ["allocation with an extra field", ALLOC({ dimension: "client", key: "A", amount: "1", note: "x" }), /cost_allocations_exact/],
  ["allocation key twice",
    ALLOC({ dimension: "client", key: "A", amount: "0.5" }, { dimension: "client", key: "A", amount: "0.5" }), /cost_allocations_exact/],
  ["allocation dimension not lowercase", ALLOC({ dimension: "Client", key: "A", amount: "1" }), /cost_allocations_exact/],
  ["allocation with an empty key", ALLOC({ dimension: "client", key: "", amount: "1" }), /cost_allocations_exact/],
  ["a null allocation element", { allocations: [null] }, /cost_allocations_exact/],
  ["allocation amount in words", ALLOC({ dimension: "client", key: "A", amount: "abc" }), /cost_allocations_exact/],
  ["allocation amount in exponent form", ALLOC({ dimension: "client", key: "A", amount: "1e0" }), /cost_allocations_exact/],
  ["allocation dimension as a number", ALLOC({ dimension: 5, key: "A", amount: "1" }), /cost_allocations_exact/],
  ["ai with a blank model", { category: "ai", model: "   " }, /cost_text_not_blank/],
  ["an empty service", { service: "" }, /cost_text_not_blank/],
  ["a blank description", { description: " \t" }, /cost_text_not_blank/],
  ["nested attribute", { attributes: { a: { b: "c" } } }, /cost_attributes_flat/],
  ["array attribute", { attributes: { a: ["x"] } }, /cost_attributes_flat/],
  ["null attribute", { attributes: { a: null } }, /cost_attributes_flat/],
  ["huge number attribute", { attributes: { a: 1e300 } }, /cost_attributes_flat/],
  ["attributes that are not an object", { attributes: [] }, /cost_attributes_flat/],
  ["bad currency", { currency: "usd" }, /cost_line_items_currency_check/],
  ["bad billing type", { billing_type: "rent" }, /cost_line_items_billing_type_check/],
  ["id with a space", { id: "has space" }, /cost_line_items_id_check/],
  ["vendor not a slug", { vendor: "Bad Vendor" }, /cost_line_items_vendor_check/],
  ["category not snake_case", { category: "lead-lists" }, /cost_line_items_category_check/],
  ["bad source", { source: "estimate" }, /cost_line_items_source_check/],
  ["bad status", { status: "draft" }, /cost_line_items_status_check/],
];
const ACCEPTED: Array<[string, Row]> = [
  ["the plain raw row", {}],
  ["a raw row using every jsonb field", {
    billing_type: "subscription", amount: "20.00",
    invoice: { id: "Q-1", url: "https://example.com/q-1" },
    usage: [{ metric: "seats", quantity: "2", unit: "seat", unit_price: "10", price_per: "1" }, { metric: "requests", quantity: "5" }],
    subscription: { ...SUB_OK, seats: "2" },
    allocations: [{ dimension: "client", key: "A", amount: "12.5" }, { dimension: "client", key: "unattributed", amount: "7.50" },
      { dimension: "feature", key: "f", amount: "20" }],
    attributes: { region: "sin1", replicas: 2, spot: true },
  }],
  ["a subscription ending on a leap day", SUB({ service_to: "2028-02-29" })],
  ["an exact metered row (unpriced usage is not counted)", { source: "metered", amount: "0.15",
    usage: [{ metric: "input_tokens", quantity: "1000000", unit_price: "0.15", price_per: "1000000" }, { metric: "requests", quantity: "3" }] }],
  ["a metered row whose thirds add up", { source: "metered", amount: "1",
    usage: [{ metric: "a", quantity: "1", unit_price: "1", price_per: "3" }, { metric: "b", quantity: "2", unit_price: "1", price_per: "3" }] }],
];
// The JSON round trip drops undefined keys (SUB({ plan: undefined }) has no plan).
const rawCases = new Map<string, Row>([...REFUSED.map(([n, p]): [string, Row] => [n, p]), ...ACCEPTED].map(([n, p], i): [string, Row] =>
  [n, JSON.parse(JSON.stringify({ id: `raw-${i}`, ...RAW, ...p }))]));

// ── database pass: migration 121 itself as pg_temp copies, rolled back ─────
const migration = readFileSync(new URL("../supabase/migrations/121_costing_feed.sql", import.meta.url), "utf8");
const tempDdl = migration
  .replaceAll("CREATE OR REPLACE FUNCTION public.", "CREATE FUNCTION pg_temp.")
  .replaceAll("CREATE TABLE IF NOT EXISTS public.", "CREATE TEMP TABLE ")
  .replaceAll("public.fn_cost_", "pg_temp.fn_cost_")
  .replaceAll("public.cost_", "pg_temp.cost_");
check("test DDL touches nothing in public", !/\bpublic\./.test(tempDdl.replace(/--.*$/gm, "")), tempDdl.match(/.{0,40}\bpublic\..{0,40}/)?.[0]);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
const isStringly = (feed: CostingFeed) => {
  const out: string[] = [];
  for (const it of feed.line_items) for (const v of Object.values(it)) if (v === null) out.push(`${it.id} has a null field`);
  try { assertFeedIntegrity(feed); } catch (e) { out.push(String(e)); }
  return out;
};
const sp = async (fn: () => Promise<unknown>): Promise<string> => {
  await c.query("SAVEPOINT s");
  try { await fn(); await c.query("SET CONSTRAINTS ALL IMMEDIATE"); await c.query("RELEASE SAVEPOINT s"); return ""; }
  catch (e) { await c.query("ROLLBACK TO SAVEPOINT s"); return String((e as Error).message ?? e); }
  finally { await c.query("SET CONSTRAINTS ALL DEFERRED"); }
};
try {
  await c.query("BEGIN");
  await c.query("SET LOCAL statement_timeout = '30s'");
  await c.query(tempDdl);
  const shadow = (await c.query("SELECT 'cost_line_items'::regclass::oid = 'pg_temp.cost_line_items'::regclass::oid AS a, 'cost_invoices'::regclass::oid = 'pg_temp.cost_invoices'::regclass::oid AS b")).rows[0];
  check("tests read the temp tables, not public", shadow.a === true && shadow.b === true);

  // Locked away from PostgREST: RLS on, and no fn_cost_* function callable by
  // anon / authenticated (a new function gets EXECUTE for PUBLIC unless revoked).
  // Temp tables never get the public schema's default grants, so the table
  // REVOKEs are checked in the migration text.
  const rls = (await c.query("SELECT relname, relrowsecurity FROM pg_class WHERE oid IN ('pg_temp.cost_line_items'::regclass, 'pg_temp.cost_invoices'::regclass)")).rows;
  check("row level security is on for both tables", rls.length === 2 && rls.every((r) => r.relrowsecurity === true), rls);
  const fns = (await c.query(`SELECT p.oid::regprocedure::text AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                                     has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
                                FROM pg_proc p WHERE p.pronamespace = pg_my_temp_schema() AND p.proname LIKE 'fn\\_cost\\_%'`)).rows;
  check("every fn_cost_* function is revoked from anon and authenticated",
    fns.length === (migration.match(/CREATE OR REPLACE FUNCTION public\.fn_cost_/g) ?? []).length && fns.every((r) => !r.anon && !r.auth), fns);
  for (const t of ["cost_invoices", "cost_line_items"]) {
    check(`migration revokes ${t} from PUBLIC, anon and authenticated`, migration.includes(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`));
  }

  // The table's date rule and the writer's isRealDate agree on every string in
  // a grid of years (incl. leap rules), months 00-13 and days 00-32.
  const grid = ["1900", "2000", "2024", "2026", "2028", "2100", "2400"].flatMap((y) =>
    Array.from({ length: 14 }, (_, mm) => Array.from({ length: 33 }, (_, dd) => `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`)).flat());
  const dbDates = (await c.query("SELECT d, pg_temp.fn_cost_is_date(d) AS ok FROM unnest($1::text[]) AS d", [grid])).rows;
  const dateDiff = dbDates.filter((r) => r.ok !== isRealDate(r.d)).map((r) => r.d);
  check(`the table's date rule agrees with the writer's on ${grid.length} dates`, dbDates.length === grid.length && dateDiff.length === 0, dateDiff.slice(0, 10));

  const e1 = await sp(async () => { await upsertInvoices(c, SPEC_INVOICES); const w = await upsertItems(c, SPEC_ITEMS, "test-writer"); check("first write inserts all", w.inserted === SPEC_ITEMS.length, w); });
  check("spec example passes every database check", e1 === "", e1);
  const w2 = await upsertItems(c, SPEC_ITEMS, "test-writer");
  check("same items again change nothing", w2.unchanged === SPEC_ITEMS.length, w2);
  check("same invoices again change nothing", (await upsertInvoices(c, SPEC_INVOICES)) === 0);
  const w3 = await upsertItems(c, [{ ...metered, amount: "1.6921", usage: [{ metric: "compute_gb_hours", quantity: "9.4", unit_price: "0.18", price_per: "1" }] }], "test-writer");
  check("a revised pending figure updates one row", w3.updated === 1, w3);
  await upsertItems(c, [metered], "test-writer");
  let otherErr = ""; try { await upsertItems(c, [metered], "another-writer"); } catch (e) { otherErr = String(e); }
  check("another writer cannot overwrite the row", /another writer/.test(otherErr), otherErr);

  const feed = await queryFeed(c, { from: "2026-10-01", to: "2026-10-09" }, now);
  check("totals exact per currency", JSON.stringify(feed.totals) === JSON.stringify([{ currency: "INR", amount: "52.20" }, { currency: "USD", amount: "40.0595" }]), feed.totals);
  check("all items returned", feed.line_items.length === SPEC_ITEMS.length, feed.line_items.length);
  check("amount kept exactly as given", feed.line_items.find((i) => i.id === ai.id)?.amount === "3.36750000");
  check("no money as a JSON number, no nulls, totals reconcile", isStringly(feed).length === 0, isStringly(feed));
  check("ordered by date then id", feed.line_items.map((i) => `${i.date} ${i.id}`).join("|") === [...feed.line_items].map((i) => `${i.date} ${i.id}`).sort().join("|"));
  check("optional fields omitted", !("model" in (feed.line_items.find((i) => i.id === plan.id) ?? {})));
  check("envelope", feed.schema_version === "1.0" && feed.product.id === "lead-database" && feed.period.from === "2026-10-01" && feed.generated_at === now.toISOString() && typeof feed.notes === "string");
  const again = await queryFeed(c, { from: "2026-10-01", to: "2026-10-09" }, new Date());
  check("same range, same answer", JSON.stringify({ ...again, generated_at: "" }) === JSON.stringify({ ...feed, generated_at: "" }));
  const empty = await queryFeed(c, { from: "2026-09-01", to: "2026-09-30" }, now);
  check("empty range: empty arrays", empty.line_items.length === 0 && empty.totals.length === 0);
  const edge = await queryFeed(c, { from: "2026-10-03", to: "2026-10-03" }, now);
  check("both ends inclusive", edge.line_items.map((i) => i.id).sort().join(",") === [plan.id, credit.id].sort().join(","), edge.line_items.map((i) => i.id));
  check("one-day totals", JSON.stringify(edge.totals) === JSON.stringify([{ currency: "USD", amount: "15.00" }]), edge.totals);
  check("JSON has no float amounts", !/"amount":\s*-?\d/.test(JSON.stringify(feed)));

  // A final figure changes only as a deliberate correction.
  const g1 = await sp(() => c.query(`UPDATE cost_line_items SET amount = 3.3676 WHERE id = $1`, [ai.id]));
  check("final row refuses a new amount", /is final/.test(g1), g1);
  const g2 = await sp(async () => { await c.query("SET LOCAL costing.allow_final_edit = 'on'"); await c.query(`UPDATE cost_line_items SET amount = 3.3676, allocations = NULL WHERE id = $1`, [ai.id]); await c.query("SET LOCAL costing.allow_final_edit = 'off'"); });
  check("final row accepts a flagged correction", g2 === "", g2);

  // Invoices: header needed, same currency and date, exact total — checked at commit (deferred).
  const inv = { vendor: "railway", id: "INV-T1", date: "2026-10-05", currency: "USD", total: "5.27" };
  const line = (id: string, amount: string, extra: Record<string, unknown> = {}) => ({ id: `railway:INV-T1:${id}`, date: "2026-10-05", category: "hosting", vendor: "railway",
    billing_type: "usage", amount, currency: "USD", source: "invoice", status: "final", invoice: { id: "INV-T1" }, ...extra });
  check("lines without a header refused", /no cost_invoices row/.test(await sp(() => upsertItems(c, [line("vcpu", "5.27")], "test-writer"))));
  check("lines that do not add up refused", /add up to/.test(await sp(async () => { await upsertInvoices(c, [inv]); await upsertItems(c, [line("vcpu", "3.00"), line("memory", "2.26")], "test-writer"); })));
  check("a line not on the invoice day refused", /not dated the invoice day/.test(await sp(async () => { await upsertInvoices(c, [inv]); await upsertItems(c, [line("vcpu", "5.27", { date: "2026-10-06" })], "test-writer"); })));
  check("a line in another currency refused", /are not in USD/.test(await sp(async () => { await upsertInvoices(c, [inv]); await upsertItems(c, [line("vcpu", "5.27", { currency: "EUR" })], "test-writer"); })));
  check("a balanced invoice is accepted", (await sp(async () => {
    await upsertInvoices(c, [inv]);
    await upsertItems(c, [line("vcpu", "3.00"), line("memory", "7.27"), line("included", "-5.00", { billing_type: "discount" })], "test-writer");
  })) === "");
  check("changing the total alone is refused", /add up to/.test(await sp(() => c.query(`UPDATE cost_invoices SET total = 5.28 WHERE vendor = 'railway' AND invoice_id = 'INV-T1'`))));
  check("deleting a header with lines is refused", /no cost_invoices row/.test(await sp(() => c.query(`DELETE FROM cost_invoices WHERE vendor = 'railway' AND invoice_id = 'INV-T1'`))));

  // Every raw case in one round trip: each insert runs in its own subtransaction
  // and is always undone (an accepted row raises 'accepted' to roll itself back).
  await c.query(`CREATE FUNCTION pg_temp.try_row(p jsonb) RETURNS text LANGUAGE plpgsql AS $f$
    DECLARE cols text;
    BEGIN
      SELECT string_agg(quote_ident(k), ', ') INTO cols FROM jsonb_object_keys(p) AS k;
      EXECUTE format('INSERT INTO pg_temp.cost_line_items (%s, origin) SELECT %s, ''t'' FROM jsonb_populate_record(NULL::pg_temp.cost_line_items, $1)', cols, cols) USING p;
      RAISE EXCEPTION 'accepted';
    EXCEPTION WHEN OTHERS THEN
      RETURN SQLERRM;
    END $f$`);
  const { rows: tried } = await c.query("SELECT key, pg_temp.try_row(value) AS result FROM jsonb_each($1::jsonb)", [JSON.stringify(Object.fromEntries(rawCases))]);
  const outcome = new Map(tried.map((r): [string, string] => [String(r.key), String(r.result)]));
  check("every raw case ran", outcome.size === rawCases.size, `${outcome.size} of ${rawCases.size}`);
  for (const [name, , constraint] of REFUSED) {
    const got = outcome.get(name) ?? "(not run)";
    check(`database refuses: ${name}`, constraint.test(got), got);
    check(`validator refuses: ${name}`, validateItem(rawCases.get(name)!).length > 0);
  }
  for (const [name] of ACCEPTED) {
    check(`database accepts ${name}`, outcome.get(name) === "accepted", outcome.get(name));
    const problems = validateItem(rawCases.get(name)!);
    check(`validator accepts ${name}`, problems.length === 0, problems);
  }
  const nanTotal = await sp(() => c.query(`INSERT INTO cost_invoices (vendor, invoice_id, invoice_date, currency, total) VALUES ('x','N','2026-10-01','USD','NaN')`));
  check("database refuses: NaN invoice total", /cost_invoices_total_check/.test(nanTotal), nanTotal || "insert succeeded");
} finally {
  await c.query("ROLLBACK").catch(() => {});
  c.release();
  await pool.end();
}

// ── route + importer database paths, against a fake Postgres ───────────────
// From here DATABASE_URL points at the fake; the route's pool is built on its
// first database use, which is this section's first call.
const seen: string[] = [];
let answer: (sql: string) => unknown = () => undefined;
const fake = await startFakePg((sql: string) => { seen.push(sql); return answer(sql); });
const FAKE_URL = `postgres://u:p@127.0.0.1:${fake.port}/db?sslmode=disable`;
process.env.DATABASE_URL = FAKE_URL;
console.error = () => {}; // every failure below is logged by the route on purpose
try {
  const ITEM_COLS = ["id", "date", "category", "vendor", "service", "model", "description", "billing_type", "amount", "currency",
    "source", "status", "invoice", "usage", "subscription", "allocations", "attributes"]
    .map((n) => [n, ["invoice", "usage", "subscription", "allocations", "attributes"].includes(n) ? JSONB : TEXT]);
  const ITEM_ROW = [sub.id, sub.date, sub.category, sub.vendor, null, null, sub.description, sub.billing_type, sub.amount, sub.currency,
    sub.source, sub.status, JSON.stringify(sub.invoice), null, JSON.stringify(sub.subscription), null, null];
  const feedRows = (total: string) => (sql: string) =>
    /FROM \(SELECT currency/.test(sql) ? { rows: { cols: [["currency", TEXT], ["amount", TEXT]], rows: [["USD", total]] } }
    : /FROM cost_line_items/.test(sql) ? { rows: { cols: ITEM_COLS, rows: [ITEM_ROW] } } : undefined;
  const Q = "?from=2026-10-01&to=2026-10-09";

  answer = feedRows("20.00");
  seen.length = 0;
  const ok = await call(Q, `Bearer ${K}`);
  const okBody = await ok.json();
  check("route 200 through its own pool", ok.status === 200 && ok.headers.get("content-type") === "application/json; charset=utf-8"
    && ok.headers.get("cache-control") === "no-store", ok.status);
  check("route body is the stored item, exactly", okBody.totals?.[0]?.amount === "20.00" && okBody.line_items?.[0]?.amount === "20.00"
    && okBody.line_items[0].subscription?.seats === "1" && !("service" in okBody.line_items[0]) && okBody.product?.environment === "production", okBody);
  check("route reads in one read-only transaction with SET LOCAL only",
    /^BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ$/.test(seen[0] ?? "") && /^SET LOCAL statement_timeout/.test(seen[1] ?? "")
    && seen.at(-1) === "COMMIT" && !seen.some((s) => /^SET (?!LOCAL)/i.test(s.trim())), seen);

  answer = feedRows("21.00");
  const r1 = await call(Q, `Bearer ${K}`);
  check("route 500 when its totals would not add up", r1.status === 500 && /failed its own check/.test((await r1.json()).error));
  answer = (sql) => (/FROM cost_line_items/.test(sql) ? { error: ["42P01", 'relation "cost_line_items" does not exist'] } : undefined);
  seen.length = 0;
  const r2 = await call(Q, `Bearer ${K}`);
  check("route 500 when the table is missing, and rolls back", r2.status === 500 && (await r2.json()).error === "costing feed failed" && seen.at(-1) === "ROLLBACK", seen.at(-1));
  answer = (sql) => (/FROM cost_line_items/.test(sql) ? { error: ["57014", "canceling statement due to statement timeout"] } : undefined);
  const r3 = await call(Q, `Bearer ${K}`);
  check("route 500 'timed out' on statement_timeout", r3.status === 500 && (await r3.json()).error === "costing feed timed out");

  // A call that may never settle is raced against 15 s, so a lost deadline is a
  // FAIL line rather than a suite that hangs.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const timed = async (label: string) => {
    const t = Date.now();
    const res = await Promise.race([call(Q, `Bearer ${K}`), sleep(15_000).then(() => null)]);
    const body = res ? await res.json() : null;
    return { status: res?.status, error: body?.error as string | undefined, ms: Date.now() - t, label };
  };
  const hangItems = (sql: string) => (/FROM cost_line_items/.test(sql) ? "hang" : undefined);

  answer = hangItems;
  const r4 = await timed("silent query");
  check("route gives up on a connection that never answers (~9 s)", r4.status === 500 && r4.error === "costing feed timed out"
    && r4.ms >= 8_500 && r4.ms < 10_500, r4);
  answer = feedRows("20.00");
  check("route works again after the deadline", (await call(Q, `Bearer ${K}`)).status === 200);
  await sleep(100);
  // Calls so far were one at a time: one live connection. Two would mean the
  // silent one was handed back to the pool instead of being closed.
  check("the silent connection was closed, not kept", fake.connections() === 1, fake.connections());

  // The server drops the connection mid-query: a 500, and nothing uncaught (a
  // checked-out pg client with no 'error' listener throws).
  const uncaught: string[] = [];
  const onUncaught = (e: unknown) => { uncaught.push(String(e)); };
  process.on("uncaughtException", onUncaught);
  answer = (sql) => (/FROM cost_line_items/.test(sql) ? "drop" : undefined);
  const r5 = await call(Q, `Bearer ${K}`);
  const r5Body = await r5.json();
  await sleep(100);
  process.off("uncaughtException", onUncaught);
  check("route 500 when the server drops the connection, nothing uncaught", r5.status === 500 && r5Body.error === "costing feed failed"
    && uncaught.length === 0, { status: r5.status, error: r5Body.error, uncaught });

  // The deadline counts from the request: a connection that takes 4 s to open
  // leaves 5 s for the queries, not 9.
  fake.drop(); await sleep(100); // the pool must open a new connection
  fake.startupDelay(4_000);
  answer = hangItems;
  const r6 = await timed("slow connect");
  check("the 9 s deadline includes a slow connect", r6.status === 500 && r6.error === "costing feed timed out" && r6.ms >= 8_500 && r6.ms < 10_500, r6);

  // A connection that never answers its startup: the pool's 5 s connect timeout.
  fake.drop(); await sleep(100);
  fake.startupDelay(Infinity);
  const r7 = await timed("no startup answer");
  check("route 500 'database unavailable' when no connection answers (~5 s)", r7.status === 500 && r7.error === "database unavailable"
    && r7.ms >= 4_500 && r7.ms < 7_000, r7);
  fake.startupDelay(0);
  answer = feedRows("20.00");
  check("route works again once connections answer", (await call(Q, `Bearer ${K}`)).status === 200);

  // The importer (a separate process) against the same fake; `seen` holds every
  // statement of the latest run. Invoice files are written outside the repo.
  answer = () => undefined;
  const runImport = (file: string, flags: string[] = [], env: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((resolve) => {
    seen.length = 0;
    const p = spawn(process.execPath, ["scripts/costing-import.mjs", file, ...flags], { cwd: REPO, env: { ...process.env, DATABASE_URL: FAKE_URL, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
  const dir = mkdtempSync(join(tmpdir(), "costing-import-test-"));
  const invLine = (name: string, part: string, date: string, amount: string, extra: Row = {}): Row => ({ id: `railway:INV-${name}:${part}`,
    date, category: "hosting", vendor: "railway", billing_type: "usage", amount, currency: "USD", source: "invoice", status: "final",
    invoice: { id: `INV-${name}` }, ...extra });
  const fileWith = (name: string, date: string, extra: Row[] = [], total = "5.00") => {
    const f = join(dir, `${name}.json`);
    writeFileSync(f, JSON.stringify({
      invoices: [{ vendor: "railway", id: `INV-${name}`, date, currency: "USD", total }],
      items: [invLine(name, "plan", date, "5.00"), ...extra],
    }));
    return f;
  };
  try {
    // The public-repo guard goes by folder identity, and fails closed.
    const refusedInRepo = (r: { code: number; out: string }) => r.code === 1 && /inside the repo/.test(r.out);
    const inRepo = await runImport(join(REPO, "package.json"));
    check("importer refuses a file inside the public repo", refusedInRepo(inRepo) && seen.length === 0, inRepo.out);
    const variant = join(REPO.replace(/database-outboundhero$/, "DATABASE-OUTBOUNDHERO"), "package.json");
    if (existsSync(variant)) { // case-insensitive volume (macOS)
      const r = await runImport(variant);
      check("importer refuses it under another letter case too", refusedInRepo(r), r.out);
    }
    const firm = join("/System/Volumes/Data", REPO, "package.json");
    if (existsSync(firm)) { // macOS firmlink: the same folder under another path
      const r = await runImport(firm);
      check("importer refuses it through /System/Volumes/Data too", refusedInRepo(r), r.out);
    }
    const noGit = await runImport(join(REPO, "package.json"), [], { PATH: dir });
    check("importer refuses it when git cannot run", refusedInRepo(noGit), noGit.out);
    check("costing-invoices/ is git-ignored", spawnSync("git", ["-C", REPO, "check-ignore", "-q", "--", "costing-invoices/x.json"]).status === 0);
    const ignored = await runImport(join(REPO, "node_modules", "pg", "package.json"));
    check("importer reads a git-ignored file inside the repo", ignored.code === 0 && !/inside the repo/.test(ignored.out), ignored.out);

    const old = await runImport(fileWith("d34", utcDay(-34)));
    check("importer asks for --backfill 34 days back", old.code === 1 && /--backfill/.test(old.out), old.out);
    const d33 = await runImport(fileWith("d33", utcDay(-33)));
    check("importer accepts a line 33 days back", d33.code === 0 && !/--backfill/.test(d33.out), d33.out);
    check("a check run runs the database's checks, then rolls back", seen.includes("SET CONSTRAINTS ALL IMMEDIATE") && seen.at(-1) === "ROLLBACK"
      && !seen.includes("COMMIT") && !seen.some((s) => /allow_final_edit/.test(s)), seen);
    const backfill = await runImport(fileWith("d34b", utcDay(-34)), ["--backfill"]);
    check("importer accepts 34 days back with --backfill", backfill.code === 0, backfill.out);
    const committed = await runImport(fileWith("c", utcDay(-1)), ["--commit"]);
    check("--commit commits", committed.code === 0 && /^written:/m.test(committed.out) && seen.at(-1) === "COMMIT", { out: committed.out, seen });
    const corrected = await runImport(fileWith("fix", utcDay(-1)), ["--correct"]);
    check("--correct sets costing.allow_final_edit in its own transaction", corrected.code === 0
      && seen.includes("SET LOCAL costing.allow_final_edit = 'on'") && seen.at(-1) === "ROLLBACK", seen);

    // The importer's own invoice checks (the fake runs no deferred check).
    // A provider_api item that names the invoice is not one of its lines (the database counts source 'invoice' only).
    const mixed = await runImport(fileWith("mix", utcDay(-1), [{ id: "railway:egress:mix", date: utcDay(-1), category: "hosting",
      vendor: "railway", billing_type: "usage", amount: "1.6920", currency: "USD", source: "provider_api", status: "pending", invoice: { id: "INV-mix" } }]));
    check("importer's invoice sum counts invoice lines only", mixed.code === 0 && !/add up to/.test(mixed.out), mixed.out);
    // Stored lines count toward the total, except the ones the file sends again.
    answer = (sql) => (/FROM cost_line_items WHERE vendor = \$1/.test(sql)
      ? { rows: { cols: [["id", TEXT], ["amount", TEXT]], rows: [["railway:INV-st:plan", "5.00"], ["railway:INV-st:egress", "1.25"]] } } : undefined);
    const stored = await runImport(fileWith("st", utcDay(-1), [], "6.25"));
    check("stored lines count once toward the invoice total", stored.code === 0 && !/add up to/.test(stored.out), stored.out);
    check("only stored invoice lines are read", seen.some((s) => /FROM cost_line_items WHERE vendor = \$1 AND source = 'invoice'/.test(s)), seen);
    answer = () => undefined;
    const short = await runImport(fileWith("off", utcDay(-1), [], "5.01"));
    check("importer refuses lines that miss the total by 0.01", short.code === 1 && /lines add up to 5\.00, the invoice total is 5\.01/.test(short.out), short.out);
    const stray = await runImport(fileWith("stray", utcDay(-1),
      [invLine("stray", "late", utcDay(-2), "0.00"), invLine("stray", "eur", utcDay(-1), "0.00", { currency: "EUR" })]));
    check("importer refuses lines off their invoice's day or currency", stray.code === 1 && /its invoice is dated/.test(stray.out)
      && /its invoice is in USD/.test(stray.out), stray.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  console.error = logError;
  fake.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
