// LinkedIn people runs (phase 4, design 2C.2, D-P4-1 to D-P4-8): the client's
// LinkedIn people search on AI Ark, an area search whatever the company, worked
// by the people runs' engine (people-runs.mjs) as source "linkedin" (by area).
//
//   Look   People Preview by area: the bodies linkedinPeopleRequests built when
//          the run was made (the client's places narrowed to its sending rules,
//          the standard titles and filters, the keywords), each paged up to
//          people_pipeline.pages_per_search pages at 1 credit a page, with AI
//          Ark exclusion lists of the people this client's LinkedIn runs already
//          looked at and the registry's bought people, within the shared daily
//          list budget. Without the lists it needs, the run stops before paying
//          for pages it would repeat. Everyone seen is screened free: no company
//          (no_company), the database, the person's own place and the offices of
//          the Preview's company against the client's area ("outside", never
//          bought), the client's exclusion terms and every one of its LinkedIn
//          keywords on the company ("excluded", never bought), the registry.
//          The Preview's company objects are kept for the run.
//   Pick   once the Look is done: per AI Ark company, at most
//          linkedin_sources.people_per_company, less the company's usable
//          contacts already in the client's People table and this run's people
//          already in the database there; people with a track phrase first
//          (track order, then rank), then the others in AI Ark's order; every
//          company's first before any second, and at most max_people to buy.
//          People another run bought with an email are picked to be copied free.
//   Buy    after a manager's Buy (auto_buy off): Export Single per pick (the
//          registry checked again first: bought since the Look, copied free).
//          Before any email step, the person's full company record is checked
//          again: the client's exclusion terms and LinkedIn keywords on its name,
//          industry and description, and its offices against the client's area;
//          a match ends the person there (Excluded, or Outside), paid for and
//          registered, with no row. Otherwise the company is brought into the
//          client's Companies table (the registry's record, free, else the
//          person's own company record from Export Single, else the Preview's
//          object for a person with no email; never a Company Search), judged
//          on any office, and the People row written (found_by linkedin; the
//          office's city and state, D13) and linked to it.
//   End    when no pick is left.
//
// Paying twice: the registry is read per page and again before each Buy; the
// lists keep repeats out of the Look; a buy is written with its registry entry
// in one statement.
//
// Plain JavaScript: the worker and the tests use it through people-runs.mjs,
// which hands it its own helpers (the kit), so the two never import each other.

import { randomUUID } from "node:crypto";
import { AiArkError, clip, LIST_MAX, LISTS_PER_DAY, LISTS_PER_REQUEST, PAGE_MAX, personInputs, SEARCH_CAP } from "./client.mjs";
import { officesOf, OFFICES_MAX, stateHalves } from "./company-filters.mjs";
import { findState } from "./geo.mjs";
import { LINKEDIN_LABELS } from "./linkedin-labels.mjs";
import { linkedinPeopleRequests, linkedinRunFilters } from "./linkedin-requests.mjs";
import { linkedinSettingsFor } from "./linkedin-settings.mjs";
import { trackOf } from "./people-requests.mjs";
import { LIST_BUDGET, LIST_REFRESH_MS, listsMadeToday } from "./runs.mjs";
import { companyTermHit, geoFor, judgePlace, targetingFor } from "../enrich/client-checks.mjs";
import { COMPANY_SEARCH_KEYS, companyInputs } from "../enrich/company-template.mjs";
import { COMPANY_INPUT_KEYS_V2 } from "../enrich/company-template-v2.mjs";
import { aiarkPersonRowKey } from "../enrich/people-template.mjs";
import { TRACKS } from "../enrich/settings.mjs";

const fmt = (n) => Number(n).toLocaleString("en-US");
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const LIST_IDS_MAX = LISTS_PER_REQUEST * LIST_MAX;
/** The Preview positions a search holds: search s, page p, position i is seq s * SEQ_SEARCH + p * PAGE_MAX + i. */
const SEQ_SEARCH = 1_000_000;

/** The keywords the run's after-pull checks read: the whole union it stored (override O1), lower case. */
const keywordsOf = (run) => [...new Set((run.filters?.linkedin?.keywords?.union ?? []).map((s) => text(s).toLowerCase()).filter(Boolean))];

// ── Creating a run ──────────────────────────────────────────────────────────

/**
 * A LinkedIn people run (createPeopleRun with a by-area source), inside the
 * caller's transaction: refused (PeopleRunRefused, 409) while LinkedIn people
 * runs are off for the client (people runs and the LinkedIn searches both on,
 * the client on both lists), with a run of any source going, when the
 * settings changed since the page loaded them (`version`), or with a plan
 * blocker. No people tracks are needed (they only order the pick).
 *
 * @param {{ query: Function }} db
 * @param {{ tag: string, mode: "live" | "demo", source: string, maxPeople?: number | null, createdBy?: string | null,
 *           settings: object, version?: string | null, ensureTables: Function }} opts
 * @param {object} kit  people-runs.mjs's helpers
 */
