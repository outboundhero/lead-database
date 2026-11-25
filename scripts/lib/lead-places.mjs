// A lead's place from its city and state text: the location job's own code,
// one lead at a time (2026-11-26). scripts/backfill-lead-locations.mjs (the
// location-worker cron, every 30 minutes) walks every lead still to be placed
// through it, and a promotion round places the leads it has just made with it
// (placeAdded in scripts/lib/enrich/promote.mjs, called by the web app's
// promote run), so the automatic push of those leads need not wait for the
// cron. For a lead, both write exactly the same, because they run the same
// passes, with the same conditions and the same statement:
//
//   pass 1   a 2-letter state ("WA"): the state of the first country in
//            PLACE_COUNTRY_ORDER that has that code, then the city in that
//            state (resolved), or the state alone (partial: no city, or one the
//            reference doesn't hold there). A code no country has: unresolved,
//            and the state text is cleared.
//   pass 1b  a longer state ("Illinois", "Ontario"): the state of that name,
//            in the same country order, then the city as in pass 1. Text that
//            names no state ("North America", "your area") is left exactly as
//            it is: unresolved leads are hidden from browse and campaigns.
//   pass 2   a city and no state: placed when one state of one country holds
//            a city of that name (resolved), else unresolved.
//   pass 3   no state and no status, flagged for review by an earlier clean
//            (raw_data location_review or state_pre_clean): unresolved.
//
// Passes 1 and 1b take leads with no state code yet, pass 2 leads with no
// status yet (the cron's --all takes them again). A pass writes the state's
// name, state_code, the country's display name, country_code, the reference's
// spelling of the city when it matched, location_id, location_status and
// location_source. Leads with no place text keep NULL.

/** A state code or name several countries have ("WA") belongs to the first of these: the existing codes came from the US+CA normalization. */
export const PLACE_COUNTRY_ORDER = Object.freeze(["US", "CA", "AU", "NZ", "GB", "IE"]);

/** A city name reduced to its letters, accents folded, as geo_locations.city_key holds it. */
export const ck = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {{ id: string, stateName: string | null, stateCode: string | null, countryDisp: string | null | undefined,
 *             countryCode: string | null, cityDisp?: string, locId?: number, status: "resolved" | "partial" | "unresolved" }} PlaceUpdate
 * @typedef {"resolved" | "partial" | "city_miss" | "stateless" | "unresolved" | null} PlaceOutcome
 *   what the cron counts: city_miss is a partial whose city the reference doesn't hold, stateless a pass 2 resolved;
 *   null for a lead pass 1b leaves as it is
 */

/**
 * Which leads each pass takes, as SQL over leads under the alias `a`. The
 * pass's own text (code, name, city) and, kept apart for the cron's --all,
 * what makes a lead still to be placed: no state code (passes 1 and 1b), no
 * status (pass 2). `review` is pass 3's whole condition.
 *
 * @param {string} a
 */
export function placeWhere(a) {
  return {
    code: `${a}.state IS NOT NULL AND length(btrim(${a}.state)) = 2`,
    name: `${a}.state IS NOT NULL AND length(btrim(${a}.state)) > 2`,
    open: `${a}.state_code IS NULL`,
    city: `${a}.state IS NULL AND ${a}.city IS NOT NULL AND btrim(${a}.city) <> ''`,
    fresh: `${a}.location_status IS NULL`,
    review: `${a}.location_status IS NULL AND ${a}.state IS NULL AND (${a}.raw_data ? 'location_review' OR ${a}.raw_data ? 'state_pre_clean')`,
  };
}

// JavaScript's trim() in SQL (pass 1b trims the state with it; btrim takes spaces only).
const JS_SPACE = String.raw`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`;
const jsTrim = (expr) => `regexp_replace(${expr}, '^${JS_SPACE}+|${JS_SPACE}+$', '', 'g')`;

/**
 * The leads a run of the location job would still write, as SQL over leads
 * under the alias `a`: a lead pass 1, 2 or 3 takes (each writes every lead it
 * takes), or one pass 1b takes whose state text names a state (lower-cased
 * and trimmed as pass 1b compares it; the state names are plain letters, so
 * lower() and JavaScript's toLowerCase agree). A lead the job has placed, or
 * leaves as it is (no place text, a state text naming no state), is not one:
 * waiting for the job changes nothing for it. The automatic push waits only
 * for these (scripts/lib/enrich/promote-push.mjs). Keep it in step with the
 * passes below.
 *
 * @param {string} a
 */
