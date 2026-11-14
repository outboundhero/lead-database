// Removing bad fits from campaigns, only by a person (2B.8). The queries and
// the live check behind scripts/bison-campaign-removal-worker.mjs --reason=fit,
// kept here so the tests call them with a stubbed fetch.
//
//   1. fn_queue_fit_removals (migration 126) puts approved review items into
//      bison_campaign_removals as 'fit_held': a status no other run reads, and
//      never 'pending' (a CHECK forbids it), so no misroute run, old checkout
//      or new, can touch them.
//   2. A dry run reads each held lead live from Bison and writes a
//      fit_removal_dry_runs record: the rows, their sha256, and how many it
//      would remove, skip (replied or interested, read live) or cannot confirm.
//      It marks nothing.
//   3. A real run names that dry run (--confirm): under 24 hours old, unused,
//      the same client and install, and its rows still exactly the rows held.
//      It reads each lead live again right before its DELETE.
//
// The live check fails closed: a lead is removed only when Bison's answer has
// lead_campaign_data as a list that includes the campaign, every entry shows
// replies 0 and interested false, and the lead's own replies (overall_stats)
// are 0. Anything missing, null or of another type is "cannot confirm", and
// the row is skipped. Bison's docs were wrong about this field before
// (bison-unsubscribe-worker.mjs), and that the single-lead endpoint returns it
// is not yet seen live: the first dry run's "cannot confirm" count shows it.

import { createHash } from "node:crypto";

export const CANNOT_CONFIRM = "cannot confirm";
export const DRY_RUN_HOURS = 24;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {{ id: number, client_tag: string, instance_url: string, campaign_id: string, bison_lead_id: number,
 *             email: string | null }} HeldRow
 */

/**
 * The fit rows held for a client (and one install, when given), in id order.
 *
 * @param {Db} db
 * @param {{ tag: string, instance?: string | null }} p
 * @returns {Promise<HeldRow[]>}
 */
export async function heldRows(db, { tag, instance = null }) {
  const { rows } = await db.query(
    `SELECT id, client_tag, instance_url, campaign_id, bison_lead_id, email
       FROM bison_campaign_removals
      WHERE reason = 'fit' AND status = 'fit_held' AND client_tag = $1 AND ($2::text IS NULL OR instance_url = $2)
      ORDER BY id`,
    [tag, instance]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), bison_lead_id: Number(r.bison_lead_id) }));
}

/** The sha256 of a set of row ids, sorted: what a real run compares with its dry run. */
export function rowsSha(ids) {
  return createHash("sha256").update([...ids].map(Number).sort((a, b) => a - b).join(",")).digest("hex");
}

/**
 * May this lead be removed from this campaign, by what Bison says now? Fails
 * closed. { remove: true } only when the answer shows every campaign with
 * replies 0 and interested false, this campaign among them, and the lead's own
 * replies 0. Otherwise { remove: false, why }, why being "replied",
 * "interested" or "cannot confirm" (with what was missing).
 *
 * @param {any} answer  Bison's GET /api/leads/{id} answer (or its data)
 * @param {string | number | null} [campaignId]
 * @returns {{ remove: boolean, why: string | null, confirmed: boolean }}
 */
export function liveCheck(answer, campaignId = null) {
  const cannot = (what) => ({ remove: false, why: `${CANNOT_CONFIRM}: ${what}`, confirmed: false });
  const lead = answer && typeof answer === "object" && answer.data && typeof answer.data === "object" ? answer.data : answer;
  if (!lead || typeof lead !== "object" || Array.isArray(lead)) return cannot("no lead in the answer");
  const camps = lead.lead_campaign_data;
  if (!Array.isArray(camps)) return cannot("no lead_campaign_data list");
  let inCampaign = campaignId == null;
  for (const c of camps) {
    if (!c || typeof c !== "object") return cannot("a campaign entry is not an object");
    if (typeof c.replies !== "number" || !Number.isFinite(c.replies)) return cannot("a campaign entry has no replies count");
    if (typeof c.interested !== "boolean") return cannot("a campaign entry has no interested flag");
    if (c.replies !== 0) return { remove: false, why: "replied", confirmed: true };
    if (c.interested !== false) return { remove: false, why: "interested", confirmed: true };
    if (campaignId != null && String(c.campaign_id ?? c.id ?? "") === String(campaignId)) inCampaign = true;
  }
  const own = lead.overall_stats?.replies;
  if (typeof own !== "number" || !Number.isFinite(own)) return cannot("no replies count for the lead");
  if (own !== 0) return { remove: false, why: "replied", confirmed: true };
  if (!inCampaign) return cannot("the campaign is not among the lead's campaigns");
  return { remove: true, why: null, confirmed: true };
}

