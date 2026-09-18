import type { Pool, PoolClient } from "pg";
import { normalizeRow, type FieldMapping } from "./normalize-row";
import { normalizeStateValue, countryForStateCode } from "./geography";
import { domainOfEmail, lookupEspForDomains } from "./esp-lookup";
import { LEAD_FIELDS, BLANKISH_VALUES, isBlankish } from "./constants";

// Bulk CSV import core (2026-09-18). Replaces the per-row PostgREST loop that
// the Uploads page used to drive — 2–3 sequential round trips per row from
// Railway (US) to Supabase (Sydney), which could not finish an 88k-row file
// inside any request budget (and, it turned out, had never been run against
// production: upload_batches was empty). This works in chunks of CHUNK rows,
// each its own transaction, with ONE set-based statement per operation:
//
//   1. rows without a usable email  -> upload_holdbacks (kept verbatim for the
//                                       chunked no-email download)
//   2. new emails                   -> INSERT ... ON CONFLICT (email) DO NOTHING
//                                       RETURNING; an email that lost a race to
//                                       another writer is merged as existing
//   3. existing emails              -> skip | merge (fill blanks only) | replace
//                                       (chosen fields only), per the strategy;
//                                       rows where nothing would change are not
//                                       rewritten (no updated_at bump, no history)
//   4. same email, DIFFERENT place  -> a lead_locations row (one person, many
//                                       locations — client decision 2026-09-17).
//                                       City and state are ONE fact (decidePlace):
//                                       a merge never fills a state that belongs
//                                       to another city, and the extra location is
//                                       judged against the primary AFTER the merge
//                                       and against the lead's existing side rows
//   5. progress counters            -> upload_batches
//
// Everything transaction-scoped (SET LOCAL): DATABASE_URL is the transaction
// pooler, where a session-level SET leaks onto shared backends (2026-09-16
// outage). Inserts are sorted by email / lead_id for a stable lock order.
// A chunk that fails on a DATA error (SQLSTATE 22xxx/23xxx) is bisected so a
// bad row costs ≤ 100 neighbours, not 2,000; anything else (deadlock, timeout,
// dropped connection, pool wait) is retried and then given up as one block.

export interface ImportConfig {
  batchId: string;
  filename: string;
  headers: string[];
  fieldMapping: FieldMapping;
  duplicateStrategy: "skip" | "merge" | "replace";
  overrideFields: string[];
  detectEsp?: boolean;          // default true: MX lookup for rows without a mapped esp
  chunkSize?: number;
  onProgress?: (c: ImportCounters) => Promise<void> | void;
  /**
   * Test mode: everything runs inside ONE transaction (chunks become
   * savepoints), `inspect` sees the would-be state, and it is all rolled back.
   * Used by scripts/test-upload-import.mts to rehearse an import on real rows
   * without writing anything. `passes` > 1 re-runs the lead chunks on the same
   * rows (holdbacks once) so idempotency is visible: the second pass must
   * insert, merge and add nothing.
   */
  dryRun?: { inspect: (client: PoolClient, passes: ImportCounters[]) => Promise<void>; passes?: number };
}

export interface ImportCounters {
  processed: number;
  inserted: number;
  merged: number;
  replaced: number;
  skipped: number;          // duplicate-skips (strategy 'skip'), NOT no-email rows
  no_email: number;         // rows held back: empty OR unusable email ('N/A', '--', no '@')
  in_file_duplicates: number;
  locations_added: number;
  esp_detected: number;     // MX results actually stored (new leads + blanks filled)
  errors: number;
  error_log: string[];
}

export interface PlaceInput { city: string | null; stateText: string | null; stateCode: string | null }
export interface ExistingPlace { city: string | null; state: string | null; state_code: string | null }
export interface PlaceDecision {
  /** Value to write to the primary column; null = leave the stored value alone. */
  city: string | null;
  state: string | null;
  /** The row's place is not the (post-write) primary → store it in lead_locations. */
  extra: boolean;
  /** The primary as it will read after the write (junk states read as null). */
  primary: PlaceInput;
}

