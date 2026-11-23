// The checks the lead database applies to anyone it sends to, run on an AI Ark
// person before they are added (the AI Ark run tables' step columns):
//
//   lead_lookup        the address in `leads`, in the copy of Email Bison
//                      (bison_leads) and on the never-contact list. Someone
//                      with no usable email is looked for by name too, so a
//                      person the database holds never goes to the pipeline
//   client_area        the person's city/state against the client's locations
//   client_exclusions  the company against the client's exclusion terms, and
//                      for cleaning clients the job title against the cleaning
//                      title exclusions; on a LinkedIn pull's row also against
//                      that pull's excluded keywords (all of them, sent to AI
//                      Ark or not, stored on the pull: migration 128), matched
//                      the same way; on a row an AI Ark tab pull wrote (its run
//                      table) or an AI Ark company pull wrote (a Companies
//                      table), against the excluded keywords that pull kept
//                      (filters.keywords: the standard ones, the built-in
//                      competitors list and the client's own), found through
//                      the row's source, as whole words
//
// Each mirrors the database's own rule (fn_client_eligibility_conditions):
// exclusion terms match anywhere in the company name and industry, cleaning
// titles match as whole words, plural-tolerant, and a place counts only as the
// location resolver (scripts/backfill-lead-locations.mjs) and then the gate would
// place it. The gate never sees a company description, so terms match it as
// whole words: "pub" must not catch "public". Free lookups, so every run re-reads
// them (cache: false): a lead added or a rule changed since the last run counts.
//
// The Companies template shares them (company-actions.mjs): client_office judges
// each of a company's offices with judgePlace(), the rule client_area applies,
// and held_general_email looks addresses up with heldAddresses().
//
// And one value, not a check (migration 139):
//
//   client_variable    a named per-client value, read at run time: the People
//                      and General tables' service_area column (the client's
//                      area in words, which a prompt reads as {{Service
//                      Area}}), chosen by serviceAreaFor() (service-area.mjs)
//                      from the client's client_variables row and its
//                      client_targeting row. Free, cached 30 seconds like the
//                      rules, never an error for a missing row (it is then
//                      empty), and no spend.

import { names } from "../aiark/add.mjs";
import { cityKey, entryKey, findState, loadGeo } from "../aiark/geo.mjs";
import { SERVICE_AREA, serviceAreaFor } from "./service-area.mjs";

const TTL_MS = 30_000;
const text = (v) => (v == null ? "" : String(v).trim());
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const targetingCache = new Map(); // client_tag -> { at, readAt, row }
let geoCache = null; // { at, geo, cities: city key -> what soleState found }
let titleCache = null; // { at, readAt, terms, rx }

// A cached read serves a row only if the database took it after the row's
// next_run_at. A re-run sets that to now(), so a re-run straight after a rule
// change reads rules at least as new as the click.
const current = (hit, since) => hit && Date.now() - hit.at < TTL_MS && (!since || hit.readAt >= new Date(since));

/**
 * A client's rules (client_targeting), or null when it has none. Cached for
 * 30 seconds, and never older than `since` (the row's next_run_at).
 */
export async function targetingFor(db, tag, since) {
  const hit = targetingCache.get(tag);
  if (current(hit, since)) return hit.row;
  const { rows: [r] } = await db.query(
    `SELECT now() AS read_at, t.client_tag, t.countries, t.include_locations, t.exclude_locations, t.exclude_terms, t.commercial_cleaning
       FROM (SELECT $1::text AS tag) q
       LEFT JOIN client_targeting t ON t.client_tag = q.tag`,
    [tag]
  );
  const row = r.client_tag ? r : null;
  targetingCache.set(tag, { at: Date.now(), readAt: r.read_at, row });
  return row;
}

/** The state and country names and codes (loadGeo), cached for 10 minutes: { geo, cities }. */
export async function geoFor(db) {
  if (geoCache && Date.now() - geoCache.at < 10 * 60_000) return geoCache;
  geoCache = { at: Date.now(), geo: await loadGeo(db), cities: new Map() };
  return geoCache;
}

/**
 * fn_whole_term_regex in JavaScript: '\m' term 's?\M', spaces as \s+,
 * case-insensitive. Word characters are letters, digits and "_", as in
 * Postgres. A term must start and end on a word character to match at all.
 */