/**
 * Writes a dry run's record and returns its id. It marks no row.
 *
 * @param {Db} db
 * @param {{ tag: string, instance?: string | null, rows: HeldRow[],
 *           counts: { remove: number, skip: number, cannot: number }, runBy?: string | null }} p
 * @returns {Promise<string>}
 */
export async function recordDryRun(db, { tag, instance = null, rows, counts, runBy = null }) {
  const ids = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
  const { rows: [r] } = await db.query(
    `INSERT INTO fit_removal_dry_runs (client_tag, instance_url, row_ids, rows_sha256, would_remove, would_skip, cannot_confirm, run_by)
     VALUES ($1, $2, $3::bigint[], $4, $5, $6, $7, $8)
     RETURNING id`,
    [tag, instance, ids, rowsSha(ids), counts.remove ?? 0, counts.skip ?? 0, counts.cannot ?? 0, runBy]
  );
  return r.id;
}

/**
 * The rows a real run may act on, or why not: the dry run must be under 24
 * hours old, unused, for the same client and install, and its rows exactly the
 * rows held now. On success it is marked used (once only), in one transaction
 * with the check.
 *
 * @param {Db} db  a client (it runs BEGIN and COMMIT)
 * @param {{ id: string, tag: string, instance?: string | null }} p
 * @returns {Promise<{ ok: true, rows: HeldRow[] } | { ok: false, why: string }>}
 */
export async function confirmDryRun(db, { id, tag, instance = null }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id ?? ""))) {
    return { ok: false, why: "--confirm must name a dry run's id" };
  }
  await db.query("BEGIN");
  try {
    const { rows: [d] } = await db.query(
      `SELECT id, client_tag, instance_url, rows_sha256, used_at, created_at > now() - make_interval(hours => $2) AS fresh
         FROM fit_removal_dry_runs WHERE id = $1 FOR UPDATE`,
      [id, DRY_RUN_HOURS]
    );
    const refuse = async (why) => {
      await db.query("ROLLBACK");
      return { ok: false, why };
    };
    if (!d) return await refuse("No such dry run");
    if (d.used_at) return await refuse("That dry run was used already: make a new one");
    if (!d.fresh) return await refuse(`That dry run is over ${DRY_RUN_HOURS} hours old: make a new one`);
    if (d.client_tag !== tag) return await refuse(`That dry run is for ${d.client_tag}, not ${tag}`);
    if ((d.instance_url ?? null) !== (instance ?? null)) return await refuse("That dry run was for another install (or for all of them)");
    const rows = await heldRows(db, { tag, instance });
    if (rowsSha(rows.map((r) => r.id)) !== d.rows_sha256) {
      return await refuse("The rows held changed since that dry run: make a new one");
    }
    await db.query(`UPDATE fit_removal_dry_runs SET used_at = now() WHERE id = $1`, [id]);
    await db.query("COMMIT");
    return { ok: true, rows };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/**
 * Settles fit rows after a real run: 'done' (removed, or already not in the
 * campaign), 'skipped' (the live check said no), 'failed' (Bison refused).
 * Only rows still 'fit_held' are written.
 *
 * @param {Db} db
 * @param {Array<{ id: number, status: "done" | "skipped" | "failed", why?: string | null, dryRunId?: string | null }>} rows
 * @returns {Promise<number>}
 */
export async function finishRows(db, rows) {
  const list = (rows ?? []).filter((r) => ["done", "skipped", "failed"].includes(r.status));
  if (!list.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE bison_campaign_removals b
        SET status = x.status, attempts = b.attempts + 1, last_error = x.why, dry_run_id = coalesce(x.dry_run_id, b.dry_run_id),
            completed_at = CASE WHEN x.status IN ('done', 'skipped') THEN now() ELSE b.completed_at END
       FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, status text, why text, dry_run_id uuid)
      WHERE b.id = x.id AND b.reason = 'fit' AND b.status = 'fit_held'`,
    [JSON.stringify(list.map((r) => ({ id: r.id, status: r.status, why: r.why ?? null, dry_run_id: r.dryRunId ?? null })))]
  );
  return rowCount ?? 0;
}

/**
 * One lead read live from its install. Never throws: { ok, json, status, why }.
 *
 * @param {{ instance: string, key: string, bisonLeadId: number, fetchImpl?: typeof fetch }} p
 */
export async function readLead({ instance, key, bisonLeadId, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`https://${instance}/api/leads/${encodeURIComponent(String(bisonLeadId))}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json, why: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, json: null, why: e?.name === "TimeoutError" ? "timed out" : String(e?.cause?.code ?? e?.message ?? "failed") };
  }
}