export function leftToPlaceSql(a) {
  const w = placeWhere(a);
  const countries = `ARRAY[${PLACE_COUNTRY_ORDER.map((c) => `'${c}'`).join(", ")}]`;
  return `((${w.code} AND ${w.open})
       OR (${w.name} AND ${w.open} AND EXISTS (SELECT 1 FROM geo_admin1 g
            WHERE g.country_code = ANY(${countries}) AND lower(g.name) = lower(${jsTrim(`${a}.state`)})))
       OR (${w.city} AND ${w.fresh})
       OR (${w.review}))`;
}

/**
 * The geo reference, as the passes read it: the enabled countries' display
 * names, the states (geo_admin1) by code and by name, and the cities
 * (geo_locations). The cron loads every city, in chunks (`onGeoRows` hears the
 * count); a caller placing a few leads passes their cities' keys (ck) and gets
 * only the rows under those keys, all the passes look up for them, read in
 * the same order (geoname_id), so each lookup answers as with every city.
 *
 * @param {Db} db
 * @param {{ cityKeys?: string[] | null, onGeoRows?: ((n: number) => void) | null }} [p]
 */
export async function loadPlaceReference(db, { cityKeys = null, onGeoRows = null } = {}) {
  const countries = new Map(); // code -> display
  for (const r of (await db.query(`SELECT code, display_name FROM supported_countries WHERE enabled`)).rows) {
    countries.set(r.code, r.display_name);
  }
  const admin1ByCode = new Map();  // `${country}|${state_code}` -> {admin1, name}
  const stateCodeCountry = new Map(); // state_code -> [countries] (collision-aware)
  for (const r of (await db.query(`SELECT country_code, admin1_code, name, state_code FROM geo_admin1`)).rows) {
    admin1ByCode.set(`${r.country_code}|${r.state_code}`, { admin1: r.admin1_code, name: r.name });
    if (!stateCodeCountry.has(r.state_code)) stateCodeCountry.set(r.state_code, []);
    stateCodeCountry.get(r.state_code).push(r.country_code);
  }
  const geo = new Map(); // `${city_key}|${country}|${admin1}` -> {id, city, pop}
  const geoByKey = new Map(); // city_key -> [{id, country, admin1, city, pop}] (for stateless lookup)
  const add = (rs) => {
    for (const r of rs) {
      const k = `${r.city_key}|${r.country_code}|${r.admin1_code}`;
      const cur = geo.get(k);
      if (!cur || Number(r.population) > cur.pop) geo.set(k, { id: Number(r.geoname_id), city: r.city, pop: Number(r.population) });
      if (!geoByKey.has(r.city_key)) geoByKey.set(r.city_key, []);
      geoByKey.get(r.city_key).push({ id: Number(r.geoname_id), country: r.country_code, admin1: r.admin1_code, city: r.city, pop: Number(r.population) });
    }
  };
  if (cityKeys) {
    const keys = [...new Set(cityKeys)];
    if (keys.length) {
      add((await db.query(
        `SELECT geoname_id, city, city_key, country_code, admin1_code, population
           FROM geo_locations WHERE city_key = ANY($1::text[]) ORDER BY geoname_id`,
        [keys]
      )).rows);
    }
  } else {
    const CH = 50000; let off = 0;
    for (;;) {
      const rs = (await db.query(`SELECT geoname_id, city, city_key, country_code, admin1_code, population
                                  FROM geo_locations ORDER BY geoname_id LIMIT ${CH} OFFSET ${off}`)).rows;
      if (!rs.length) break;
      add(rs);
      off += CH; onGeoRows?.(off);
    }
  }
  // Pass 1b's names: lower(name) -> {country, code, name}, the first country in the order that has the name.
  const admin1ByName = new Map();
  for (const pref of PLACE_COUNTRY_ORDER) {
    for (const [k, v] of admin1ByCode) {
      const [country] = k.split("|");
      if (country !== pref) continue;
      const key = v.name.toLowerCase();
      if (!admin1ByName.has(key)) admin1ByName.set(key, { country, code: k.split("|")[1], name: v.name });
    }
  }
  return { countries, admin1ByCode, stateCodeCountry, geo, geoByKey, admin1ByName };
}

