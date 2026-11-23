#!/usr/bin/env node
// Checks for two compile and run rules (2026-11-24), no database and no network:
//   R1. C#69's place is the client's own inclusion terms (client_inclusions):
//       none lets every company through, a hit passes, a miss stops, a client
//       with no rules is an error; the template never compiles another client's list
//   R2. FIXED_PLACE_CLAUSES: the "Northern Virginia and Maryland" clause is
//       dropped from every compiled AI prompt, its period kept
//
//   node scripts/test-parity-rules.mjs

import { checker } from "./fixtures/test-support.mjs";
import { CLIENT_ACTIONS, resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { FIXED_PLACE_CLAUSES, withoutFixedPlaces } from "./lib/enrich/compile-original.mjs";
import { COMPANY_COLUMNS_V2 } from "./lib/enrich/company-template-v2.mjs";

const t0 = Date.now();
const count = checker();
const { check, section } = count;

section("R1. The client's own inclusion terms in C#69's place");
/** A fake database whose client_targeting holds one row per tag (or none). */
const dbWith = (rows) => ({
  async query(_sql, params) {
    const r = rows[params?.[0]];
    return { rows: [{ read_at: new Date(), client_tag: r ? params[0] : null, include_terms: r?.include_terms ?? null, exclude_terms: [], countries: [], include_locations: [], exclude_locations: [] }] };
  },
});
const run = async (tag, rows, inputs) => {
  resetClientChecks();
  return CLIENT_ACTIONS.client_inclusions.run({ inputs, table: { client_tag: tag }, row: { next_run_at: new Date() }, db: dbWith(rows) });
};
const company = { company: "Springfield Family Dental", industry: "Dentist", description: "A dental practice with three chairs." };
const none = await run("NOTERMS", { NOTERMS: { include_terms: [] } }, company);
check("no inclusion terms of its own: every company passes (an explicit true, which the Master Filter reads)",
  none.status === "done" && none.value === true && none.display === "No inclusion terms", JSON.stringify(none));
const nullTerms = await run("NULLTERMS", { NULLTERMS: { include_terms: null } }, company);
check("... also when the list is not set at all", nullTerms.status === "done" && nullTerms.value === true);
const hit = await run("DENTAL", { DENTAL: { include_terms: ["Dentist", "orthodontics"] } }, company);
check("a term in the company name or industry passes, and says which", hit.status === "done" && hit.value === true && hit.display === '"dentist" in the industry', JSON.stringify(hit));
const word = await run("CHAIRS", { CHAIRS: { include_terms: ["chairs"] } }, { ...company, industry: "" });
check("a term in the description passes as a whole word", word.status === "done" && word.value === true && word.display === '"chairs" in the company description', JSON.stringify(word));
const miss = await run("SCHOOLS", { SCHOOLS: { include_terms: ["school", "university"] } }, company);
check("no term matches: stopped, with an explicit false", miss.status === "done" && miss.value === false && miss.display === "No inclusion term matched", JSON.stringify(miss));
const norules = await run("NORULES", {}, company);
check("a client with no targeting rules is an error, as the exclusion check is", norules.status === "error" && /no targeting rules/.test(norules.note));
const spec = COMPANY_COLUMNS_V2.find((s) => s.key === "inclusion_keywords_filter");
check("the template compiles C#69 as the client_inclusions action on the company, industry and description, never a list",
  spec?.from === "C#69" && spec.kind === "action" && spec.action === "client_inclusions" && spec.change === true && !spec.formula &&
    spec.inputs?.company === "{{company}}" && spec.inputs?.industry === "{{industry}}" && spec.inputs?.description === "{{description}}",
  JSON.stringify(spec));

section("R2. No fixed place names in a client's prompts");
const sentence = `"...remove toxic runoff. Usually they only have cold power washers and it can lead to city fines, especially in the Northern Virginia and Maryland areas. And please note that facilities with large windows..."`;
const twice = `${sentence} + " " + ${sentence}`;
check("the clause is dropped and its period kept",
  withoutFixedPlaces(sentence) === `"...remove toxic runoff. Usually they only have cold power washers and it can lead to city fines. And please note that facilities with large windows..."`);
check("every occurrence goes (one prompt holds it twice); nothing else changes", !withoutFixedPlaces(twice).includes("Northern Virginia") && withoutFixedPlaces(twice).split("city fines.").length === 3 &&
  withoutFixedPlaces('"Clinics in Maryland and Virginia only"') === '"Clinics in Maryland and Virginia only"' && withoutFixedPlaces("") === "" && withoutFixedPlaces(null) === "");
check("the rule list is the one clause", FIXED_PLACE_CLAUSES.length === 1 && FIXED_PLACE_CLAUSES[0] === ", especially in the Northern Virginia and Maryland areas.");

console.log(`\n${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(count.failed ? 1 : 0);