interface Prepared {
  rowIndex: number;                       // 1-based data-row index in the file
  raw: string[];
  lead: Record<string, unknown>;
  email: string;
  city: string | null;
  stateCode: string | null;               // normalized 2-letter code when known
  stateText: string | null;
  espFromMx: boolean;
}

interface ExtraLocation { email: string; city: string | null; stateText: string | null; stateCode: string | null; rowIndex: number }
interface ExistingLead { id: string; email: string; city: string | null; state: string | null; state_code: string | null; esp: string | null }
type Deltas = Partial<Pick<ImportCounters, "inserted" | "merged" | "replaced" | "skipped" | "locations_added" | "esp_detected">>;

const TEXT_TYPES = new Set(["text", "character varying", "character"]);
const LEAD_KEYS = new Set([...LEAD_FIELDS.map((f) => f.key), "email_type", "category_source", "esp"]);
// Chunks smaller than this are not bisected further on a data error.
const BISECT_FLOOR = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const METRO_PREFIX = /^(greater|metro(politan)?)\s+/i;
const METRO_SUFFIX = /\s+(area|metro(politan)?(\s+area)?|region)$/i;

export { isBlankish };
/** A cell we can store as an email: not a placeholder, one '@', a dot after it. */
export const isImportableEmail = (e: string): boolean => !!e && !isBlankish(e) && EMAIL_RE.test(e);

