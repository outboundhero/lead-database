// HTTP for the Clay tab's actions (actions.mjs, pipeline-actions.mjs,
// email-vendors.mjs): JSON over fetch, never throwing for an HTTP status, and
// the rule that a paid request with no answer is sent at most twice.
//
// A paid call is made once per attempt (tries: 1). The row-level retry of the
// worker (scripts/enrich-worker.mjs) handles a lost answer, with its backoff.
// A request that timed out may still have been billed, so a cell is sent at
// most twice with no answer (counted from enrich_cell_runs), then it ends in an
// error until a person re-runs it.
//
// A rate limit is the one answer a paid call waits out in place (paidHttpJson,
// below): a 429 is not billed, so the same request goes again after the wait
// the answer asks for, instead of the row going back to the queue.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESPONSE_CAP = 32_000;

/** A provider answer cut down to what enrich_cell_runs keeps. */
export function capped(value) {
  if (value == null) return null;
  const s = JSON.stringify(value);
  return s.length <= RESPONSE_CAP ? value : { truncated: true, head: s.slice(0, RESPONSE_CAP) };
}

/**
 * A provider answer as a run record keeps it, with `extra` (the rate-limit
 * headers, the waits) beside its own fields; the answer as it is when there
 * is nothing extra.
 *
 * @param {any} json
 * @param {Record<string, unknown>} extra
 */
export function answerWith(json, extra) {
  if (!Object.keys(extra).length) return json;
  if (json == null) return { ...extra };
  return typeof json === "object" && !Array.isArray(json) ? { ...json, ...extra } : { body: json, ...extra };
}

/**
 * JSON over HTTP, retrying 429s, 5xx and network errors `tries` times (3 by
 * default; paid calls pass 1). Never throws for an HTTP status: the caller
 * decides what a status means. The error text holds no request URL.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number, tries?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, json: any, error: string | null, headers?: Headers | null }>}
 */
export async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 30_000, tries = 3 } = {}) {
  let last = { ok: false, status: 0, json: null, error: "no attempt", headers: null };
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      const raw = await res.text();
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* not JSON */
      }
      last = { ok: res.ok, status: res.status, json, error: res.ok ? null : `HTTP ${res.status}: ${raw.slice(0, 200)}`, headers: res.headers };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      last = { ok: false, status: 0, json: null, error: timeout ? `timed out after ${timeoutMs / 1000}s` : e?.cause?.code || e?.message || "request failed", headers: null };
    }
    if (attempt < tries) await sleep(2_000 * attempt);
  }
  return last;
}

export const retryableStatus = (s) => s === 0 || s === 429 || s >= 500;

// ── Rate limits, waited out in place ────────────────────────────────────────
// A paid call's 429 that is a plain rate limit (the caller tells it apart from
// a billing, quota or credits refusal, which stops as before and is never sent
// again) is waited out and the same request sent again. The wait is what the
// answer asks for: retry-after-ms, then Retry-After (seconds or a date), then
// the answer's own words ("Please try again in 1.5s": OpenAI's message gives
// the wait this very request needs), then the x-ratelimit-reset-* header of
// the limit used up (its remaining is 0; else the longest of them), else 2 s,
// 4 s, 8 s. A little jitter is added, so slots that hit the limit together do
// not all come back at once. Bounds: each wait at most 60 s, at most 3 retries,
// at most 2 minutes of waiting for one call. Past them the 429 is answered as
// before and the row is tried again later with its backoff.
//
// A 429 is not billed, so a retry never pays twice. A send with no answer
// (status 0) is never sent again here: the lost-send guard below counts it, as
// before. Any other status is answered at once.

/** The bounds of the waits for one paid call. */
export const RATE_LIMIT_RETRY = Object.freeze({ retries: 3, waitMaxMs: 60_000, totalMaxMs: 120_000, waitMinMs: 250, jitterMs: 500 });

const rateDeps = { sleep, random: Math.random, now: Date.now };

/**
 * For tests: stand-ins for the wait, the jitter and the clock. Returns the
 * ones in force before, to put back.
 *
 * @param {Partial<typeof rateDeps>} deps
 */
export function setRateLimitDeps(deps = {}) {
  const before = { ...rateDeps };
  Object.assign(rateDeps, deps);
  return before;
}

const DURATION_PART = /^(\d+(?:\.\d+)?)(ms|h|m|s)/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * A duration in ms: plain seconds ("30", "1.5") or as OpenAI writes it ("20ms",
 * "1.5s", "6m0s", "1h2m3s"). Null for anything else.
 *
 * @param {unknown} v
 * @returns {number | null}
 */
export function durationMs(v) {
  let rest = String(v ?? "").trim().toLowerCase();
  if (!rest) return null;
  if (/^\d+(\.\d+)?$/.test(rest)) return Math.round(Number(rest) * 1_000);
  let total = 0;
  while (rest) {
    const m = DURATION_PART.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * UNIT_MS[/** @type {keyof typeof UNIT_MS} */ (m[2])];
    rest = rest.slice(m[0].length);
  }
  return Math.round(total);
}

/** A reset header in ms from now: a duration, or a Unix time (seconds or ms) some APIs send instead. */
function resetMs(v, now) {
  const n = Number(v);
  if (v !== "" && Number.isFinite(n) && n > 1e12) return Math.max(0, n - now);
  if (v !== "" && Number.isFinite(n) && n > 1e9) return Math.max(0, n * 1_000 - now);
  return durationMs(v);
}

/**
 * The wait a rate-limited answer asks for, in ms, or null when it says nothing
 * usable (then the caller backs off on its own).
 *
 * @param {{ headers?: { get: (name: string) => string | null } | null, json?: any, error?: string | null }} r
 * @param {number} [now]
 * @returns {number | null}
 */
