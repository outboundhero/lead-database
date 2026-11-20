import type { PoolClient } from "pg";
import { CLEANING_EXCLUDE_COMPANY_TYPES } from "../../../scripts/lib/aiark/cleaning-filters.mjs";
import { pickCompanyFilters } from "../../../scripts/lib/aiark/company-filters.mjs";
import { createCompanyRun } from "../../../scripts/lib/aiark/company-runs.mjs";
import { COMPETITORS_EDIT_HREF, COMPETITORS_FALLBACK, readCompetitors } from "../../../scripts/lib/aiark/competitors.mjs";
import type { loadGeo } from "../../../scripts/lib/aiark/geo.mjs";
import {
  checkPlaces,
  cleanOwnInput,
  LINKEDIN_FLAGS,
  linkedinSettingsFor,
  logFor,
  ownOf,
  placeFromText,
  placeText,
  readLinkedinRow,
  readSavedFilters,
  readStarter,
  readTargeting,
  resolveLinkedin,
} from "../../../scripts/lib/aiark/linkedin-settings.mjs";
import { linkedinCompanyRequests, linkedinPeopleRequests, linkedinRunFilters } from "../../../scripts/lib/aiark/linkedin-requests.mjs";
import { createPeopleRun } from "../../../scripts/lib/aiark/people-runs.mjs";
import { normTag, settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import type { PeopleFilters } from "@/lib/aiark/types";
import type {
  LinkedinKeywordsView,
  LinkedinKind,
  LinkedinLogEntry,
  LinkedinPlan,
  LinkedinPlanView,
  LinkedinPreview,
  LinkedinSettingsView,
  LinkedinSwitchView,
  NarrowedPlace,
  PlaceEntry,
  PlaceView,
  UnplacedValue,
} from "./types";

// Server side of the LinkedIn sources (phase 4, migration 128): the AI Ark
// tab's LinkedIn editor and the Companies tab's LinkedIn plans and refusals.
// The resolver, the save and the request builders are the engine's
// (scripts/lib/aiark/linkedin-*.mjs, shared with the worker and the seed);
// this file reads what a route needs and shapes it for the page. Nothing here
// calls AI Ark.
//
// Two overrides of the phase 4 contract are read from the resolver's answer:
//   O1  keywords.checkedAfter: the keywords AI Ark's request can't hold, which
//       are checked after the pull (keywordsView, checkedAfterOf);
//   O2  search: the client's own places narrowed to its sending rules, those
//       left out ("not searched") and the own states or countries searched as
//       the rules' places inside them (narrowPlaces; read by areaOf).
// Each is read in one function, so the shape the engine gives them is named
// in one place.

type Geo = Awaited<ReturnType<typeof loadGeo>>;
type Effective = ReturnType<typeof resolveLinkedin>;
export type Settings = ReturnType<typeof settingsFrom>;
type Built = ReturnType<typeof linkedinCompanyRequests>;

const iso = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};
const kindWord = (kind: LinkedinKind) => (kind === "people" ? "people" : "company");

/** The settings, read fresh (the routes never use the worker's 30-second cache). */
export async function readSettingsNow(c: PoolClient): Promise<Settings> {
  const { rows } = await c.query<{ key: string; value: unknown }>(`SELECT key, value FROM enrich_settings`);
  return settingsFrom(rows);
}

/** The LinkedIn switch for a client: on, on its list, and with the pipeline each source needs. */
export function switchView(s: Settings, tag: string): LinkedinSwitchView {
  const t = normTag(tag);
  const ls = s.linkedin_sources;
  return {
    enabled: ls.enabled,
    onList: ls.tags.includes(t),
    companies: s.flagOn("linkedin_companies", t),
    people: s.flagOn("linkedin_people", t),
    peoplePerCompany: ls.people_per_company,
  };
}

/**
 * Why a LinkedIn search of this kind can't run for the client now, as the
 * routes answer it (409): the pipeline the source needs (company pulls for a
 * company search, people runs for a people search), then the LinkedIn switch
 * and its client list. Null when nothing stops it here.
 */
