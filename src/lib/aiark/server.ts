import type { PoolClient } from "pg";
import { enrichPool } from "@/lib/enrich/db";
import { loadGeo } from "../../../scripts/lib/aiark/filters.mjs";
import { aiArkFor as aiArkClient, webhookFor } from "../../../scripts/lib/aiark/runs.mjs";
import { competitorsOf, peopleFor, planFor } from "../../../scripts/lib/aiark/start-run.mjs";
import { competitorsView, type readCompetitors } from "../../../scripts/lib/aiark/competitors.mjs";
import type { AiArkModes, AiArkPlan, AiArkRun, CompetitorsListView, PeopleFilters, PlanReport, RunMode } from "./types";

export { cleanPeopleFilters, DEPARTMENT_SUGGESTIONS, INDUSTRY_SUGGESTIONS, SENIORITY } from "../../../scripts/lib/aiark/filters.mjs";
export { createRun } from "../../../scripts/lib/aiark/runs.mjs";
export { addState, beginAdd, EXTRA_FIELDS, finishAdd, IMPORT_COLUMNS, STALE_HOURS } from "../../../scripts/lib/aiark/add.mjs";
export { AiArkError, personInputs } from "../../../scripts/lib/aiark/client.mjs";
export { clientInfo, savedPeople, startRun, subsetTargeting, targetingOf } from "../../../scripts/lib/aiark/start-run.mjs";

// Server side of the AI Ark tab. The filter mapper, the AI Ark client, the
// run engine and the start checks (start-run.mjs, which the weekly top-up's
// worker calls too) are shared with the worker (scripts/lib/aiark/*.mjs);
// this file only reads what a route needs and shapes it for the page.

// Real tags hold "&" and "-" (JPC&A, K&LCS) besides letters and digits.
export const TAG_RE = /^[A-Z0-9][A-Z0-9_&-]{0,39}$/;
export const cleanTag = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : "");

type Geo = Awaited<ReturnType<typeof loadGeo>>;
let geoCache: { at: number; geo: Geo } | null = null;

export async function geo(c: PoolClient): Promise<Geo> {
  if (!geoCache || Date.now() - geoCache.at > 10 * 60_000) geoCache = { at: Date.now(), geo: await loadGeo(c) };
  return geoCache.geo;
}

/**
 * The web app's AI Ark client. AI Ark's rate limit is per key, and a count here
 * can run while the worker pulls at AIARK_RPS (4), so the web app keeps to 1 a
 * second (AIARK_RPS_WEB).
 */
export function aiArkFor(mode: RunMode, { env = process.env, db }: { env?: NodeJS.ProcessEnv; db: Parameters<typeof aiArkClient>[1]["db"] }) {
  const rps = Number(env.AIARK_RPS_WEB);
  return aiArkClient(mode, { env, db, rps: env.AIARK_RPS_WEB && Number.isFinite(rps) ? rps : 1 });
}

/** Which kinds of run this server can start, and why not. Never says what a key is. */
export function modes(): AiArkModes {
  const env = process.env;
  const live = Boolean(env.AIARK_API_KEY?.trim());
  const hook = webhookFor("live", env);
  return {
    live: { ready: live, why: live ? null : "Needs AIARK_API_KEY on the web app and the worker" },
    demo: { ready: env.AIARK_DEMO === "1", why: env.AIARK_DEMO === "1" ? null : "Demo runs are off (AIARK_DEMO=1)" },
    exportLive: { ready: Boolean(hook.url), why: hook.url ? null : hook.why ?? null },
  };
}

// clientInfo, targetingOf and savedPeople are start-run.mjs's (re-exported
// above): the start checks read the client the same way the tab does.

/**
 * The saved filters, or what applies until someone saves: the standard filters
 * for a cleaning client, nothing otherwise. The rule is filtersFor()'s (scope
 * "ai_ark"), the one the LinkedIn sources read too (D-P4-1), through
 * start-run.mjs's peopleFor().
 */
export function peopleOrDefaults(saved: Record<string, unknown> | null, clientType: string | null) {
  const p = peopleFor(saved, clientType);
  if (p.saved) {
    return {
      saved: true,
      updatedAt: p.updatedAt as string,
      version: p.version as string,
      defaultsFrom: null,
      value: p.value as PeopleFilters,
    };
  }
  return {
    saved: false,
    updatedAt: null,
    version: null,
    defaultsFrom: p.defaultsFrom === "cleaning" ? ("cleaning" as const) : null,
    value: p.value as PeopleFilters,
  };
}

type Competitors = Awaited<ReturnType<typeof readCompetitors>>;

/**
 * The built-in competitors list (scripts/lib/aiark/competitors.mjs) as stored
 * now, for a client whose searches send the standard keywords (scope "ai_ark":
 * a cleaning client); null for any other, whose searches don't use it. The
 * rule is start-run.mjs's competitorsOf(), which a pull's start reads too.
 */
export async function competitorsFor(c: PoolClient, clientType: string | null): Promise<Competitors | null> {
  return (await competitorsOf(c, clientType)) ?? null;
}

