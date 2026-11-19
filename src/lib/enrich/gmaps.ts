import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { placeInputs } from "../../../scripts/lib/enrich/maps-place.mjs";
import { ensurePipelineTables, PIPELINE_TEMPLATES } from "../../../scripts/lib/enrich/templates.mjs";
import { normName, type NameCheck } from "./inbound";
import type { IncomingRow } from "./insert-rows";

/** A place's row key, "maps:" and its place id (null skips the place). */
export { placeRowKey } from "../../../scripts/lib/enrich/maps-place.mjs";

// One GMaps Scraper app chunk, as a client's inbound URL receives it
// (POST /api/enrich/intake/<token>, migration 129). The scraper app sends each
// chunk exactly as it would send it to Clay:
//   { taskId, originalTaskId?, chunkIndex?, totalChunks?,
//     extra: { client, keyword, city, state, category, scrape_queue_id } (or null),
//     postbackData: { tasks: [ { result: [ { items: [ ...up to 25 places... ] } ] } ] } }
// Every place of every task and result becomes one row of the client's
// Companies (pipeline) table (placeInputs, scripts/lib/enrich/maps-place.mjs),
// keyed "maps:" and its place id. A place with no place id is skipped and
// counted. A blank search city, state or category is fine: the place's own
// address places it.
//
// Also here: the intake's slots (3 deliveries at once in this process) and
// the client's Companies (pipeline) table, made under a per-client lock when
// it is missing.

/** The name of the table Maps places land in, as the Test answer says it. */
export const MAPS_TABLE_NAME: string = PIPELINE_TEMPLATES.companies.name;
/** The largest body the intake reads: 5 MB. */
export const INTAKE_MAX_BYTES = 5 * 1024 * 1024;
/** Deliveries worked at once in one web process: 3 of the Clay pool's 6 connections, so the Clay and Companies tabs keep 3. */
export const INTAKE_SLOTS = 3;
/** How long a delivery waits for a slot before it answers 429 (no try used). */
export const SLOT_WAIT_MS = 2_000;

const TEXT_MAX = 200;
/** A chunk id longer than this is kept as its sha256, so it always fits the unique index. */
const CHUNK_ID_MAX = 500;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Lone UTF-16 halves made U+FFFD: Postgres refuses them inside jsonb, which would fail the chunk on every try. */
const wellFormed = (s: string) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");

/** Text as stored in a label or the meta: white space made single, no NUL, well formed, at most 200 characters. */
function text(v: unknown, max = TEXT_MAX): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return wellFormed(String(v).replace(/\u0000/g, "").replace(/\s+/g, " ").trim()).slice(0, max);
}

const whole = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

// ── The body ────────────────────────────────────────────────────────────────

/**
 * The request body as text, or null when it is over `max` bytes. A stream is
 * read a piece at a time and given up past the limit, so a large body is never
 * held whole. Anything else (the tests' stand-in) is read with text().
 */
export async function readBodyCapped(req: { body?: unknown; text: () => Promise<string> }, max = INTAKE_MAX_BYTES): Promise<string | null> {
  const stream = req.body as ReadableStream<Uint8Array> | null | undefined;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(parts));
  }
  const raw = await req.text();
  return Buffer.byteLength(raw, "utf8") > max ? null : raw;
}

/** The scraper app's Test: { test: true, ... } with no postbackData. */
export function isTestCall(body: unknown): boolean {
  const b = obj(body);
  return b.test === true && b.postbackData == null;
}

/** Does the body carry the places list a chunk has (postbackData.tasks)? */
export function isChunk(body: unknown): boolean {
  return Array.isArray(obj(obj(body).postbackData).tasks);
}

/** The client name the chunk carries (extra.client), as sent: the scraper app's own name for the client. */
export function chunkClientName(body: unknown): unknown {
  return obj(obj(body).extra).client;
}

/**
 * The chunk's repeat key: taskId when originalTaskId is set (the scraper
 * app's rewrite to "<task>-<chunk>"), else "<taskId>-<chunkIndex>" when
 * chunkIndex is a whole number, else taskId, else null (rows still dedupe by
 * place). An id over 500 characters is kept as its sha256.
 */