// A lead's 2-letter code could be US or CA/AU (WA!): US wins, then CA, in PLACE_COUNTRY_ORDER.
function countryForStateCode(ref, code) {
  const cands = ref.stateCodeCountry.get(code) ?? [];
  for (const pref of PLACE_COUNTRY_ORDER) if (cands.includes(pref)) return pref;
  return null;
}

// Passes 1 and 1b once the state is known: the city in it, or the state alone.
function withCity(ref, base, city, country, a1) {
  if (city && city.trim()) {
    const hit = ref.geo.get(`${ck(city)}|${country}|${a1.admin1}`);
    if (hit) return { update: { ...base, cityDisp: hit.city, locId: hit.id, status: "resolved" }, outcome: "resolved" };
    return { update: { ...base, status: "partial" }, outcome: "city_miss" };
  }
  return { update: { ...base, status: "partial" }, outcome: "partial" };
}

/**
 * Pass 1: a lead whose state is a 2-letter code (`r.state`, `r.city`).
 *
 * @param {Awaited<ReturnType<typeof loadPlaceReference>>} ref
 * @param {{ id: string, city: string | null, state: string }} r
 * @returns {{ update: PlaceUpdate | null, outcome: PlaceOutcome }}
 */
export function placeByStateCode(ref, r) {
  const code = r.state.trim().toUpperCase();
  const country = countryForStateCode(ref, code);
  if (!country) return { update: { id: r.id, stateName: null, stateCode: null, countryDisp: null, countryCode: null, status: "unresolved" }, outcome: "unresolved" };
  const a1 = ref.admin1ByCode.get(`${country}|${code}`);
  if (!a1) return { update: null, outcome: "unresolved" };
  const base = { id: r.id, stateName: a1.name, stateCode: code, countryDisp: ref.countries.get(country), countryCode: country };
  return withCity(ref, base, r.city, country, a1);
}

/**
 * Pass 1b: a lead whose state is a longer text, matched to a state's full
 * name (Bison's custom variables write full names, and the 3-day import and
 * the custom-vars backfill copy them in verbatim, so pass 1's codes never
 * reach them). Text that names no state is left exactly as it is (outcome
 * null): marking it unresolved would hide ~50k leads that browse and
 * campaigns show now, and that is not this pass's call to make.
 *
 * @param {Awaited<ReturnType<typeof loadPlaceReference>>} ref
 * @param {{ id: string, city: string | null, state: string }} r
 * @returns {{ update: PlaceUpdate | null, outcome: PlaceOutcome }}
 */
export function placeByStateName(ref, r) {
  const hit = ref.admin1ByName.get(r.state.trim().toLowerCase());
  if (!hit) return { update: null, outcome: null }; // junk or foreign — leave untouched
  const a1 = ref.admin1ByCode.get(`${hit.country}|${hit.code}`);
  if (!a1) return { update: null, outcome: null };
  const base = { id: r.id, stateName: a1.name, stateCode: hit.code, countryDisp: ref.countries.get(hit.country), countryCode: hit.country };
  return withCity(ref, base, r.city, hit.country, a1);
}

/**
 * Pass 2: a lead with a city and no state, placed only when one (country,
 * state) holds a city of that name.
 *
 * @param {Awaited<ReturnType<typeof loadPlaceReference>>} ref
 * @param {{ id: string, city: string }} r
 * @returns {{ update: PlaceUpdate, outcome: PlaceOutcome }}
 */
export function placeByCity(ref, r) {
  const list = ref.geoByKey.get(ck(r.city)) ?? [];
  // unique = one (country, admin1) with meaningful population dominance
  const spots = new Map();
  for (const g of list) spots.set(`${g.country}|${g.admin1}`, g);
  if (spots.size === 1) {
    const g = [...spots.values()][0];
    const a1 = [...ref.admin1ByCode.entries()].find(([k, v]) => k.startsWith(g.country + "|") && v.admin1 === g.admin1);
    if (a1) {
      return {
        update: { id: r.id, stateName: a1[1].name, stateCode: a1[0].split("|")[1], countryDisp: ref.countries.get(g.country), countryCode: g.country, cityDisp: g.city, locId: g.id, status: "resolved" },
        outcome: "stateless",
      };
    }
  }
  return { update: { id: r.id, stateName: null, stateCode: null, countryDisp: null, countryCode: null, status: "unresolved" }, outcome: "unresolved" };
}

