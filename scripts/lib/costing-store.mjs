// Costing feed writers' shared module (migration 121, ReplyRouter spec v1.0).
//
// Every writer — the invoice import and the provider pulls — validates items
// here before they reach cost_line_items, where the database re-checks what it
// can. Money never becomes a JavaScript number: decimal strings are compared
// and summed as BigInt counts of 1e-12 units (the spec's precision).

const BILLING_TYPES = new Set(["usage", "subscription", "one_time", "tax", "fee", "credit", "discount", "refund"]);
const NEGATIVE_TYPES = new Set(["credit", "discount", "refund"]);
const SOURCES = new Set(["invoice", "provider_api", "metered"]);
const STATUSES = new Set(["final", "pending"]);
const ITEM_KEYS = new Set(["id", "date", "category", "vendor", "service", "model", "description", "billing_type", "amount",
  "currency", "source", "status", "invoice", "usage", "subscription", "allocations", "attributes"]);
const DEC = /^-?(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;
const UDEC = /^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._@/+-]{0,199}$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SNAKE = /^[a-z0-9_]+$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const SCALE = 10n ** 12n;
const MAX_UNITS = 10n ** 27n; // |amount| < 1e15, the same bound as the table's CHECK

/** Exact decimal string -> BigInt count of 1e-12 units. Throws on anything else. */
export function toUnits(s) {
  if (typeof s !== "string" || !DEC.test(s)) throw new Error(`not an exact decimal string: ${JSON.stringify(s)}`);
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(i) * SCALE + BigInt(f.padEnd(12, "0"));
  return neg ? -v : v;
}