export function chunkId(body: unknown): string | null {
  const b = obj(body);
  const taskId = text(b.taskId, Infinity);
  if (!taskId) return null;
  const index = whole(b.chunkIndex);
  const id = text(b.originalTaskId, Infinity) ? taskId : index !== null ? `${taskId}-${index}` : taskId;
  return id.length <= CHUNK_ID_MAX ? id : `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

/**
 * One chunk as rows of the client's Companies (pipeline) table, with the
 * delivery's label and meta. `how` is the name check's answer, kept in the
 * meta with the name the chunk carried.
 */
export function mapsDelivery(body: unknown, tag: string, how: NameCheck["how"]) {
  const b = obj(body);
  const extra = obj(b.extra);
  const items = list(obj(b.postbackData).tasks)
    .flatMap((t) => list(obj(t).result))
    .flatMap((r) => list(obj(r).items));
  const rows: IncomingRow[] = items.map((item) => ({
    inputs: Object.fromEntries(Object.entries(placeInputs(item, b.extra ?? null, tag)).map(([k, v]) => [k, wellFormed(v)])),
  }));
  const keyword = text(extra.keyword);
  const city = text(extra.city);
  const state = text(extra.state);
  const label = [keyword, city, state].filter(Boolean).join(" · ").slice(0, TEXT_MAX) || "Google Maps";
  const meta = {
    task_id: text(b.originalTaskId) || text(b.taskId) || null,
    keyword: keyword || null,
    city: city || null,
    state: state || null,
    category: text(extra.category) || null,
    scrape_queue_id: text(extra.scrape_queue_id) || null,
    client_name: normName(extra.client) || null,
    name_check: how,
    chunk_index: whole(b.chunkIndex),
    total_chunks: whole(b.totalChunks),
  };
  return { rows, chunkId: chunkId(body), label, meta };
}

// ── Slots ───────────────────────────────────────────────────────────────────

let slotsInUse = 0;
const slotWaiters: Array<() => void> = [];

/** One of the intake's slots: true once taken, false when none came free within `waitMs`. Give it back with releaseIntakeSlot(). */
export function takeIntakeSlot(waitMs = SLOT_WAIT_MS): Promise<boolean> {
  if (slotsInUse < INTAKE_SLOTS) {
    slotsInUse++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      slotsInUse++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const i = slotWaiters.indexOf(wake);
      if (i >= 0) slotWaiters.splice(i, 1);
      resolve(false);
    }, waitMs);
    slotWaiters.push(wake);
  });
}

/** Gives a slot back; the delivery waiting longest takes it. */
export function releaseIntakeSlot(): void {
  slotsInUse = Math.max(0, slotsInUse - 1);
  slotWaiters.shift()?.();
}

// ── The client's Companies (pipeline) table ─────────────────────────────────

/** ensurePipelineTables()'s two refusals: the Clay originals are not loaded, or the client still has a retired companies_v1 table. */
export function isTablesRefusal(e: unknown): e is Error {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "OriginalsMissing" || name === "RetiredV1Table";
}

/**
 * The per-client lock under which a client's pipeline tables are made, for
 * the rest of the caller's transaction. The intake and the Clay tab's Create
 * take the same one, so two of them never make the tables at once.
 */
export async function lockPipelineTables(c: PoolClient, tag: string): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('enrich-pipeline-tables:' || $1))`, [tag]);
}

/** The client's three pipeline tables, made or brought up to date under the per-client lock. Throws as ensurePipelineTables() does. */
export async function ensureClientTables(c: PoolClient, tag: string) {
  await lockPipelineTables(c, tag);
  return ensurePipelineTables(c, tag);
}

async function findMapsTable(c: PoolClient, tag: string) {
  const { rows } = await c.query<{ id: string; keys: string[] }>(
    `SELECT t.id, coalesce(array_agg(k.key ORDER BY k.position) FILTER (WHERE k.key IS NOT NULL), '{}') AS keys
       FROM enrich_tables t
       LEFT JOIN enrich_columns k ON k.table_id = t.id AND k.kind = 'input'
      WHERE t.client_tag = $1 AND t.kind = 'companies' AND t.template = 'companies_v2'
      GROUP BY t.id`,
    [tag]
  );
  const t = rows[0];
  return t ? { id: t.id, inputKeys: t.keys, ready: t.keys.includes("place_id") } : null;
}

/**
 * The client's Companies (pipeline) table as Maps places need it (with its
 * place_id input), inside the caller's transaction. When it is missing, or
 * older than the Maps inputs, the client's three pipeline tables are made or
 * brought up to date under the per-client lock, in a savepoint. Null when
 * they can't be made now (isTablesRefusal); nothing is then written.
 */
export async function mapsTableFor(c: PoolClient, tag: string): Promise<{ id: string; inputKeys: string[] } | null> {
  let t = await findMapsTable(c, tag);
  if (t?.ready) return { id: t.id, inputKeys: t.inputKeys };
  await lockPipelineTables(c, tag);
  t = await findMapsTable(c, tag); // another delivery may have made it meanwhile
  if (!t?.ready) {
    await c.query("SAVEPOINT maps_table");
    try {
      await ensurePipelineTables(c, tag);
      await c.query("RELEASE SAVEPOINT maps_table");
    } catch (e) {
      if (!isTablesRefusal(e)) throw e;
      await c.query("ROLLBACK TO SAVEPOINT maps_table");
      return null;
    }
    t = await findMapsTable(c, tag);
  }
  return t?.ready ? { id: t.id, inputKeys: t.inputKeys } : null;
}