export function switchRefusal(s: Settings, tag: string, kind: LinkedinKind, what: "counted" | "started"): string | null {
  const t = normTag(tag);
  if (kind === "companies") {
    if (!s.company_pipeline.enabled) return `Company pulls are off, so nothing was ${what}. An admin can switch them on in the settings.`;
    if (!s.flagOn("company_pipeline", t)) return `${t} is not on the company pipeline's client list, so nothing was ${what}. An admin adds it in the settings.`;
  } else {
    if (!s.people_pipeline.enabled) return `People runs are off, so nothing was ${what}. An admin can switch them on in the settings.`;
    if (!s.flagOn("people_pipeline", t)) return `${t} is not on the people runs' client list, so nothing was ${what}. An admin can add it in the settings.`;
  }
  if (!s.linkedin_sources.enabled) return `LinkedIn searches are off, so nothing was ${what}. An admin can switch them on in the settings.`;
  if (!s.flagOn("linkedin_sources", t)) return `${t} is not on the LinkedIn searches' client list, so nothing was ${what}. An admin adds it in the settings.`;
  return null;
}

/** The 409 for a count, pull or run whose LinkedIn search changed since the page loaded it. */
export function changedText(tag: string, kind: LinkedinKind, what: "counted" | "started") {
  return `${normTag(tag)}'s LinkedIn ${kindWord(kind)} search changed since this page loaded it (its LinkedIn settings, its rules or its AI Ark people filters), so nothing was ${what}. Reload to see it.`;
}

// ── What the engine says, read in one place each (O1, O2) ───────────────────

/**
 * O1: the keywords of the union AI Ark's request can't hold. They are not
 * dropped: every company and person a LinkedIn search finds is checked against
 * the whole list after the pull. The resolver gives them as
 * keywords.checkedAfter (keywordsFor in linkedin-settings.mjs).
 */
export function checkedAfterOf(e: Effective): string[] {
  return [...e.keywords.checkedAfter];
}

/**
 * O2: the places a LinkedIn search sends (the client's own include places
 * narrowed to its sending rules, client_targeting), those left out (not
 * searched: outside the sending rules), and each own state or country the
 * rules don't cover whole with the rules' places inside it that are searched
 * instead. All three are the resolver's `search` (narrowPlaces), so the page,
 * the count, the pull and the run never disagree on what is searched.
 */
export function areaOf(e: Effective): { sent: PlaceEntry[]; notSearched: PlaceEntry[]; narrowed: Array<{ entry: PlaceEntry; into: PlaceEntry[] }> } {
  const s = e.search;
  return {
    sent: [...s.include],
    notSearched: s.notSearched.map((n) => n.entry),
    narrowed: s.replaced.map((r) => ({ entry: r.entry, into: [...r.by] })),
  };
}

const viewsOf = (entries: PlaceEntry[], g: Geo): PlaceView[] => entries.map((entry) => ({ entry, text: placeText(entry, g) }));

export function keywordsView(e: Effective): LinkedinKeywordsView {
  return { union: e.keywords.union.length, sent: e.keywords.sent.length, checkedAfter: checkedAfterOf(e) };
}

/** The request bodies of a LinkedIn search of the resolver's kind, with its blockers and notes (no AI Ark call). */
export function linkedinPlanOf(e: Effective, g: Geo): Built {
  return e.kind === "people" ? linkedinPeopleRequests({ effective: e, geo: g }) : linkedinCompanyRequests({ effective: e, geo: g });
}

const planOf = (built: Built): LinkedinPlan => ({
  searches: built.requests.length,
  blockers: [...built.blockers],
  pullBlockers: [...built.pullBlockers],
  notes: [...built.notes],
});

/** O2 as the page shows it: the places sent, those not searched, and the own states or countries searched as the rules' places inside them. */
export function areaView(e: Effective, g: Geo): { placesSent: PlaceView[]; notSearched: PlaceView[]; narrowed: NarrowedPlace[] } {
  const area = areaOf(e);
  const narrowed: NarrowedPlace[] = area.narrowed.map((n) => ({ entry: { entry: n.entry, text: placeText(n.entry, g) }, into: viewsOf(n.into, g) }));
  return { placesSent: viewsOf(area.sent, g), notSearched: viewsOf(area.notSearched, g), narrowed };
}

