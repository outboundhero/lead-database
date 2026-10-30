import type { PoolClient } from "pg";
import { enrichPool } from "@/lib/enrich/db";
import {
  buildRequests,
  cleanPeopleFilters,
  CLEANING_DEFAULTS,
  EMPTY_PEOPLE_FILTERS,
  loadGeo,
} from "../../../scripts/lib/aiark/filters.mjs";
import { aiArkFor, webhookFor } from "../../../scripts/lib/aiark/runs.mjs";
import type { AiArkModes, AiArkPlan, AiArkRun, PeopleFilters, PlanReport } from "./types";

export { cleanPeopleFilters, DEPARTMENT_SUGGESTIONS, INDUSTRY_SUGGESTIONS, SENIORITY } from "../../../scripts/lib/aiark/filters.mjs";
export { aiArkFor, createRun } from "../../../scripts/lib/aiark/runs.mjs";
export { AiArkError, personInputs } from "../../../scripts/lib/aiark/client.mjs";

// Server side of the AI Ark tab. The filter mapper, the AI Ark client and the
// run engine are shared with the worker (scripts/lib/aiark/*.mjs); this file
// only reads what a route needs and shapes it for the page.

export const TAG_RE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
export const cleanTag = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : "");

type Geo = Awaited<ReturnType<typeof loadGeo>>;
let geoCache: { at: number; geo: Geo } | null = null;

export async function geo(c: PoolClient): Promise<Geo> {
  if (!geoCache || Date.now() - geoCache.at > 10 * 60_000) geoCache = { at: Date.now(), geo: await loadGeo(c) };
  return geoCache.geo;
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

export async function clientInfo(c: PoolClient, tag: string) {
  const { rows } = await c.query(`SELECT tag, name, client_type, status FROM client_tags WHERE tag = $1`, [tag]);
  return rows[0] ?? null;
}

export async function targetingOf(c: PoolClient, tag: string) {
  const { rows } = await c.query(
    `SELECT client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at
       FROM client_targeting WHERE client_tag = $1`,
    [tag]
  );
  return rows[0] ?? null;
}

export async function savedPeople(c: PoolClient, tag: string) {
  const { rows } = await c.query(
    `SELECT titles, title_mode, exclude_titles, seniority, departments, employee_bands, industries, exclude_industries, updated_at
       FROM client_people_filters WHERE client_tag = $1`,
    [tag]
  );
  return rows[0] ?? null;
}

/** The saved filters, or the starting point the tab shows until someone saves. */
export function peopleOrDefaults(saved: Record<string, unknown> | null, clientType: string | null) {
  if (saved) {
    const { updated_at, ...value } = saved;
    return { saved: true, updatedAt: updated_at as string, defaultsFrom: null, value: cleanPeopleFilters(value).value as PeopleFilters };
  }
  const cleaning = clientType === "Cleaning";
  return {
    saved: false,
    updatedAt: null,
    defaultsFrom: cleaning ? "cleaning" : null,
    value: (cleaning ? CLEANING_DEFAULTS : EMPTY_PEOPLE_FILTERS) as PeopleFilters,
  };
}

export function plan(targeting: Record<string, unknown> | null, people: PeopleFilters, g: Geo): AiArkPlan & { requests: object[] } {
  const built = buildRequests({ targeting, people, geo: g });
  return {
    requests: built.requests,
    searches: built.requests.length,
    report: built.report as PlanReport,
    notes: built.notes,
    blockers: built.blockers,
    pullBlockers: built.pullBlockers,
    example: built.requests[0] ?? null,
  };
}

/** The plan as the page shows it: everything but the request bodies beyond the first. */
export function planView(targeting: Record<string, unknown> | null, people: PeopleFilters, g: Geo): AiArkPlan {
  const p = plan(targeting, people, g);
  return { searches: p.searches, report: p.report, notes: p.notes, blockers: p.blockers, pullBlockers: p.pullBlockers, example: p.example };
}

/** Credits left: live from AI Ark (a free call), demo from the demo runs' spend. */
export async function creditsLeft(mode: "live" | "demo"): Promise<{ credits: number | null; error: string | null }> {
  const got = await aiArkFor(mode, { env: process.env, db: enrichPool() });
  if (!got.client) return { credits: null, error: got.why ?? null };
  try {
    return { credits: await got.client.credits(), error: null };
  } catch (e) {
    return { credits: null, error: e instanceof Error ? e.message : "AI Ark did not answer" };
  }
}

export const RUN_FIELDS = `r.id, r.client_tag, r.mode, r.strategy, r.status, r.size_requested, r.table_id, r.match_count,
  r.pulled, r.with_email, r.skipped_held, r.credits_used::float8 AS credits_used, r.credits_before::float8 AS credits_before,
  r.credits_after::float8 AS credits_after, r.attempts, r.next_run_at, r.last_error, r.stop_reason, r.created_at, r.started_at,
  r.finished_at, r.updated_at, jsonb_array_length(r.requests) AS searches,
  r.progress->>'lists_note' AS lists_note, (r.progress->>'excluded')::int AS excluded,
  r.progress #>> '{job,state}' AS job_state, up.full_name AS created_by_name`;

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
  }
  return rows;
}
