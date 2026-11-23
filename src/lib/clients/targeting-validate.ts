// A client's places (client_targeting.countries, include_locations and
// exclude_locations), as the Rules dialog (Clients page), the Clay tab's
// Location tab and their routes read, check and compare them. Moved here from
// PUT /api/clients/targeting, so both routes check places the same way.
//
// No server-only import: the dialog and the tab use the parsing half in the
// browser, the routes the validation half, each with the database client of
// their own transaction.

/** One place: a country, a state in it, or a city in a state ({country, state?, city?}, client_targeting's shape). */
export type LocationEntry = { country: string; state?: string; city?: string };

/** The countries the Rules dialog offers. */
export const TARGET_COUNTRIES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "US", label: "USA" },
  { code: "CA", label: "Canada" },
  { code: "AU", label: "Australia" },
  { code: "NZ", label: "New Zealand" },
  { code: "GB", label: "United Kingdom" },
  { code: "IE", label: "Ireland" },
];

const COUNTRY_WORDS: Record<string, string> = {
  usa: "US", us: "US", "united states": "US", america: "US",
  canada: "CA", australia: "AU", "new zealand": "NZ",
  "united kingdom": "GB", uk: "GB", ireland: "IE",
};

/** A place as typed: "Spokane, WA" is a city, "Washington" or "WA" a state, "Canada" a country. The server checks it. */
export function parseEntry(raw: string): LocationEntry {
  const t = raw.trim();
  const asCountry = COUNTRY_WORDS[t.toLowerCase()];
  if (asCountry) return { country: asCountry };
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // "City, ST" or "City, ST, Country"
    const country = parts[2] ? COUNTRY_WORDS[parts[2].toLowerCase()] ?? parts[2].toUpperCase() : "US";
    return { country, state: parts[1], city: parts[0] };
  }
  return { country: "US", state: t }; // a bare state name or code
}

/** A place as a chip shows it: "Spokane, WA", "WA", "USA" (the country added outside the US). */
export function entryLabel(e: LocationEntry): string {
  if (e.city) return `${e.city}, ${e.state}${e.country !== "US" ? `, ${e.country}` : ""}`;
  if (e.state) return `${e.state}${e.country !== "US" ? `, ${e.country}` : ""}`;
  return TARGET_COUNTRIES.find((c) => c.code === e.country)?.label ?? e.country;
}

/** Countries as sent: trimmed, upper case, blanks dropped, once each. Not a list: null. */
export function cleanCountries(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map((c) => String(c ?? "").trim().toUpperCase()).filter(Boolean))];
}

/** Terms as stored: trimmed, lower case, blanks dropped, once each, sorted (as migration 078 left them). */
export function cleanTerms(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const raw of v) {
    const t = String(raw).trim().toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen].sort();
}

/** A list of places as sent: objects, or "City, ST" text (parseEntry). Not a list: null. */
export function entriesOf(v: unknown): Array<Partial<LocationEntry>> | null {
  if (!Array.isArray(v)) return null;
  return v.map((e) => (typeof e === "string" ? parseEntry(e) : e && typeof e === "object" ? (e as Partial<LocationEntry>) : {}));
}

/** One place's key: country, state code and city (lower case). Two places with one key are the same place. */
export const entryKey = (e: Partial<LocationEntry>) =>
  `${String(e.country ?? "").trim().toUpperCase()}|${String(e.state ?? "").trim().toUpperCase()}|${String(e.city ?? "").trim().toLowerCase()}`;

const keysOf = (list: unknown): string[] =>
  (Array.isArray(list) ? list : []).map((e) => entryKey(e && typeof e === "object" ? (e as Partial<LocationEntry>) : {})).sort();
const countryKeys = (list: unknown): string[] =>
  [...new Set((Array.isArray(list) ? list : []).map((c) => String(c ?? "").trim().toUpperCase()).filter(Boolean))].sort();

/** A client's places: the three lists a hand edit locks. */
export type Places = { countries: string[]; include_locations: LocationEntry[]; exclude_locations: LocationEntry[] };

/** The places of a client with no client_targeting row yet: the table's defaults. */
export const DEFAULT_PLACES: Places = Object.freeze({ countries: ["US"], include_locations: [], exclude_locations: [] }) as Places;

/** Do two sets of places hold the same countries and the same places (order aside)? */
export function samePlaces(a: Partial<Places> | null | undefined, b: Partial<Places> | null | undefined): boolean {
  const x = a ?? DEFAULT_PLACES;
  const y = b ?? DEFAULT_PLACES;
  const eq = (p: string[], q: string[]) => p.length === q.length && p.every((v, i) => v === q[i]);
  return (
    eq(countryKeys(x.countries), countryKeys(y.countries)) &&
    eq(keysOf(x.include_locations), keysOf(y.include_locations)) &&
    eq(keysOf(x.exclude_locations), keysOf(y.exclude_locations))
  );
}