/** BigInt 1e-12 units -> decimal string, trailing zeros trimmed, at least 2 decimals. */
export function fromUnits(u) {
  const neg = u < 0n;
  const a = neg ? -u : u;
  let f = (a % SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  if (f.length < 2) f = f.padEnd(2, "0");
  return `${neg ? "-" : ""}${a / SCALE}.${f}`;
}

export function isRealDate(s) {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const extraKeys = (o, allowed) => Object.keys(o).filter((k) => !allowed.includes(k));
// RegExp.test() turns its argument into a string, so 123 would pass /^[0-9]+$/.
const matches = (re, v) => typeof v === "string" && re.test(v);

// Inside invoice / usage / subscription a key is either absent or a string: an
// explicit null would be stored as-is and served to ReplyRouter as null (the
// spec allows absent, not null), so null counts as a wrong type, not as absent.
// Top-level null fields are fine — they are stored as SQL NULL and omitted.

/** Problems with one line item against the spec (§2–§7); [] when it is valid. */
export function validateItem(it) {
  if (!isObj(it)) return ["item is not an object"];
  const e = [];
  for (const k of Object.keys(it)) if (!ITEM_KEYS.has(k)) e.push(`unknown field "${k}"`);
  if (!matches(ID, it.id)) e.push("id must be 1-200 characters of [A-Za-z0-9:._@/+-]");
  if (!isRealDate(it.date)) e.push("date must be a real YYYY-MM-DD (UTC) date");
  if (!matches(SNAKE, it.category)) e.push("category must be lowercase [a-z0-9_]");
  if (!matches(SLUG, it.vendor)) e.push("vendor must be a lowercase slug");
  for (const k of ["service", "model", "description"]) {
    if (it[k] != null && (typeof it[k] !== "string" || !it[k].trim())) e.push(`${k} must be a non-empty string when given`);
  }
  if (!BILLING_TYPES.has(it.billing_type)) e.push(`billing_type must be one of ${[...BILLING_TYPES].join(", ")}`);
  const amountOk = typeof it.amount === "string" && DEC.test(it.amount);
  if (!amountOk) e.push("amount must be an exact decimal string with at most 12 decimals (never a JSON number)");
  else {
    const u = toUnits(it.amount);
    if (u >= MAX_UNITS || u <= -MAX_UNITS) e.push("amount is out of range (|amount| must be under 1e15)");
    if (BILLING_TYPES.has(it.billing_type)) {
      if (NEGATIVE_TYPES.has(it.billing_type) && u > 0n) e.push(`a ${it.billing_type} must be negative`);
      if (!NEGATIVE_TYPES.has(it.billing_type) && u < 0n) e.push("amount may be negative only for credit / discount / refund");
    }
  }
  if (!matches(CURRENCY, it.currency)) e.push("currency must be ISO 4217 (three uppercase letters)");
  if (!SOURCES.has(it.source)) e.push("source must be invoice | provider_api | metered");
  if (!STATUSES.has(it.status)) e.push("status must be final | pending");
  // Only issued invoices are entered, so an invoice line is final (spec §3.4).
  if (it.source === "invoice" && it.status !== "final") e.push("an invoice line is final (enter only issued invoices)");
  if (it.category === "ai" && !it.model) e.push("model is required when category is ai");

  if (it.invoice != null) {
    if (!isObj(it.invoice)) e.push("invoice must be an object");
    else {
      if (typeof it.invoice.id !== "string" || !it.invoice.id) e.push("invoice.id must be a non-empty string");
      if (it.invoice.url !== undefined && typeof it.invoice.url !== "string") e.push("invoice.url must be a string (leave it out when there is none)");
      for (const k of extraKeys(it.invoice, ["id", "url"])) e.push(`unknown invoice field "${k}"`);
    }
  } else if (it.source === "invoice") e.push("invoice { id } is required when source is invoice");

  const priced = [];
  if (it.usage != null) {
    if (!Array.isArray(it.usage)) e.push("usage must be an array");
    else it.usage.forEach((u, i) => {
      if (!isObj(u)) { e.push(`usage[${i}] is not an object`); return; }
      if (!matches(SNAKE, u.metric)) e.push(`usage[${i}].metric must be snake_case`);
      if (!matches(UDEC, u.quantity)) e.push(`usage[${i}].quantity must be a non-negative decimal string`);
      for (const k of ["unit_price", "price_per"]) {
        if (u[k] !== undefined && !matches(UDEC, u[k])) e.push(`usage[${i}].${k} must be a non-negative decimal string`);
      }
      if ((u.unit_price === undefined) !== (u.price_per === undefined)) e.push(`usage[${i}]: unit_price and price_per go together`);
      else if (matches(UDEC, u.price_per) && toUnits(u.price_per) === 0n) e.push(`usage[${i}].price_per must not be 0`);
      if (u.unit !== undefined && typeof u.unit !== "string") e.push(`usage[${i}].unit must be a string`);
      for (const k of extraKeys(u, ["metric", "quantity", "unit", "unit_price", "price_per"])) e.push(`usage[${i}]: unknown field "${k}"`);
      if ([u.quantity, u.unit_price, u.price_per].every((v) => matches(UDEC, v)) && toUnits(u.price_per) !== 0n) priced.push(u);
    });
  }
  // spec §3.3 / §6: a metered amount must equal Σ quantity × unit_price ÷ price_per EXACTLY.
  if (it.source === "metered") {
    if (!priced.length) e.push("a metered item needs priced usage (quantity, unit_price, price_per)");
    else if (amountOk) {
      let num = 0n, den = 1n; // running sum in 1e-12 units, as a fraction
      for (const u of priced) {
        const n = toUnits(u.quantity) * toUnits(u.unit_price), d = toUnits(u.price_per);
        num = num * d + n * den; den *= d;
      }
      if (num !== toUnits(it.amount) * den) e.push(`metered amount ${it.amount} is not exactly Σ quantity × unit_price ÷ price_per`);
    }
  }

  if (it.billing_type === "subscription" && it.subscription == null) e.push("a subscription item needs subscription { plan, interval, service_from, service_to }");
  if (it.subscription != null) {
    const s = it.subscription;
    if (!isObj(s)) e.push("subscription must be an object");
    else {
      if (typeof s.plan !== "string" || !s.plan) e.push("subscription.plan is required");
      if (s.interval !== "month" && s.interval !== "year") e.push("subscription.interval must be month | year");
      if (s.seats !== undefined && !matches(UDEC, s.seats)) e.push("subscription.seats must be a decimal string");
      if (!isRealDate(s.service_from) || !isRealDate(s.service_to)) e.push("subscription.service_from / service_to must be YYYY-MM-DD");
      else if (s.service_from > s.service_to) e.push("subscription.service_from is after service_to");
      for (const k of extraKeys(s, ["plan", "interval", "seats", "service_from", "service_to"])) e.push(`unknown subscription field "${k}"`);
    }
  }

  if (it.allocations != null) {
    if (!Array.isArray(it.allocations)) e.push("allocations must be an array");
    else {
      const sums = new Map(), seen = new Set();
      let ok = true;
      it.allocations.forEach((a, i) => {
        if (!isObj(a)) { e.push(`allocations[${i}] is not an object`); ok = false; return; }
        if (!matches(SNAKE, a.dimension)) { e.push(`allocations[${i}].dimension must be lowercase`); ok = false; }
        if (typeof a.key !== "string" || !a.key) { e.push(`allocations[${i}].key is required`); ok = false; }
        if (typeof a.amount !== "string" || !DEC.test(a.amount)) { e.push(`allocations[${i}].amount must be an exact decimal string`); ok = false; }
        for (const k of extraKeys(a, ["dimension", "key", "amount"])) e.push(`allocations[${i}]: unknown field "${k}"`);
        const dk = `${a.dimension}\u0000${a.key}`;
        if (seen.has(dk)) e.push(`allocations: ${a.dimension}/${a.key} appears twice`);
        seen.add(dk);
        if (ok) sums.set(a.dimension, (sums.get(a.dimension) ?? 0n) + toUnits(a.amount));
      });
      if (ok && amountOk) {
        for (const [d, s] of sums) {
          if (s !== toUnits(it.amount)) e.push(`allocations for "${d}" add up to ${fromUnits(s)}, not ${it.amount} — put the rest on key "unattributed"`);
        }
      }
    }
  }

  if (it.attributes != null) {
    if (!isObj(it.attributes)) e.push("attributes must be a flat object");
    // Numbers under 1e15, as the table checks: JSON.parse turns 1e999 into
    // Infinity, which JSON.stringify would then store as null.
    else for (const [k, v] of Object.entries(it.attributes)) {
      const ok = typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e15);
      if (!ok) e.push(`attributes.${k} must be a string, a boolean or a number under 1e15`);
    }
  }
  return e;
}

/** Problems with one invoice header { vendor, id, date, currency, total, url? }; [] when valid. */
export function validateInvoice(inv) {
  if (!isObj(inv)) return ["invoice is not an object"];
  const e = [];
  for (const k of extraKeys(inv, ["vendor", "id", "date", "currency", "total", "url"])) e.push(`unknown invoice field "${k}"`);
  if (!matches(SLUG, inv.vendor)) e.push("vendor must be a lowercase slug");
  if (typeof inv.id !== "string" || !inv.id) e.push("id is required");
  if (!isRealDate(inv.date)) e.push("date (the charge day) must be a real YYYY-MM-DD date");
  if (!matches(CURRENCY, inv.currency)) e.push("currency must be ISO 4217");
  if (typeof inv.total !== "string" || !DEC.test(inv.total)) e.push("total must be an exact decimal string");
  else { const u = toUnits(inv.total); if (u >= MAX_UNITS || u <= -MAX_UNITS) e.push("total is out of range"); }
  if (inv.url != null && typeof inv.url !== "string") e.push("url must be a string");
  return e;
}

/** Upsert invoice headers (cost_invoices). The caller owns the transaction. */
export async function upsertInvoices(client, invoices) {
  let written = 0;
  for (const inv of invoices) {
    const { rowCount } = await client.query(
      `INSERT INTO cost_invoices AS h (vendor, invoice_id, invoice_date, currency, total, url)
       VALUES ($1, $2, $3::date, $4, $5::numeric, $6)
       ON CONFLICT (vendor, invoice_id) DO UPDATE SET
         invoice_date = EXCLUDED.invoice_date, currency = EXCLUDED.currency, total = EXCLUDED.total, url = EXCLUDED.url,
         updated_at = now()
       WHERE (h.invoice_date, h.currency, h.total::text, h.url)
             IS DISTINCT FROM (EXCLUDED.invoice_date, EXCLUDED.currency, EXCLUDED.total::text, EXCLUDED.url)`,
      [inv.vendor, inv.id, inv.date, inv.currency, inv.total, inv.url ?? null]);
    written += rowCount;
  }
  return written;
}

/** All problems in a batch, including duplicate ids. */
export function validateBatch(items) {
  const problems = [];
  const ids = new Set();
  items.forEach((it, i) => {
    const label = typeof it?.id === "string" ? it.id : `#${i}`;
    for (const m of validateItem(it)) problems.push(`${label}: ${m}`);
    if (typeof it?.id === "string") {
      if (ids.has(it.id)) problems.push(`${label}: duplicate id in this batch`);
      ids.add(it.id);
    }
  });
  return problems;
}

/**
 * Upsert validated items for one writer (origin). The caller owns the
 * transaction. An id already stored by a DIFFERENT origin is refused, so the
 * provider pull can never overwrite an invoice line (or the reverse).
 * Returns { inserted, updated, unchanged }.
 */
export async function upsertItems(client, items, origin) {
  if (!SLUG.test(origin)) throw new Error(`origin must be a lowercase slug: ${origin}`);
  const problems = validateBatch(items);
  if (problems.length) throw new Error(`${problems.length} invalid item(s):\n  ${problems.slice(0, 50).join("\n  ")}`);
  if (!items.length) return { inserted: 0, updated: 0, unchanged: 0 };

  const { rows: owned } = await client.query(
    "SELECT id, origin FROM cost_line_items WHERE id = ANY($1::text[]) AND origin <> $2", [items.map((i) => i.id), origin]);
  if (owned.length) {
    throw new Error(`${owned.length} id(s) belong to another writer: ${owned.slice(0, 10).map((r) => `${r.id} (${r.origin})`).join(", ")}`);
  }

  const j = (v) => (v == null ? null : JSON.stringify(v));
  let inserted = 0, updated = 0, unchanged = 0;
  for (const it of items) {
    const { rows } = await client.query(
      `INSERT INTO cost_line_items AS c (id, date, category, vendor, service, model, description, billing_type, amount, currency,
                                         source, status, invoice, usage, subscription, allocations, attributes, origin)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18)
       ON CONFLICT (id) DO UPDATE SET
         date = EXCLUDED.date, category = EXCLUDED.category, vendor = EXCLUDED.vendor, service = EXCLUDED.service,
         model = EXCLUDED.model, description = EXCLUDED.description, billing_type = EXCLUDED.billing_type,
         amount = EXCLUDED.amount, currency = EXCLUDED.currency, source = EXCLUDED.source, status = EXCLUDED.status,
         invoice = EXCLUDED.invoice, usage = EXCLUDED.usage, subscription = EXCLUDED.subscription,
         allocations = EXCLUDED.allocations, attributes = EXCLUDED.attributes, updated_at = now()
       WHERE c.origin = EXCLUDED.origin
         AND (c.date, c.category, c.vendor, c.service, c.model, c.description, c.billing_type, c.amount::text, c.currency,
              c.source, c.status, c.invoice, c.usage, c.subscription, c.allocations, c.attributes)
             IS DISTINCT FROM
             (EXCLUDED.date, EXCLUDED.category, EXCLUDED.vendor, EXCLUDED.service, EXCLUDED.model, EXCLUDED.description,
              EXCLUDED.billing_type, EXCLUDED.amount::text, EXCLUDED.currency, EXCLUDED.source, EXCLUDED.status,
              EXCLUDED.invoice, EXCLUDED.usage, EXCLUDED.subscription, EXCLUDED.allocations, EXCLUDED.attributes)
       RETURNING (xmax = 0) AS inserted`,
      [it.id, it.date, it.category, it.vendor, it.service ?? null, it.model ?? null, it.description ?? null, it.billing_type,
       it.amount, it.currency, it.source, it.status, j(it.invoice), j(it.usage), j(it.subscription), j(it.allocations),
       j(it.attributes), origin]);
    if (!rows.length) unchanged++;
    else if (rows[0].inserted) inserted++;
    else updated++;
  }
  return { inserted, updated, unchanged };
}