async function leadColumnTypes(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query(
    `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'leads'`
  );
  return new Map(rows.map((r) => [r.column_name as string, r.data_type as string]));
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const sameText = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isMetro = (c: string) => METRO_PREFIX.test(c.trim()) || METRO_SUFFIX.test(c.trim());
const coreCity = (c: string) => c.trim().toLowerCase().replace(METRO_PREFIX, "").replace(METRO_SUFFIX, "").trim();
/** "Greater Sacramento" / "Sacramento Area" name the same place as "Sacramento" (the client's files are full of these). */
const sameCity = (a: string, b: string) => sameText(a, b) || ((isMetro(a) || isMetro(b)) && coreCity(a) === coreCity(b));

/**
 * Are two places the same? Cities decide when both are present (a state code
 * conflict — Portland OR vs Portland ME — still splits them; a metro text next
 * to the same city does not). Without a city on one side, states decide; with
 * nothing comparable, they are NOT the same (the file's place is kept as an
 * extra rather than silently dropped).
 */
export function samePlace(a: PlaceInput, b: PlaceInput): boolean {
  if (a.city && b.city) {
    if (!sameCity(a.city, b.city)) return false;
    return !(a.stateCode && b.stateCode && a.stateCode !== b.stateCode);
  }
  if (a.stateCode && b.stateCode) return a.stateCode === b.stateCode;
  if (a.stateText && b.stateText) return sameText(a.stateText, b.stateText);
  return false;
}

/**
 * City and state are one fact. For an existing lead and an incoming row:
 *   merge   — fill city only if the stored state is blank/junk or matches the
 *             row's state; fill state only if the stored city is blank or is the
 *             row's city. A stored state with no code that the row can improve
 *             ('local', 'New', 'North America'…) counts as blank. Anything else
 *             leaves the primary alone.
 *   replace — the chosen columns take the row's values; with BOTH city and
 *             state chosen the row must supply both (half a place is not a
 *             place — it is kept as an extra instead).
 *   skip    — nothing is written and no extra location is added.
 * `extra` is judged against the primary AFTER that write, so a row that just
 * became the primary is never stored a second time as an extra.
 */
export function decidePlace(ex: ExistingPlace, row: PlaceInput, strategy: "skip" | "merge" | "replace", overrideFields: Iterable<string>): PlaceDecision {
  const exCity = isBlankish(ex.city) ? null : ex.city!.trim();
  const exState = isBlankish(ex.state) ? null : ex.state!.trim();
  const exCode = ex.state_code ?? (exState ? normalizeStateValue(exState) : null);
  const rowState = row.stateCode ?? row.stateText;      // what normalizeRow stores in leads.state
  const none: PlaceDecision = { city: null, state: null, extra: false, primary: { city: exCity, stateText: exState, stateCode: exCode } };
  if (strategy === "skip") return none;
  if (!row.city && !row.stateText) return none;

  let city: string | null = null, state: string | null = null;
  if (strategy === "replace") {
    const o = new Set(overrideFields);
    const both = o.has("city") && o.has("state");
    if (!(both && !(row.city && rowState))) {
      if (o.has("city") && row.city) city = row.city;
      if (o.has("state") && rowState) state = rowState;
    }
  } else {
    const stateJunk = exState != null && exCode == null && row.stateCode != null;
    const stateCompatible = exState == null || stateJunk || row.stateCode == null || exCode == null || exCode === row.stateCode;
    const cityCompatible = exCity == null || (row.city != null && sameCity(exCity, row.city));
    if (exCity == null && row.city && stateCompatible) city = row.city;
    if ((exState == null || stateJunk) && rowState && cityCompatible) state = rowState;
  }
  const primary: PlaceInput = {
    city: city ?? exCity,
    stateText: state ?? (exCode == null && row.stateCode != null && strategy === "merge" ? null : exState),
    stateCode: state ? row.stateCode : exCode,
  };
  return { city, state, extra: !samePlace(primary, row), primary };
}

/** Prepare every row: normalize, split holdbacks, dedupe in-file, detect ESP. */
export async function prepareRows(
  rows: string[][],
  cfg: ImportConfig,
): Promise<{ prepared: Prepared[]; holdbacks: Array<{ rowIndex: number; raw: string[] }>; extras: ExtraLocation[]; counters: Pick<ImportCounters, "no_email" | "in_file_duplicates"> }> {
  const prepared: Prepared[] = [];
  const holdbacks: Array<{ rowIndex: number; raw: string[] }> = [];
  const extras: ExtraLocation[] = [];
  const firstByEmail = new Map<string, Prepared>();
  let no_email = 0, in_file_duplicates = 0;
  // Raw (as-imported) city/state text for lead_locations.city_text/state_text:
  // normalizeRow already turns "California" into "CA", and the side table must
  // keep what the file said.
  const cityIdx = Number(Object.keys(cfg.fieldMapping).find((k) => cfg.fieldMapping[Number(k)] === "city") ?? -1);
  const stateIdx = Number(Object.keys(cfg.fieldMapping).find((k) => cfg.fieldMapping[Number(k)] === "state") ?? -1);
  const rawCell = (raw: string[], idx: number) => { const v = idx >= 0 ? (raw[idx] ?? "").trim() : ""; return v && !isBlankish(v) ? v : null; };

  rows.forEach((raw, i) => {
    const rowIndex = i + 1;
    const lead = normalizeRow(raw, cfg.headers, cfg.fieldMapping);
    const email = typeof lead.email === "string" ? lead.email : "";
    if (!isImportableEmail(email)) { holdbacks.push({ rowIndex, raw }); no_email++; return; }

    if (lead.category && !lead.category_source) lead.category_source = "upload";
    const stateText = rawCell(raw, stateIdx) ?? (typeof lead.state === "string" ? lead.state : null);
    const stateCode = stateText ? normalizeStateValue(stateText) : null;
    const city = rawCell(raw, cityIdx) ?? (typeof lead.city === "string" ? lead.city : null);

    const first = firstByEmail.get(email);
    if (first) {
      in_file_duplicates++;
      // Same person again in the same file. Blank fields of the first
      // occurrence are filled from this one (the file's own merge); a different
      // place is a second location; the same place is just a repeat.
      for (const [k, v] of Object.entries(lead)) if (k !== "city" && k !== "state" && first.lead[k] == null && v != null) first.lead[k] = v;
      const here: PlaceInput = { city, stateText, stateCode };
      if (!city && !stateText) return;
      if (!first.city && !first.stateText) {
        Object.assign(first, { city, stateText, stateCode });
        if (lead.city != null) first.lead.city = lead.city;
        if (lead.state != null) first.lead.state = lead.state;
      } else if (samePlace(here, { city: first.city, stateText: first.stateText, stateCode: first.stateCode })) {
        if (!first.city && city) { first.city = city; if (lead.city != null) first.lead.city = lead.city; }
        if (!first.stateText && stateText) { first.stateText = stateText; first.stateCode = stateCode; if (lead.state != null) first.lead.state = lead.state; }
      } else {
        extras.push({ email, city, stateText, stateCode, rowIndex });
      }
      return;
    }
    const p: Prepared = { rowIndex, raw, lead, email, city, stateCode, stateText, espFromMx: false };
    firstByEmail.set(email, p);
    prepared.push(p);
  });

  if (cfg.detectEsp !== false) {
    const domains = new Set<string>();
    for (const p of prepared) if (!p.lead.esp) { const d = domainOfEmail(p.email); if (d) domains.add(d); }
    const esp = await lookupEspForDomains(domains);
    for (const p of prepared) {
      if (p.lead.esp) continue;
      const d = domainOfEmail(p.email); const v = d ? esp.get(d) : null;
      if (v) { p.lead.esp = v; p.espFromMx = true; }
    }
  }
  return { prepared, holdbacks, extras, counters: { no_email, in_file_duplicates } };
}

/** Run the whole import: prepare, then process chunks each in its own transaction. */
export async function importRows(pool: Pool, rows: string[][], cfg: ImportConfig): Promise<ImportCounters> {
  const freshCounters = (): ImportCounters => ({
    processed: 0, inserted: 0, merged: 0, replaced: 0, skipped: 0, no_email: 0,
    in_file_duplicates: 0, locations_added: 0, esp_detected: 0, errors: 0, error_log: [],
  });
  let counters = freshCounters();
  const { prepared, holdbacks, extras, counters: pc } = await prepareRows(rows, cfg);
  Object.assign(counters, pc);

  const dry = !!cfg.dryRun;
  // Dry run: one client, one transaction, savepoints per chunk. Live: a client
  // per chunk so a dropped connection is simply replaced for the next attempt.
  const shared = dry ? await pool.connect() : null;
  const withClient = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    if (shared) return fn(shared);
    const c = await pool.connect();
    let dead: unknown = undefined;
    try { return await fn(c); }
    catch (e) { if (isConnectionError(e)) dead = e; throw e; }
    finally { c.release(dead as Error | undefined); }
  };
  if (shared) await shared.query("begin");
  try {
    const types = await withClient(leadColumnTypes);
    const CHUNK = cfg.chunkSize ?? 2000;

    /**
     * Run `work` on `items` inside one transaction, with recovery: transient
     * failures retry (3×, backoff); a data error bisects down to BISECT_FLOOR
     * rows, then the block is counted as errors with the Postgres detail (for a
     * CHECK/unique violation it names the failing row) and, for lead rows, the
     * emails involved. Counter deltas are applied only after a commit.
     */
    const recover = async <T,>(items: T[], work: (items: T[], client: PoolClient) => Promise<Deltas | void>, describe: (items: T[]) => string, timeout: string, attempt = 1): Promise<void> => {
      try {
        const d = await withClient((client) => inTx(client, dry, () => work(items, client), timeout));
        if (d) for (const k of Object.keys(d) as Array<keyof Deltas>) counters[k] += d[k] ?? 0;
      } catch (e) {
        if (isDataError(e) && items.length > BISECT_FLOOR) {
          const half = Math.ceil(items.length / 2);
          await recover(items.slice(0, half), work, describe, timeout);
          await recover(items.slice(half), work, describe, timeout);
          return;
        }
        if (!isDataError(e) && attempt < 3) { await sleep(2000 * attempt); return recover(items, work, describe, timeout, attempt + 1); }
        counters.errors += items.length;
        const err = e as { message?: string; detail?: string; code?: string };
        counters.error_log.push(`${items.length} row(s) — ${describe(items)}: ${err.message ?? String(e)}${err.detail ? ` [${err.detail}]` : ""}${err.code ? ` (${err.code})` : ""}`.slice(0, 700));
      }
    };

    // Holdbacks first, in chunks: verbatim rows, dense seq. A failed holdback
    // block must never stop the lead import that follows.
    for (let i = 0; i < holdbacks.length; i += CHUNK) {
      const slice = holdbacks.slice(i, i + CHUNK);
      await recover(slice, async (items, client) => {
        const seq0 = i + slice.indexOf(items[0]);
        await client.query(
          `insert into upload_holdbacks (batch_id, seq, row_index, raw)
           select $1, $2 + (ord - 1), (v->>'row_index')::int, v->'raw'
             from jsonb_array_elements($3::jsonb) with ordinality as t(v, ord)
           on conflict (batch_id, seq) do nothing`,
          [cfg.batchId, seq0, JSON.stringify(items.map((h) => ({ row_index: h.rowIndex, raw: h.raw })))]
        );
      }, (items) => `no-email rows, file rows ${items[0].rowIndex}–${items[items.length - 1].rowIndex}`, "120s");
    }
    // Extra locations from in-file duplicates are attached after the lead exists;
    // group them by email so each chunk can pick up its own.
    const extrasByEmail = new Map<string, ExtraLocation[]>();
    for (const e of extras) (extrasByEmail.get(e.email) ?? extrasByEmail.set(e.email, []).get(e.email)!).push(e);

    prepared.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    const describeLeads = (items: Prepared[]) => {
      const idx = items.map((p) => p.rowIndex);
      return items.length <= BISECT_FLOOR
        ? `emails ${items.map((p) => p.email).join(", ")}`
        : `file rows ${Math.min(...idx)}–${Math.max(...idx)} (not contiguous)`;
    };
    const passes = shared ? Math.max(1, cfg.dryRun?.passes ?? 1) : 1;
    const passResults: ImportCounters[] = [];
    for (let pass = 1; pass <= passes; pass++) {
      if (pass > 1) counters = Object.assign(freshCounters(), pc);
      for (let i = 0; i < prepared.length; i += CHUNK) {
        await recover(prepared.slice(i, i + CHUNK), (items, client) => processChunk(client, items, extrasByEmail, cfg, types), describeLeads, "180s");
        counters.processed = Math.min(i + CHUNK, prepared.length) + counters.no_email + counters.in_file_duplicates;
        if (cfg.onProgress) await cfg.onProgress(counters);
      }
      counters.processed = rows.length;
      passResults.push(counters);
    }
    if (shared) {
      await cfg.dryRun!.inspect(shared, passResults);
      await shared.query("rollback");
    }
  } catch (e) {
    if (shared) await shared.query("rollback").catch(() => {});
    throw e;
  } finally {
    shared?.release();
  }
  return counters;
}