// GeoNames spells out abbreviations ("St. George" -> "Saint George") and drops
// some suffixes ("Suisun City" -> "Suisun"). Variants are tried only after the
// exact key misses, so "Kansas City" never degrades to "Kansas".
function cityVariants(city: string): string[] {
  const out: string[] = [];
  const abbr: Array<[RegExp, string]> = [
    [/^st\.?\s+/i, "Saint "], [/^ste\.?\s+/i, "Sainte "], [/^ft\.?\s+/i, "Fort "], [/^mt\.?\s+/i, "Mount "],
  ];
  for (const [re, full] of abbr) if (re.test(city)) out.push(city.replace(re, full));
  if (/\s+city$/i.test(city)) out.push(city.replace(/\s+city$/i, ""));
  return out;
}

// city_key is accent-folded; the SQL regexp only strips non-letters, so fold here.
const foldAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** A database client: the route's transaction (withTx), or a pool. */
export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/** Why one place can't be stored, or its canonical form (the state's code, the city as the geo reference spells it). */
async function checkEntry(db: Db, e: Partial<LocationEntry>): Promise<{ entry: LocationEntry } | { error: string }> {
  const country = String(e.country ?? "").trim().toUpperCase();
  if (!country) return { error: "entry missing country" };
  const c = await db.query(`SELECT 1 FROM supported_countries WHERE code = $1 AND enabled`, [country]);
  if (!c.rows.length) return { error: `unsupported country "${String(e.country)}"` };
  const out: LocationEntry = { country };
  const rawState = typeof e.state === "string" ? e.state.trim() : "";
  if (rawState) {
    // the code ("WA") or the full name ("Washington")
    const s = await db.query(
      `SELECT state_code FROM geo_admin1
        WHERE country_code = $1 AND (state_code = $2 OR LOWER(name) = LOWER($3)) LIMIT 1`,
      [country, rawState.toUpperCase(), rawState]
    );
    if (!s.rows.length) return { error: `unknown state "${rawState}" in ${country}` };
    out.state = String(s.rows[0].state_code);
  }
  const rawCity = typeof e.city === "string" ? e.city.trim() : "";
  if (rawCity) {
    if (!out.state) return { error: `city "${rawCity}" needs a state` };
    let found: string | null = null;
    for (const candidate of [rawCity, ...cityVariants(rawCity)]) {
      const g = await db.query(
        `SELECT g.city FROM geo_locations g
           JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
          WHERE g.country_code = $1 AND a.state_code = $2
            AND g.city_key = regexp_replace(lower($3), '[^a-z]', '', 'g')
          ORDER BY g.population DESC NULLS LAST LIMIT 1`,
        [country, out.state, foldAccents(candidate)]
      );
      if (g.rows.length) {
        found = String(g.rows[0].city);
        break;
      }
    }
    if (!found) return { error: `"${rawCity}" is not a known place in ${out.state}, ${country}` };
    out.city = found; // the geo reference's spelling and casing
  }
  return { entry: out };
}

/**
 * Every place checked against the geo reference, as PUT /api/clients/targeting
 * always has: a supported country, a known state (code or name, stored as the
 * code), a city known in that state (stored as the geo reference spells it).
 * Returns the places in canonical form, once each, and every reason one can't
 * be stored (none stored then).
 */
export async function validateEntries(db: Db, entries: Array<Partial<LocationEntry>>): Promise<{ entries: LocationEntry[]; errors: string[] }> {
  const out: LocationEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const r = await checkEntry(db, e && typeof e === "object" ? e : {});
    if ("error" in r) {
      errors.push(r.error);
      continue;
    }
    const k = entryKey(r.entry);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.entry);
  }
  return { entries: out, errors };
}

/** Every country that is no supported one (two letters, enabled in supported_countries). */
export async function countryErrors(db: Db, countries: string[]): Promise<string[]> {
  const errors: string[] = [];
  for (const c of countries) {
    if (!/^[A-Z]{2}$/.test(c)) {
      errors.push(`"${c}" is not a country code`);
      continue;
    }
    const r = await db.query(`SELECT 1 FROM supported_countries WHERE code = $1 AND enabled`, [c]);
    if (!r.rows.length) errors.push(`unsupported country "${c}"`);
  }
  return errors;
}