function standardOf(e: Effective): LinkedinSettingsView["standard"] {
  const f = e.filters.value as PeopleFilters;
  const list = e.competitors ?? COMPETITORS_FALLBACK;
  return {
    from: e.filters.from,
    titles: f.titles?.length ?? 0,
    titleMode: f.title_mode ?? "WORD",
    excludeTitles: f.exclude_titles?.length ?? 0,
    bands: f.employee_bands ?? [],
    excludeIndustries: f.exclude_industries?.length ?? 0,
    companyTypes: [...CLEANING_EXCLUDE_COMPANY_TYPES],
    keywords: [...e.keywords.standard],
    competitors: { name: list.name, from: list.from, terms: [...list.terms], added: e.keywords.list.added.length, note: list.note, editHref: COMPETITORS_EDIT_HREF },
    filters: f,
  };
}

// ── The editor's view (GET and PUT /api/aiark/linkedin-settings) ────────────

/**
 * One kind of a client's LinkedIn settings as the AI Ark tab's editor shows
 * them: its own lists (editable), the standard filters (read only), the
 * keywords sent and those checked after the pull, the places not searched,
 * the plan, where the lists came from, the log of saves and seed writes, and
 * the version a save sends back. Read inside the caller's transaction.
 */
export async function settingsView(
  c: PoolClient,
  { tag, kind, g, effective }: { tag: string; kind: LinkedinKind; g: Geo; effective?: Effective }
): Promise<LinkedinSettingsView> {
  const e = effective ?? (await linkedinSettingsFor(c, { tag, kind }));
  const built = linkedinPlanOf(e, g);
  const rules = await readTargeting(c, e.tag);
  const log = await logFor(c, { tag: e.tag, kind, limit: 10 });
  const row = e.row;
  let updatedBy: string | null = null;
  if (row?.source === "manual" && row.updated_by) {
    const { rows } = await c.query<{ full_name: string | null }>(`SELECT full_name FROM user_profiles WHERE id = $1`, [row.updated_by]);
    updatedBy = rows[0]?.full_name ?? null;
  }
  const flags = Array.isArray(row?.flags) ? row.flags : [];
  const words = LINKEDIN_FLAGS as Record<string, string>;
  return {
    tag: e.tag,
    kind,
    from: e.from,
    own: {
      include_locations: viewsOf(e.own.include_locations, g),
      exclude_locations: viewsOf(e.own.exclude_locations, g),
      unplaced: e.own.unplaced.map((u: UnplacedValue) => ({ ...u, suggestionTexts: u.suggestions.map((s) => placeText(s, g)) })),
      exclude_keywords: [...e.own.exclude_keywords],
    },
    standard: standardOf(e),
    keywords: keywordsView(e),
    ...areaView(e, g),
    rules: {
      exists: Boolean(rules),
      places: Array.isArray(rules?.include_locations) ? rules.include_locations.length : 0,
      excludedPlaces: Array.isArray(rules?.exclude_locations) ? rules.exclude_locations.length : 0,
    },
    plan: planOf(built),
    provenance: row
      ? {
          source: row.source,
          clay: row.clay_source_id || row.clay_campaign || row.clay_set_up_at
            ? { sourceId: row.clay_source_id ?? null, campaign: row.clay_campaign ?? null, setUpAt: iso(row.clay_set_up_at), fingerprint: row.clay_fingerprint ?? null }
            : null,
          copiedFrom: row.copied_from ?? null,
          seededAt: iso(row.seeded_at),
          updatedAt: iso(row.updated_at),
          updatedBy,
          notes: Array.isArray(row.notes) ? [...row.notes] : [],
          flags: [...flags],
          flagWords: Object.fromEntries(flags.filter((f) => f in words).map((f) => [f, words[f]])),
        }
      : { source: null, clay: null, copiedFrom: null, seededAt: null, updatedAt: null, updatedBy: null, notes: [], flags: [], flagWords: {} },
    starter: { ...e.starter },
    log: log.map(
      (l): LinkedinLogEntry => ({
        id: l.id,
        action: l.action,
        at: iso(l.at) ?? "",
        byName: l.by_name ?? null,
        seededBy: l.seeded_by ?? null,
        before: (l.before as unknown as LinkedinLogEntry["before"]) ?? null,
        after: l.after as unknown as LinkedinLogEntry["after"],
      })
    ),
    version: e.versions.own,
    searchVersion: e.version,
  };
}

