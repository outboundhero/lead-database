// Unit checks for the city/state merge rule and the "is this an extra
// location?" judgement (src/lib/uploads/import-rows.ts: decidePlace, samePlace,
// isImportableEmail). No database. Run: npx tsx scripts/test-merge-location.mts
//
// The cases come from the 2026-09-18 review of the import engine, which found
// that filling city and state independently invents places that do not exist
// (Denver + a state that belonged to Lincoln, CA) and that the extra-location
// rule compared against the PRE-merge row (Orangevale stored twice).
import { decidePlace, samePlace, isImportableEmail, type ExistingPlace, type PlaceInput } from "../src/lib/uploads/import-rows";
import { normalizeRow, cleanCompanyName } from "../src/lib/uploads/normalize-row";
import { normalizeEspLabel } from "../src/lib/uploads/constants";

let failed = 0, passed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
}
const ex = (city: string | null, state: string | null, code: string | null = null): ExistingPlace => ({ city, state, state_code: code });
const row = (city: string | null, stateText: string | null, stateCode: string | null = null): PlaceInput => ({ city, stateText, stateCode });
const pick = (d: ReturnType<typeof decidePlace>) => ({ city: d.city, state: d.state, extra: d.extra });

console.log("merge — the three rows from the review");
// farid: DB Denver|null, file Lincoln, California → Denver stays stateless, Lincoln is an extra
eq("city-only lead + other city/state: no fill, extra", pick(decidePlace(ex("Denver", null), row("Lincoln", "California", "CA"), "merge", [])), { city: null, state: null, extra: true });
// b.cassidy: DB null|California, file Orangevale, CA → Orangevale becomes primary, NOT also an extra
eq("state-only lead + city in that state: fill city, no extra", pick(decidePlace(ex(null, "California", "CA"), row("Orangevale", "California", "CA"), "merge", [])), { city: "Orangevale", state: null, extra: false });
// pamaro-style: same person twice in file, second at "Greater Sacramento Area" — judged in processChunk via samePlace against the post-merge primary
eq("samePlace: primary Sacramento/CA vs metro text", samePlace(row("Sacramento", "CA", "CA"), row(null, "Greater Sacramento Area")), false);

console.log("merge — fill rules");
eq("both blank: fill both", pick(decidePlace(ex(null, null), row("Dallas", "Texas", "TX"), "merge", [])), { city: "Dallas", state: "TX", extra: false });
eq("blank state, same city: fill state", pick(decidePlace(ex("Dallas", null), row("Dallas", "TX", "TX"), "merge", [])), { city: null, state: "TX", extra: false });
eq("blank state, city only in file: nothing", pick(decidePlace(ex("Dallas", null), row("Dallas", null), "merge", [])), { city: null, state: null, extra: false });
eq("blank state, state only in file: not filled (could be another city) → extra", pick(decidePlace(ex("Denver", null), row(null, "TX", "TX"), "merge", [])), { city: null, state: null, extra: true });
eq("state-only lead, other state: no fill, extra", pick(decidePlace(ex(null, "TX", "TX"), row("Lincoln", "CA", "CA"), "merge", [])), { city: null, state: null, extra: true });
eq("state-only lead, city with no state in file: fill city", pick(decidePlace(ex(null, "TX", "TX"), row("Dallas", null), "merge", [])), { city: "Dallas", state: null, extra: false });
eq("junk state 'local' + same city with real state: fill state", pick(decidePlace(ex("Denver", "local"), row("Denver", "Colorado", "CO"), "merge", [])), { city: null, state: "CO", extra: false });
eq("junk state 'local' + other city: keep, extra", pick(decidePlace(ex("Denver", "local"), row("Lincoln", "CA", "CA"), "merge", [])), { city: null, state: null, extra: true });
eq("placeholder city '--' counts as blank", pick(decidePlace(ex("--", "CA", "CA"), row("Orangevale", "CA", "CA"), "merge", [])), { city: "Orangevale", state: null, extra: false });
eq("full name vs code are the same state", pick(decidePlace(ex("Denver", "Colorado"), row("Denver", "CO", "CO"), "merge", [])), { city: null, state: null, extra: false });
eq("same city, conflicting codes (Portland OR vs ME): extra", pick(decidePlace(ex("Portland", "OR", "OR"), row("Portland", "Maine", "ME"), "merge", [])), { city: null, state: null, extra: true });
eq("same city, metro text in file: same place", pick(decidePlace(ex("Denver", "CO", "CO"), row("Denver", "Greater Denver Area"), "merge", [])), { city: null, state: null, extra: false });
eq("case/space-insensitive city", pick(decidePlace(ex("denver ", "CO", "CO"), row("Denver", "CO", "CO"), "merge", [])), { city: null, state: null, extra: false });
eq("row without a place: nothing", pick(decidePlace(ex("Denver", "CO", "CO"), row(null, null), "merge", [])), { city: null, state: null, extra: false });
eq("metro-only existing, same metro text: same", pick(decidePlace(ex(null, "Greater Chicago Area"), row(null, "greater chicago area"), "merge", [])), { city: null, state: null, extra: false });
eq("metro-only existing, other metro text: extra", pick(decidePlace(ex(null, "Greater Chicago Area"), row(null, "Greater Denver Area"), "merge", [])), { city: null, state: null, extra: true });

