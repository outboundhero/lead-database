// State and country names for the AI Ark tab: AI Ark writes places as names
// ("Armonk, New York, United States"), client_targeting stores codes
// ({"city": "Armonk", "state": "NY", "country": "US"}). Read from geo_admin1
// and supported_countries, the same reference the location resolver uses.

const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

/** @param db anything with query(sql) -> { rows } */
export async function loadGeo(db) {
  const [{ rows: states }, { rows: countries }] = await Promise.all([
    db.query(`SELECT country_code, state_code, name FROM geo_admin1`),
    db.query(`SELECT code, name FROM supported_countries`),
  ]);
  const stateName = new Map();
  const stateCode = new Map();
  for (const s of states) {
    stateName.set(`${s.country_code}|${s.state_code}`.toUpperCase(), s.name);
    stateCode.set(`${s.country_code}|${String(s.name).toLowerCase()}`, s.state_code);
    stateCode.set(`${s.country_code}|${String(s.state_code).toLowerCase()}`, s.state_code);
  }
  const countryName = new Map();
  const countryCode = new Map();
  for (const c of countries) {
    countryName.set(String(c.code).toUpperCase(), c.name);
    countryCode.set(String(c.name).toLowerCase(), c.code);
    countryCode.set(String(c.code).toLowerCase(), c.code);
  }
  countryCode.set("usa", "US");
  countryCode.set("united states of america", "US");
  countryCode.set("uk", "GB");
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
 * A city name reduced to letters, the way geo_locations.city_key is built
 * (accents folded, everything but a–z dropped), with Saint/Fort/Mount
 * shortened so "Saint Albans" and "St. Albans" meet.
 */
export function cityKey(s) {
  return clean(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/\bfort\b/g, "ft")
    .replace(/\bmount\b/g, "mt")
    .replace(/[^a-z]/g, "");
}
