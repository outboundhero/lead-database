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
//                      title exclusions
//
// Each mirrors the database's own rule (fn_client_eligibility_conditions):
// exclusion terms match anywhere in the company name and industry, cleaning
// titles match as whole words, plural-tolerant, and a place counts only as the
// location resolver (scripts/backfill-lead-locations.mjs) and then the gate would
// place it. The gate never sees a company description, so terms match it as
// whole words: "pub" must not catch "public". Free lookups, so every run re-reads
// them (cache: false): a lead added or a rule changed since the last run counts.

import { names } from "../aiark/add.mjs";
import { cityKey, entryKey, findState, loadGeo } from "../aiark/geo.mjs";

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

async function targetingFor(db, tag, since) {
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

async function geoFor(db) {
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
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "comcast.net"]);

/** A name's letters and digits, without case or accents: "José-Luis" is "joseluis". */
const nameKey = (s) => text(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Text for LIKE, taken literally. */
const likeText = (s) => s.replace(/[\\%_]/g, "\\$&");

/** The company as the lead database holds it: the first "|" part with its spaces collapsed (cleanCompanyName, src/lib/uploads/normalize-row.ts). */
const companyAsHeld = (v) => text(v).split("|").map((s) => s.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";

/**
 * The addresses a person most likely has at their company. These shapes reached
 * 87% of 2,165 random leads on a company domain (2026-11-05); first@, flast@ and
 * first.last@ alone reached 77%.
 */
export function likelyAddresses(first, last, domain) {
  const f = nameKey(first).replace(/[^a-z0-9]/g, "");
  const l = nameKey(last).replace(/[^a-z0-9]/g, "");
  const d = text(domain).toLowerCase().replace(/^www\./, "");
  if (!f || !l || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || FREE_MAIL.has(d)) return [];
  const shapes = [f, `${f}.${l}`, `${f}${l}`, `${f[0]}${l}`, `${f[0]}.${l}`, `${f}_${l}`, `${f}-${l}`, l, `${f}${l[0]}`, `${l}.${f}`, `${l}${f}`, `${l}${f[0]}`, `${f}.${l[0]}`];
  return [...new Set(shapes)].map((s) => `${s}@${d}`);
}

/** Whoever holds a guessed address has this name: the same first name, and the same last name unless the row has none. */
function sameName(first, last, heldFirst, heldLast) {
  return Boolean(nameKey(heldFirst)) && nameKey(heldFirst) === nameKey(first) && (!nameKey(heldLast) || nameKey(heldLast) === nameKey(last));
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
    note: `AI Ark gave no usable email, and ${r.email} ${how}, so this person stays out of the pipeline. ${note}`,
  };
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
 * Leads with the same name at the same company, whatever its case. A Preview's
 * last name is masked ("Sm***h", a short one "N***"): the letters it shows must
 * fit. Only `leads` can be asked: nothing indexes a name or company in the Bison copy.
 */
async function byNameAndCompany(db, first, last, company) {
  const parts = last.split(/\*+/);
  const lastName = !last.includes("*") ? likeText(last) : parts[0] || parts.at(-1) ? `${likeText(parts[0])}%${likeText(parts.at(-1))}` : "";
  if (!company || !lastName) return [];
  const { rows } = await db.query(
    `SELECT l.email, l.id AS lead_id, l.is_bounced, l.bounce_type, l.is_suppressed,
            s.email IS NOT NULL AS listed, s.reason,
            EXISTS (SELECT 1 FROM bison_leads b WHERE lower(b.email) = l.email) AS in_bison
       FROM leads l
       LEFT JOIN suppressed_emails s ON s.email = l.email
      WHERE l.company ILIKE $1 AND lower(l.first_name) = lower($2) AND lower(l.last_name) LIKE lower($3)
      LIMIT 20`,
    [likeText(company), first, lastName]
  );
  return rows;
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
  if (!first || !last) return { status: "empty", note: "AI Ark gave no usable email and no full name, so there is nothing to look up" };
  const likely = last.includes("*") ? [] : await byLikelyAddress(db, first, last, inputs.domain);
  if (likely.length) return heldAnswer(strongest(likely), LIKELY_ADDRESS);
  const same = await byNameAndCompany(db, first, last, companyAsHeld(inputs.company));
  if (same.length) return heldAnswer(strongest(same), NAME_AND_COMPANY);
  return { status: "empty", note: "AI Ark gave no usable email. Nothing in the lead database or its copy of Email Bison matches this person's likely addresses, and no lead has the same name and company" };
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

async function clientArea({ inputs, table, row, db }) {
  const t = await targetingFor(db, table.client_tag, row?.next_run_at);
  if (!t) return { status: "error", note: `${table.client_tag} has no targeting rules`, retryable: false };
  const include = Array.isArray(t.include_locations) ? t.include_locations : [];
  const exclude = Array.isArray(t.exclude_locations) ? t.exclude_locations : [];
  const { geo, cities } = await geoFor(db);
  const placeText = [inputs.city, inputs.state, inputs.country].map(text).filter(Boolean).join(", ") || "(no place)";
  const outside = (note) => ({ status: "done", value: false, display: "Outside", note });

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
    };
  }
  if (!include.length) return { status: "done", value: true, display: "Inside", note: "The client's rules list no places, so every place counts" };
  const hit = include.find(matches);
  if (hit) return { status: "done", value: true, display: "Inside", note: `Matches the client's place ${entryLabel(hit)}` };
  const accented = include.find((e) => inEntry(e, cityKey));
  if (accented) return outside(`The client's place ${entryLabel(accented)} has an accent, and the send gate can't match an accented place yet`);
  return outside(`"${placeText}" is not one of the client's ${include.length} places`);
}

// ── client_exclusions ───────────────────────────────────────────────────────

async function clientExclusions({ inputs, table, row, db }) {
  const t = await targetingFor(db, table.client_tag, row?.next_run_at);
  if (!t) return { status: "error", note: `${table.client_tag} has no targeting rules`, retryable: false };
  const terms = (Array.isArray(t.exclude_terms) ? t.exclude_terms : []).map((s) => text(s).toLowerCase()).filter(Boolean);
  const fields = [
    ["company name", companyAsHeld(inputs.company)],
    ["industry", text(inputs.industry)],
  ];
  for (const [label, value] of fields) {
    const v = value.toLowerCase();
    if (!v) continue;
    const term = terms.find((x) => v.includes(x));
    if (term) {
      const display = `"${term}" in the ${label}`;
      return { status: "done", value: display, display, note: `Matches the client's exclusion term "${term}" (matched anywhere in the text, as the lead database does)` };
    }
  }
  const description = text(inputs.description);
  const word = description ? terms.find((x) => new RegExp(wholeTermSource(x), "iu").test(description)) : null;
  if (word) {
    const display = `"${word}" in the company description`;
    return { status: "done", value: display, display, note: `The description has the client's exclusion term "${word}" as a whole word` };
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
  return { status: "empty", note: `Clear of the client's ${terms.length} exclusion terms${titleNote}` };
}

export const CLIENT_ACTIONS = {
  lead_lookup: { run: leadLookup, cache: false },
  client_area: { run: clientArea, cache: false },
  client_exclusions: { run: clientExclusions, cache: false },
};

/** For tests: forget cached rules and titles. */
export function resetClientChecks() {
  targetingCache.clear();
  geoCache = null;
  titleCache = null;
}
