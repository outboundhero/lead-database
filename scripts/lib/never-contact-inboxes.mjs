// Never-contact inboxes (migration 136, the client's answer of 2026-11-20):
// general inboxes the client's Clay General inboxes filter matches go on the
// never-contact list, and are not counted as good leads.
//
// The filter is the client's own text. It is read at run time from the Clay
// originals loaded in the database (enrich_originals, the "inboxes" kind):
// several of that table's columns only run for an address their run
// condition does not match, written as !/<filter>/i.test(<the email>). The
// seed takes the filter most of those columns share (it must hold
// customerservice@, the variant the client named; a tie, or none, is "not
// loaded") and stores it in enrich_settings.never_contact_inboxes (pattern,
// source, sha256, read_at). It is never written into this repo.
//
// Only leads with email_type 'general' are ever looked at: the filter also
// matches some company domains, so a personal address must never be touched.
//
//   dry run   counts the general inboxes the filter matches that are not on the
//             list yet (leads created up to now), with a sample of up to 5
//             addresses for each part of the filter; stored as a dry_run row.
//   apply     an admin names a dry run of the current filter made in the last
//             24 hours, after the owner approved its count. The topup-worker then
//             sweeps leads in (created_at, id) order up to that dry run's
//             bound, chunk_rows ids at a time, through
//             fn_suppress_general_inboxes(), the one writer of the reason
//             clay_general_filter: it adds the address to suppressed_emails,
//             flags its leads and queues the Bison unsubscribe (as the "Never
//             contact" action does), at most rows_per_day a UTC day. When the
//             backlog is done the apply follows new imports (leads created up
//             to 5 minutes ago) while the switch is on. Stop ends it.
//
// Nothing here writes suppressed_emails or leads itself.

import { createHash } from "node:crypto";
import { inboxPatternOf, settingsFrom } from "./enrich/settings.mjs";
import { NEVER_CONTACT_REASON } from "./overlap-topup.mjs";

/** The seed keeps only a filter holding this (the answers file: the variant with customerservice@). */
export const FILTER_MARKER = "customerservice@";
/** An apply must name a dry run at most this old. */
export const DRY_RUN_FRESH_HOURS = 24;
/** The follow step leaves leads younger than this for later (an import may still be committing). */
export const FOLLOW_LAG_MINUTES = 5;
export const SAMPLE_PER_PART = 5;
/** Leads read a statement while sweeping, in (created_at, id) order. */
export const SWEEP_WINDOW = 20_000;
const VARIANT_RE = /^[a-z0-9][a-z0-9_]*$/;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const fmt = (n) => Number(n).toLocaleString("en-US");

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {Db & { connect: () => Promise<Db & { release: () => void }> }} DbPool
 */

/**
 * The filters a run condition tests an address with, negated and case
 * blind: each `!/<re>/i.test(` in it, the regular expression's text.
 *
 * @param {unknown} formula  definition.settings.conditionalRunFormulaText
 * @returns {string[]}
 */
export function negatedFilterLiterals(formula) {
  const out = [];
  for (const m of String(formula ?? "").matchAll(/!\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)\.test\(/g)) {
    if (m[2] === "i") out.push(m[1]);
  }
  return out;
}

/**
 * The filter most columns share. Each column counts once for each different
 * filter it holds. None, a tie at the top, or a top filter without the marker
 * is "not loaded" (pattern null), with why.
 *
 * @param {Array<{ formula: unknown }>} columns
 * @param {{ marker?: string }} [opts]
 * @returns {{ pattern: string | null, used: number, total: number, why: string | null }}
 *   used: columns holding the filter picked; total: columns holding any filter
 */