// ── The editor's preview (POST /api/aiark/linkedin-settings) ────────────────

/** Typed places resolved as a save resolves them: text read as a place, then checked against the geo reference. */
async function resolveTyped(c: PoolClient, g: Geo, places: Array<string | PlaceEntry>, label: string, errors: string[]): Promise<PlaceEntry[]> {
  const entries: PlaceEntry[] = [];
  const labels: string[] = [];
  for (const p of places) {
    if (typeof p === "string") {
      const r = placeFromText(p, g);
      if ("why" in r) errors.push(`${label}: ${p}: ${r.why}`);
      else {
        entries.push(r.entry);
        labels.push(p);
      }
    } else {
      entries.push(p);
      labels.push(placeText(p, g));
    }
  }
  const checked = await checkPlaces(c, entries, g, { label: (_e: PlaceEntry, i: number) => `${label}: ${labels[i]}` });
  errors.push(...checked.errors);
  return checked.entries;
}

/**
 * The plan for lists not saved yet: what a save of `value` would search, with
 * every reason a save would refuse (each place, keyword and unplaced value
 * named). Nothing is written and AI Ark is not called.
 */
export async function previewView(
  c: PoolClient,
  { tag, kind, value, g }: { tag: string; kind: LinkedinKind; value: unknown; g: Geo }
): Promise<LinkedinPreview> {
  const t = normTag(tag);
  const shape = cleanOwnInput(value);
  const errors = [...shape.errors];
  const include = await resolveTyped(c, g, shape.value.include_locations, "Places", errors);
  const exclude = await resolveTyped(c, g, shape.value.exclude_locations, "Places left out", errors);
  const row = await readLinkedinRow(c, t, kind);
  const stored = row ? ownOf(row).unplaced : [];
  const keyOf = (u: UnplacedValue) => `${u.side}|${u.field}|${u.value}`;
  const storedKeys = new Set(stored.map(keyOf));
  const sentKeys = new Set(shape.value.unplaced.map(keyOf));
  const added = shape.value.unplaced.filter((u) => !storedKeys.has(keyOf(u)));
  if (added.length) errors.push(`Unplaced values can be kept or removed, not added: ${added.slice(0, 3).map((u) => `"${u.value}"`).join(", ")}`);
  const { rows: [client] } = await c.query<{ client_type: string | null }>(`SELECT client_type FROM client_tags WHERE tag = $1`, [t]);
  const targeting = await readTargeting(c, t);
  const saved = await readSavedFilters(c, t);
  const starter = await readStarter(c);
  const competitors = await readCompetitors(c);
  const draft = {
    client_tag: t, kind, notes: [], flags: [], source: "manual", copied_from: null, clay_source_id: null, clay_campaign: null, clay_set_up_at: null,
    clay_fingerprint: null, seed_sha256: null, seeded_at: null, updated_by: null, created_at: "", updated_at: "", version: "preview",
    ...(row ?? {}),
    include_locations: include,
    exclude_locations: exclude,
    unplaced: stored.filter((u: UnplacedValue) => sentKeys.has(keyOf(u))),
    exclude_keywords: shape.value.exclude_keywords,
  } as unknown as NonNullable<Parameters<typeof resolveLinkedin>[0]["row"]>;
  const e = resolveLinkedin({ tag: t, kind, row: draft, targeting, starter, saved, clientType: client?.client_type ?? null, competitors });
  const built = linkedinPlanOf(e, g);
  return { plan: planOf(built), keywords: keywordsView(e), ...areaView(e, g), errors };
}