export async function createLinkedinPeopleRun(db, { tag, mode, source, maxPeople = null, createdBy = null, settings, version = null, ensureTables }, kit) {
  const s = settings;
  const pp = s.people_pipeline;
  const refuse = (msg, extra) => {
    throw Object.assign(new kit.PeopleRunRefused(msg), extra ?? {});
  };
  if (!pp.enabled) refuse("People runs are off, so nothing was started.");
  if (!s.flagOn("people_pipeline", tag)) refuse(`${tag} is not on the people runs' client list, so nothing was started.`);
  if (!s.linkedin_sources?.enabled) refuse("LinkedIn searches are off, so nothing was started.");
  if (!s.flagOn("linkedin_people", tag)) refuse(`${tag} is not on the LinkedIn searches' client list, so nothing was started.`);
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('aiark-people-run:' || $1))`, [tag]);
  const going = await kit.activePeopleRun(db, tag);
  if (going) refuse(`${tag} already has a people run going (${going.status}). Cancel it or let it finish first.`);
  const effective = await linkedinSettingsFor(db, { tag, kind: "people" });
  if (version != null && version !== effective.version) {
    refuse(`${tag}'s LinkedIn people settings, its rules or its saved AI Ark filters changed since this page loaded them. Reload to see them; nothing was started.`, { changed: true });
  }
  const { geo } = await geoFor(db);
  const built = linkedinPeopleRequests({ effective, geo });
  if (built.blockers.length) refuse(built.blockers.join(" "));
  if (!built.requests.length) refuse(`${tag}'s LinkedIn people search has nothing to ask AI Ark, so nothing was started.`);
  const tables = await ensureTables(db, tag, { settings: s });
  const size = Math.max(1, Math.min(pp.max_people_per_run, Number.isInteger(maxPeople) && maxPeople > 0 ? maxPeople : pp.max_people_per_run));

  const id = randomUUID();
  const demo = mode === "demo";
  const { rows: [bought] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, label, meta, created_by) VALUES ($1, 'linkedin', $2, $3, $4) RETURNING id`,
    [tables.people, `${LINKEDIN_LABELS.peopleRun}${demo ? " (made-up people)" : ""}`, JSON.stringify({ people_run_id: id, mode, source, max_people: size }), createdBy]
  );
  const { rows: [copied] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, label, meta, created_by) VALUES ($1, 'registry', $2, $3, $4) RETURNING id`,
    [tables.people, "Copied from earlier runs (no charge)", JSON.stringify({ people_run_id: id, mode, source }), createdBy]
  );
  const { rows: [companies] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, label, meta, created_by) VALUES ($1, 'linkedin', $2, $3, $4) RETURNING id`,
    [tables.companies, `${LINKEDIN_LABELS.personCompanies}${demo ? " (made-up companies)" : ""}`, JSON.stringify({ people_run_id: id, mode, source }), createdBy]
  );
  const filters = {
    source,
    tracks: s.people_tracks ?? null,
    linkedin: linkedinRunFilters(effective),
    bodies: built.requests,
    bodies_per_batch: 1,
    people_per_company: s.linkedin_sources.people_per_company,
    pages_per_search: pp.pages_per_search,
    cleaning: true,
    notes: built.notes,
    variant: tables.variant ?? "default",
    company_source_id: companies.id,
  };
  const { rows: [run] } = await db.query(
    `INSERT INTO aiark_people_runs (id, client_tag, mode, source, companies_table_id, people_table_id, source_id, registry_source_id,
                                    max_people, filters, companies, batches, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12) RETURNING *`,
    [id, tag, mode, source, tables.companies, tables.people, bought.id, copied.id, size, JSON.stringify(filters), built.requests.length, createdBy]
  );
  return run;
}

// ── Look ────────────────────────────────────────────────────────────────────

const listsDue = (p) => !p.lists_at || Date.now() - Date.parse(p.lists_at) > LIST_REFRESH_MS;

/**
 * The people the Look's lists leave out, newest first, as of `at`: those this
 * client's LinkedIn runs looked at (this one too), then the registry's bought
 * people, at most 100,000 in all.
 */
async function listIds(pool, run, at) {
  const { rows: looked } = await pool.query(
    `SELECT c.person_id FROM aiark_people_candidates c JOIN aiark_people_runs r ON r.id = c.run_id
      WHERE r.client_tag = $1 AND r.source = 'linkedin' AND r.mode = $2 AND c.looked_at < $3::timestamptz
      GROUP BY c.person_id ORDER BY max(c.looked_at) DESC, c.person_id LIMIT $4`,
    [run.client_tag, run.mode, at, LIST_IDS_MAX]
  );
  const { rows: bought } = await pool.query(
    `SELECT person_id FROM aiark_people WHERE demo = $1 AND pulled_at < $2::timestamptz ORDER BY pulled_at DESC, person_id LIMIT $3`,
    [run.mode === "demo", at, LIST_IDS_MAX]
  );
  const seen = new Set(looked.map((r) => r.person_id));
  const all = [...seen];
  for (const r of bought) {
    if (all.length >= LIST_IDS_MAX) break;
    if (!seen.has(r.person_id)) all.push(r.person_id);
  }
  return { looked: Math.min(seen.size, LIST_IDS_MAX), all };
}

/**
 * The Look's exclusion lists, made one at a time (free) and saved as they are
 * made, within the shared daily budget. Every list this client's own looked-at
 * people need must be made, or the run stops: without them the Look would pay
 * again for the pages it already read. A rebuild (the lists a day old) starts
 * the current search over, now leaving out what this run saw.
 */
async function makeLookLists(ctx, kit) {
  const { pool, run, client } = ctx;
  const p = ctx.progress;
  const resumed = p.lists_new && Date.now() - Date.parse(p.lists_new.started) < LIST_REFRESH_MS ? p.lists_new : null;
  let plan = resumed;
  if (!plan) {
    const { rows: [{ at }] } = await pool.query(`SELECT now()::text AS at`);
    plan = { at, started: new Date().toISOString(), made: [], count: 0 };
  }
  const ids = await listIds(pool, run, plan.at);
  const need = Math.ceil(ids.all.length / LIST_MAX);
  const must = Math.ceil(ids.looked / LIST_MAX);
  const budget = Math.max(0, LIST_BUDGET - (await listsMadeToday(pool, run.mode)));
  if (budget < must - plan.made.length) {
    return {
      stop: `Not enough exclusion lists left today: AI Ark allows ${LISTS_PER_DAY} a day, shared with the AI Ark tab, company pulls and people runs, and ${fmt(budget)} ${budget === 1 ? "is" : "are"} left. This client's LinkedIn runs have already looked at ${fmt(ids.looked)} people, and without the lists this Look would pay again for their pages, so it stopped before buying any. Start a new run tomorrow.`,
    };
  }
  let left = budget;
  let refused = null;
  while (plan.made.length < need && left > 0) {
    const chunk = ids.all.slice(plan.count, plan.count + LIST_MAX);
    if (!chunk.length) break;
    let id;
    try {
      id = await client.createList(chunk, "people_id");
    } catch (e) {
      if (!(e instanceof AiArkError) || e.retryable || e.kind === "key" || e.kind === "credits") throw e;
      refused = e.message;
      break;
    }
    left--;
    plan = { ...plan, made: [...plan.made, id], count: plan.count + chunk.length };
    ctx.progress = { ...ctx.progress, lists_new: plan, lists_log: [...(ctx.progress.lists_log ?? []), new Date().toISOString()] };
    await kit.savePosition(ctx);
  }
  if (refused && plan.count < ids.looked) {
    return { stop: `AI Ark refused an exclusion list (${refused}): without it this Look would pay again for pages this client's LinkedIn runs already read, so it stopped before buying any.` };
  }
  const short = plan.count < ids.all.length;
  const restart = Boolean(p.lists_at) && plan.made.join() !== (p.lists ?? []).join();
  ctx.progress = {
    ...ctx.progress,
    lists: plan.made,
    lists_at: plan.started,
    lists_new: null,
    excluded: plan.count,
    lists_short: short,
    lists_note: refused
      ? `AI Ark refused an exclusion list (${refused}): people the registry holds may be seen again (they are copied or passed over, never bought twice).`
      : short
        ? `The lists leave out the ${fmt(plan.count)} newest of ${fmt(ids.all.length)} people already looked at or bought; the others may be seen again (copied or passed over, never bought twice).`
        : null,
    // New lists change what a search returns: the current search starts over.
    ...(restart ? { page: 0 } : {}),
  };
  await kit.savePosition(ctx);
  return { more: true };
}