console.log("replace / skip");
eq("skip: nothing, never an extra", pick(decidePlace(ex("Denver", null), row("Lincoln", "CA", "CA"), "skip", [])), { city: null, state: null, extra: false });
eq("replace city+state chosen: primary becomes the row, no extra", pick(decidePlace(ex("Denver", "CO", "CO"), row("Lincoln", "California", "CA"), "replace", ["city", "state"])), { city: "Lincoln", state: "CA", extra: false });
eq("replace only city chosen: state stays CO → Lincoln/CO ≠ Lincoln/CA → extra", pick(decidePlace(ex("Denver", "CO", "CO"), row("Lincoln", "California", "CA"), "replace", ["city"])), { city: "Lincoln", state: null, extra: true });
eq("replace nothing location-related chosen: extra", pick(decidePlace(ex("Denver", "CO", "CO"), row("Lincoln", "California", "CA"), "replace", ["title"])), { city: null, state: null, extra: true });

console.log("metro spellings in the CITY column (the client's files)");
eq("'Greater Sacramento' is Sacramento", samePlace(row("Greater Sacramento", null), row("Sacramento", "CA", "CA")), true);
eq("'Sacramento Area' is Sacramento", samePlace(row("Sacramento Area", "California", "CA"), row("Sacramento", "CA", "CA")), true);
eq("'Greater Sacramento' next to primary Sacramento/CA: not an extra", pick(decidePlace(ex("Sacramento", "California", "CA"), row("Greater Sacramento", null), "merge", [])), { city: null, state: null, extra: false });
eq("'Dallas-Fort Worth Metroplex' is not Dallas (kept as extra)", samePlace(row("Dallas-Fort Worth Metroplex", "TX", "TX"), row("Dallas", "TX", "TX")), false);
eq("metro city with a conflicting code still splits", samePlace(row("Greater Portland", "OR", "OR"), row("Portland", "ME", "ME")), false);
eq("replace city+state chosen, row has city only: half a place is an extra, primary untouched", pick(decidePlace(ex("Denver", "CO", "CO"), row("Lincoln", null), "replace", ["city", "state"])), { city: null, state: null, extra: true });

console.log("normalizeRow: placeholders, company, esp, typed columns");
const H = ["city", "state", "email", "company", "esp", "bounced", "created", "sent", "conf"];
const M = { 0: "city", 1: "state", 2: "email", 3: "company", 4: "esp", 5: "is_bounced", 6: "created_at", 7: "emails_sent", 8: "category_confidence" };
const n1 = normalizeRow(["--", "N/A", "a@b.co", "| Acme | tagline", "Gsuite", "Yes", "2024-02-30T00:00:00Z", "99999999999", "85%"], H, M);
eq("'--' city dropped", n1.city, undefined);
eq("'N/A' state dropped", n1.state, undefined);
eq("company '| Acme | tagline' → Acme", n1.company, "Acme");
eq("esp 'Gsuite' → Google", n1.esp, "Google");
eq("is_bounced 'Yes' → true", n1.is_bounced, true);
eq("emails_sent beyond int4 dropped", n1.emails_sent, undefined);
eq("category_confidence '85%' → 0.85", n1.category_confidence, 0.85);
const n2 = normalizeRow(["Dallas", "Texas", "b@c.io", "Radoslovich | Shapiro, PC", "Fastmail", "maybe", "not a date", "12", "0.4"], H, M);
eq("state Texas → TX", n2.state, "TX");
eq("company keeps first part", n2.company, "Radoslovich");
eq("unknown esp dropped (MX fills it)", n2.esp, undefined);
eq("is_bounced 'maybe' dropped", n2.is_bounced, undefined);
eq("bad date dropped", n2.created_at, undefined);
eq("emails_sent 12", n2.emails_sent, 12);
eq("category_confidence 0.4", n2.category_confidence, 0.4);
eq("cleanCompanyName('|') → undefined", cleanCompanyName("|"), undefined);
for (const [e, want] of [["Office 365", "Microsoft"], ["gmail", "Google"], ["Proofpoint Essentials", "Proofpoint"], ["mimecast", "Mimecast"], ["other", "Custom"], ["Fastmail", null]] as const) {
  eq(`normalizeEspLabel(${JSON.stringify(e)})`, normalizeEspLabel(e), want);
}

console.log("importable emails");
for (const [e, want] of [["a@b.co", true], ["N/A", false], ["--", false], ["", false], ["none", false], ["bob", false], ["bob@bob", false], ["a b@c.com", false], ["first.last@sub.example.co.uk", true]] as const) {
  eq(`isImportableEmail(${JSON.stringify(e)})`, isImportableEmail(e), want);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
