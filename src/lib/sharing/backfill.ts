import type { PoolClient } from "pg";
import { clientPool, flagOn, settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import { minimumOf } from "../../../scripts/lib/coverage.mjs";
import { UTC_DAY_START } from "../../../scripts/lib/share/db.mjs";
import { BACKFILL_ORIGIN, backfillFrom } from "../../../scripts/lib/backfill/settings.mjs";
import { cityIdsOf, coverageOf, orderPlaces, placesOf, readReceivers } from "../../../scripts/lib/backfill/places.mjs";
import { BACKFILL_STALE_HOURS, backfillReady } from "../../../scripts/lib/backfill/run.mjs";
import { iso } from "./db";
import type { BackfillClient, BackfillPlace, BackfillRun, BackfillSwitch, BackfillView } from "./types";

// What the Sharing page's Backfill tab reads (GET /api/sharing/backfill): the
// database backfill's switch and the caps in force, a warning when it is on
// and no firing ran lately, the newest 20 runs, and per listed client its
// pool, why it cannot receive, whether it is on the push list, its places in
// the order a firing reads them with each pass's progress, its low places,
// its shares today against the day cap, and its live backfill shares by push
// state. Runs inside the caller's read-only transaction. Before migration 138
// it answers ready false.

const RUNS_SHOWN = 20;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function runOf(r: Record<string, unknown>): BackfillRun {
  return {
    id: String(r.id),
    mode: r.mode === "apply" ? "apply" : "preview",
    state: (["running", "done", "stopped", "error"].includes(r.state as string) ? r.state : "error") as BackfillRun["state"],
    stopReason: (r.stop_reason as string | null) ?? null,
    startedAt: iso(r.started_at) ?? "",
    finishedAt: iso(r.finished_at),
    batchId: (r.batch_id as string | null) ?? null,
    receivers: Array.isArray(r.receivers) ? (r.receivers as string[]) : [],
    counts: obj(r.counts) as BackfillRun["counts"],
    totals: obj(r.totals) as BackfillRun["totals"],
    lastError: (r.last_error as string | null) ?? null,
  };
}

/** "3 hours", "2 days": how long ago, for the warning. */
function ago(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** The Backfill tab's view, read in the caller's transaction. */
export async function backfillView(c: PoolClient): Promise<BackfillView> {
  if (!(await backfillReady(c))) return { ready: false, switch: null, warning: null, runs: [], clients: [] };
  const { rows: srows } = await c.query(`SELECT key, value FROM enrich_settings`);
  const settings = settingsFrom(srows);
  const bf = backfillFrom(srows);
  const os = settings.overlap_sharing;
  const sw: BackfillSwitch = {
    enabled: bf.enabled,
    mode: bf.mode,
    tags: [...bf.tags],
    perClientFiring: os.push_max_per_job,
    perClientDay: os.push_max_per_day,
    perFiring: bf.max_per_run,
    maxMinutes: bf.max_minutes,
    recheckDays: bf.recheck_days,
    untagged: bf.untagged,
  };

  const { rows: runRows } = await c.query(
    `SELECT id, mode, state, stop_reason, started_at, finished_at, batch_id, receivers, counts, totals, last_error
       FROM share_backfill_runs ORDER BY started_at DESC LIMIT $1`,
    [RUNS_SHOWN]
  );
  const runs = runRows.map(runOf);
  const newest = runs[0] ? Date.parse(runs[0].startedAt) : null;
  const staleMs = BACKFILL_STALE_HOURS * 3_600_000;
  const warning =
    bf.enabled && (newest == null || Date.now() - newest > staleMs)
      ? `The backfill is on, but ${newest == null ? "no firing has run yet" : `its newest firing started ${ago(Date.now() - newest)} ago`}: the backfill-worker service may not be running.`
      : null;

  const tags = bf.tags;
  const receivers = await readReceivers(c, tags);
  const known = [...receivers.keys()];
  const geoIds = await cityIdsOf(c, known);
  const coverage = await coverageOf(c, known);
  const { rows: names } = await c.query(`SELECT tag, name FROM client_tags WHERE tag = ANY($1::text[])`, [known]);
  const nameOf = new Map(names.map((r) => [r.tag as string, (r.name as string | null) ?? null]));
  const { rows: cursorRows } = await c.query(
    `SELECT receiver_tag, place_key, windows, next_window, pass_done_at, shared::int AS shared
       FROM share_backfill_cursors WHERE receiver_tag = ANY($1::text[])`,
    [known]
  );
  const cursorOf = new Map(cursorRows.map((r) => [`${r.receiver_tag}|${r.place_key}`, r]));
  const { rows: todayRows } = await c.query(
    `SELECT receiver_tag, count(*)::int AS n FROM lead_shares
      WHERE receiver_tag = ANY($1::text[]) AND applied_at >= ${UTC_DAY_START} AND push_state IS NOT NULL
      GROUP BY 1`,
    [known]
  );
  const todayOf = new Map(todayRows.map((r) => [r.receiver_tag as string, r.n as number]));
  const { rows: liveRows } = await c.query(
    `SELECT receiver_tag, coalesce(push_state, 'none') AS state, count(*)::int AS n FROM lead_shares
      WHERE receiver_tag = ANY($1::text[]) AND origin_tag = $2 AND undone_at IS NULL AND applied_at IS NOT NULL
      GROUP BY 1, 2`,
    [known, BACKFILL_ORIGIN]
  );

  const clients: BackfillClient[] = tags.map((tag) => {
    const r = receivers.get(tag);
    if (!r) {
      return {
        tag, name: null, pool: null, receiveBlock: null, isClient: false, onPushList: false, minimum: settings.weekly_topup.default_minimum,
        places: [], unresolved: [], lowPlaces: 0, sharedToday: 0, backfillShares: {},
      };
    }
    const { places, unresolved } = placesOf(tag, r.include_locations, geoIds);
    const { minimum } = minimumOf({ own: r.min_leads_per_place, defaultMinimum: settings.weekly_topup.default_minimum });
    const ranked = orderPlaces(places, coverage.get(tag), minimum);
    const placeViews: BackfillPlace[] = ranked.map((p) => {
      const cur = cursorOf.get(`${tag}|${p.key}`);
      return {
        key: p.key,
        label: p.label,
        kind: p.kind,
        available: p.available,
        low: p.low,
        windows: cur ? Number(cur.windows) : null,
        windowsRead: cur ? Number(cur.next_window) : null,
        passDoneAt: iso(cur?.pass_done_at),
        shared: cur ? Number(cur.shared) : null,
      };
    });
    const shares: Record<string, number> = {};
    for (const x of liveRows) if (x.receiver_tag === tag) shares[x.state as string] = x.n as number;
    return {
      tag,
      name: nameOf.get(tag) ?? null,
      pool: clientPool(settings, tag, r.client_type),
      receiveBlock: r.block,
      isClient: true,
      onPushList: flagOn(settings, "share_push", tag),
      minimum,
      places: placeViews,
      unresolved: unresolved.map((u) => u.label),
      lowPlaces: ranked.filter((p) => p.low).length,
      sharedToday: todayOf.get(tag) ?? 0,
      backfillShares: shares,
    };
  });
  return { ready: true, switch: sw, warning, runs, clients };
}
