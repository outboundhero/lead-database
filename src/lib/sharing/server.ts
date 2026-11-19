import type { PoolClient } from "pg";
import { clientPool, flagOn, settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import { SHARE_SKIP_REASONS, SHARING_CAPABILITY } from "../../../scripts/lib/overlap-topup.mjs";
import { BISON_GROUPS } from "../../../scripts/lib/bison-groups.mjs";
import { workerState } from "@/lib/enrich/queries";
import { iso } from "./db";
import type {
  BatchShareBadge,
  ClientsAnswer,
  HeldAnswer,
  JobAnswer,
  JobPushBatch,
  JobReceiver,
  JobsAnswer,
  LeadShare,
  ShareJob,
  ShareJobState,
  ShareOutcome,
  SharePushState,
  ShareRowView,
  SharingSwitch,
  SharingWorker,
} from "./types";

// What the Sharing page's routes read (share_jobs, lead_shares: migration 134;
// both are server-only, so every read goes through the web app's pg pool).
// Each function runs inside the caller's transaction.

type Settings = ReturnType<typeof settingsFrom>;

export async function readSettings(c: PoolClient): Promise<Settings> {
  const { rows } = await c.query(`SELECT key, value FROM enrich_settings WHERE key = 'overlap_sharing'`);
  return settingsFrom(rows);
}

export function switchView(s: Settings): SharingSwitch {
  const o = s.overlap_sharing;
  return {
    enabled: o.enabled,
    mode: o.mode,
    since: o.since,
    tags: [...o.tags],
    push_tags: [...o.push_tags],
    write_tags: o.write_tags,
    held_retry_days: o.held_retry_days,
  };
}

/** The worker running now, and whether it runs the share step. */
export async function sharingWorker(c: PoolClient): Promise<SharingWorker | null> {
  const w = await workerState(c);
  if (!w) return null;
  const caps = w.info?.capabilities;
  return { online: w.online, secondsAgo: w.seconds_ago, sharing: Array.isArray(caps) && caps.includes(SHARING_CAPABILITY) };
}

const JOB_FIELDS = `j.batch_id, j.origin_tag, j.origin_pool, j.state, j.reason, j.topup, j.mode, j.batch_done_at, j.place_wait_until,
  j.place_wait_hit_at, j.new_leads, j.leads_no_place, j.receivers, j.receivers_done, j.receivers_applied, j.receivers_over_cap,
  j.counts, j.attempts, j.next_try_at, j.recheck_until, j.last_error, j.created_at, j.decided_at, j.applied_at, j.undone_at,
  b.filename, b.source_label, b.inserted_rows`;

const SKIP_TEXT = SHARE_SKIP_REASONS as Record<string, string>;

function jobOf(r: Record<string, unknown>): ShareJob {
  const reason = (r.reason as string | null) ?? null;
  return {
    batch_id: r.batch_id as string,
    filename: (r.filename as string | null) ?? null,
    source_label: (r.source_label as string | null) ?? null,
    inserted_rows: (r.inserted_rows as number | null) ?? null,
    origin_tag: (r.origin_tag as string | null) ?? null,
    origin_pool: (r.origin_pool as string | null) ?? null,
    state: r.state as ShareJobState,
    reason,
    reason_text: reason ? SKIP_TEXT[reason] ?? reason.replace(/_/g, " ") : null,
    topup: r.topup === true,
    mode: (r.mode as ShareJob["mode"]) ?? null,
    batch_done_at: iso(r.batch_done_at) ?? "",
    place_wait_until: iso(r.place_wait_until),
    place_wait_hit_at: iso(r.place_wait_hit_at),
    new_leads: Number(r.new_leads ?? 0),
    leads_no_place: Number(r.leads_no_place ?? 0),
    receivers: (r.receivers as string[]) ?? [],
    receivers_done: (r.receivers_done as string[]) ?? [],
    receivers_applied: (r.receivers_applied as string[]) ?? [],
    receivers_over_cap: (r.receivers_over_cap as string[]) ?? [],
    counts: (r.counts as ShareJob["counts"]) ?? {},
    attempts: Number(r.attempts ?? 0),
    next_try_at: iso(r.next_try_at),
    recheck_until: iso(r.recheck_until),
    last_error: (r.last_error as string | null) ?? null,
    created_at: iso(r.created_at) ?? "",
    decided_at: iso(r.decided_at),
    applied_at: iso(r.applied_at),
    undone_at: iso(r.undone_at),
  };
}

/** A page's place in the jobs list: the last job's created_at (to the microsecond) and id. */
export const JOBS_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The jobs list, newest first, a page at a time. Keyset on (created_at, id):
 * the share step may make many jobs in one statement, all with the same
 * created_at, so the time alone would lose some at a page's edge.
 */
export async function listJobs(
  c: PoolClient,
  { state, origin, before, limit }: { state: string | null; origin: string | null; before: string | null; limit: number }
): Promise<Omit<JobsAnswer, "ready">> {
  const settings = await readSettings(c);
  const cursor = before ? JOBS_CURSOR.exec(before) : null;
  const { rows } = await c.query(
    `SELECT ${JOB_FIELDS},
            to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || j.batch_id AS cursor
       FROM share_jobs j LEFT JOIN upload_batches b ON b.id = j.batch_id
      WHERE ($1::text IS NULL OR j.state = $1)
        AND ($2::text IS NULL OR j.origin_tag = $2)
        AND ($3::timestamptz IS NULL OR (j.created_at, j.batch_id) < ($3::timestamptz, $4::uuid))
      ORDER BY j.created_at DESC, j.batch_id DESC
      LIMIT $5`,
    [state, origin, cursor?.[1] ?? null, cursor?.[2] ?? null, limit + 1]
  );
  const jobs = rows.slice(0, limit).map(jobOf);
  const { rows: states } = await c.query(`SELECT state, count(*)::int AS n FROM share_jobs GROUP BY state`);
  const { rows: [hit] } = await c.query(
    `SELECT count(*)::int AS n FROM share_jobs WHERE place_wait_hit_at > now() - interval '7 days'`
  );
  return {
    jobs,
    next: rows.length > limit ? (rows[limit - 1]?.cursor as string) ?? null : null,
    byState: Object.fromEntries(states.map((r) => [r.state, r.n])),
    waitedLimit: hit?.n ?? 0,
    worker: await sharingWorker(c),
    switch: switchView(settings),
  };
}

function rowView(r: Record<string, unknown>): ShareRowView {
  const place = r.matched_place as { label?: unknown } | null;
  return {
    id: String(r.id),
    lead_id: r.lead_id as string,
    email: (r.email as string | null) ?? null,
    company: (r.company as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    matched_place: place && typeof place.label === "string" ? place.label : null,
    outcome: r.outcome as ShareOutcome,
    applied_at: iso(r.applied_at),
    push_state: (r.push_state as SharePushState | null) ?? null,
    push_note: (r.push_note as string | null) ?? null,
    push_batch_id: (r.push_batch_id as string | null) ?? null,
    tag_added: r.tag_added === true,
    undone_at: iso(r.undone_at),
  };
}

/** One job: per receiver its rows by outcome and push state, a sample, and the push batches its rows went into. */
export async function jobDetail(c: PoolClient, batchId: string): Promise<JobAnswer | null> {
  const { rows: [j] } = await c.query(
    `SELECT ${JOB_FIELDS} FROM share_jobs j LEFT JOIN upload_batches b ON b.id = j.batch_id WHERE j.batch_id = $1`,
    [batchId]
  );
  if (!j) return null;
  const job = jobOf(j);
  const settings = await readSettings(c);
  const { rows: groups } = await c.query(
    `SELECT receiver_tag, outcome, push_state, count(*)::int AS n,
            count(*) FILTER (WHERE applied_at IS NOT NULL)::int AS applied,
            count(*) FILTER (WHERE undone_at IS NOT NULL)::int AS undone,
            count(*) FILTER (WHERE tag_added)::int AS tagged
       FROM lead_shares WHERE batch_id = $1
      GROUP BY receiver_tag, outcome, push_state`,
    [batchId]
  );
  const { rows: samples } = await c.query(
    `SELECT x.*, l.email, l.company, l.city, l.state
       FROM (SELECT s.*, row_number() OVER (PARTITION BY s.receiver_tag
                                            ORDER BY (s.outcome IN ('shared', 'own_topup')) DESC, s.id) AS rn
               FROM lead_shares s WHERE s.batch_id = $1) x
       LEFT JOIN leads l ON l.id = x.lead_id
      WHERE x.rn <= 20
      ORDER BY x.receiver_tag, x.rn`,
    [batchId]
  );
  const tags = [...new Set([...job.receivers, ...Object.keys(job.counts), ...groups.map((g) => g.receiver_tag as string)])].sort();
  const { rows: blocks } = await c.query(
    `SELECT t AS tag, public.fn_client_receive_block(t) AS block FROM unnest($1::text[]) AS t`,
    [tags]
  );
  const blockOf = new Map(blocks.map((r) => [r.tag as string, (r.block as string | null) ?? null]));
  const receivers: JobReceiver[] = tags.map((tag) => {
    const mine = groups.filter((g) => g.receiver_tag === tag);
    const outcomes: JobReceiver["outcomes"] = {};
    const push: JobReceiver["push"] = {};
    let appliedRows = 0;
    let undoneRows = 0;
    let taggedRows = 0;
    for (const g of mine) {
      const o = g.outcome as ShareOutcome;
      outcomes[o] = (outcomes[o] ?? 0) + g.n;
      if (g.push_state) push[g.push_state as SharePushState] = (push[g.push_state as SharePushState] ?? 0) + g.n;
      appliedRows += g.applied;
      undoneRows += g.undone;
      taggedRows += g.tagged;
    }
    return {
      tag,
      receiveBlock: blockOf.get(tag) ?? null,
      onPushList: flagOn(settings, "share_push", tag),
      overCap: job.receivers_over_cap.includes(tag),
      applied: job.receivers_applied.includes(tag),
      outcomes,
      appliedRows,
      undoneRows,
      taggedRows,
      push,
      sample: samples.filter((s) => s.receiver_tag === tag).map(rowView),
    };
  });
  const { rows: pb } = await c.query(
    `SELECT b.id, b.client_tag, b.status, b.total, b.sent, b.created_at, b.push_options->>'source' AS source
       FROM push_batches b
      WHERE b.id IN (SELECT DISTINCT s.push_batch_id FROM lead_shares s WHERE s.batch_id = $1 AND s.push_batch_id IS NOT NULL)
      ORDER BY b.created_at DESC`,
    [batchId]
  );
  const pushBatches: JobPushBatch[] = pb.map((b) => ({
    id: b.id,
    receiver: b.client_tag,
    status: b.status,
    total: b.total ?? null,
    sent: b.sent ?? 0,
    created_at: iso(b.created_at) ?? "",
    source: b.source ?? null,
  }));
  return { job, receivers, pushBatches, switch: switchView(settings) };
}

/** Every row of a job (or of one receiver of it), for the CSV. */
export async function jobRows(c: PoolClient, batchId: string, receiver: string | null) {
  const { rows } = await c.query(
    `SELECT s.receiver_tag, l.email, l.company, l.city, l.state, s.matched_place->>'label' AS matched_place, s.outcome,
            s.applied_at, s.push_state, s.push_note, s.undone_at
       FROM lead_shares s LEFT JOIN leads l ON l.id = s.lead_id
      WHERE s.batch_id = $1 AND ($2::text IS NULL OR s.receiver_tag = $2)
      ORDER BY s.receiver_tag, s.id
      LIMIT 200000`,
    [batchId, receiver]
  );
  return rows;
}

/** Every client: its pool or "isolated", whether it can receive, its place on the two lists, shares in the last 7 days. */
export async function sharingClients(c: PoolClient): Promise<Omit<ClientsAnswer, "ready">> {
  const { rows: all } = await c.query(`SELECT key, value FROM enrich_settings`);
  const settings = settingsFrom(all);
  const { rows } = await c.query(
    `SELECT ct.tag, ct.name, ct.status, ct.client_type, ct.group_no, public.fn_client_receive_block(ct.tag) AS block
       FROM client_tags ct ORDER BY ct.tag`
  );
  const { rows: shared } = await c.query(
    `SELECT receiver_tag, count(*)::int AS n FROM lead_shares
      WHERE outcome = 'shared' AND applied_at > now() - interval '7 days' AND undone_at IS NULL
      GROUP BY receiver_tag`
  );
  const sharedOf = new Map(shared.map((r) => [r.receiver_tag as string, r.n as number]));
  return {
    clients: rows.map((r) => ({
      tag: r.tag,
      name: r.name ?? null,
      status: r.status ?? null,
      client_type: r.client_type ?? null,
      group_no: r.group_no ?? null,
      pool: clientPool(settings, r.tag, r.client_type),
      receiveBlock: r.block ?? null,
      onList: flagOn(settings, "overlap_sharing", r.tag),
      onPushList: flagOn(settings, "share_push", r.tag),
      shared7d: sharedOf.get(r.tag) ?? 0,
    })),
    pools: settings.overlap_sharing.pools,
    isolatedSuffixes: settings.overlap_sharing.isolated_tag_suffixes,
  };
}

/** Held and queued rows by client, leads with no usable place by place text, and the installs the mirror covers. */
export async function heldView(c: PoolClient): Promise<Omit<HeldAnswer, "ready">> {
  const settings = await readSettings(c);
  const days = settings.overlap_sharing.held_retry_days;
  const { rows: held } = await c.query(
    `SELECT receiver_tag, push_note, count(*)::int AS n, min(held_since) AS oldest, max(held_at) AS last_try,
            bool_or(held_since > now() - make_interval(days => $1::int)) AS retried
       FROM lead_shares WHERE push_state = 'held' AND undone_at IS NULL
      GROUP BY receiver_tag, push_note
      ORDER BY n DESC LIMIT 500`,
    [days]
  );
  const { rows: queued } = await c.query(
    `SELECT receiver_tag, count(*)::int AS n, min(applied_at) AS oldest
       FROM lead_shares WHERE push_state = 'queued' AND undone_at IS NULL
      GROUP BY receiver_tag ORDER BY n DESC LIMIT 500`
  );
  // Leads of the last 30 days' jobs still with no usable place, by the place text they carry.
  const { rows: noPlace } = await c.query(
    `SELECT coalesce(nullif(btrim(l.city), ''), '') AS city, coalesce(nullif(btrim(l.state), ''), '') AS state,
            coalesce(nullif(btrim(l.country_code), ''), '') AS country, coalesce(l.location_status, 'not looked at') AS status,
            count(*)::int AS n
       FROM share_jobs j
       JOIN upload_batch_leads u ON u.batch_id = j.batch_id AND u.outcome = 'new'
       JOIN leads l ON l.id = u.lead_id
      WHERE j.leads_no_place > 0 AND j.created_at > now() - interval '30 days'
        AND (l.location_status IS NULL OR l.location_status NOT IN ('resolved', 'partial'))
      GROUP BY 1, 2, 3, 4
      ORDER BY n DESC LIMIT 100`
  );
  const installs = Object.entries(BISON_GROUPS as Record<string, { b2b: string; b2c: string }>).flatMap(([g, pair]) => [
    { install: pair.b2b, group: Number(g), side: "b2b" as const },
    { install: pair.b2c, group: Number(g), side: "b2c" as const },
  ]);
  const { rows: cov } = await c.query(
    `SELECT i.inst,
            EXISTS (SELECT 1 FROM bison_leads b WHERE b.instance_url = i.inst) AS covered,
            (SELECT max(s.updated_at) FROM bison_sync_state s WHERE s.instance_url = i.inst) AS last_sync
       FROM unnest($1::text[]) AS i(inst)`,
    [installs.map((i) => i.install)]
  );
  const covOf = new Map(cov.map((r) => [r.inst as string, r]));
  return {
    held: held.map((r) => ({
      receiver: r.receiver_tag,
      note: r.push_note ?? null,
      rows: r.n,
      oldest: iso(r.oldest),
      lastTry: iso(r.last_try),
      retried: r.retried === true,
    })),
    queued: queued.map((r) => ({ receiver: r.receiver_tag, rows: r.n, oldest: iso(r.oldest) })),
    noPlace: noPlace.map((r) => ({ city: r.city, state: r.state, country: r.country, status: r.status, leads: r.n })),
    mirror: installs.map((i) => ({
      ...i,
      covered: covOf.get(i.install)?.covered === true,
      lastSync: iso(covOf.get(i.install)?.last_sync),
    })),
    heldRetryDays: days,
  };
}

/** The Uploads page's badge for these batches: only batches with a share job are in the answer. */
export async function batchBadges(c: PoolClient, ids: string[]): Promise<Record<string, BatchShareBadge>> {
  const { rows } = await c.query(
    `SELECT j.batch_id, j.state, j.reason,
            (SELECT count(DISTINCT s.receiver_tag)::int FROM lead_shares s
              WHERE s.batch_id = j.batch_id AND s.outcome = 'shared' AND s.applied_at IS NOT NULL AND s.undone_at IS NULL) AS shared_to,
            (SELECT count(DISTINCT s.receiver_tag)::int FROM lead_shares s
              WHERE s.batch_id = j.batch_id AND s.outcome = 'shared' AND s.applied_at IS NULL) AS preview_to
       FROM share_jobs j WHERE j.batch_id = ANY($1::uuid[])`,
    [ids]
  );
  return Object.fromEntries(
    rows.map((r) => [r.batch_id, { state: r.state, reason: r.reason ?? null, sharedTo: r.shared_to ?? 0, previewTo: r.preview_to ?? 0 }])
  );
}

/** Every share of one lead, newest first. */
export async function leadShares(c: PoolClient, leadId: string): Promise<LeadShare[]> {
  const { rows } = await c.query(
    `SELECT s.id, s.batch_id, s.origin_tag, s.receiver_tag, s.outcome, s.matched_place->>'label' AS matched_place, s.decided_at,
            s.applied_at, s.push_state, s.push_note, s.pushed_at, s.push_batch_id, s.tag_added, s.undone_at,
            b.filename, b.source_label
       FROM lead_shares s LEFT JOIN upload_batches b ON b.id = s.batch_id
      WHERE s.lead_id = $1
      ORDER BY s.decided_at DESC, s.id DESC LIMIT 50`,
    [leadId]
  );
  return rows.map((r) => ({
    id: String(r.id),
    batch_id: r.batch_id,
    filename: r.filename ?? null,
    source_label: r.source_label ?? null,
    origin_tag: r.origin_tag,
    receiver_tag: r.receiver_tag,
    outcome: r.outcome,
    matched_place: r.matched_place ?? null,
    decided_at: iso(r.decided_at) ?? "",
    applied_at: iso(r.applied_at),
    push_state: r.push_state ?? null,
    push_note: r.push_note ?? null,
    pushed_at: iso(r.pushed_at),
    push_batch_id: r.push_batch_id ?? null,
    tag_added: r.tag_added === true,
    undone_at: iso(r.undone_at),
  }));
}