export function pickFilter(columns, { marker = FILTER_MARKER } = {}) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  let total = 0;
  for (const col of columns) {
    const lits = [...new Set(negatedFilterLiterals(col.formula))];
    if (!lits.length) continue;
    total++;
    for (const l of lits) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  if (!counts.size) return { pattern: null, used: 0, total, why: "No General inboxes column's run condition holds a filter." };
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const [top, n] = ranked[0];
  if (ranked.length > 1 && ranked[1][1] === n) {
    return { pattern: null, used: n, total, why: `Two different filters are each shared by ${n} columns, so neither was picked.` };
  }
  if (!top.toLowerCase().includes(marker.toLowerCase())) {
    return { pattern: null, used: n, total, why: `The filter most columns share does not hold ${marker}, so it was not picked.` };
  }
  return { pattern: top, used: n, total, why: null };
}

/** The parts of a usable pattern: its alternatives, in order (the shape check allows no groups, so | splits them). */
export function filterParts(pattern) {
  return String(pattern ?? "").split("|");
}

/**
 * Reads the filter from the Clay originals of one variant (default unless told).
 *
 * @param {Db} db
 * @param {{ variant?: string, marker?: string }} [opts]
 * @returns {Promise<{ pattern: string | null, sha256: string | null, source: string, used: number, total: number, why: string | null }>}
 */
export async function readFilter(db, { variant = "default", marker = FILTER_MARKER } = {}) {
  if (!VARIANT_RE.test(variant)) throw new Error(`"${variant}" is not a variant name`);
  const { rows } = await db.query(
    `SELECT position, definition->'settings'->>'conditionalRunFormulaText' AS formula
       FROM enrich_originals WHERE template_kind = 'inboxes' AND variant = $1 ORDER BY position`,
    [variant]
  );
  if (!rows.length) {
    return { pattern: null, sha256: null, source: `${variant} inboxes`, used: 0, total: 0, why: `The Clay originals hold no General inboxes columns for ${variant}.` };
  }
  const pick = pickFilter(rows, { marker });
  const source = `${variant} inboxes: ${pick.used} of ${pick.total} run conditions`;
  if (!pick.pattern) return { pattern: null, sha256: null, source, used: pick.used, total: pick.total, why: pick.why };
  const sha256 = sha256Hex(pick.pattern);
  if (inboxPatternOf({ pattern: pick.pattern, sha256 }) !== pick.pattern) {
    return {
      pattern: null, sha256: null, source, used: pick.used, total: pick.total,
      why: "The filter read is not in a shape this can use (letters, digits, @ _ . - and \\. only, parts joined by |, none empty).",
    };
  }
  return { pattern: pick.pattern, sha256, source, used: pick.used, total: pick.total, why: null };
}

/**
 * The seed: reads the filter and stores it in the setting, leaving the switch
 * and the pace as they are. Writes nothing when no filter can be read. A live
 * apply of another filter is stopped: its count no longer holds.
 *
 * @param {Db} db  a client inside the caller's transaction
 * @param {{ variant?: string, marker?: string }} [opts]
 * @returns {Promise<{ loaded: boolean, source: string, sha256: string | null, parts: number, changed: boolean, why: string | null, stoppedApply: string | null }>}
 */
export async function seedFilter(db, { variant = "default", marker = FILTER_MARKER } = {}) {
  const read = await readFilter(db, { variant, marker });
  if (!read.pattern || !read.sha256) {
    return { loaded: false, source: read.source, sha256: null, parts: 0, changed: false, why: read.why, stoppedApply: null };
  }
  const { rows: [before] } = await db.query(`SELECT value FROM enrich_settings WHERE key = 'never_contact_inboxes' FOR UPDATE`);
  if (!before) throw new Error("The never_contact_inboxes setting is missing: apply migration 136 first.");
  await db.query(
    `UPDATE enrich_settings
        SET value = value || jsonb_build_object('pattern', $1::text, 'source', $2::text, 'sha256', $3::text,
                                                'read_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            updated_at = now()
      WHERE key = 'never_contact_inboxes'`,
    [read.pattern, read.source, read.sha256]
  );
  const changed = before.value?.sha256 !== read.sha256;
  let stoppedApply = null;
  if (changed) {
    const { rows } = await db.query(
      `UPDATE never_contact_inbox_runs
          SET state = 'stopped', finished_at = now(), last_error = 'The filter was read again and is different: run a new dry run.'
        WHERE kind = 'apply' AND state IN ('running', 'following') AND pattern_sha256 <> $1 RETURNING id`,
      [read.sha256]
    );
    stoppedApply = rows[0]?.id ?? null;
  }
  return { loaded: true, source: read.source, sha256: read.sha256, parts: filterParts(read.pattern).length, changed, why: null, stoppedApply };
}

