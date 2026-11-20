// The built-in competitors list (custom_lists, kind 'competitors', built in,
// seeded by migration 069 as "Janitorial & facility-service competitors"),
// edited on the Lists page, in every AI Ark search that sends the standard
// keywords (cleaning-filters.mjs): the AI Ark tab's counts and pulls for
// cleaning clients (the weekly top-up's pulls among them), the Companies tab's
// AI Ark company pulls for cleaning clients, and the LinkedIn sources for every
// client. It is read when a count, plan or pull is made, so an edit applies from
// the next one on; each pull keeps the terms it used (filters.keywords, or
// filters.linkedin.keywords for a LinkedIn search).
//
// The list holds company keywords, not AI Ark industry names: its terms go with
// the standard keywords on a company's name, industry and description (whole
// words), never to "Leave out industries" (exact catalog names), and never to
// the people keywords (headline and summary), where "building maintenance"
// would leave out the facility managers the job titles look for.
//
// Plain JavaScript: the routes, the workers and the tests share it.

/** The built-in list's name (built-in lists can't be renamed on the Lists page). */
export const COMPETITORS_LIST_NAME = "Janitorial & facility-service competitors";

/** The terms migration 069 seeded the list with: used, and said so, when the database has no such list. */
export const COMPETITORS_SEED = Object.freeze([
  "janitorial", "commercial cleaning", "cleaning service", "cleaning services", "facility service", "facility services",
  "building maintenance", "building services", "custodial", "janitor", "maid service", "housekeeping service",
  "porter service", "day porter", "floor care", "carpet cleaning", "window cleaning", "pressure washing",
  "power washing", "sanitation service", "disinfection service",
]);

/** Where the Lists page is (a manager's sidebar, "Lists"); the Leads page's Lists chip points there too. */
export const COMPETITORS_EDIT_HREF = "/lists";

/**
 * @typedef {{ name: string, terms: string[], from: "database" | "fallback", id: string | null, updatedAt: string | null,
 *             note: string | null }} Competitors
 *   terms: trimmed, spaces collapsed, once each (case aside), in the list's order; from "fallback": the database has
 *   no built-in list of kind competitors, so the 069 seed is used and `note` says so
 */

/** The longest term kept: filters.mjs's VALUE_MAX, and what the Lists page stores (120 characters). */
const TERM_MAX = 120;
const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const fmt = (n) => Number(n).toLocaleString("en-US");

/** A list's items as a search uses them: trimmed, spaces collapsed, at most 120 characters, once each (case aside). */
export function cleanCompetitorTerms(items) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const s = clean(raw);
    if (!s || s.length > TERM_MAX) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** What a pull uses when the database holds no built-in competitors list: the 069 seed, and a note saying so. */
export const COMPETITORS_FALLBACK = Object.freeze({
  name: COMPETITORS_LIST_NAME,
  terms: Object.freeze([...COMPETITORS_SEED]),
  from: "fallback",
  id: null,
  updatedAt: null,
  note: `The built-in list "${COMPETITORS_LIST_NAME}" is missing from the database, so the ${fmt(COMPETITORS_SEED.length)} terms it was first made with are left out instead.`,
});

/**
 * The list from its custom_lists row (id, name, items, updated_at), or the
 * fallback when there is no row. A row that holds no usable term applies as
 * an empty list, and the note says so.
 *
 * @param {{ id?: string, name?: string, items?: unknown, updated_at?: string | Date | null } | null | undefined} row
 * @returns {Competitors}
 */
export function competitorsFrom(row) {
  if (!row) return COMPETITORS_FALLBACK;
  const terms = cleanCompetitorTerms(row.items);
  const updatedAt = row.updated_at == null ? null : row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  const name = clean(row.name) || COMPETITORS_LIST_NAME;
  return {
    name,
    terms,
    from: "database",
    id: row.id ? String(row.id) : null,
    updatedAt,
    note: terms.length ? null : `The built-in list "${name}" holds no terms, so it leaves nothing out.`,
  };
}

/**
 * The built-in competitors list as stored now: the built-in row of kind
 * competitors (the one named COMPETITORS_LIST_NAME first, should there be two),
 * or the fallback when there is none. Runs on the caller's client.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @returns {Promise<Competitors>}
 */
export async function readCompetitors(db) {
  const { rows } = await db.query(
    `SELECT id, name, items, updated_at
       FROM custom_lists
      WHERE kind = 'competitors' AND built_in
      ORDER BY (name = $1) DESC, updated_at DESC
      LIMIT 1`,
    [COMPETITORS_LIST_NAME]
  );
  return competitorsFrom(rows[0] ?? null);
}

/** What the AI Ark tab shows of the list: its name, how many terms, where it came from, and where to edit it. */
export function competitorsView(c) {
  return { name: c.name, terms: c.terms.length, from: c.from, note: c.note, editHref: COMPETITORS_EDIT_HREF };
}
