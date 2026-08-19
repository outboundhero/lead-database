/**
 * Verifies that selecting a client on the Leads page applies its targeting
 * CORRECTLY — i.e. that city+state stay paired.
 *
 * Regression under test (2026-08-19): locations used to be flattened into the
 * flat City/State chips. Those chips AND independently and cannot express a
 * pair, so the state was discarded and the City chip held bare city names that
 * match in ANY state. Client BBS saw Washington DC, Rockville MD and Syracuse
 * NY leads for a Utah/Nevada target list.
 *
 * This drives the REAL reducer and the REAL buildRpcFilters, then pushes the
 * result through the REAL fn_lead_filter_conditions in Postgres and counts, so
 * it exercises the whole path rather than a reimplementation of it.
 *
 *   npx tsx scripts/test-client-targeting.mts            # all clients
 *   npx tsx scripts/test-client-targeting.mts BBS ABM    # named clients
 */
import { Client } from "pg";
import { filterReducer } from "../src/lib/hooks/use-filters";
import { DEFAULT_FILTER_STATE, normalizeFilterState } from "../src/types/filters";
import { buildRpcFilters } from "../src/lib/filters/build-rpc-filters";
import type { TargetingPatch } from "../src/lib/hooks/use-filters";
import type { LocationTargetEntry } from "../src/types/filters";

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error("DATABASE_URL is required");

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

interface TargetingRow {
  client_tag: string;
  include_locations: LocationTargetEntry[] | null;
  exclude_locations: LocationTargetEntry[] | null;
  include_terms: string[] | null;
  exclude_terms: string[] | null;
}

// Mirrors the patch that leads/page.tsx builds on client select.
function patchFor(t: TargetingRow): TargetingPatch {
  return {
    locations: { include: t.include_locations ?? [], exclude: t.exclude_locations ?? [] },
    categorySearchInclude: t.include_terms ?? [],
    keywordExclude: [],
    categorySearchExclude: t.exclude_terms ?? [],
  };
}

const applied = (t: TargetingRow) =>
  filterReducer(DEFAULT_FILTER_STATE, { type: "APPLY_CLIENT_TARGETING", patch: patchFor(t) } as never);

async function main() {
  const only = process.argv.slice(2).map((s) => s.toUpperCase());
  const db = new Client({ connectionString: DB });
  await db.connect();
  await db.query("set statement_timeout = '180s'");

  const { rows } = await db.query<TargetingRow>(
    `select client_tag, include_locations, exclude_locations, include_terms, exclude_terms
       from client_targeting
      where jsonb_array_length(coalesce(include_locations::jsonb,'[]'::jsonb)) > 0
      order by client_tag`
  );
  const targets = only.length ? rows.filter((r) => only.includes(r.client_tag)) : rows;
  console.log(`\nTesting ${targets.length} client(s) with location targeting\n`);

  // ---- Structural invariants, every client ----------------------------------
  console.log("── structural invariants (all clients) ──");
  let cityChipPolluted = 0, pairsLost = 0, stateMissing = 0, roundTripDirty = 0;

  for (const t of targets) {
    const s = applied(t);
    const entries = t.include_locations ?? [];
    const withCity = entries.filter((e) => e.city);
    const coveredStates = [...new Set(entries.filter((e) => e.state).map((e) => e.state))];

    // 1. THE BUG: bare city names must never reach the flat City chip.
    if (s.location.city.include.length > 0) cityChipPolluted++;

    // 2. Every city entry must survive as a PAIR in locationTargets.
    const paired = new Set(s.locationTargets.include.map((e) => `${e.country}|${e.state ?? ""}|${e.city ?? ""}`));
    if (withCity.some((e) => !paired.has(`${e.country}|${e.state ?? ""}|${e.city ?? ""}`))) pairsLost++;

    // 3. Every covered state must be visible in the State chip.
    if (coveredStates.some((st) => !s.location.state.include.includes(st as string))) stateMissing++;

    // 4. Deselecting must restore the default state exactly.
    const back = filterReducer(s, { type: "REMOVE_CLIENT_TARGETING", patch: patchFor(t) } as never);
    if (back.locationTargets.include.length !== 0 ||
        back.locationTargets.exclude.length !== 0 ||
        back.location.state.include.length !== 0 ||
        back.location.city.include.length !== 0) roundTripDirty++;
  }

  ok("no client puts bare city names in the City chip", cityChipPolluted === 0, `${cityChipPolluted} client(s) polluted`);
  ok("every city entry survives as a city+state pair", pairsLost === 0, `${pairsLost} client(s) lost pairs`);
  ok("every covered state is visible in the State chip", stateMissing === 0, `${stateMissing} client(s) missing states`);
  ok("deselecting a client restores a clean slate", roundTripDirty === 0, `${roundTripDirty} client(s) left residue`);

  // ---- Behavioural check against the database ------------------------------
  // Location part only, so any difference is attributable to the pairing fix.
  const sample = only.length ? targets : targets.slice(0, 6);
  console.log(`\n── database behaviour (${sample.length} client(s)) ──`);

  for (const t of sample) {
    const s = applied(t);
    const rpc = buildRpcFilters(normalizeFilterState({
      ...DEFAULT_FILTER_STATE,
      locationTargets: s.locationTargets,
      location: { ...DEFAULT_FILTER_STATE.location, state: s.location.state },
    } as never));

    const { rows: [{ w }] } = await db.query<{ w: string }>(
      `select array_to_string(fn_lead_filter_conditions($1::jsonb), ' AND ') as w`, [JSON.stringify(rpc)]
    );
    if (!w) { ok(`${t.client_tag}: produced a location condition`, false, "empty WHERE"); continue; }

    // fn_location_entry_condition resolves a city+state entry to GEONAME IDS and
    // matches l.location_id, so the authority on where a lead is is its resolved
    // geo row — NOT the free-text l.city column, which can disagree with it
    // (BBS has 6 such rows, e.g. city text "Austin" resolving to Las Vegas, NV).
    // Assert against the resolved place, and against the state the client covers.
    const coveredStates = [...new Set((t.include_locations ?? []).filter((e) => e.state).map((e) => e.state))];
    const pairs = (t.include_locations ?? []).filter((e) => e.city)
      .map((e) => `${(e.city as string).toLowerCase().replace(/[^a-z]/g, "")}|${(e.state as string ?? "").toUpperCase()}`);

    const { rows: [r] } = await db.query<{ total: string; out_of_state: string; off_target: string }>(
      `with m as (
         select l.state_code, g.city_key, a.state_code as geo_state
           from leads l
           left join geo_locations g on g.geoname_id = l.location_id
           left join geo_admin1 a on a.country_code = g.country_code and a.admin1_code = g.admin1_code
          where ${w} and l.is_bounced = false)
       select count(*) as total,
              -- the client's actual complaint: a lead outside the covered states
              count(*) filter (where state_code is not null and upper(state_code) <> all($1::text[])) as out_of_state,
              -- pairing: resolved place must be one of the client's city+state pairs
              count(*) filter (where city_key is not null
                                 and (city_key || '|' || upper(geo_state)) <> all($2::text[])) as off_target
         from m`,
      [coveredStates, pairs]
    );
    const total = Number(r.total), oos = Number(r.out_of_state), off = Number(r.off_target);
    ok(`${t.client_tag}: 0 out-of-state leads (of ${total.toLocaleString()} matched)`, oos === 0, `${oos.toLocaleString()} outside ${coveredStates.join("/")}`);
    ok(`${t.client_tag}: every matched lead resolves to a targeted city+state`, off === 0, `${off.toLocaleString()} off-target`);
  }

  await db.end();
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