export function wholeTermSource(term) {
  return `(?<![\\p{L}\\p{N}_])${escapeRx(term).replace(/\s+/g, "\\s+")}s?(?![\\p{L}\\p{N}_])`;
}

async function cleaningTitles(db, since) {
  if (current(titleCache, since)) return titleCache;
  const { rows: [r] } = await db.query(
    `SELECT now() AS read_at, coalesce(array_agg(term ORDER BY term), '{}') AS terms FROM commercial_cleaning_excluded_titles`
  );
  // \m and \M need a word character on their side: a term that starts or ends
  // with punctuation can never match in Postgres, so it never matches here.
  const terms = r.terms.map(text).filter((t) => /^[\p{L}\p{N}_]/u.test(t) && /[\p{L}\p{N}_]$/u.test(t));
  const rx = terms.length ? new RegExp(terms.map((t) => `(?:${wholeTermSource(t)})`).join("|"), "iu") : null;
  titleCache = { at: Date.now(), readAt: r.read_at, terms, rx };
  return titleCache;
}

// ── lead_lookup ─────────────────────────────────────────────────────────────

const USABLE_VERDICTS = new Set(["Valid", "Catch-all"]);
const LIKELY_ADDRESS = "likely address";
const NAME_AND_COMPANY = "name and company";
// A company "on" one of these says nothing about the address: john.smith@gmail.com is many people.
export const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "comcast.net"]);

