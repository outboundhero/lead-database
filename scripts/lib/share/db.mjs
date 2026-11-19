// Small database helpers the share step and the Sharing page's actions share
// (scripts/lib/share/). Plain JavaScript: the enrich-worker, the seed script
// and the web app's routes all load it.
//
// Every statement runs in a transaction of its own with SET LOCAL
// statement_timeout: DATABASE_URL is the transaction pooler, where a
// session-level SET leaks onto other clients (src/lib/uploads/import-rows.ts:32-34).

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {Db & { release: (err?: Error | boolean) => void }} Client
 * @typedef {Db & { connect: () => Promise<Client> }} Pool
 */

/** What a database without migrations 133 and 134 answers: no table (42P01), no column (42703), no function (42883). */
export const SHARE_UNREADY = new Set(["42P01", "42703", "42883"]);

/** Is this error a missing migration (the step then stays idle)? */
export function isUnready(e) {
  return SHARE_UNREADY.has(/** @type {{ code?: string }} */ (e)?.code ?? "");
}

/** Each statement's limit, under the worker's 70-second query timeout (scripts/enrich-worker.mjs). */
export const STATEMENT_TIMEOUT = "60s";

/**
 * Runs fn in one transaction on a client of its own, with SET LOCAL
 * statement_timeout. Rolls back on any error and throws it on.
 *
 * @template T
 * @param {Pool} pool
 * @param {(c: Client) => Promise<T>} fn
 * @param {{ timeout?: string, readOnly?: boolean }} [opts]
 * @returns {Promise<T>}
 */
export async function inTx(pool, fn, { timeout = STATEMENT_TIMEOUT, readOnly = false } = {}) {
  const c = await pool.connect();
  let dead = undefined;
  try {
    await c.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await c.query(`SET LOCAL statement_timeout = '${timeout}'`);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch((e2) => {
      dead = e2;
    });
    throw e;
  } finally {
    c.release(dead);
  }
}

/** One read statement in a read-only transaction of its own. */
export async function read(pool, sql, params = []) {
  return inTx(pool, (c) => c.query(sql, params), { readOnly: true });
}

/** SQL: the start of today's UTC day, as a timestamptz. */
export const UTC_DAY_START = `(date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')`;

/** SQL: the exact, comma-bounded, any-case test for one tag in leads.tags (119_leads_search_speed.sql:683), the tag bound at ref. */
export function tagTestSql(alias = "l", ref = "$1") {
  return `coalesce(${alias}.tags ~* ('(^|,)\\s*' || public.fn_regex_escape(${ref}) || '\\s*(,|$)'), false)`;
}

/** Splits a list into slices of at most n. */
export function slices(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Is this a uuid in text? */
export const isUuid = (v) => typeof v === "string" && UUID.test(v);