const code = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code) : "");
const isConnectionError = (e: unknown) =>
  ["ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01", "08000", "08003", "08006"].includes(code(e)) ||
  /connection terminated|connection.*closed|socket hang up/i.test(e instanceof Error ? e.message : "");
// SQLSTATE class 22 (data exception) / 23 (integrity constraint): a row is bad
// and retrying cannot help — bisect instead. Everything else is retried.
const isDataError = (e: unknown) => /^2[23]/.test(code(e));

// One transaction per chunk so partial progress survives a failure. In dry-run
// mode the outer transaction is already open, so a chunk is a SAVEPOINT instead
// (SET LOCAL still applies to the enclosing transaction).
let savepointSeq = 0;
async function inTx<T>(client: PoolClient, dry: boolean, fn: () => Promise<T>, timeout = "120s"): Promise<T> {
  const sp = `c${++savepointSeq}`;
  await client.query(dry ? `savepoint ${sp}` : "begin");
  try {
    await client.query(`set local statement_timeout = '${timeout}'`);
    const out = await fn();
    await client.query(dry ? `release savepoint ${sp}` : "commit");
    return out;
  } catch (e) {
    await client.query(dry ? `rollback to savepoint ${sp}` : "rollback").catch(() => {});
    throw e;
  }
}

async function processChunk(
  client: PoolClient,
  chunk: Prepared[],
  extrasByEmail: Map<string, ExtraLocation[]>,
  cfg: ImportConfig,
  types: Map<string, string>,
): Promise<Deltas> {
  const d: Required<Deltas> = { inserted: 0, merged: 0, replaced: 0, skipped: 0, locations_added: 0, esp_detected: 0 };
  const emails = chunk.map((p) => p.email);
  const selectExisting = async (list: string[]) => {
    const { rows } = await client.query(
      `select id, email, city, state, state_code, esp from leads where email = any($1::text[])`, [list]
    );
    return rows as ExistingLead[];
  };
  const existing = new Map<string, ExistingLead>((await selectExisting(emails)).map((r) => [r.email, r]));
  const idByEmail = new Map<string, string>([...existing.values()].map((r) => [r.email, r.id]));

  // Column list: every mapped/derived key that is a real leads column.
  const cols = [...new Set(chunk.flatMap((p) => Object.keys(p.lead)))].filter((k) => LEAD_KEYS.has(k) && types.has(k)).sort();
  const colList = cols.map(q).join(", ");

  // 2. New leads.
  let fresh = chunk.filter((p) => !existing.has(p.email));
  if (fresh.length) {
    const { rows: ins } = await client.query(
      `insert into leads (${colList})
       select ${colList} from jsonb_populate_recordset(null::leads, $1::jsonb)
       on conflict (email) do nothing
       returning id, email`,
      [JSON.stringify(fresh.map((p) => p.lead))]
    );
    const landed = new Set<string>();
    for (const r of ins) { landed.add(r.email as string); idByEmail.set(r.email as string, r.id as string); }
    d.inserted += ins.length;
    // Lost a race to another writer (a second upload, the Bison sync): those
    // emails exist now — treat them as existing from here on.
    const raced = fresh.filter((p) => !landed.has(p.email));
    if (raced.length) {
      for (const r of await selectExisting(raced.map((p) => p.email))) { existing.set(r.email, r); idByEmail.set(r.email, r.id); }
      fresh = fresh.filter((p) => landed.has(p.email));
    }
    d.esp_detected += fresh.filter((p) => p.espFromMx).length;
  }

  // 3. Existing leads, per strategy. City/state are decided per row in JS
  //    (decidePlace) and sent as "write this" / "leave alone" values.
  const dupes = chunk.filter((p) => existing.has(p.email));
  const decisions = new Map<string, PlaceDecision>();
  for (const p of dupes) {
    decisions.set(p.email, decidePlace(existing.get(p.email)!, { city: p.city, stateText: p.stateText, stateCode: p.stateCode }, cfg.duplicateStrategy, cfg.overrideFields));
  }
  if (dupes.length) {
    if (cfg.duplicateStrategy === "skip") {
      d.skipped += dupes.length;
    } else {
      const updatable = cols.filter((c) => c !== "email" && c !== "id");
      const chosen = cfg.duplicateStrategy === "replace" ? updatable.filter((c) => cfg.overrideFields.includes(c)) : updatable;
      if (chosen.length) {
        // "Blank" for merge purposes includes placeholder junk already in the
        // database (BLANKISH_VALUES): a real value from the file replaces it.
        const expr = (c: string) => {
          const isText = TEXT_TYPES.has(types.get(c) ?? "");
          if (cfg.duplicateStrategy === "merge" && c !== "city" && c !== "state") {
            return isText
              ? `case when l.${q(c)} is null or btrim(l.${q(c)}) = any($3::text[]) then coalesce(r.${q(c)}, l.${q(c)}) else l.${q(c)} end`
              : `coalesce(l.${q(c)}, r.${q(c)})`;
          }
          return `coalesce(r.${q(c)}, l.${q(c)})`;   // replace; and merge city/state (decided per row)
        };
        const payload = dupes.map((p) => {
          const dec = decisions.get(p.email)!;
          const row: Record<string, unknown> = { ...p.lead };
          if ("city" in row) row.city = dec.city ?? undefined;
          if ("state" in row) row.state = dec.state ?? undefined;
          return row;
        });
        // Only rows where at least one chosen column would actually change are
        // rewritten — no updated_at bump, no history row, no index churn
        // otherwise; the history rows come from the same statement.
        const sql =
          `with changed as (
             update leads l set ${chosen.map((c) => `${q(c)} = ${expr(c)}`).join(", ")}
               from jsonb_populate_recordset(null::leads, $1::jsonb) r
              where l.email = r.email
                and (${chosen.map((c) => `${expr(c)} is distinct from l.${q(c)}`).join(" or ")})
              returning l.id, l.email
           ), h as (
             insert into lead_history (lead_id, event_type, notes) select id, 'updated', $2 from changed
           )
           select id, email from changed`;
        const notes = `${cfg.duplicateStrategy === "merge" ? "Merged" : "Replaced"} from upload: ${cfg.filename}`;
        // $3 (the blank-ish placeholders) only appears in merge expressions;
        // Postgres rejects a bind with more parameters than the statement uses.
        const { rows: changed } = await client.query(sql, sql.includes("$3") ? [JSON.stringify(payload), notes, BLANKISH_VALUES] : [JSON.stringify(payload), notes]);
        const n = changed.length;
        if (cfg.duplicateStrategy === "merge") d.merged += n; else d.replaced += n;
        if (n && chosen.includes("esp")) {
          const changedEmails = new Set(changed.map((r) => r.email as string));
          d.esp_detected += dupes.filter((p) => p.espFromMx && changedEmails.has(p.email) && (cfg.duplicateStrategy === "replace" || !existing.get(p.email)!.esp)).length;
        }
      }
    }
  }

  // 4. Additional locations: existing leads whose place differs from the incoming
  //    row (judged against the post-write primary AND the lead's existing side
  //    rows, so "Lincoln, CA" is not added next to "Lincoln, Calif."), plus
  //    in-file repeats of any lead in this chunk at another place. Nothing under
  //    'skip' for existing leads.
  const primaryOf = new Map<string, PlaceInput>();   // post-write primary
  for (const p of dupes) primaryOf.set(p.email, decisions.get(p.email)!.primary);
  for (const p of fresh) primaryOf.set(p.email, { city: p.city, stateText: p.stateText, stateCode: p.stateCode });
  const known = new Map<string, PlaceInput[]>();     // lead_id -> places already stored / queued
  const candidates: Array<{ leadId: string; loc: PlaceInput }> = [];
  for (const p of dupes) {
    if (decisions.get(p.email)!.extra) candidates.push({ leadId: idByEmail.get(p.email)!, loc: { city: p.city, stateText: p.stateText, stateCode: p.stateCode } });
  }
  for (const p of chunk) {
    const list = extrasByEmail.get(p.email); if (!list) continue;
    if (cfg.duplicateStrategy === "skip" && existing.has(p.email)) continue;
    const leadId = idByEmail.get(p.email); if (!leadId) continue;
    for (const e of list) candidates.push({ leadId, loc: { city: e.city, stateText: e.stateText, stateCode: e.stateCode } });
  }
  if (candidates.length) {
    const leadIds = [...new Set(candidates.map((c) => c.leadId))];
    const { rows: side } = await client.query(
      `select lead_id, city_text, state_text, state_code from lead_locations where lead_id = any($1::uuid[])`, [leadIds]
    );
    for (const s of side) (known.get(s.lead_id as string) ?? known.set(s.lead_id as string, []).get(s.lead_id as string)!)
      .push({ city: s.city_text as string | null, stateText: s.state_text as string | null, stateCode: s.state_code as string | null });
  }
  const locs: Array<{ lead_id: string; city_text: string | null; state_text: string | null; state_code: string | null; country_code: string | null }> = [];
  for (const { leadId, loc } of candidates) {
    if (!loc.city && !loc.stateText) continue;
    const email = [...idByEmail.entries()].find(([, id]) => id === leadId)?.[0];
    const primary = email ? primaryOf.get(email) : undefined;
    if (primary && samePlace(primary, loc)) continue;
    const seen = known.get(leadId) ?? known.set(leadId, []).get(leadId)!;
    if (seen.some((s) => samePlace(s, loc))) continue;
    seen.push(loc);
    locs.push({ lead_id: leadId, city_text: loc.city, state_text: loc.stateText, state_code: loc.stateCode, country_code: countryForStateCode(loc.stateCode) });
  }
  if (locs.length) {
    locs.sort((a, b) => (a.lead_id < b.lead_id ? -1 : a.lead_id > b.lead_id ? 1 : 0));
    const { rowCount } = await client.query(
      `insert into lead_locations (lead_id, city_text, state_text, state_code, country_code, source, upload_batch_id)
       select (v->>'lead_id')::uuid, v->>'city_text', v->>'state_text', v->>'state_code', v->>'country_code', 'upload', $2
         from jsonb_array_elements($1::jsonb) v
       on conflict (lead_id, location_key) do nothing`,
      [JSON.stringify(locs), cfg.batchId]
    );
    d.locations_added += rowCount ?? 0;
  }
  return d;
}