/** The setting as stored, read fresh. */
async function settingOf(db) {
  const { rows } = await db.query(`SELECT key, value FROM enrich_settings WHERE key = 'never_contact_inboxes'`);
  const s = settingsFrom(rows);
  return { nc: s.never_contact_inboxes, on: s.flagOn("never_contact_inboxes", "") };
}

/**
 * The dry run: how many general inboxes the filter matches that are not on
 * the list yet (leads created up to now), and up to SAMPLE_PER_PART addresses
 * for each part. Stored as a dry_run row an admin can then apply. Read only
 * on leads; works whether the switch is on or off.
 *
 * @param {Db} db  a client inside the caller's transaction (with its own statement timeout)
 * @param {{ by?: string | null }} [opts]
 * @returns {Promise<{ run: any } | { status: number, error: string }>}
 */
export async function dryRun(db, { by = null } = {}) {
  const { nc } = await settingOf(db);
  if (!nc.pattern || !nc.sha256) {
    return { status: 409, error: "The Clay General inboxes filter is not loaded. Run the seed first (node scripts/never-contact-inboxes.mjs --seed)." };
  }
  const parts = filterParts(nc.pattern);
  const { rows: [r] } = await db.query(
    `WITH m AS (
       SELECT DISTINCT lower(btrim(l.email)) AS email
         FROM leads l
        WHERE l.email_type = 'general' AND btrim(coalesce(l.email, '')) <> '' AND l.email ~* $1
          AND l.created_at IS NOT NULL AND l.created_at <= now()
          AND NOT EXISTS (SELECT 1 FROM suppressed_emails s WHERE s.email = lower(btrim(l.email)))
     ), p AS (
       SELECT a.ord::int AS ord, m.email, row_number() OVER (PARTITION BY a.ord ORDER BY m.email) AS rn,
              count(*) OVER (PARTITION BY a.ord) AS n
         FROM m JOIN unnest($2::text[]) WITH ORDINALITY AS a(part, ord) ON m.email ~* a.part
     )
     SELECT (SELECT count(*)::int FROM m) AS counted,
            coalesce((SELECT jsonb_object_agg(ord::text, jsonb_build_object('count', n, 'sample', sample))
                        FROM (SELECT ord, max(n)::int AS n, jsonb_agg(email ORDER BY email) FILTER (WHERE rn <= $3) AS sample
                                FROM p GROUP BY ord) z), '{}'::jsonb) AS parts`,
    [nc.pattern, parts, SAMPLE_PER_PART]
  );
  const sample = {
    parts: parts.map((part, i) => {
      const hit = r.parts?.[String(i + 1)];
      return { part, count: hit?.count ?? 0, sample: hit?.sample ?? [] };
    }),
  };
  const { rows: [run] } = await db.query(
    `INSERT INTO never_contact_inbox_runs (kind, state, pattern_sha256, bound_at, counted, sample, created_by, started_at, finished_at)
     VALUES ('dry_run', 'done', $1, now(), $2, $3::jsonb, $4, now(), clock_timestamp())
     RETURNING *`,
    [nc.sha256, r.counted, JSON.stringify(sample), by]
  );
  return { run };
}

/**
 * The apply an admin starts on an approved dry run. The topup-worker does the
 * work (sweep()); this only records it, once checked: the switch on and the
 * filter loaded, the dry run of the current filter and at most 24 hours old,
 * no other apply live.
 *
 * @param {Db} db
 * @param {{ dryRunId: string, by?: string | null }} opts
 * @returns {Promise<{ run: any } | { status: number, error: string }>}
 */
