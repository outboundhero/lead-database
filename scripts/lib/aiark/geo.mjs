// State and country names for the AI Ark tab: AI Ark's location filters take
// names, client_targeting stores codes ({"city": "Armonk", "state": "NY",
// "country": "US"}). A place goes out as "Armonk, New York", with no country;
// AI Ark documents no format for a city with its state. Read from geo_admin1,
// supported_countries and location_aliases, the same reference the location
// resolver uses.

const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const fold = (v) => clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// A state name or code more than one country has ("WA") belongs to the first of
// these, as in the location resolver.
const COUNTRY_ORDER = ["US", "CA", "AU", "NZ", "GB", "IE"];

// State spellings the CSV import turns into a code and geo_admin1 doesn't hold.
// Copied from src/lib/uploads/geography.ts, which plain node can't import.
const IMPORT_STATES = [
  ["US", "washington, d.c.", "DC"],
  ["CA", "newfoundland", "NL"],
  ["CA", "pei", "PE"],
];

/** @param db anything with query(sql) -> { rows } */
export async function loadGeo(db) {
  const [{ rows: states }, { rows: countries }, { rows: aliases }] = await Promise.all([
    db.query(`SELECT country_code, state_code, name FROM geo_admin1`),
    db.query(`SELECT code, name FROM supported_countries`),
    db.query(`SELECT alias_key, country_code FROM location_aliases WHERE level = 'country'`),
  ]);
  const stateName = new Map();
  const stateCode = new Map(); // country|folded name or code -> code
  for (const s of states) {
    stateName.set(`${s.country_code}|${s.state_code}`.toUpperCase(), s.name);
    stateCode.set(`${s.country_code}|${fold(s.name)}`, s.state_code);
    stateCode.set(`${s.country_code}|${fold(s.state_code)}`, s.state_code);
  }
  for (const [country, spelling, code] of IMPORT_STATES) stateCode.set(`${country}|${spelling}`, code);
  const countryName = new Map();
  const countryCode = new Map(); // cityKey of a name, code or alias ("U.S.A.") -> code
  for (const c of countries) {
    countryName.set(String(c.code).toUpperCase(), c.name);
    countryCode.set(cityKey(c.name), c.code);
    countryCode.set(cityKey(c.code), c.code);
  }
  for (const a of aliases) countryCode.set(a.alias_key, a.country_code);
  return { stateName, stateCode, countryName, countryCode };
}

/** One client_targeting location entry as an AI Ark location string, or why it can't be one. */
export function placeString(entry, geo) {
  const country = clean(entry?.country).toUpperCase();
  const state = clean(entry?.state).toUpperCase();
  const city = clean(entry?.city);
  if (!country) return { why: "no country" };
  const countryName = geo.countryName.get(country);
  if (!countryName) return { why: `country ${country} is not a supported country` };
  if (!state) return city ? { why: "a city without a state" } : { value: countryName };
  const stateName = geo.stateName.get(`${country}|${state}`);
  if (!stateName) return { why: `unknown state ${state} in ${country}` };
  return { value: city ? `${city}, ${stateName}` : stateName };
}

/**
 * Where a state name or code is, the way the location resolver decides it: the
 * first country in its order that has it. It never reads the person's country.
 * @returns {{country: string, state: string} | null}
 */
export function findState(geo, s) {
  const key = fold(s);
  for (const country of COUNTRY_ORDER) {
    const state = geo.stateCode.get(`${country}|${key}`);
    if (state) return { country, state };
  }
  return null;
}

/**
 * A city name reduced to letters, exactly as the resolver does it and
 * geo_locations.city_key holds it: accents folded, everything but a-z dropped.
 * "St. Paul" and "Saint Paul" stay different keys, as they are to the resolver.
 */
export function cityKey(s) {
  return fold(s).replace(/[^a-z]/g, "");
}

/**
 * The key fn_location_entry_condition gives a client's entry: everything but
 * a-z dropped with no accent folding, so "Ile des Chênes" becomes "iledeschnes",
 * which no city_key holds, and the send gate never matches that entry.
 */
export function entryKey(s) {
  return clean(s).toLowerCase().replace(/[^a-z]/g, "");
}