/**
 * The passes' writes, one statement, in lead id order: the cron and a
 * promotion's placement can write the same new leads at the same moment, and
 * as the statement looks each lead up by its id in that order, two writes
 * take their shared rows in the same order and never deadlock (pass 2 reads
 * its leads in no order). The order changes nothing written: a lead is in a
 * write once.
 *
 * @param {Db} db
 * @param {PlaceUpdate[]} updates
 */
export async function writePlaces(db, updates) {
  if (!updates.length) return;
  const b = [...updates].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  await db.query(`
    UPDATE leads l SET
      state = v.state_name, state_code = v.state_code,
      country = v.country_disp, country_code = v.country_code,
      city = COALESCE(v.city_disp, l.city),
      location_id = v.loc_id, location_status = v.status,
      location_source = COALESCE(l.raw_data->>'state_source', 'source')
    FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) state_name, unnest($3::text[]) state_code,
                 unnest($4::text[]) country_disp, unnest($5::text[]) country_code,
                 unnest($6::text[]) city_disp, unnest($7::bigint[]) loc_id, unnest($8::text[]) status) v
    WHERE l.id = v.id
  `, [b.map((u) => u.id), b.map((u) => u.stateName), b.map((u) => u.stateCode),
      b.map((u) => u.countryDisp), b.map((u) => u.countryCode),
      b.map((u) => u.cityDisp ?? null), b.map((u) => u.locId ?? null), b.map((u) => u.status)]);
}

/**
 * Pass 3: leads an earlier clean flagged for review that have no place yet go
 * to the unresolved queue. Every such lead, or only these ids.
 *
 * @param {Db} db
 * @param {string[] | null} [ids]
 * @returns {Promise<number>} how many
 */
export async function markForReview(db, ids = null) {
  const w = placeWhere("l");
  const r = await db.query(
    `UPDATE leads l SET location_status = 'unresolved' WHERE ${w.review}${ids ? " AND l.id = ANY($1::uuid[])" : ""}`,
    ids ? [ids] : undefined
  );
  return r.rowCount ?? 0;
}

/**
 * Places these leads now, exactly as the location job's next run would: each
 * read with the pass that would take it (the cron's own conditions), the
 * reference read for their cities only, the same passes and the same writes.
 * A lead no pass takes (placed already, or no place text) is left as it is,
 * as is one whose state text names no state. Bounded by the ids: a promote
 * batch's are at most promotion.batch_max (1,000).
 *
 * @param {Db} db  best one transaction (the caller's)
 * @param {string[]} ids  lead ids
 * @returns {Promise<{ leads: number, resolved: number, partial: number, unresolved: number, untouched: number }>}
 */
export async function placeLeads(db, ids) {
  const list = [...new Set((ids ?? []).filter(Boolean).map(String))];
  const out = { leads: list.length, resolved: 0, partial: 0, unresolved: 0, untouched: 0 };
  if (!list.length) return out;
  const w = placeWhere("l");
  const { rows } = await db.query(
    `SELECT l.id::text AS id, l.city, l.state,
            CASE WHEN ${w.code} AND ${w.open} THEN 'code'
                 WHEN ${w.name} AND ${w.open} THEN 'name'
                 WHEN ${w.city} AND ${w.fresh} THEN 'city' END AS pass
       FROM leads l WHERE l.id = ANY($1::uuid[]) ORDER BY l.id`,
    [list]
  );
  const taken = rows.filter((r) => r.pass);
  const updates = [];
  if (taken.length) {
    const ref = await loadPlaceReference(db, { cityKeys: taken.filter((r) => r.city != null).map((r) => ck(r.city)) });
    for (const r of taken) {
      const got = r.pass === "code" ? placeByStateCode(ref, r) : r.pass === "name" ? placeByStateName(ref, r) : placeByCity(ref, r);
      if (got.update) updates.push(got.update);
    }
    await writePlaces(db, updates);
  }
  const review = await markForReview(db, list);
  for (const u of updates) out[u.status]++;
  out.unresolved += review;
  out.untouched = rows.length - updates.length - review;
  return out;
}
