import type { PoolClient } from "pg";
import { excludedTitlesFor } from "../../../scripts/lib/aiark/people-requests.mjs";
import { eligibilityCounts, MISS_ESTIMATE, peopleSpendCeiling } from "../../../scripts/lib/aiark/people-runs.mjs";
import { originalsSummary } from "../../../scripts/lib/enrich/compile-original.mjs";
import { KEYED_STEPS, OPTIONAL_KEYS } from "../../../scripts/lib/enrich/pipeline-actions.mjs";
import { normTag, settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import { capFor, spentToday } from "../../../scripts/lib/enrich/spend.mjs";
import { variantName } from "../../../scripts/lib/enrich/templates.mjs";
import type { WorkerState } from "@/lib/enrich/types";
import {
  TRACK_LABELS,
  TRACKS,
  type Candidate,
  type CandidatesPage,
  type Contact,
  type ContactsPage,
  type PeoplePlan,
  type PeopleRun,
  type PeopleSetup,
  type PeopleTrackView,
  type Track,
} from "./types";

export {
  approveBuy,
  activePeopleRun,
  cancelPeopleRun,
  createPeopleRun,
  PeopleRunRefused,
} from "../../../scripts/lib/aiark/people-runs.mjs";

// Server side of the Companies tab's people runs and contacts. The run engine
// is shared with the worker (scripts/lib/aiark/people-runs.mjs); this file
// reads what the routes need and shapes it for the page: the plan (switches,
// tracks, eligible companies, the estimate), the runs, a run's candidates, and
// a company's contacts (enrich_contacts), all in keyset pages with no OFFSET.

type Settings = ReturnType<typeof settingsFrom>;

const fmt = (n: number) => n.toLocaleString("en-US");
// The AI searches' worst case per company (C#41 and C#56 at their caps, section 7.2): about 3 cents each with web search.
const AI_SEARCH_USD = 0.045;

/** The settings, read fresh (the routes never use the worker's 30-second cache). */
export async function readSettingsFresh(c: PoolClient): Promise<Settings> {
  const { rows } = await c.query<{ key: string; value: unknown }>(`SELECT key, value FROM enrich_settings`);
  return settingsFrom(rows);
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * What the people panel shows for a client, read free: the switch for this
 * client, the tracks and their phrases (read only, from the originals'
 * seed), the excluded titles, the companies a run would take and why others
 * are left out, and the estimate. `blockers` says why a run can't start, as
 * far as the page can tell; the route checks again.
 */
export async function peoplePlan(c: PoolClient, tag: string, settings?: Settings): Promise<PeoplePlan> {
  const t = normTag(tag);
  const s = settings ?? (await readSettingsFresh(c));
  const pp = s.people_pipeline;
  const { rows: tables } = await c.query<{ kind: string; id: string }>(
    `SELECT kind, id FROM enrich_tables WHERE client_tag = $1 AND template IN ('companies_v2', 'inboxes_v1', 'people_v1')`,
    [t]
  );
  const table = (k: string) => tables.find((x) => x.kind === k)?.id ?? null;
  const companies = table("companies")
    ? await eligibilityCounts(c, { tag: t, source: "ai_ark", recheckDays: pp.recheck_days, tableId: table("companies"), skipHeld: pp.skip_company_when_held })
    : { passing: 0, eligible: 0, held: 0, notChecked: 0, looked: 0, noId: 0 };
  const { rows: [client] } = await c.query<{ client_type: string | null }>(`SELECT client_type FROM client_tags WHERE tag = $1`, [t]);
  const { rows: [saved] } = await c.query<{ exclude_titles: string[] }>(`SELECT exclude_titles FROM client_people_filters WHERE client_tag = $1`, [t]);
  const excluded = excludedTitlesFor(saved ?? null, client?.client_type ?? null) as PeoplePlan["excludedTitles"];
  const tracks: PeopleTrackView[] | null = s.people_tracks
    ? TRACKS.map((k: Track) => ({
        track: k,
        label: TRACK_LABELS[k],
        phrases: [...(s.people_tracks?.[k]?.phrases ?? [])],
        from: [...(s.people_tracks?.[k]?.from ?? [])],
      }))
    : null;
  const searches = Math.ceil(companies.eligible / pp.ids_per_search);
  const on = s.flagOn("people_pipeline", t);
  const blockers: string[] = [];
  if (!pp.enabled) blockers.push("People runs are off. An admin can switch them on in the settings.");
  else if (!pp.tags.includes(t)) blockers.push(`${t} is not on the people runs' client list. An admin can add it in the settings.`);
  if (!tracks) blockers.push("The people tracks are not loaded: they come from the Clay originals' seed.");
  if (!table("companies")) blockers.push(`${t} has no pipeline Companies table yet: pull companies first.`);
  else if (!companies.eligible) blockers.push("No company is ready for a people run.");
  return {
    on,
    switchOn: pp.enabled,
    onList: pp.tags.includes(t),
    autoBuy: s.flagOn("auto_buy", t),
    aiSearches: s.flagOn("ai_searches", t),
    tracks,
    excludedTitles: excluded,
    tables: { companies: table("companies"), inboxes: table("inboxes"), people: table("people") },
    companies,
    settings: { ...pp, tags: [...pp.tags] },
    estimate: {
      searches,
      lookMin: searches,
      lookMax: searches * pp.pages_per_search,
      buyMax: Math.min(companies.eligible * TRACKS.length, pp.max_people_per_run),
      aiSearchUsd: Math.round(companies.eligible * AI_SEARCH_USD * 100) / 100,
    },
    blockers,
  };
}

/** The steps that wait for a key we may not hold, and whether the worker says it holds it. */
export function keysView(worker: WorkerState | null): PeopleSetup["keys"] {
  const holds: Record<string, string> = {};
  for (const step of Object.values(KEYED_STEPS) as { key: string; originals: string[] }[]) {
    holds[step.key] = [...new Set([...(holds[step.key] ? holds[step.key].split(", ") : []), ...step.originals])].join(", ");
  }
  const vendor: Record<string, string> = {
    FINDYMAIL_API_KEY: "Findymail", PROSPEO_API_KEY: "Prospeo", ANYMAIL_FINDER_API_KEY: "Anymail Finder", ENRICHLEY_API_KEY: "Enrichley",
  };
  const keys = worker?.info?.keys ?? {};
  const out: PeopleSetup["keys"] = (OPTIONAL_KEYS as readonly string[]).map((k) => ({
    key: k,
    vendor: vendor[k] ?? k,
    holds: holds[k] ?? "",
    held: typeof keys[k] === "boolean" ? keys[k] : null,
    built: true,
  }));
  // Not built: no key in either list (0.3).
  out.push({ key: "ICYPEAS_API_KEY", vendor: "Icypeas", holds: "C#30 (the database and AI Ark take its place)", held: null, built: false });
  out.push({ key: "CLEARBIT_API_KEY", vendor: "Clearbit", holds: "C#23", held: null, built: false });
  return out;
}

/** The people setup: the plan, the runs, the originals loaded, today's spend and the keyed steps. */
export async function peopleSetup(c: PoolClient, tag: string, worker: WorkerState | null): Promise<PeopleSetup> {
  const s = await readSettingsFresh(c);
  const spent = await spentToday(c);
  return {
    plan: await peoplePlan(c, tag, s),
    runs: await peopleRunsFor(c, tag),
    originals: await originalsSummary(c, variantName(tag)),
    spend: {
      reoon: { used: spent.reoon_checks, cap: capFor("reoon_checks", s) },
      openaiPipeline: { used: spent.openai_usd_pipeline, cap: capFor("openai_usd_pipeline", s) },
      openaiFit: { used: spent.openai_usd_fit, cap: capFor("openai_usd_fit", s) },
    },
    keys: keysView(worker),
  };
}

// ── Runs ────────────────────────────────────────────────────────────────────

export const PEOPLE_RUN_FIELDS = `r.id, r.client_tag, r.mode, r.source, r.status, r.max_people, r.companies, r.batches, r.pages, r.looked, r.copied,
  r.picked, r.bought, r.with_email, r.skipped_held, r.lost_answers, r.credits_used::float8 AS credits_used,
  r.credits_before::float8 AS credits_before, r.credits_after::float8 AS credits_after, r.attempts, r.next_run_at, r.last_error,
  r.stop_reason, r.created_at, r.started_at, r.finished_at, r.updated_at, r.buy_approved_at, r.filters,
  up.full_name AS created_by_name, ub.full_name AS buy_approved_by_name`;

type RunRow = Omit<PeopleRun, "verdicts" | "settled" | "ceiling" | "more_companies"> & { filters: Record<string, unknown> };

/** A client's newest people runs (10), with their candidates by verdict and companies settled. */
export async function peopleRunsFor(c: PoolClient, tag: string, limit = 10): Promise<PeopleRun[]> {
  const { rows } = await c.query<RunRow>(
    `SELECT ${PEOPLE_RUN_FIELDS}
       FROM aiark_people_runs r
       LEFT JOIN user_profiles up ON up.id = r.created_by
       LEFT JOIN user_profiles ub ON ub.id = r.buy_approved_by
      WHERE r.client_tag = $1
      ORDER BY r.created_at DESC LIMIT $2`,
    [normTag(tag), limit]
  );
  return attachRunStats(c, rows);
}

/** One people run as the tab shows it, or null. */
export async function peopleRunById(c: PoolClient, id: string): Promise<PeopleRun | null> {
  const { rows } = await c.query<RunRow>(
    `SELECT ${PEOPLE_RUN_FIELDS}
       FROM aiark_people_runs r
       LEFT JOIN user_profiles up ON up.id = r.created_by
       LEFT JOIN user_profiles ub ON ub.id = r.buy_approved_by
      WHERE r.id = $1`,
    [id]
  );
  return (await attachRunStats(c, rows))[0] ?? null;
}

async function attachRunStats(c: PoolClient, rows: RunRow[]): Promise<PeopleRun[]> {
  const ids = rows.map((r) => r.id);
  const verdicts = new Map<string, Record<string, number>>();
  const settled = new Map<string, number>();
  if (ids.length) {
    const { rows: v } = await c.query<{ run_id: string; verdict: string; n: number }>(
      `SELECT run_id, verdict, count(*)::int AS n FROM aiark_people_candidates WHERE run_id = ANY($1::uuid[]) GROUP BY 1, 2`,
      [ids]
    );
    for (const x of v) verdicts.set(x.run_id, { ...(verdicts.get(x.run_id) ?? {}), [x.verdict]: x.n });
    const { rows: st } = await c.query<{ run_id: string; n: number }>(
      `SELECT run_id, count(*)::int AS n FROM aiark_people_run_companies WHERE run_id = ANY($1::uuid[]) AND state IN ('settled', 'skipped_held') GROUP BY 1`,
      [ids]
    );
    for (const x of st) settled.set(x.run_id, x.n);
  }
  return rows.map(({ filters, ...r }) => ({
    ...r,
    verdicts: verdicts.get(r.id) ?? {},
    settled: settled.get(r.id) ?? 0,
    ceiling: peopleSpendCeiling({ batches: r.batches, max_people: r.max_people, filters }),
    more_companies: filters?.more_companies === true,
  }));
}

/** What the pause shows: at most this many credits for the picks, plus MISS_ESTIMATE a miss if a miss is charged. */
export const missEstimate = MISS_ESTIMATE;

// ── Keyset cursors ──────────────────────────────────────────────────────────

function encode(parts: (string | number | null)[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

function decode(raw: string | null, shape: ("string" | "number" | "nullable-number")[]): (string | number | null)[] | null {
  if (!raw) return null;
  if (raw.length > 1_000) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== shape.length) return null;
  for (let i = 0; i < shape.length; i++) {
    const x = v[i];
    if (shape[i] === "string" && (typeof x !== "string" || x.length > 200)) return null;
    if (shape[i] === "number" && !Number.isSafeInteger(x)) return null;
    if (shape[i] === "nullable-number" && x !== null && !Number.isSafeInteger(x)) return null;
  }
  return v as (string | number | null)[];
}

// ── Contacts ────────────────────────────────────────────────────────────────

const CONTACT_FIELDS = `k.row_id::bigint AS row_id, k.table_id, k.kind, k.email, k.verdict, k.usable, k.held, k.full_name, k.title, k.linkedin,
  k.track, k.found_by, k.stage, k.outcome, k.city, k.state`;
// Best first: usable, then waiting for Enrichley, then the rest; held after new; then by track and rank.
const CONTACT_ORDER = `CASE WHEN k.usable AND NOT k.held THEN 0 WHEN k.usable THEN 1 WHEN k.verdict = 'enrichley' THEN 2 ELSE 3 END`;

const toContact = (r: Contact & { row_id: string | number }): Contact => ({ ...r, row_id: Number(r.row_id) });

/**
 * For a page of listed companies: up to 3 general emails and up to 3 people
 * each, best first (usable, then waiting for Enrichley), read in one query.
 */
export async function contactsFor(c: PoolClient, { tag, rowIds }: { tag: string; rowIds: number[] }) {
  const out = new Map<number, { general: Contact[]; people: Contact[] }>();
  if (!rowIds.length) return out;
  const { rows } = await c.query<Contact & { row_id: string; company_row_id: string }>(
    `SELECT co.id::bigint AS company_row_id, x.*
       FROM unnest($2::bigint[]) AS co(id)
       CROSS JOIN LATERAL (
         SELECT ${CONTACT_FIELDS}
           FROM enrich_contacts k
          WHERE k.company_row_id = co.id AND k.client_tag = $1 AND k.kind = 'general'
          ORDER BY ${CONTACT_ORDER}, k.row_id LIMIT 3
       ) x
     UNION ALL
     SELECT co.id::bigint AS company_row_id, y.*
       FROM unnest($2::bigint[]) AS co(id)
       CROSS JOIN LATERAL (
         SELECT ${CONTACT_FIELDS}
           FROM enrich_contacts k
          WHERE k.company_row_id = co.id AND k.client_tag = $1 AND k.kind = 'person'
          ORDER BY ${CONTACT_ORDER}, k.track NULLS LAST, k.rank NULLS LAST, k.row_id LIMIT 3
       ) y`,
    [normTag(tag), rowIds]
  );
  for (const r of rows) {
    const id = Number(r.company_row_id);
    const entry = out.get(id) ?? { general: [], people: [] };
    const { company_row_id: _c, ...rest } = r;
    void _c;
    (r.kind === "general" ? entry.general : entry.people).push(toContact(rest));
    out.set(id, entry);
  }
  return out;
}

export const CONTACTS_PAGE = 50;

/**
 * One company's inboxes and people, general emails first, then people, each
 * by row id: keyset pages of 50 (`after` is the page before's `next`), no
 * OFFSET. The first page also says how many of each kind there are.
 */
export async function contactsPage(c: PoolClient, { tag, row, after }: { tag: string; row: number; after: string | null }): Promise<ContactsPage | null> {
  const cur = after ? decode(after, ["string", "number"]) : null;
  if (after && !cur) return null;
  const kindRank = (k: string) => (k === "general" ? 0 : 1);
  const params: unknown[] = [normTag(tag), row, CONTACTS_PAGE + 1];
  let where = "";
  if (cur) {
    params.push(kindRank(String(cur[0])), cur[1]);
    where = `AND (CASE WHEN k.kind = 'general' THEN 0 ELSE 1 END, k.row_id) > ($4::int, $5::bigint)`;
  }
  const { rows } = await c.query<Contact & { row_id: string }>(
    `SELECT ${CONTACT_FIELDS} FROM enrich_contacts k
      WHERE k.client_tag = $1 AND k.company_row_id = $2 ${where}
      ORDER BY CASE WHEN k.kind = 'general' THEN 0 ELSE 1 END, k.row_id
      LIMIT $3`,
    params
  );
  let next: string | null = null;
  const page = rows.slice(0, CONTACTS_PAGE).map(toContact);
  if (rows.length > CONTACTS_PAGE) {
    const last = page[page.length - 1];
    next = encode([last.kind, last.row_id]);
  }
  let totals: ContactsPage["totals"];
  if (!cur) {
    const { rows: [t] } = await c.query<{ general: number; people: number }>(
      `SELECT count(*) FILTER (WHERE kind = 'general')::int AS general, count(*) FILTER (WHERE kind = 'person')::int AS people
         FROM enrich_contacts WHERE client_tag = $1 AND company_row_id = $2`,
      [normTag(tag), row]
    );
    totals = t;
  }
  return { rows: page, next, ...(totals ? { totals } : {}) };
}

// ── Candidates ──────────────────────────────────────────────────────────────

export const CANDIDATES_PAGE = 100;

/**
 * One run's candidates and their screen verdicts, by company then person id:
 * keyset pages of 100, no OFFSET. A Preview's last name stays masked.
 */
export async function candidatesPage(c: PoolClient, { runId, after }: { runId: string; after: string | null }): Promise<CandidatesPage | null> {
  const cur = after ? decode(after, ["number", "string"]) : null;
  if (after && !cur) return null;
  const params: unknown[] = [runId, CANDIDATES_PAGE + 1];
  let where = "";
  if (cur) {
    params.push(cur[0], cur[1]);
    where = `AND (k.company_row_id, k.person_id) > ($3::bigint, $4::text)`;
  }
  const { rows } = await c.query<Candidate & { company_row_id: string; row_id: string | null }>(
    `SELECT k.person_id, k.company_row_id::bigint AS company_row_id, e.company, k.first_name, k.last_name, k.title, k.city, k.region,
            k.country, k.seniority, k.track, k.rank, k.verdict, k.pick, k.row_id::bigint AS row_id
       FROM aiark_people_candidates k
       LEFT JOIN enrich_companies e ON e.row_id = k.company_row_id
      WHERE k.run_id = $1 ${where}
      ORDER BY k.company_row_id, k.person_id
      LIMIT $2`,
    params
  );
  const page = rows.slice(0, CANDIDATES_PAGE).map((r) => ({ ...r, company_row_id: Number(r.company_row_id), row_id: r.row_id == null ? null : Number(r.row_id) }));
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > CANDIDATES_PAGE && last ? encode([last.company_row_id, last.person_id]) : null };
}

/** The plan's note on the estimate, as words. */
export function estimateText(p: PeoplePlan): string {
  const e = p.estimate;
  return `Look: at least ${fmt(e.lookMin)} credit${e.lookMin === 1 ? "" : "s"} (one page a search), at most ${fmt(e.lookMax)}. Buy: at most ${fmt(e.buyMax)} people, 1 credit each with an email.`;
}
