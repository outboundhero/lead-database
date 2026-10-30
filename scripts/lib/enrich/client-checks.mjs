// The checks the lead database applies to anyone it sends to, run on an AI Ark
// person before they are added (the AI Ark run tables' step columns):
//
//   lead_lookup        the address in `leads` and on the never-contact list
//   client_area        the person's city/state against the client's locations
//   client_exclusions  the company against the client's exclusion terms, and
//                      for cleaning clients the job title against the cleaning
//                      title exclusions
//
// Each mirrors the database's own rule (fn_client_eligibility_conditions):
// exclusion terms match anywhere in the text, cleaning titles match as whole
// words, plural-tolerant. Free lookups, so every run re-reads them (cache:
// false): a lead added or a rule changed since the last run counts.

import { cityKey, loadGeo } from "../aiark/geo.mjs";

const TTL_MS = 30_000;
const text = (v) => (v == null ? "" : String(v).trim());
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const targetingCache = new Map(); // client_tag -> { at, row }
let geoCache = null; // { at, geo }
let titleCache = null; // { at, terms, rx }

async function targetingFor(db, tag) {
  const hit = targetingCache.get(tag);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  const { rows } = await db.query(
    `SELECT client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning
       FROM client_targeting WHERE client_tag = $1`,
    [tag]
  );
  const row = rows[0] ?? null;
  targetingCache.set(tag, { at: Date.now(), row });
  return row;
}

async function geoFor(db) {
  if (geoCache && Date.now() - geoCache.at < 10 * 60_000) return geoCache.geo;
  geoCache = { at: Date.now(), geo: await loadGeo(db) };
  return geoCache.geo;
}

/**
 * fn_whole_term_regex in JavaScript: '\m' term 's?\M', spaces as \s+,
 * case-insensitive. Word characters are letters, digits and "_", as in
 * Postgres. A term must start and end on a word character to match at all.
 */
export function wholeTermSource(term) {
  return `(?<![\\p{L}\\p{N}_])${escapeRx(term).replace(/\s+/g, "\\s+")}s?(?![\\p{L}\\p{N}_])`;
}

async function cleaningTitles(db) {
  if (titleCache && Date.now() - titleCache.at < TTL_MS) return titleCache;
  const { rows } = await db.query(`SELECT term FROM commercial_cleaning_excluded_titles ORDER BY term`);
  // \m and \M need a word character on their side: a term that starts or ends
  // with punctuation can never match in Postgres, so it never matches here.
  const terms = rows.map((r) => text(r.term)).filter((t) => /^[\p{L}\p{N}_]/u.test(t) && /[\p{L}\p{N}_]$/u.test(t));
  const rx = terms.length ? new RegExp(terms.map((t) => `(?:${wholeTermSource(t)})`).join("|"), "iu") : null;
  titleCache = { at: Date.now(), terms, rx };
  return titleCache;
}

// ── lead_lookup ─────────────────────────────────────────────────────────────

async function leadLookup({ inputs, db }) {
  const email = text(inputs.email).toLowerCase();
  if (!email) return { status: "empty", note: "No email to look up" };
  const { rows } = await db.query(
    `SELECT l.id AS lead_id, l.is_bounced, l.bounce_type, l.is_suppressed,
            s.email IS NOT NULL AS listed, s.reason
       FROM (SELECT $1::text AS email) e
       LEFT JOIN leads l ON l.email = e.email
       LEFT JOIN suppressed_emails s ON s.email = e.email`,
    [email]
  );
  const r = rows[0] ?? {};
  const neverContact = Boolean(r.listed || r.is_suppressed);
  if (!r.lead_id && !neverContact) return { status: "empty", note: "Not in the lead database or on the never-contact list" };
  const value = { lead_id: r.lead_id ?? null, bounced: Boolean(r.is_bounced), never_contact: neverContact };
  const display = neverContact ? "Never contact" : r.is_bounced ? "Bounced" : "In the database";
  const note = neverContact
    ? `On the never-contact list${r.reason ? `: ${r.reason}` : ""}${r.lead_id ? "" : " (the lead itself was deleted)"}`
    : r.is_bounced
      ? `A lead with this address bounced${r.bounce_type ? ` (${r.bounce_type})` : ""}`
      : "A lead with this address is already in the database";
  return { status: "done", value, display, note };
}

// ── client_area ─────────────────────────────────────────────────────────────

function entryLabel(e) {
  return [e.city, e.state, e.country].filter(Boolean).join(", ");
}

async function clientArea({ inputs, table, db }) {
  const t = await targetingFor(db, table.client_tag);
  if (!t) return { status: "error", note: `${table.client_tag} has no targeting rules`, retryable: false };
  const include = Array.isArray(t.include_locations) ? t.include_locations : [];
  const exclude = Array.isArray(t.exclude_locations) ? t.exclude_locations : [];
  const geo = await geoFor(db);
  const placeText = [inputs.city, inputs.state, inputs.country].map(text).filter(Boolean).join(", ") || "(no place)";

  const country = geo.countryCode.get(text(inputs.country).toLowerCase()) ?? null;
  if (!country) {
    return { status: "done", value: false, display: "Outside", note: `AI Ark gave no country we know for "${placeText}"` };
  }
  const allowed = (Array.isArray(t.countries) ? t.countries : []).map((c) => text(c).toUpperCase());
  if (allowed.length && !allowed.includes(country)) {
    return { status: "done", value: false, display: "Outside", note: `${country} is not one of the client's countries (${allowed.join(", ")})` };
  }
  const state = text(inputs.state) ? geo.stateCode.get(`${country}|${text(inputs.state).toLowerCase()}`) ?? null : null;
  const city = cityKey(inputs.city);
  const matches = (e) =>
    text(e?.country).toUpperCase() === country &&
    (!text(e?.state) || (state !== null && text(e.state).toUpperCase() === state)) &&
    (!text(e?.city) || (city !== "" && cityKey(e.city) === city));

  const out = exclude.find(matches);
  if (out) return { status: "done", value: false, display: "Outside", note: `Inside a place the client excludes: ${entryLabel(out)}` };
  if (!include.length) return { status: "done", value: true, display: "Inside", note: "The client's rules list no places, so every place counts" };
  const hit = include.find(matches);
  if (hit) return { status: "done", value: true, display: "Inside", note: `Matches the client's place ${entryLabel(hit)}` };
  if (!state && text(inputs.state)) {
    return { status: "done", value: false, display: "Outside", note: `"${text(inputs.state)}" is not a state we know in ${country}` };
  }
  if (!state) {
    return {
      status: "done",
      value: false,
      display: "Can't tell",
      note: `AI Ark gave no state ("${placeText}"), so the place can't be matched to the client's ${include.length} places`,
    };
  }
  return { status: "done", value: false, display: "Outside", note: `"${placeText}" is not one of the client's ${include.length} places` };
}

// ── client_exclusions ───────────────────────────────────────────────────────

async function clientExclusions({ inputs, table, db }) {
  const t = await targetingFor(db, table.client_tag);
  if (!t) return { status: "error", note: `${table.client_tag} has no targeting rules`, retryable: false };
  const terms = (Array.isArray(t.exclude_terms) ? t.exclude_terms : []).map((s) => text(s).toLowerCase()).filter(Boolean);
  const fields = [
    ["company name", text(inputs.company)],
    ["industry", text(inputs.industry)],
    ["company description", text(inputs.description)],
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
  let titleNote = "";
  if (t.commercial_cleaning) {
    const { terms: titleTerms, rx } = await cleaningTitles(db);
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