/** Text of a city as AI Ark wrote it, with capitals when it came all lower case. */
function cityName(s) {
  const t = text(s);
  return /\p{Lu}/u.test(t) ? t : t.replace(/(^|[\s'.-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

/**
 * Where a company is for the client (D13, override O2): its offices (head
 * office first) judged as client_office judges them; the first inside, with
 * its city and state code. `known: false` when AI Ark gave no office.
 *
 * @returns {Promise<{ known: boolean, inside: boolean, city?: string, state?: string, why?: string }>}
 */
export async function officeInArea(db, tag, record) {
  const offices = officesOf(record ?? {}).slice(0, OFFICES_MAX);
  if (!offices.length) return { known: false, inside: false };
  const t = await targetingFor(db, tag);
  if (!t) return { known: true, inside: false, why: `${tag} has no targeting rules` };
  const { geo } = await geoFor(db);
  let first = null;
  for (const o of offices) {
    const state = stateHalves(o.state).find((h) => findState(geo, h)) ?? text(o.state);
    const v = await judgePlace({ city: o.city, state, country: o.country }, { targeting: t, db });
    first ??= v;
    if (v.value === true) return { known: true, inside: true, city: cityName(o.city), state: v.place?.state ?? "" };
  }
  return { known: true, inside: false, why: first?.note ?? "no office is in the client's area" };
}

/** A company's facts the exclusion checks read: its name, main industry and description. */
const companyFacts = (record) => {
  const s = record?.summary ?? {};
  return { company: text(s.name ?? record?.name), industry: text(s.industry), description: clip(text(s.description), 5_000) };
};

/** The Preview's company object as kept for the run: what the checks and a bring-in read, no more. */
function previewCompany(co) {
  const s = co?.summary ?? {};
  const loc = co?.location ?? {};
  return {
    id: text(co?.id),
    summary: {
      name: text(s.name) || null, industry: text(s.industry) || null, description: clip(text(s.description), 2_000) || null,
      type: text(s.type) || null, staff: s.staff && typeof s.staff === "object" ? s.staff : null,
    },
    location: {
      headquarter: loc.headquarter && typeof loc.headquarter === "object" ? loc.headquarter : null,
      locations: (Array.isArray(loc.locations) ? loc.locations : []).filter((o) => o && typeof o === "object").slice(0, OFFICES_MAX),
    },
    industries: (Array.isArray(co?.industries) ? co.industries : []).map(text).filter(Boolean).slice(0, 10),
  };
}

/**
 * One Preview page screened, free: per person the verdict (the first that
 * applies), track and rank; the Preview's company objects to keep.
 */
async function screenArea(ctx, kit, people, { search, page }) {
  const { run } = ctx;
  const tracks = run.filters?.tracks ?? null;
  const keywords = keywordsOf(run);
  const items = people.map((p, i) => ({ p, f: kit.factsOf(p), seq: search * SEQ_SEARCH + page * PAGE_MAX + i })).filter((x) => x.f.person_id);
  const registry = await kit.registryOf(ctx.pool, items.map((x) => x.f.person_id));
  const screened = await kit.mapLimit(items, kit.consts.SCREEN_THREADS, async ({ p, f, seq }) => {
    const found = tracks ? trackOf(f.title, tracks) : null;
    let verdict = "candidate";
    let held = null;
    if (!f.company_id) verdict = "no_company";
    else {
      const company = { name: f.company, domain: "", industry: f.industry, description: f.description };
      const r = await kit.screenOne(ctx, f, company);
      verdict = r.verdict;
      held = r.held_lead_id ?? null;
      // Override O2: no office of the company in the client's area means the person's row would be outside it (D13).
      if (verdict === "candidate") {
        const where = await officeInArea(ctx.pool, run.client_tag, p.company);
        if (where.known && !where.inside) verdict = "outside";
      }
      // Override O1: every LinkedIn keyword, sent to AI Ark or not, on what the Preview holds of the company.
      if (verdict === "candidate" && companyTermHit({ company: f.company, industry: f.industry, description: f.description }, keywords)) verdict = "excluded";
      if (verdict === "candidate" && registry.has(f.person_id)) verdict = "bought_before";
    }
    return { f, seq, verdict, held, track: found?.track ?? null, rank: found?.rank ?? null };
  });
  const candidates = screened.map((x) => ({
    person_id: x.f.person_id, company_id: x.f.company_id || null, first_name: x.f.first_name || null, last_name: x.f.last_name || null,
    title: x.f.title || null, city: x.f.city || null, region: x.f.region || null, country: x.f.country || null, seniority: x.f.seniority || null,
    department: x.f.department || null, track: x.track, rank: x.rank, verdict: x.verdict, held_lead_id: x.held, seq: x.seq,
  }));
  const companies = new Map();
  for (const { p } of items) {
    const id = text(p.company?.id);
    if (id && !companies.has(id)) companies.set(id, { company_id: id, record: previewCompany(p.company) });
  }
  return { candidates, companies: [...companies.values()] };
}

const AREA_LOOK_SQL = `
  WITH st AS (
    SELECT status, claim_token = $2 AS held, (progress->>'last_page') IS NOT DISTINCT FROM $3::text AS repeat
      FROM aiark_people_runs WHERE id = $1 FOR UPDATE
  ), pc AS (
    INSERT INTO aiark_people_preview_companies (run_id, company_id, record)
    SELECT $1, x.company_id, x.record FROM jsonb_to_recordset($5::jsonb) AS x(company_id text, record jsonb)
    ON CONFLICT (run_id, company_id) DO NOTHING
    RETURNING 1
  ), cand AS (
    INSERT INTO aiark_people_candidates (run_id, person_id, company_row_id, company_id, first_name, last_name, title, city, region, country,
                                         seniority, department, track, rank, verdict, held_lead_id, seq)
    SELECT $1, x.person_id, NULL, x.company_id, x.first_name, x.last_name, x.title, x.city, x.region, x.country,
           x.seniority, x.department, x.track, x.rank, x.verdict, x.held_lead_id, x.seq
      FROM jsonb_to_recordset($4::jsonb) AS x(person_id text, company_id text, first_name text, last_name text, title text, city text,
           region text, country text, seniority text, department text, track text, rank smallint, verdict text, held_lead_id uuid, seq int)
    ON CONFLICT (run_id, person_id) DO NOTHING
    RETURNING person_id
  ), u AS (
    UPDATE aiark_people_runs q
       SET pages = q.pages + CASE WHEN (SELECT repeat FROM st) THEN 0 ELSE 1 END,
           looked = q.looked + (SELECT count(*) FROM cand)::int,
           credits_used = q.credits_used + CASE WHEN (SELECT repeat FROM st) THEN 0 ELSE $6::numeric END,
           progress = CASE WHEN (SELECT held FROM st) THEN $7::jsonb ELSE q.progress END,
           claimed_at = CASE WHEN q.claim_token = $2 THEN now() ELSE q.claimed_at END
     WHERE q.id = $1
    RETURNING q.credits_used
  )
  SELECT (SELECT held FROM st) AS held, (SELECT status FROM st) AS status, (SELECT count(*) FROM cand)::int AS looked,
         (SELECT credits_used::float8 FROM u) AS used`;

/**
 * A Look page into the run, in one statement (as people-runs' writeLookPage):
 * its candidates, the Preview's company objects, the counters and the cursor;
 * written even after a lost claim (the page is paid for), the cursor moved only
 * while the claim is held, the page's credit counted once.
 */
async function writeAreaPage(ctx, kit, { candidates, companies, pageId, progress, credits }) {
  let plain = false;
  for (let tries = 0; ; tries++) {
    try {
      const cand = plain ? kit.plainOf(candidates) : kit.sane(candidates);
      const cos = plain ? kit.plainOf(companies) : kit.sane(companies);
      const { rows: [r] } = await ctx.pool.query(AREA_LOOK_SQL, [
        ctx.run.id, ctx.run.claim_token, pageId, JSON.stringify(cand), JSON.stringify(cos), credits, JSON.stringify(progress),
      ]);
      ctx.spent = r.used;
      if (!r.held) throw new kit.LostClaim();
      ctx.progress = progress;
      if (r.status === "cancelled") throw new kit.Cancelled();
      return r;
    } catch (e) {
      if (e instanceof kit.LostClaim || e instanceof kit.Cancelled) throw e;
      if (/^22/.test(String(e?.code ?? "")) && !plain) {
        plain = true;
        continue;
      }
      if (tries < kit.consts.WRITE_RETRIES) {
        await kit.sleep(kit.consts.WRITE_RETRY_MS * (tries + 1));
        continue;
      }
      await kit.readBack(ctx, e);
      throw e;
    }
  }
}

/**
 * One slice of a LinkedIn Look: the exclusion lists first, then one Preview
 * page of the current search (1 credit); when every search is read, the pick.
 */
export async function lookByArea(ctx, kit) {
  const { run } = ctx;
  const f = run.filters;
  const p = ctx.progress;
  const bodies = Array.isArray(f.bodies) ? f.bodies : [];
  const search = p.search ?? 0;
  if (search >= bodies.length) {
    await pickByArea(ctx, kit);
    ctx.progress = { ...ctx.progress, look_done: true, looked_at: new Date().toISOString() };
    await kit.savePosition(ctx);
    return { more: true };
  }
  if (listsDue(p)) return makeLookLists(ctx, kit);
  const page = p.page ?? 0;
  if (page >= Math.max(1, Number(f.pages_per_search) || 1) || (page + 1) * PAGE_MAX > SEARCH_CAP) {
    // More people than a search may look at: the rest are not looked at.
    ctx.progress = { ...p, search: search + 1, page: 0, capped: [...new Set([...(p.capped ?? []), search])] };
    await kit.savePosition(ctx);
    return { more: true };
  }
  const gate = await kit.beforePaidCall(ctx, 1);
  if (gate) return gate;
  await kit.savePosition(ctx); // a cancel is seen here, before the page is bought

  let res;
  try {
    res = await ctx.client.preview(bodies[search], { page, size: PAGE_MAX, lists: p.lists ?? [] });
  } catch (e) {
    if (e instanceof AiArkError && e.kind === "bad_request" && /request size/i.test(e.message)) {
      ctx.balance = ctx.balance == null ? null : ctx.balance + 1; // a refusal is free
      return { fail: `AI Ark refused LinkedIn search ${search + 1} of ${bodies.length} as too large (${e.message}); nothing was charged for it.` };
    }
    if (e instanceof AiArkError && (e.kind === "network" || e.kind === "server")) {
      const lost = Number(p.lost_in_row ?? 0) + 1;
      ctx.progress = { ...p, lost_in_row: lost, lost_pages: Number(p.lost_pages ?? 0) + 1, lost_credits: round2(Number(p.lost_credits ?? 0) + 1) };
      if (lost >= kit.consts.LOST_PAGES_MAX) {
        return { stop: `AI Ark's answer was lost ${lost} times in a row (${e.message}). Each of those pages may have been charged, so the run stopped.` };
      }
      return { error: e };
    }
    throw e;
  }
  const people = res.content.filter((x) => x && typeof x === "object" && x.id);
  const shot = await screenArea(ctx, kit, people, { search, page });
  const lastPage = !res.content.length || res.content.length < PAGE_MAX || (page + 1) * PAGE_MAX >= res.totalElements;
  const pageId = randomUUID();
  const next = {
    ...ctx.progress,
    lost_in_row: 0,
    matches: { ...(ctx.progress.matches ?? {}), [String(search)]: res.totalElements },
    ...(lastPage ? { search: search + 1, page: 0 } : { page: page + 1 }),
    last_page: pageId,
  };
  await writeAreaPage(ctx, kit, { candidates: shot.candidates, companies: shot.companies, pageId, progress: next, credits: 1 });
  return { more: true };
}

// ── Pick ────────────────────────────────────────────────────────────────────

/**
 * The run's picks, worked out from its candidates (pure): per AI Ark company,
 * up to `room(company)` people, people with a track phrase first (track
 * order, then rank), then the others in AI Ark's order (seq); every company's
 * first before any second (companies in the order AI Ark first showed them);
 * at most `maxBuys` to buy. Bought-before people (with an email in the
 * registry) are copied free and are not counted against maxBuys.
 *
 * @param {Array<{ person_id: string, company_id: string, verdict: string, track: string | null, rank: number | null, seq: number | null, copy_ok?: boolean }>} rows
 * @param {{ room: (companyId: string) => number, maxBuys: number }} opts
 * @returns {Array<{ person_id: string, company_id: string, buy: boolean }>} in the order they are bought
 */
export function pickArea(rows, { room, maxBuys }) {
  const byCompany = new Map();
  for (const r of rows) {
    if (!r.company_id) continue;
    const buy = r.verdict === "candidate";
    if (!buy && !(r.verdict === "bought_before" && r.copy_ok)) continue;
    if (!byCompany.has(r.company_id)) byCompany.set(r.company_id, []);
    byCompany.get(r.company_id).push({ ...r, buy });
  }
  const order = (x) => (x.track && TRACKS.includes(x.track) ? TRACKS.indexOf(x.track) : TRACKS.length);
  const seqOf = (x) => (Number.isFinite(Number(x.seq)) && x.seq !== null ? Number(x.seq) : Number.MAX_SAFE_INTEGER);
  const lists = [];
  for (const [companyId, list] of byCompany) {
    list.sort((a, b) => order(a) - order(b) || (order(a) < TRACKS.length ? Number(a.rank ?? 0) - Number(b.rank ?? 0) : 0) || seqOf(a) - seqOf(b) || (a.person_id < b.person_id ? -1 : 1));
    const n = Math.max(0, Math.floor(room(companyId)));
    if (n) lists.push({ first: Math.min(...list.map(seqOf)), list: list.slice(0, n) });
  }
  lists.sort((a, b) => a.first - b.first);
  const out = [];
  let buys = 0;
  for (let i = 0; lists.some((l) => i < l.list.length); i++) {
    for (const l of lists) {
      const x = l.list[i];
      if (!x) continue;
      if (x.buy && buys >= maxBuys) continue;
      if (x.buy) buys++;
      out.push({ person_id: x.person_id, company_id: x.company_id, buy: x.buy });
    }
  }
  return out;
}

/**
 * The pick, in one transaction fenced on the claim: what pickArea gives,
 * with each company's room = people_per_company less its usable contacts in
 * the client's People table and this run's people already in the database
 * there. Picks get pick 'picked'; the run's picked count goes up.
 */
async function pickByArea(ctx, kit) {
  const { run } = ctx;
  const c = await ctx.pool.connect();
  try {
    await c.query("BEGIN");
    const { rows: [held] } = await c.query(`SELECT 1 FROM aiark_people_runs WHERE id = $1 AND claim_token = $2 FOR UPDATE`, [run.id, run.claim_token]);
    if (!held) throw new kit.LostClaim();
    const { rows } = await c.query(
      `SELECT c.person_id, c.company_id, c.verdict, c.track, c.rank, c.seq, (a.email IS NOT NULL) AS copy_ok
         FROM aiark_people_candidates c LEFT JOIN aiark_people a ON a.person_id = c.person_id
        WHERE c.run_id = $1 AND c.pick = 'none' AND c.company_id IS NOT NULL AND c.verdict IN ('candidate', 'bought_before', 'held')`,
      [run.id]
    );
    const ids = [...new Set(rows.map((r) => r.company_id))];
    const { rows: usable } = ids.length
      ? await c.query(
          `SELECT substr(r.row_key, 7) AS company_id, count(*)::int AS n
             FROM enrich_contacts e JOIN enrich_rows r ON r.id = e.company_row_id
            WHERE e.client_tag = $1 AND e.kind = 'person' AND e.usable AND r.table_id = $2 AND r.row_key = ANY($3::text[])
            GROUP BY 1`,
          [run.client_tag, run.companies_table_id, ids.map((id) => `aiark:${id}`)]
        )
      : { rows: [] };
    const have = new Map(usable.map((u) => [u.company_id, u.n]));
    for (const r of rows) if (r.verdict === "held") have.set(r.company_id, (have.get(r.company_id) ?? 0) + 1);
    const perCompany = Math.max(1, Number(run.filters?.people_per_company) || 13);
    const picks = pickArea(rows, { room: (id) => perCompany - (have.get(id) ?? 0), maxBuys: Math.max(0, Number(run.max_people) - Number(run.bought ?? 0)) });
    if (picks.length) {
      await c.query(`UPDATE aiark_people_candidates SET pick = 'picked' WHERE run_id = $1 AND person_id = ANY($2::text[]) AND pick = 'none'`, [
        run.id, picks.map((x) => x.person_id),
      ]);
    }
    await c.query(`UPDATE aiark_people_runs SET picked = picked + $2, claimed_at = now() WHERE id = $1`, [run.id, picks.length]);
    await c.query("COMMIT");
    ctx.run.picked = Number(ctx.run.picked) + picks.length;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ── Buy ─────────────────────────────────────────────────────────────────────

/** The registry's record of a company (aiark_companies), or null. */
async function registryCompany(pool, companyId, mode) {
  const { rows } = await pool.query(`SELECT company_id, record FROM aiark_companies WHERE company_id = $1 AND demo = $2`, [companyId, mode === "demo"]);
  return rows[0] ? { ...rows[0].record, id: rows[0].company_id } : null;
}

/** The Preview's company object this run kept, or null. */
async function previewCompanyOf(pool, runId, companyId) {
  const { rows } = await pool.query(`SELECT record FROM aiark_people_preview_companies WHERE run_id = $1 AND company_id = $2`, [runId, companyId]);
  return rows[0]?.record ? { ...rows[0].record, id: companyId } : null;
}

const BRING_SQL = `
  WITH r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text)
    VALUES ($1::uuid, $2::uuid, $3, $4)
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id
  ), c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $1::uuid, 'done', to_jsonb(kv.value), left(kv.value, 300)
      FROM r CROSS JOIN LATERAL jsonb_each_text($5::jsonb) AS kv
    RETURNING 1
  )
  SELECT coalesce((SELECT id FROM r), (SELECT e.id FROM enrich_rows e WHERE e.table_id = $1::uuid AND e.row_key = $3)) AS id,
         (SELECT count(*) FROM r)::int AS inserted`;

/**
 * A LinkedIn person's company brought into the client's Companies table (D-P4-8,
 * decision 21): the row keyed aiark:<company id>, an existing one reused, else
 * written from `record` with the source "LinkedIn people (AI Ark)", queued, and
 * judged on any office (no hq_only). Free: no Company Search.
 *
 * @returns {Promise<{ id: number, inserted: boolean }>}
 */
export async function bringCompanyIn(db, { run, record }) {
  const inputs = { ...companyInputs(record, { source: LINKEDIN_LABELS.personCompanies }), client_tag: String(run.client_tag ?? "") };
  const cells = {};
  for (const k of COMPANY_INPUT_KEYS_V2) {
    const v = inputs[k];
    if (v) cells[k] = clip(String(v).replace(/\u0000/g, ""), 5_000);
  }
  const search = clip(COMPANY_SEARCH_KEYS.map((k) => cells[k]).filter(Boolean).join(" ").toLowerCase(), 2_000);
  const { rows: [r] } = await db.query(BRING_SQL, [run.companies_table_id, run.filters?.company_source_id ?? null, `aiark:${record.id}`, search, JSON.stringify(cells)]);
  return { id: Number(r.id), inserted: r.inserted > 0 };
}

const AREA_BUY_SQL = `
  WITH st AS (
    SELECT status, claim_token = $2 AS held FROM aiark_people_runs WHERE id = $1 FOR UPDATE
  ), cand AS (
    SELECT pick FROM aiark_people_candidates WHERE run_id = $1 AND person_id = $3 FOR UPDATE
  ), fresh AS (
    SELECT coalesce((SELECT pick FROM cand) = 'picked', false) AND ($19::boolean OR coalesce((SELECT held FROM st), false)) AS yes
  ), r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text)
    SELECT $4::uuid, $5::uuid, $6::text, $7::text WHERE (SELECT yes FROM fresh) AND $8::jsonb IS NOT NULL
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id
  ), c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $4::uuid, 'done', kv.value,
           left(CASE WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}' ELSE coalesce(kv.value ->> 'name', kv.value::text) END, 300)
      FROM r CROSS JOIN LATERAL jsonb_each($8::jsonb) AS kv
    RETURNING 1
  ), rowid AS (
    SELECT CASE WHEN $8::jsonb IS NULL THEN NULL
                ELSE coalesce((SELECT id FROM r), (SELECT e.id FROM enrich_rows e WHERE e.table_id = $4::uuid AND e.row_key = $6::text)) END AS id
  ), p AS (
    INSERT INTO aiark_people (person_id, demo, run_id, row_id, email, email_status, company_id, record, people_run_id)
    SELECT $3, $9::boolean, NULL, (SELECT id FROM rowid), nullif($10, ''), nullif($11, ''), $12, $13::jsonb, $1
     WHERE (SELECT yes FROM fresh) AND $13::jsonb IS NOT NULL
    ON CONFLICT (person_id) DO NOTHING
    RETURNING 1
  ), k AS (
    UPDATE aiark_people_candidates
       SET pick = $14, verdict = $15, row_id = (SELECT id FROM rowid), company_row_id = $16::bigint
     WHERE run_id = $1 AND person_id = $3 AND (SELECT yes FROM fresh)
    RETURNING 1
  ), u AS (
    UPDATE aiark_people_runs q
       SET bought = q.bought + CASE WHEN (SELECT yes FROM fresh) THEN $20::int ELSE 0 END,
           copied = q.copied + CASE WHEN (SELECT yes FROM fresh) AND NOT $19::boolean THEN (SELECT count(*) FROM r)::int ELSE 0 END,
           with_email = q.with_email + CASE WHEN (SELECT yes FROM fresh) AND $21::boolean THEN 1 ELSE 0 END,
           credits_used = q.credits_used + CASE WHEN (SELECT yes FROM fresh) THEN $17::numeric ELSE 0 END,
           progress = CASE WHEN (SELECT held FROM st) THEN $18::jsonb ELSE q.progress END,
           claimed_at = CASE WHEN q.claim_token = $2 THEN now() ELSE q.claimed_at END
     WHERE q.id = $1
    RETURNING q.bought, q.credits_used
  )
  SELECT (SELECT held FROM st) AS held, (SELECT status FROM st) AS status, (SELECT yes FROM fresh) AS fresh,
         (SELECT id FROM rowid) AS row_id, (SELECT count(*) FROM r)::int AS inserted,
         (SELECT bought FROM u) AS bought, (SELECT credits_used::float8 FROM u) AS used`;

/**
 * What happened to one pick, in one statement: the People row with its input
 * cells (or none, when the person ended Excluded or Outside, or was passed
 * over), the registry entry of a person bought, the candidate's pick, verdict,
 * row and company row, and the counters. A buy is written even after a lost
 * claim (the person is paid for); a copy only while the claim is held.
 */
async function writePick(ctx, kit, c, w) {
  const { run } = ctx;
  const next = { ...ctx.progress, buying: null };
  let plain = false;
  for (let tries = 0; ; tries++) {
    try {
      const cells = w.cells ? JSON.stringify(plain ? kit.plainOf(w.cells) : kit.sane(w.cells)) : null;
      const record = w.record ? JSON.stringify(plain ? kit.plainOf(w.record) : kit.sane(w.record)) : null;
      const { rows: [r] } = await ctx.pool.query(AREA_BUY_SQL, [
        run.id, run.claim_token, c.person_id, run.people_table_id, w.copy ? run.registry_source_id : run.source_id, aiarkPersonRowKey(c.person_id),
        w.search ?? "", cells, run.mode === "demo", w.email ?? "", w.emailStatus ?? "", c.company_id, record, w.pick, w.verdict,
        w.companyRowId ?? null, Number(w.credits) || 0, JSON.stringify(next), !w.copy, w.copy ? 0 : 1, !w.copy && Boolean(w.email),
      ]);
      ctx.spent = r.used;
      ctx.run.bought = r.bought;
      if (!r.held) throw new kit.LostClaim();
      ctx.progress = next;
      if (r.status === "cancelled") throw new kit.Cancelled();
      return r;
    } catch (e) {
      if (e instanceof kit.LostClaim || e instanceof kit.Cancelled) throw e;
      if (/^22/.test(String(e?.code ?? "")) && !plain) {
        plain = true;
        continue;
      }
      if (tries < kit.consts.WRITE_RETRIES) {
        await kit.sleep(kit.consts.WRITE_RETRY_MS * (tries + 1));
        continue;
      }
      await kit.readBack(ctx, e);
      throw e;
    }
  }
}

/**
 * Before any email step (override O1, O2): the person's full company record
 * and the record the company row would be built from, against the client's
 * exclusion terms and every LinkedIn keyword of the run (name, industry,
 * description), then the company's offices against the client's area.
 *
 * @returns {Promise<{ verdict: "excluded" | "outside", why: string } | { verdict: null, where: object }>}
 */
async function finalCheck(ctx, records, bringFrom) {
  const { run } = ctx;
  const t = await targetingFor(ctx.pool, run.client_tag);
  const terms = (Array.isArray(t?.exclude_terms) ? t.exclude_terms : []).map((s) => text(s).toLowerCase()).filter(Boolean);
  const keywords = keywordsOf(run);
  for (const rec of records) {
    if (!rec) continue;
    const facts = companyFacts(rec);
    const hit = companyTermHit(facts, terms) ?? companyTermHit(facts, keywords);
    if (hit) return { verdict: "excluded", why: `"${hit.term}" in the ${hit.label}` };
  }
  const where = await officeInArea(ctx.pool, run.client_tag, bringFrom);
  if (where.known && !where.inside) return { verdict: "outside", why: where.why ?? "no office is in the client's area" };
  return { verdict: null, where };
}

/**
 * The company a pick's row is linked to (decision 21): the registry's record
 * (free), else the person's own company record (Export Single, with its
 * domain), else the Preview's object this run kept (no domain).
 *
 * @param {{ pool: object, run: { id: string, mode: string } }} ctx
 * @param {{ company_id: string }} c  the candidate
 * @param {object | null} personCompany  the bought person's company record, or null
 * @returns {Promise<{ record: object, from: "registry" | "person" | "preview" | "none" }>}
 */
export async function linkedinCompanyFor(ctx, c, personCompany) {
  const reg = await registryCompany(ctx.pool, c.company_id, ctx.run.mode);
  if (reg) return { record: reg, from: "registry" };
  if (personCompany && text(personCompany.id) === text(c.company_id)) return { record: personCompany, from: "person" };
  const preview = await previewCompanyOf(ctx.pool, ctx.run.id, c.company_id);
  if (preview) return { record: preview, from: "preview" };
  return { record: { id: c.company_id, summary: {} }, from: "none" };
}

/** The People row's cells for a LinkedIn person (found_by linkedin; the office's place, D13; the person's own when AI Ark gave no office). */
function linkedinCells(ctx, kit, { c, record, companyRowId, company, where, email = "", emailStatus = "", domainType = "", stage, source, pulledBefore = "" }) {
  const own = kit.factsOf(record);
  const written = where?.inside ? { city: where.city ?? "", state: where.state ?? "" } : { city: own.city, state: own.region };
  return kit.personRowCells({
    tag: ctx.run.client_tag,
    company: { company_row_id: companyRowId, company_id: c.company_id, website: text(company?.link?.website) },
    track: c.track, rank: c.rank, person: record, email, emailStatus, domainType, stage, source, pulledBefore,
    foundBy: "linkedin", written,
  });
}

/**
 * A pick another run bought (the registry, read again before each buy): with
 * an email, copied free with its company brought in, after the same final
 * check as a buy; with none, passed over (D27).
 */
async function copyPick(ctx, kit, c, reg) {
  const preview = await previewCompanyOf(ctx.pool, ctx.run.id, c.company_id);
  if (!reg.email) {
    return writePick(ctx, kit, c, { copy: true, pick: "none", verdict: "bought_before" });
  }
  const personCompany = reg.record?.company && typeof reg.record.company === "object" ? { ...reg.record.company, id: text(reg.record.company.id) || c.company_id } : null;
  const { record: company } = await linkedinCompanyFor(ctx, c, personCompany);
  const check = await finalCheck(ctx, [personCompany, company, preview], company);
  if (check.verdict) return writePick(ctx, kit, c, { copy: true, pick: "none", verdict: check.verdict });
  const brought = await bringCompanyIn(ctx.pool, { run: ctx.run, record: company });
  const tab = reg.record ? null : (await kit.tabCellsOf(ctx.pool, kit.tabRowsOf([reg]))).get(Number(reg.row_id));
  let record = reg.record;
  if (!record) {
    const v = (k) => (typeof tab?.[k] === "string" ? tab[k] : "");
    record = {
      ...kit.recordOf(c, { name: text(company.summary?.name), industry: text(company.summary?.industry), domain: text(company.link?.domain) }),
      profile: { full_name: v("full_name"), first_name: v("first_name") || c.first_name || "", last_name: v("last_name"), title: v("title") || c.title || "" },
      link: { linkedin: v("linkedin") },
      email: { state: "DONE", output: [{ address: reg.email, status: reg.email_status === "VALID" ? "VALID" : "INVALID", domainType: v("email_domain_type") }] },
    };
  }
  const inputs = personInputs(record);
  const when = new Date(reg.pulled_at).toISOString().slice(0, 10);
  const { cells, search } = linkedinCells(ctx, kit, {
    c, record, companyRowId: brought.id, company, where: check.where, email: reg.email, emailStatus: reg.email_status ?? inputs.email_status ?? "",
    domainType: inputs.email_domain_type ?? "", stage: "copied", source: "Copied from an earlier run (no charge)",
    pulledBefore: `Bought ${when}${reg.people_run_id ? ` (people run ${String(reg.people_run_id).slice(0, 6)})` : reg.run_id ? ` (AI Ark run ${String(reg.run_id).slice(0, 6)})` : ""}`,
  });
  return writePick(ctx, kit, c, { copy: true, cells, search, pick: "none", verdict: "bought_before", companyRowId: brought.id });
}

/** A person bought (Export Single answered): ended Excluded or Outside, or their company brought in and their People row written. */
async function boughtPick(ctx, kit, c, got) {
  const found = got.found === true;
  const preview = await previewCompanyOf(ctx.pool, ctx.run.id, c.company_id);
  const personCompany = found && got.person?.company && typeof got.person.company === "object"
    ? { ...got.person.company, id: text(got.person.company.id) || c.company_id }
    : null;
  const { record: company } = await linkedinCompanyFor(ctx, c, personCompany);
  const record = found
    ? got.person
    : kit.recordOf(c, { name: text(company.summary?.name ?? preview?.summary?.name), industry: text(company.summary?.industry ?? preview?.summary?.industry), domain: text(company.link?.domain) });
  const inputs = personInputs(record);
  const email = found ? inputs.email ?? "" : "";
  const base = { pick: found ? "bought" : "no_email", record, email, emailStatus: found ? inputs.email_status ?? "" : "", credits: got.credits };
  const check = await finalCheck(ctx, [personCompany, company], company);
  if (check.verdict) return writePick(ctx, kit, c, { ...base, verdict: check.verdict });
  const brought = await bringCompanyIn(ctx.pool, { run: ctx.run, record: company });
  const { cells, search } = linkedinCells(ctx, kit, {
    c, record, companyRowId: brought.id, company, where: check.where, email, emailStatus: base.emailStatus,
    domainType: found ? inputs.email_domain_type ?? "" : "", stage: found ? "bought" : "no_email", source: LINKEDIN_LABELS.peopleRun,
  });
  return writePick(ctx, kit, c, { ...base, verdict: "candidate", cells, search, companyRowId: brought.id });
}

/**
 * One slice of a LinkedIn run's Buy: up to maxBuysPerSlice picks, in AI Ark's
 * order. A pick the registry holds is copied (or passed over); any other is
 * bought with Export Single (the money checks before each call). Ends when no
 * pick is left.
 */
export async function buyByArea(ctx, kit) {
  const { run, pool } = ctx;
  if (ctx.progress.buying?.person_id) {
    // The slice before was cut off between a call and its write.
    await kit.markLost(ctx, ctx.progress.buying.person_id, "The worker stopped before the answer was written");
  }
  const { rows: picks } = await pool.query(
    `SELECT person_id, company_id, track, rank, seq, first_name, last_name, title, city, region, country, seniority, department
       FROM aiark_people_candidates WHERE run_id = $1 AND pick = 'picked'
      ORDER BY seq NULLS LAST, person_id LIMIT $2`,
    [run.id, ctx.maxBuysPerSlice]
  );
  if (!picks.length) return { done: null };
  const registry = await kit.registryOf(pool, picks.map((c) => c.person_id));
  let lostInARow = 0;
  for (const c of picks) {
    if (ctx.shouldStop()) return { wait: 0 };
    const reg = registry.get(c.person_id);
    if (reg) {
      await copyPick(ctx, kit, c, reg);
      continue;
    }
    if (Number(run.max_people) - Number(run.bought) <= 0) {
      return { done: `Bought the most people this run allows (${fmt(run.max_people)}); the picks left were not bought.` };
    }
    const gate = await kit.beforePaidCall(ctx, 1);
    if (gate) return gate;
    ctx.progress = { ...ctx.progress, buying: { person_id: c.person_id, company_id: c.company_id, at: new Date().toISOString() } };
    await kit.savePosition(ctx); // a cancel is seen here, before the person is bought
    let got;
    try {
      got = await ctx.client.exportSingle(c.person_id);
      lostInARow = 0;
    } catch (e) {
      if (e instanceof AiArkError && (e.kind === "network" || e.kind === "server")) {
        await kit.markLost(ctx, c.person_id, e.message);
        if (++lostInARow >= kit.consts.LOST_ANSWERS_MAX) return { error: e };
        continue;
      }
      // Refused before AI Ark did anything (out of credits, the key, too fast): nothing was bought.
      ctx.progress = { ...ctx.progress, buying: null };
      throw e;
    }
    await boughtPick(ctx, kit, c, got);
  }
  return { more: true };
}