/** What the AI Ark tab shows of the list beside "Leave out industries". */
export function competitorsListView(list: Competitors | null): CompetitorsListView | null {
  return list ? (competitorsView(list) as CompetitorsListView) : null;
}

export function plan(
  targeting: Record<string, unknown> | null,
  people: PeopleFilters,
  g: Geo,
  clientType: string | null = null,
  competitors: Competitors | null = null
): AiArkPlan & { requests: object[] } {
  const p = planFor(targeting, people, g, clientType, competitors ?? undefined);
  return { ...p, report: p.report as PlanReport };
}

/** The plan as the page shows it: everything but the request bodies beyond the first. */
export function planView(
  targeting: Record<string, unknown> | null,
  people: PeopleFilters,
  g: Geo,
  clientType: string | null = null,
  competitors: Competitors | null = null
): AiArkPlan {
  const p = plan(targeting, people, g, clientType, competitors);
  return { searches: p.searches, report: p.report, notes: p.notes, blockers: p.blockers, pullBlockers: p.pullBlockers, example: p.example };
}

const CREDITS_WAIT_MS = 5_000;

/**
 * Credits left: live from AI Ark (a free call), demo from the demo runs' spend.
 * Never holds the tab up: past 5 s the answer is "no balance" and the call
 * finishes on its own (a slow or rate-limited AI Ark can take minutes).
 */
export async function creditsLeft(mode: "live" | "demo"): Promise<{ credits: number | null; error: string | null }> {
  const read = async () => {
    const got = await aiArkFor(mode, { env: process.env, db: enrichPool() });
    if (!got.client) return { credits: null, error: got.why ?? null };
    try {
      return { credits: await got.client.credits(), error: null };
    } catch (e) {
      return { credits: null, error: e instanceof Error ? e.message : "AI Ark did not answer" };
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ credits: null; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ credits: null, error: "AI Ark did not give the balance within 5 seconds" }), CREDITS_WAIT_MS);
  });
  try {
    return await Promise.race([read(), late]);
  } finally {
    clearTimeout(timer);
  }
}

// series: set on each part of an export pull larger than 10,000 (start-run.mjs).
// export_taken: the export the run holds now has AI Ark's track id, so AI Ark
// has taken it and charged for it (the cancel route reads the same).
export const RUN_FIELDS = `r.id, r.client_tag, r.mode, r.strategy, r.status, r.size_requested, r.table_id, r.match_count::float8 AS match_count,
  r.pulled, r.with_email, r.skipped_held, r.credits_used::float8 AS credits_used, r.credits_before::float8 AS credits_before,
  r.credits_after::float8 AS credits_after, r.attempts, r.next_run_at, r.last_error, r.stop_reason, r.created_at, r.started_at,
  r.finished_at, r.updated_at, jsonb_array_length(r.requests) AS searches,
  (r.status = 'cancelled' AND r.finished_at IS NULL AND jsonb_typeof(r.progress->'job') = 'object') AS finishing,
  r.progress->>'lists_note' AS lists_note, (r.progress->>'excluded')::int AS excluded,
  (r.progress->>'keyword_skipped')::int AS keyword_skipped,
  r.progress #>> '{job,state}' AS job_state,
  r.progress->'series' AS series, (r.progress #>> '{job,track_id}') IS NOT NULL AS export_taken,
  (r.progress #>> '{job,size}')::int AS job_size, up.full_name AS created_by_name`;

const OUTCOME_RUNS = 5; // outcomes are counted for the newest runs only: the tab polls this

export async function runsFor(c: PoolClient, tag: string | null, limit = 20): Promise<AiArkRun[]> {
  const { rows } = await c.query<AiArkRun>(
    `SELECT ${RUN_FIELDS}
       FROM aiark_runs r LEFT JOIN user_profiles up ON up.id = r.created_by
      WHERE ($1::text IS NULL OR r.client_tag = $1)
      ORDER BY r.created_at DESC LIMIT $2`,
    [tag, limit]
  );
  const tables = rows.slice(0, OUTCOME_RUNS).map((r) => r.table_id).filter(Boolean);
  if (tables.length) {
    const { rows: counts } = await c.query<{ table_id: string; outcome: string; n: number }>(
      `SELECT table_id, value #>> '{}' AS outcome, count(*)::int AS n
         FROM enrich_cells
        WHERE table_id = ANY($1::uuid[]) AND column_key = 'outcome' AND status = 'done'
        GROUP BY 1, 2`,
      [tables]
    );
    for (const x of counts) {
      const run = rows.find((r) => r.table_id === x.table_id);
      if (run) (run.outcomes ??= {})[x.outcome] = x.n;
    }
    const { rows: added } = await c.query<{ table_id: string; n: number }>(
      `SELECT table_id, count(*)::int AS n
         FROM enrich_cells
        WHERE table_id = ANY($1::uuid[]) AND column_key = 'add_to_database' AND status = 'done' AND value->>'added' = 'true'
        GROUP BY 1`,
      [tables]
    );
    for (const x of added) {
      const run = rows.find((r) => r.table_id === x.table_id);
      if (run) run.added = x.n;
    }
  }
  return rows;
}