// ── The Companies tab (GET /api/companies/setup and /people/setup) ──────────

/** A LinkedIn search of a client and kind as the Companies tab's panels show it, with the version a count, pull or run sends back. */
export async function linkedinPlanView(
  c: PoolClient,
  { tag, kind, settings, g }: { tag: string; kind: LinkedinKind; settings: Settings; g: Geo }
): Promise<LinkedinPlanView> {
  const e = await linkedinSettingsFor(c, { tag, kind });
  const built = linkedinPlanOf(e, g);
  const area = areaOf(e);
  return {
    kind,
    switch: switchView(settings, tag),
    from: e.from,
    places: e.own.include_locations.length,
    placesSent: area.sent.length,
    notSearched: area.notSearched.length,
    narrowed: area.narrowed.length,
    excludedPlaces: e.own.exclude_locations.length,
    unplaced: e.own.unplaced.length,
    keywords: { union: e.keywords.union.length, sent: e.keywords.sent.length, checkedAfter: checkedAfterOf(e).length },
    searches: built.requests.length,
    blockers: [...built.blockers],
    pullBlockers: [...built.pullBlockers],
    notes: [...built.notes],
    version: e.version,
  };
}

/**
 * linkedinPlanView, or null when it can't be read, so the Companies tab still
 * loads (for example before migration 128 is applied). Inside a savepoint: a
 * failed read leaves the caller's transaction usable.
 */
export async function linkedinPlanViewSafe(c: PoolClient, opts: Parameters<typeof linkedinPlanView>[1]): Promise<LinkedinPlanView | null> {
  await c.query("SAVEPOINT linkedin_plan");
  try {
    const v = await linkedinPlanView(c, opts);
    await c.query("RELEASE SAVEPOINT linkedin_plan");
    return v;
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT linkedin_plan").catch(() => {});
    console.error(`linkedin plan (${opts.kind}):`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Starting a LinkedIn pull or run ─────────────────────────────────────────

/** What a LinkedIn company pull keeps in its aiark_company_runs.filters: what it was asked, and filters.linkedin (the engine's linkedinRunFilters). */
export function linkedinPullFilters(e: Effective, built: Built) {
  return {
    source: "linkedin",
    company: pickCompanyFilters(e.filters.value),
    filters_from: e.filters.from,
    linkedin_version: e.version,
    report: built.report,
    notes: built.notes,
    linkedin: linkedinRunFilters(e),
  };
}

type CompanyRunArgs = Parameters<typeof createCompanyRun>[1];
type PeopleRunArgs = Parameters<typeof createPeopleRun>[1];

/** A LinkedIn pull the engine could not make as one: the route answers 409 and the transaction is rolled back. */
export class LinkedinPullRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedinPullRefused";
  }
}

/**
 * createCompanyRun with source "linkedin" and the resolver's made-up rules
 * (linkedinTargeting, the builder's `targeting`), so the free registry copy
 * matches the places AI Ark is asked for (contract section 8). An engine that
 * did not keep the source would copy and buy by the client's database rules
 * instead: such a pull is refused (thrown, so the caller's transaction rolls
 * back) and nothing is started.
 */
export async function createLinkedinCompanyRun(c: PoolClient, args: CompanyRunArgs & { targeting: object }) {
  const opts: CompanyRunArgs & { source: "linkedin"; targeting: object } = { ...args, source: "linkedin" };
  const run = await createCompanyRun(c, opts);
  if (run?.source !== "linkedin") {
    throw new LinkedinPullRefused("This build can't make LinkedIn company pulls yet (the pull engine kept no LinkedIn source), so nothing was started.");
  }
  return run;
}

/** createPeopleRun with source "linkedin" and the version the page showed (the engine refuses a changed one; contract section 7). */
export function createLinkedinPeopleRun(c: PoolClient, args: PeopleRunArgs & { version: string }) {
  const opts: PeopleRunArgs & { version: string } = { ...args, source: "linkedin" };
  return createPeopleRun(c, opts);
}