export async function startApply(db, { dryRunId, by = null }) {
  const { nc, on } = await settingOf(db);
  if (!nc.pattern || !nc.sha256) return { status: 409, error: "The Clay General inboxes filter is not loaded, so nothing can be applied." };
  if (!on) return { status: 409, error: "Never-contact inboxes are switched off. Switch them on in the Companies settings first, then apply." };
  const { rows: [dry] } = await db.query(
    `SELECT *, created_at > now() - make_interval(hours => $2) AS fresh FROM never_contact_inbox_runs WHERE id = $1`,
    [dryRunId, DRY_RUN_FRESH_HOURS]
  );
  if (!dry || dry.kind !== "dry_run" || dry.state !== "done") return { status: 404, error: "That is not a finished dry run." };
  if (dry.pattern_sha256 !== nc.sha256) return { status: 409, error: "That dry run counted another filter. Run a new dry run." };
  if (!dry.fresh) return { status: 409, error: `That dry run is more than ${DRY_RUN_FRESH_HOURS} hours old. Run a new one and check its count.` };
  const { rows } = await db.query(
    `INSERT INTO never_contact_inbox_runs (kind, state, pattern_sha256, dry_run_id, bound_at, counted, created_by, started_at)
     VALUES ('apply', 'running', $1, $2, $3, $4, $5, now())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [nc.sha256, dry.id, dry.bound_at, dry.counted, by]
  );
  if (!rows[0]) return { status: 409, error: "An apply is already running. Stop it first." };
  return { run: rows[0] };
}

/**
 * Stops the live apply (running or following), if any.
 *
 * @param {Db} db
 * @returns {Promise<any | null>} the stopped run
 */
export async function stopApply(db) {
  const { rows } = await db.query(
    `UPDATE never_contact_inbox_runs SET state = 'stopped', finished_at = now()
      WHERE kind = 'apply' AND state IN ('running', 'following') RETURNING *`
  );
  return rows[0] ?? null;
}

/**
 * Addresses marked today (UTC) with this reason, and the day's cap.
 * @param {Db} db
 */
export async function todayCount(db) {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM suppressed_emails
      WHERE reason = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [NEVER_CONTACT_REASON]
  );
  return r.n;
}

/**
 * What the General inboxes panel shows: whether the filter is loaded (never
 * the filter itself), the switch and pace, today's and all marks, the live
 * apply, the latest dry run (with its parts and sample) and recent runs.
 *
 * @param {Db} db
 */
export async function neverContactStatus(db) {
  const { nc, on } = await settingOf(db);
  const { rows: [{ total }] } = await db.query(
    `SELECT count(*)::int AS total FROM suppressed_emails WHERE reason = $1`, [NEVER_CONTACT_REASON]);
  const today = await todayCount(db);
  const { rows: runs } = await db.query(
    `SELECT r.id, r.kind, r.state, left(r.pattern_sha256, 12) AS sha12, r.dry_run_id, r.bound_at, r.counted, r.cursor_created_at,
            r.suppressed, r.leads_flagged, r.bison_queued, r.created_at, r.started_at, r.finished_at, r.last_error,
            up.full_name AS created_by_name,
            (r.kind = 'dry_run' AND r.state = 'done' AND r.pattern_sha256 = $1
             AND r.created_at > now() - make_interval(hours => $2)) AS can_apply,
            CASE WHEN r.kind = 'dry_run' THEN r.sample END AS sample
       FROM never_contact_inbox_runs r LEFT JOIN user_profiles up ON up.id = r.created_by
      ORDER BY r.created_at DESC LIMIT 10`,
    [nc.sha256 ?? "", DRY_RUN_FRESH_HOURS]
  );
  const live = runs.find((r) => r.kind === "apply" && (r.state === "running" || r.state === "following")) ?? null;
  const latestDryRun = runs.find((r) => r.kind === "dry_run") ?? null;
  return {
    loaded: Boolean(nc.pattern),
    source: nc.source,
    readAt: nc.read_at,
    sha12: nc.sha256 ? nc.sha256.slice(0, 12) : null,
    parts: nc.pattern ? filterParts(nc.pattern).length : 0,
    enabled: nc.enabled,
    on,
    rowsPerDay: nc.rows_per_day,
    chunkRows: nc.chunk_rows,
    today,
    total,
    live,
    latestDryRun,
    runs: runs.map(({ sample, ...r }) => (r.id === latestDryRun?.id ? { ...r, sample } : r)),
  };
}

/**
 * The topup-worker's step: works the live apply while the switch is on.
 * Reads leads in (created_at, id) order after its cursor, up to the dry run's
 * bound (state running) or up to FOLLOW_LAG_MINUTES ago (state following,
 * once the backlog is done), SWEEP_WINDOW at a time, and hands the general
 * inboxes the filter matches to fn_suppress_general_inboxes() chunk_rows ids
 * a call, each call in one transaction with the run's counts and cursor. It
 * stops for the day when the day's cap is used, and when `deadline` passes.
 *
 * @param {DbPool} pool
 * @param {{ deadline?: number, log?: (m: string) => void }} [opts]
 * @returns {Promise<{ idle: string | null, suppressed: number, leadsFlagged: number, bisonQueued: number, capped: boolean, state: string | null }>}
 */
export async function sweep(pool, { deadline = Infinity, log = () => {} } = {}) {
  const out = { idle: null, suppressed: 0, leadsFlagged: 0, bisonQueued: 0, capped: false, state: null };
  const { nc, on } = await settingOf(pool);
  if (!on) return { ...out, idle: "switched off or no filter loaded" };
  const { rows: [live] } = await pool.query(
    `SELECT r.*, up.full_name AS by_name FROM never_contact_inbox_runs r LEFT JOIN user_profiles up ON up.id = r.created_by
      WHERE r.kind = 'apply' AND r.state IN ('running', 'following') LIMIT 1`
  );
  if (!live) return { ...out, idle: "no apply" };
  out.state = live.state;
  if (live.pattern_sha256 !== nc.sha256) {
    await pool.query(
      `UPDATE never_contact_inbox_runs SET state = 'error', finished_at = now(),
              last_error = 'The filter changed since this apply was approved: run a new dry run.'
        WHERE id = $1 AND state IN ('running', 'following')`,
      [live.id]
    );
    return { ...out, idle: "the filter changed", state: "error" };
  }
  if ((await todayCount(pool)) >= nc.rows_per_day) return { ...out, capped: true };

  let state = live.state;
  while (Date.now() < deadline) {
    // The cursor and the bound as Postgres prints them, so no microsecond is lost on the way.
    const { rows: [cur] } = await pool.query(
      `SELECT state, coalesce(cursor_created_at, '-infinity'::timestamptz)::text AS at, coalesce(cursor_id, $2::uuid) AS id,
              (CASE WHEN state = 'running' THEN bound_at ELSE now() - make_interval(mins => $3) END)::text AS upper
         FROM never_contact_inbox_runs WHERE id = $1`,
      [live.id, ZERO_UUID, FOLLOW_LAG_MINUTES]
    );
    if (!cur || (cur.state !== "running" && cur.state !== "following")) break;
    state = cur.state;
    const c = await pool.connect();
    let window;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout = 60000");
      ({ rows: [window] } = await c.query(
        `WITH w AS (
           SELECT l.id, l.created_at,
                  (l.email_type = 'general' AND btrim(coalesce(l.email, '')) <> '' AND l.email ~* $4
                   AND NOT EXISTS (SELECT 1 FROM suppressed_emails s WHERE s.email = lower(btrim(l.email)))) AS hit
             FROM leads l
            WHERE l.created_at IS NOT NULL AND (l.created_at, l.id) > ($1::timestamptz, $2::uuid) AND l.created_at <= $3::timestamptz
            ORDER BY l.created_at, l.id
            LIMIT $5
         )
         SELECT count(*)::int AS n,
                (array_agg(created_at::text ORDER BY created_at DESC, id DESC))[1] AS last_at,
                (array_agg(id ORDER BY created_at DESC, id DESC))[1] AS last_id,
                coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', created_at::text) ORDER BY created_at, id) FILTER (WHERE hit),
                         '[]'::jsonb) AS hits
           FROM w`,
        [cur.at, cur.id, cur.upper, nc.pattern, SWEEP_WINDOW]
      ));
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    if (window.n === 0) {
      if (state === "running") {
        // The backlog is done: from now on, follow new imports.
        const { rowCount } = await pool.query(
          `UPDATE never_contact_inbox_runs SET state = 'following' WHERE id = $1 AND state = 'running'`, [live.id]);
        if (!rowCount) break;
        state = "following";
        log(`never-contact inboxes: the backlog is done (${fmt(out.suppressed)} marked this firing); following new imports`);
        continue;
      }
      break;
    }
    /** @type {Array<{ id: string, at: string }>} */
    const hits = window.hits;
    let stopped = false;
    for (let i = 0; i < hits.length; i += nc.chunk_rows) {
      const chunk = hits.slice(i, i + nc.chunk_rows);
      const last = chunk[chunk.length - 1];
      const r = await chunkStep(pool, live, nc.sha256, chunk.map((h) => h.id), last);
      if (!r) {
        stopped = true; // stopped by an admin meanwhile
        break;
      }
      out.suppressed += r.suppressed;
      out.leadsFlagged += r.leads_flagged;
      out.bisonQueued += r.bison_queued;
      if (r.cap_left === 0) {
        out.capped = true;
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    // Every hit of the window is done: the cursor moves past the whole window.
    const { rowCount } = await pool.query(
      `UPDATE never_contact_inbox_runs SET cursor_created_at = $2::timestamptz, cursor_id = $3
        WHERE id = $1 AND state IN ('running', 'following')`,
      [live.id, window.last_at, window.last_id]
    );
    if (!rowCount) break;
  }
  const { rows: [after] } = await pool.query(`SELECT state FROM never_contact_inbox_runs WHERE id = $1`, [live.id]);
  out.state = after?.state ?? state;
  if (out.suppressed) {
    log(`never-contact inboxes: ${fmt(out.suppressed)} general inboxes marked never contact, ${fmt(out.leadsFlagged)} leads flagged, ` +
      `${fmt(out.bisonQueued)} Bison unsubscribes queued${out.capped ? " (the day's cap is reached)" : ""}`);
  }
  return out;
}

/**
 * One call of the writer and the run's counts, in one transaction, the run
 * row locked so a Stop waits for it. The cursor moves to the chunk's last
 * lead only when the call was not cut short by the day's cap (cap_left > 0):
 * a cut chunk is done again the next day, and the addresses it already marked
 * are skipped then. Null when the run is no longer live.
 */
async function chunkStep(pool, live, sha256, ids, last) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout = 120000");
    const { rows: [run] } = await c.query(
      `SELECT state FROM never_contact_inbox_runs WHERE id = $1 FOR UPDATE`, [live.id]);
    if (!run || (run.state !== "running" && run.state !== "following")) {
      await c.query("ROLLBACK");
      return null;
    }
    const { rows: [r] } = await c.query(
      `SELECT * FROM public.fn_suppress_general_inboxes($1::uuid[], $2, $3, $4, $5)`,
      [ids, sha256, live.id, live.created_by, live.by_name ?? null]
    );
    await c.query(
      `UPDATE never_contact_inbox_runs
          SET suppressed = suppressed + $2, leads_flagged = leads_flagged + $3, bison_queued = bison_queued + $4,
              cursor_created_at = CASE WHEN $5 THEN $6::timestamptz ELSE cursor_created_at END,
              cursor_id = CASE WHEN $5 THEN $7::uuid ELSE cursor_id END
        WHERE id = $1`,
      [live.id, r.suppressed, r.leads_flagged, r.bison_queued, r.cap_left > 0, last.at, last.id]
    );
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