export function askedWaitMs(r, now = rateDeps.now()) {
  const headers = r?.headers && typeof r.headers.get === "function" ? r.headers : null;
  const get = (k) => String(headers?.get(k) ?? "").trim();
  const ms = get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Math.round(Number(ms));
  const after = get("retry-after");
  if (after) {
    if (/^\d+(\.\d+)?$/.test(after)) return Math.round(Number(after) * 1_000);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const words = [r?.json?.error?.message, r?.json?.message, r?.error].filter((s) => typeof s === "string").join(" ");
  const go = /try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(words);
  if (go && durationMs(go[1]) != null) return durationMs(go[1]);
  const secs = /(?:retry|try again) (?:after|in) (\d+(?:\.\d+)?) ?(?:seconds?|secs?|s)\b/i.exec(words);
  if (secs) return Math.round(Number(secs[1]) * 1_000);
  const resets = [];
  for (const kind of ["-requests", "-tokens", ""]) {
    const d = resetMs(get(`x-ratelimit-reset${kind}`), now);
    if (d != null) resets.push({ d, usedUp: get(`x-ratelimit-remaining${kind}`) === "0" });
  }
  if (!resets.length) return null;
  const usedUp = resets.filter((x) => x.usedUp);
  return Math.max(...(usedUp.length ? usedUp : resets).map((x) => x.d));
}

// Since the process started: the sends made again after a rate limit, the time
// waited, and the calls still rate limited after their waits (the row then
// went back to the queue as before). The worker's heartbeat carries them, so
// a raised ENRICH_CONCURRENCY can be judged by how often the limits are met.
const waitTotals = { retries: 0, waited_ms: 0, gave_up: 0 };

/** The rate-limit waits of this process so far: { retries, waited_ms, gave_up }. */
export function rateLimitWaits() {
  return { ...waitTotals };
}

/**
 * JSON over HTTP for a paid call: one send, and the same request again after
 * each rate limit waited out (see above). `isRateLimit(answer)` is asked about
 * each 429 and must say no to a billing, quota or credits refusal, which is
 * then answered at once, as before. The answer is httpJson's, the last one
 * received, with rate_limited: { retries, waited_ms } when it waited, else
 * null.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} opts  as httpJson's; always one try
 * @param {{ isRateLimit: (answer: { status: number, json: any, error: string | null, headers?: Headers | null }) => boolean }} rule
 * @returns {Promise<{ ok: boolean, status: number, json: any, error: string | null, headers?: Headers | null,
 *   rate_limited: { retries: number, waited_ms: number } | null }>}
 */
export async function paidHttpJson(url, opts, { isRateLimit }) {
  const waits = { retries: 0, waited_ms: 0 };
  for (;;) {
    const r = await httpJson(url, { ...opts, tries: 1 });
    const limited = r.status === 429 && isRateLimit(r);
    let wait = null;
    if (limited && waits.retries < RATE_LIMIT_RETRY.retries) {
      const asked = askedWaitMs(r) ?? 2_000 * 2 ** waits.retries;
      const jitter = Math.floor(rateDeps.random() * RATE_LIMIT_RETRY.jitterMs);
      wait = Math.min(RATE_LIMIT_RETRY.waitMaxMs, Math.max(RATE_LIMIT_RETRY.waitMinMs, asked) + jitter);
      if (waits.waited_ms + wait > RATE_LIMIT_RETRY.totalMaxMs) wait = null;
    }
    if (wait == null) {
      if (limited) waitTotals.gave_up++;
      return { ...r, rate_limited: waits.retries ? { ...waits } : null };
    }
    await rateDeps.sleep(wait);
    waits.retries++;
    waits.waited_ms += wait;
    waitTotals.retries++;
    waitTotals.waited_ms += wait;
  }
}

/** How many sends a paid cell may make with no answer before it stops. */
export const MAX_LOST_SENDS = 2;

/**
 * The sends of one cell that got no answer at all (no HTTP status: a timeout
 * or a dropped connection) since its last answered run.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } | null | undefined} db
 * @param {{ id?: number | string } | null | undefined} row
 * @param {{ key?: string } | null | undefined} column
 * @returns {Promise<number>}
 */
export async function lostSends(db, row, column) {
  if (!db || row?.id == null || !column?.key) return 0;
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM enrich_cell_runs r
      WHERE r.row_id = $1 AND r.column_key = $2 AND r.status = 'error' AND coalesce(r.http_status, 0) = 0
        AND r.id > coalesce((SELECT max(d.id) FROM enrich_cell_runs d
                              WHERE d.row_id = $1 AND d.column_key = $2 AND d.status IN ('done', 'empty')), 0)`,
    [row.id, column.key]
  );
  return Number(rows?.[0]?.n ?? 0);
}

/** A forced re-run (run_force holds the column, or "*") may send again. */
export const forcedFor = (row, column) => Array.isArray(row?.run_force) && row.run_force.some((k) => k === "*" || k === column?.key);

/**
 * Refuses a paid send when this cell was already sent twice with no answer,
 * unless a person forced it again. Returns the cell to write, or null to go on.
 */
export async function lostSendGuard({ db, row, column }) {
  if (forcedFor(row, column)) return null;
  let n = 0;
  try {
    n = await lostSends(db, row, column);
  } catch {
    n = 0; // a test or a fake db without the table: no history to read
  }
  if (n < MAX_LOST_SENDS) return null;
  return {
    status: "error",
    note: `Sent ${n} times with no answer, so it is not sent again: a request that timed out may still be billed. Re-run the cell to send it once more.`,
    retryable: false,
  };
}