/** A name's letters and digits, without case or accents: "José-Luis" is "joseluis". */
const nameKey = (s) => text(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** A last name without what follows a comma or bracket: "Smith, CPA" and "Smith (he/him)" are "Smith". */
const surname = (s) => text(s).split(/[,(]/)[0];

/** Text for LIKE, taken literally. */
const likeText = (s) => s.replace(/[\\%_]/g, "\\$&");

/** The company as the lead database holds it: the first "|" part with its spaces collapsed (cleanCompanyName, src/lib/uploads/normalize-row.ts). */
export const companyAsHeld = (v) => text(v).split("|").map((s) => s.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";

/**
 * The addresses a person most likely has at their company. These shapes reached
 * 87% of 2,165 random leads on a company domain (2026-11-05); first@, flast@ and
 * first.last@ alone reached 77%.
 */
export function likelyAddresses(first, last, domain) {
  const f = nameKey(first).replace(/[^a-z0-9]/g, "");
  const l = nameKey(surname(last)).replace(/[^a-z0-9]/g, "");
  const d = text(domain).toLowerCase().replace(/^www\./, "");
  if (!f || !l || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || FREE_MAIL.has(d)) return [];
  const shapes = [f, `${f}.${l}`, `${f}${l}`, `${f[0]}${l}`, `${f[0]}.${l}`, `${f}_${l}`, `${f}-${l}`, l, `${f}${l[0]}`, `${l}.${f}`, `${l}${f}`, `${l}${f[0]}`, `${f}.${l[0]}`];
  return [...new Set(shapes)].map((s) => `${s}@${d}`);
}

/**
 * Whether two last names can be one person's. What follows a comma or bracket
 * doesn't count, and one may start with the other, word by word: "Smith" agrees
 * with "Smith, CPA" and "Smith Jones", not "Smithson" or "Jones Smith". A name
 * that is only brackets, like the database's "(General Email)", agrees with nothing.
 */
function sameLastName(a, b) {
  const x = surname(a);
  const y = surname(b);
  if (!nameKey(x) || !nameKey(y)) return false;
  if (nameKey(x) === nameKey(y)) return true;
  const words = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const [short, long] = [words(x), words(y)].sort((p, q) => p.length - q.length);
  return short.every((w, i) => long[i] === w);
}

/**
 * Whether a held last name fits a Preview's masked one: the letters it shows at
 * the start, and at the end unless that is a symbol ("Sm***)", "Sm***®"), the end
 * of something the held name needn't have. Only-brackets names fit nothing.
 */
function fitsMask(mask, held) {
  const parts = text(mask).split(/\*+/);
  const start = nameKey(parts[0]);
  const end = /^\p{L}+$/u.test(parts.at(-1)) ? nameKey(parts.at(-1)) : "";
  const short = nameKey(surname(held));
  if (!start || !short) return false;
  return [short, nameKey(held)].some((h) => h.startsWith(start) && h.endsWith(end) && h.length >= start.length + end.length);
}

/** Whoever holds a guessed address has this name: the same first name, and the same last name unless the row has none. */
function sameName(first, last, heldFirst, heldLast) {
  return Boolean(nameKey(heldFirst)) && nameKey(heldFirst) === nameKey(first) && (!nameKey(heldLast) || sameLastName(last, heldLast));
}

/** The answer for an address the database holds. `matched` says how someone with no usable email was tied to it. */
function heldAnswer(r, matched = null) {
  const neverContact = Boolean(r.listed || r.is_suppressed);
  const value = { lead_id: r.lead_id ?? null, bounced: Boolean(r.is_bounced), never_contact: neverContact, in_bison: Boolean(r.in_bison) };
  const display = neverContact ? "Never contact" : r.is_bounced ? "Bounced" : r.lead_id ? "In the database" : "In Email Bison";
  const note = neverContact
    ? `On the never-contact list${r.reason ? `: ${r.reason}` : ""}${r.lead_id ? "" : " (the lead itself was deleted)"}`
    : r.is_bounced
      ? `A lead with this address bounced${r.bounce_type ? ` (${r.bounce_type})` : ""}`
      : r.lead_id
        ? "A lead with this address is already in the database"
        : "This address is in the copy of Email Bison and not yet in leads, which counts as already in the database";
  if (!matched) return { status: "done", value, display, note };
  const how = matched === NAME_AND_COMPANY ? "has the same name and company" : "is at the company's domain, under the same name";
  return {
    status: "done",
    value: { ...value, matched_on: matched, address: r.email },
    display,
    note: `This person came with no usable email, and ${r.email} ${how}, so they stay out of the pipeline. ${note}`,
  };
}

/**
 * The addresses the database holds, of those given: each as a lead, in the
 * copy of Email Bison (its lower(email) index) or on the never-contact list,
 * with the fields heldAnswer reads. Exact matches only.
 */
export async function heldAddresses(db, emails) {
  if (!emails.length) return [];
  const { rows } = await db.query(
    `SELECT e.email, l.id AS lead_id, l.is_bounced, l.bounce_type, l.is_suppressed,
            s.email IS NOT NULL AS listed, s.reason,
            EXISTS (SELECT 1 FROM bison_leads b WHERE lower(b.email) = e.email) AS in_bison
       FROM unnest($1::text[]) AS e(email)
       LEFT JOIN leads l ON l.email = e.email
       LEFT JOIN suppressed_emails s ON s.email = e.email`,
    [emails]
  );
  return rows.filter((r) => r.lead_id || r.listed || r.is_suppressed || r.in_bison);
}

async function byAddress(db, email) {
  const { rows } = await db.query(
    `SELECT e.email, l.id AS lead_id, l.is_bounced, l.bounce_type, l.is_suppressed,
            s.email IS NOT NULL AS listed, s.reason,
            EXISTS (SELECT 1 FROM bison_leads b WHERE lower(b.email) = e.email) AS in_bison
       FROM (SELECT $1::text AS email) e
       LEFT JOIN leads l ON l.email = e.email
       LEFT JOIN suppressed_emails s ON s.email = e.email`,
    [email]
  );
  const r = rows[0];
  return r && (r.lead_id || r.listed || r.is_suppressed || r.in_bison) ? r : null;
}

/**
 * Holders of the person's likely addresses. A guess proves nothing alone (jsmith@
 * may be Jane), so the name on the row has to agree. An address only on the
 * never-contact list has no name to check: if the pipeline finds it, the address
 * check stops it there.
 */
async function byLikelyAddress(db, first, last, domain) {
  const addresses = likelyAddresses(first, last, domain);
  if (!addresses.length) return [];
  const { rows } = await db.query(
    `SELECT e.email, l.id AS lead_id, l.first_name, l.last_name, l.is_bounced, l.bounce_type, l.is_suppressed,
            s.email IS NOT NULL AS listed, s.reason,
            b.email IS NOT NULL AS in_bison, b.first_name AS bison_first, b.last_name AS bison_last
       FROM unnest($1::text[]) AS e(email)
       LEFT JOIN leads l ON l.email = e.email
       LEFT JOIN suppressed_emails s ON s.email = e.email
       LEFT JOIN LATERAL (SELECT x.email, x.first_name, x.last_name FROM bison_leads x WHERE lower(x.email) = e.email LIMIT 1) b ON true
      WHERE l.id IS NOT NULL OR b.email IS NOT NULL`,
    [addresses]
  );
  return rows.filter((r) => (r.lead_id && sameName(first, last, r.first_name, r.last_name)) || (r.in_bison && sameName(first, last, r.bison_first, r.bison_last)));
}

/**
 * Leads with the same name at the same company, whatever its case. The company's
 * index finds the rows and the last name is compared here, as it is written many
 * ways. A Preview's is masked ("Sm***h", a short one "N***"). Only `leads` can be
 * asked: nothing indexes a name or company in the Bison copy. The limit only
 * matters past 200 people with one first name at one company.
 */
async function byNameAndCompany(db, first, last, company) {
  if (!company || !nameKey(last)) return [];
  const { rows } = await db.query(
    `SELECT l.email, l.id AS lead_id, l.last_name, l.is_bounced, l.bounce_type, l.is_suppressed,
            s.email IS NOT NULL AS listed, s.reason,
            EXISTS (SELECT 1 FROM bison_leads b WHERE lower(b.email) = l.email) AS in_bison
       FROM leads l
       LEFT JOIN suppressed_emails s ON s.email = l.email
      WHERE l.company ILIKE $1 AND lower(trim(l.first_name)) = lower($2)
      LIMIT 200`,
    [likeText(company), first]
  );
  const fits = last.includes("*") ? fitsMask : sameLastName;
  return rows.filter((r) => fits(last, r.last_name));
}

// What decides the Outcome comes first.
const weight = (r) => (r.listed || r.is_suppressed ? 0 : r.is_bounced ? 1 : r.lead_id ? 2 : 3);
const strongest = (rows) => rows.reduce((a, b) => (weight(b) < weight(a) ? b : a));

async function leadLookup({ inputs, db }) {
  const email = text(inputs.email).toLowerCase();
  const known = email ? await byAddress(db, email) : null;
  if (known) return heldAnswer(known);
  // A usable address nobody holds is a new lead: only someone with none is looked for by name.
  const verdict = text(inputs.verdict);
  if (!verdict || USABLE_VERDICTS.has(verdict)) {
    return { status: "empty", note: email ? "Not in the lead database, its copy of Email Bison or on the never-contact list" : "No email to look up" };
  }
  const [first, last] = names(inputs);
  if (!first || !last) return { status: "empty", note: "This person came with no usable email and no full name, so there is nothing to look up" };
  const likely = last.includes("*") ? [] : await byLikelyAddress(db, first, last, inputs.domain);
  if (likely.length) return heldAnswer(strongest(likely), LIKELY_ADDRESS);
  const same = await byNameAndCompany(db, first, last, companyAsHeld(inputs.company));
  if (same.length) return heldAnswer(strongest(same), NAME_AND_COMPANY);
  return { status: "empty", note: "This person came with no usable email. Nothing in the lead database or its copy of Email Bison matches their likely addresses, and no lead has the same name and company" };
}

// ── client_area ─────────────────────────────────────────────────────────────

function entryLabel(e) {
  return [e.city, e.state, e.country].filter(Boolean).join(", ");
}

/**
 * Where a person with no state is, by the resolver's second pass: a city that
 * exactly one state in the whole reference holds, whatever country AI Ark says.
 * Anything else leaves the lead unresolved, and the gate refuses it.
 */
async function soleState(db, cities, key) {
  if (!key) return null;
  if (cities.has(key)) return cities.get(key);
  const { rows } = await db.query(
    `SELECT DISTINCT g.country_code, g.admin1_code, a.state_code
       FROM geo_locations g
       LEFT JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
      WHERE g.city_key = $1
      LIMIT 2`,
    [key]
  );
  const place = rows.length === 1 && rows[0].state_code ? { country: rows[0].country_code, state: rows[0].state_code } : null;
  cities.set(key, place);
  return place;
}

/**
 * Is a place ({city, state, country} as AI Ark writes them) inside a client's
 * area? Decided the way the location resolver and then the send gate would
 * place a lead there. The answer is the cell client_area writes
 * ({status: "done", value: true | false, display, note}), plus `place`: the
 * {country, state} codes the lead database would give it (state null when it
 * couldn't place it), or null when the country is unknown. client_office runs
 * this for every office of a company.
 *
 * @param {{ city?: string, state?: string, country?: string }} inputs
 * @param {{ targeting: object, db: { query: Function } }} opts  targeting: the client's client_targeting row
 */
export async function judgePlace(inputs, { targeting: t, db }) {
  const include = Array.isArray(t.include_locations) ? t.include_locations : [];
  const exclude = Array.isArray(t.exclude_locations) ? t.exclude_locations : [];
  const { geo, cities } = await geoFor(db);
  const placeText = [inputs.city, inputs.state, inputs.country].map(text).filter(Boolean).join(", ") || "(no place)";
  let where = null; // the place's codes, once known
  const outside = (note) => ({ status: "done", value: false, display: "Outside", note, place: where });

  // A country we don't know is someone really abroad, whatever the state says.
  const said = text(inputs.country) ? geo.countryCode.get(cityKey(inputs.country)) ?? null : null;
  if (text(inputs.country) && !said) return outside(`AI Ark gave no country we know for "${placeText}"`);

  // The resolver places a lead by its state, or with no state by its city, and
  // never reads the country. AI Ark's country can only rule that place out.
  const stateText = text(inputs.state);
  const city = cityKey(inputs.city);
  const found = stateText ? findState(geo, stateText) : await soleState(db, cities, city);
  const place = found && (!said || found.country === said) ? found : null;
  const country = place?.country ?? said;
  if (!country) return outside(`AI Ark gave no country we know for "${placeText}"`);

  where = { country, state: place?.state ?? null };
  const allowed = (Array.isArray(t.countries) ? t.countries : []).map((c) => text(c).toUpperCase());
  if (!allowed.includes(country)) {
    return outside(allowed.length ? `${country} is not one of the client's countries (${allowed.join(", ")})` : "The client's rules list no countries");
  }
  const state = place?.state ?? null;
  const inEntry = (e, key) =>
    text(e?.country).toUpperCase() === country &&
    (!text(e?.state) || (state !== null && text(e.state).toUpperCase() === state)) &&
    (!text(e?.city) || (city !== "" && key(e.city) === city));
  const matches = (e) => inEntry(e, entryKey);

  const out = exclude.find(matches);
  if (out) return outside(`Inside a place the client excludes: ${entryLabel(out)}`);
  if (!state && stateText) {
    return outside(found ? `"${stateText}" is in ${found.country}, not ${country}` : `"${stateText}" is not a state we know in ${country}`);
  }
  // No state: the lead ends up unresolved, or with no country_code, and is never
  // shown as inside, even under a rule that lists only a country or no places.
  // The gate refuses both, except that a client with require_location off takes
  // a lead with no place at all.
  if (!state) {
    return {
      status: "done",
      value: false,
      display: "Can't tell",
      note: `AI Ark gave no state ("${placeText}") and the city doesn't settle one, so the lead database couldn't place this person`,
      place: where,
    };
  }
  if (!include.length) return { status: "done", value: true, display: "Inside", note: "The client's rules list no places, so every place counts", place: where };
  const hit = include.find(matches);
  if (hit) return { status: "done", value: true, display: "Inside", note: `Matches the client's place ${entryLabel(hit)}`, place: where };
  const accented = include.find((e) => inEntry(e, cityKey));
  if (accented) return outside(`The client's place ${entryLabel(accented)} has an accent, and the send gate can't match an accented place yet`);
  return outside(`"${placeText}" is not one of the client's ${include.length} places`);
}

async function clientArea({ inputs, table, row, db }) {
  const t = await targetingFor(db, table.client_tag, row?.next_run_at);
  if (!t) return { status: "error", note: `${table.client_tag} has no targeting rules`, retryable: false };
  const { status, value, display, note } = await judgePlace(inputs, { targeting: t, db });
  return { status, value, display, note };
}

// ── client_exclusions ───────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const linkedinCache = new Map(); // run id -> its keywords (a run's stored filters never change)
const pullCache = new Map(); // source id -> the keywords its pull kept, or null (a run's stored filters never change)
const CACHE_MAX = 200;

const lowerUnion = (v) => (Array.isArray(v) ? [...new Set(v.map((s) => text(s).toLowerCase()).filter(Boolean))] : null);

/** The tables whose rows a keeping pull writes: an AI Ark tab run's own, and a client's Companies table. */
const PULL_TABLE_KINDS = new Set(["ai_ark", "companies"]);

/**
 * The excluded keywords kept by the AI Ark pull that wrote a row (an AI Ark
 * tab run's own table, or a client's Companies table for an AI Ark company
 * pull, bought or copied free): filters.keywords.union, lower case. Null when
 * the row came from anything else, or from a pull that kept none (one made
 * before the competitors list, or for a client the standard keywords don't
 * apply to), and for any other kind of table (a People table's rows were
 * checked in their pull's table). Read through the row's source
 * (meta.run_id), cached per source.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ id?: string, kind?: string }} table  the row's table (its id and kind; a check with no table reads nothing)
 * @param {{ id?: number | string } | null | undefined} row
 * @returns {Promise<string[] | null>}
 */
export async function pullKeywordsOf(db, table, row) {
  if (!table?.id || !PULL_TABLE_KINDS.has(table.kind) || row?.id == null) return null;
  const { rows: [r] } = await db.query(`SELECT source_id FROM enrich_rows WHERE id = $1 AND table_id = $2`, [row.id, table.id]);
  const sourceId = r?.source_id ?? null;
  if (!sourceId) return null;
  if (pullCache.has(sourceId)) return pullCache.get(sourceId);
  const { rows: [k] } = await db.query(
    `SELECT CASE WHEN x.run_id IS NULL THEN NULL
                 ELSE coalesce((SELECT q.filters -> 'keywords' -> 'union' FROM aiark_runs q WHERE q.id = x.run_id),
                               (SELECT q.filters -> 'keywords' -> 'union' FROM aiark_company_runs q WHERE q.id = x.run_id)) END AS union
       FROM enrich_sources s
       CROSS JOIN LATERAL (SELECT CASE WHEN s.meta ->> 'run_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                       THEN (s.meta ->> 'run_id')::uuid END AS run_id) x
      WHERE s.id = $1 AND s.kind IN ('ai_ark', 'registry')`,
    [sourceId]
  );
  const list = lowerUnion(k?.union);
  if (pullCache.size > CACHE_MAX) pullCache.delete(pullCache.keys().next().value);
  pullCache.set(sourceId, list);
  return list;
}

/**
 * The excluded keywords a LinkedIn pull or people run stored (filters.linkedin.keywords.union:
 * the standard ones and the client's own, all of them), lower case; null when the run holds none.
 */
export async function linkedinKeywordsOf(db, runId) {
  if (linkedinCache.has(runId)) return linkedinCache.get(runId);
  const { rows } = await db.query(
    `SELECT filters -> 'linkedin' -> 'keywords' -> 'union' AS union FROM aiark_company_runs WHERE id = $1::uuid
     UNION ALL
     SELECT filters -> 'linkedin' -> 'keywords' -> 'union' FROM aiark_people_runs WHERE id = $1::uuid`,
    [runId]
  );
  const list = lowerUnion(rows[0]?.union);
  if (linkedinCache.size > CACHE_MAX) linkedinCache.delete(linkedinCache.keys().next().value);
  if (list) linkedinCache.set(runId, list);
  return list;
}

/**
 * The first term a company's name, industry or description holds, the way the
 * lead database matches the client's exclusion terms: anywhere in the name and
 * the industry, as whole words in the description. Null when none does.
 *
 * @param {{ company?: string, industry?: string, description?: string }} inputs
 * @param {string[]} terms  lower case
 * @returns {{ term: string, label: string } | null}
 */
export function companyTermHit(inputs, terms) {
  const fields = [
    ["company name", companyAsHeld(inputs.company)],
    ["industry", text(inputs.industry)],
  ];
  for (const [label, value] of fields) {
    const v = value.toLowerCase();
    if (!v) continue;
    const term = terms.find((x) => v.includes(x));
    if (term) return { term, label };
  }
  const description = text(inputs.description);
  const word = description ? terms.find((x) => new RegExp(wholeTermSource(x), "iu").test(description)) : null;
  return word ? { term: word, label: "company description" } : null;
}

/** A text's words as AI Ark's WORD match reads them (hasWords in company-filters.mjs): letters and digits, lower case. */
const wordList = (s) => text(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Does the word list `outer` hold the words of `inner`, in order and side by side? */
function holdsWords(outer, inner) {
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

/**
 * The first LinkedIn excluded keyword a company's name, industry or description
 * holds as whole words, the way AI Ark matches the keywords it is sent (its
 * WORD match, hasWords in company-filters.mjs): the keyword's words, in order
 * and side by side. "pub" holds in "Joe's Pub", not in "Public Safety"; "spa"
 * not in "Aerospace". The client's sheet exclusion terms are matched by
 * companyTermHit instead. Null when no keyword holds.
 *
 * @param {{ company?: string, industry?: string, description?: string }} inputs
 * @param {string[]} keywords
 * @returns {{ term: string, label: string } | null}
 */
export function companyKeywordHit(inputs, keywords) {
  const phrases = keywords.map((k) => ({ k, w: wordList(k) })).filter((x) => x.w.length);
  if (!phrases.length) return null;
  const fields = [
    ["company name", companyAsHeld(inputs.company)],
    ["industry", text(inputs.industry)],
    ["company description", text(inputs.description)],
  ];
  for (const [label, value] of fields) {
    const words = wordList(value);
    if (!words.length) continue;
    const hit = phrases.find((x) => holdsWords(words, x.w));
    if (hit) return { term: hit.k, label };
  }
  return null;
}

async function clientExclusions({ inputs, table, row, db }) {
  const t = await targetingFor(db, table.client_tag, row?.next_run_at);
  if (!t) return { status: "error", note: `${table.client_tag} has no targeting rules`, retryable: false };
  const terms = (Array.isArray(t.exclude_terms) ? t.exclude_terms : []).map((s) => text(s).toLowerCase()).filter(Boolean);
  const hit = companyTermHit(inputs, terms);
  if (hit) {
    const display = `"${hit.term}" in the ${hit.label}`;
    const note = hit.label === "company description"
      ? `The description has the client's exclusion term "${hit.term}" as a whole word`
      : `Matches the client's exclusion term "${hit.term}" (matched anywhere in the text, as the lead database does)`;
    return { status: "done", value: display, display, note };
  }
  // A LinkedIn pull's row: the pull's own excluded keywords, every one of them, as whole words (as AI Ark matches them).
  const run = text(inputs.linkedin_run);
  let linkedinCount = 0;
  if (run) {
    if (!UUID.test(run)) return { status: "error", note: `The row names a LinkedIn pull that is not one ("${run.slice(0, 40)}")`, retryable: false };
    const keywords = await linkedinKeywordsOf(db, run);
    if (!keywords) return { status: "error", note: "The LinkedIn pull that wrote this row holds no excluded keywords, so they could not be checked", retryable: false };
    linkedinCount = keywords.length;
    const k = companyKeywordHit(inputs, keywords.filter((x) => !terms.includes(x)));
    if (k) {
      const display = `LinkedIn keyword "${k.term}" in the ${k.label}`;
      return { status: "done", value: display, display, note: `Matches the client's LinkedIn excluded keyword "${k.term}" (as whole words, as AI Ark matches the keywords it is sent; checked after the pull, sent to AI Ark or not)` };
    }
  }
  let titleNote = "";
  if (t.commercial_cleaning) {
    const { terms: titleTerms, rx } = await cleaningTitles(db, row?.next_run_at);
    const title = text(inputs.title);
    if (rx && title && rx.test(title)) {
      const term = titleTerms.find((x) => new RegExp(wholeTermSource(x), "iu").test(title)) ?? "a cleaning title exclusion";
      const display = `Job title matches "${term}"`;
      return { status: "done", value: display, display, note: `"${title}" is on the cleaning title exclusions (whole words, as the lead database matches them)` };
    }
    titleNote = ` and the ${titleTerms.length} cleaning title exclusions`;
  }
  // A row an AI Ark pull wrote: every keyword that pull kept, sent to AI Ark or not, as whole words, as AI Ark
  // matches the ones it is sent. The client's own terms among them were matched the stricter way above; as whole
  // words they also catch what that misses ("Pressure-Washing Pros" for "pressure washing"), as the search would have.
  let pullCount = 0;
  if (!run) {
    const keywords = await pullKeywordsOf(db, table, row);
    if (keywords) {
      pullCount = keywords.length;
      const k = companyKeywordHit(inputs, keywords);
      if (k) {
        const display = `Excluded keyword "${k.term}" in the ${k.label}`;
        return {
          status: "done", value: display, display,
          note: `Matches the pull's excluded keyword "${k.term}" (the standard keywords, the built-in competitors list and the client's own terms, as whole words, as AI Ark matches the keywords it is sent; checked after the pull, sent to AI Ark or not)`,
        };
      }
    }
  }
  const linkedinNote = run ? ` and the LinkedIn pull's ${linkedinCount} excluded keywords` : pullCount ? ` and the pull's ${pullCount} excluded keywords` : "";
  return { status: "empty", note: `Clear of the client's ${terms.length} exclusion terms${linkedinNote}${titleNote}` };
}

// ── client_variable ─────────────────────────────────────────────────────────

const variableCache = new Map(); // "<tag>|<name>" -> { at, readAt, targeting, variable }
let variablesTable = null; // { at, ok }: whether client_variables exists (migration 139)

/** Is client_variables in the database? Read again every 10 minutes; before 139 every client has no variable. */
async function hasVariablesTable(db) {
  if (variablesTable && Date.now() - variablesTable.at < 10 * 60_000) return variablesTable.ok;
  const { rows: [r] } = await db.query(`SELECT to_regclass('public.client_variables') IS NOT NULL AS ok`);
  variablesTable = { at: Date.now(), ok: r?.ok === true };
  return variablesTable.ok;
}

/**
 * A client's variable `name` (its client_variables row) and the parts of its
 * rules a service area falls back to (client_targeting's sheet_raw and
 * include_locations), each null when the client has none. Cached for 30
 * seconds, and never older than `since` (the row's next_run_at), as
 * targetingFor() is.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {string} tag
 * @param {string} name
 * @param {Date | string | null | undefined} [since]
 * @returns {Promise<{ targeting: { sheet_raw: unknown, include_locations: unknown } | null, variable: { value: string, source: string } | null }>}
 */
export async function clientVariableFor(db, tag, name, since) {
  const key = `${tag}|${name}`;
  const hit = variableCache.get(key);
  if (current(hit, since)) return hit;
  const withVariables = await hasVariablesTable(db);
  const { rows: [r] } = await db.query(
    withVariables
      ? `SELECT now() AS read_at, t.client_tag, t.sheet_raw, t.include_locations, v.value, v.source
           FROM (SELECT $1::text AS tag, $2::text AS name) q
           LEFT JOIN client_targeting t ON t.client_tag = q.tag
           LEFT JOIN client_variables v ON v.client_tag = q.tag AND v.name = q.name`
      : `SELECT now() AS read_at, t.client_tag, t.sheet_raw, t.include_locations, NULL::text AS value, NULL::text AS source
           FROM (SELECT $1::text AS tag, $2::text AS name) q
           LEFT JOIN client_targeting t ON t.client_tag = q.tag`,
    [tag, name]
  );
  const out = {
    at: Date.now(),
    readAt: r.read_at,
    targeting: r.client_tag ? { sheet_raw: r.sheet_raw, include_locations: r.include_locations } : null,
    variable: r.value != null ? { value: r.value, source: r.source } : null,
  };
  variableCache.set(key, out);
  return out;
}

const SERVICE_AREA_FROM = {
  variable: (source) =>
    source === "scraper" ? "The client's service area, as the scraper sent it"
      : source === "sheet" ? "The client's service area, from the onboarding sheet"
        : "The client's service area, as typed on the Clay tab (Client setup, Location)",
  sheet: () => "The onboarding sheet's places text (no service area typed for the client)",
  places: () => "Made from the client's places (no service area typed, no places text in the onboarding sheet)",
};

/** client_variable: the client's value named config.name (service_area: serviceAreaFor()), read at run time. */
async function clientVariable({ table, row, db, config }) {
  const name = text(config?.name) || SERVICE_AREA;
  const r = await clientVariableFor(db, table.client_tag, name, row?.next_run_at);
  if (name !== SERVICE_AREA) {
    const v = text(r.variable?.value);
    return v ? { status: "done", value: v, display: v, note: `The client's ${name}` } : { status: "empty", note: `${table.client_tag} has no ${name}` };
  }
  const { value, from, source } = serviceAreaFor(r.targeting, r.variable);
  if (!value) return { status: "empty", note: "No service area: none typed for the client, no places text in the onboarding sheet and no places" };
  return { status: "done", value, display: value, note: SERVICE_AREA_FROM[from](source) };
}

export const CLIENT_ACTIONS = {
  lead_lookup: { run: leadLookup, cache: false },
  client_area: { run: clientArea, cache: false },
  client_exclusions: { run: clientExclusions, cache: false },
  client_variable: { run: clientVariable, cache: false },
};

/** For tests: forget cached rules, titles and client variables. */
export function resetClientChecks() {
  targetingCache.clear();
  linkedinCache.clear();
  pullCache.clear();
  variableCache.clear();
  variablesTable = null;
  geoCache = null;
  titleCache = null;
}
