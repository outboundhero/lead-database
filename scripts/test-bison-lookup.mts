// Looking a lead up in Bison by email (2026-11-21).
//
//   npx tsx scripts/test-bison-lookup.mts
//
// Pure: scripts/lib/bison-lookup.mjs, plus a simulated install with Bison's
// quirk (GET /api/leads/{path} reads a path that starts with digits as a numeric
// id) to show the direct route can never find such a lead and the search can.
import { directLookupUnsafe, exactEmailMatch } from "./lib/bison-lookup.mjs";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

console.log("which addresses the direct route cannot be trusted with");
eq("starts with digits", directLookupUnsafe("360abc@example.com"), true);
eq("all digits before the @", directLookupUnsafe("096@example.com"), true);
eq("a leading zero", directLookupUnsafe("04center@example.com"), true);
eq("leading slashes", directLookupUnsafe("//abc@example.com"), true);
eq("padding is ignored", directLookupUnsafe("  4abc@example.com"), true);
eq("a plain address is fine", directLookupUnsafe("john.smith@example.com"), false);
eq("capitals are fine", directLookupUnsafe("John@Example.com"), false);
eq("digits later on are fine", directLookupUnsafe("office360@example.com"), false);
eq("empty is not flagged", directLookupUnsafe(""), false);

console.log("\npicking the exact match from search results");
const rows = [
  { id: 1, email: "4abc@example.com.au" },          // a longer address that contains it
  { id: 2, email: "x4abc@example.com" },
  { id: 3, email: "4ABC@Example.com " },            // the one (case and padding differ)
  { id: null, email: "4abc@example.com" },          // no id: never picked
];
eq("exact, any case, trimmed", exactEmailMatch(rows, "4abc@example.com")?.id, 3);
eq("partial matches are not picked", exactEmailMatch(rows.slice(0, 2), "4abc@example.com"), null);
eq("a row without an id is not picked", exactEmailMatch([rows[3]], "4abc@example.com"), null);
eq("no rows", exactEmailMatch([], "4abc@example.com"), null);
eq("not an array", exactEmailMatch(null, "4abc@example.com"), null);
eq("empty address", exactEmailMatch(rows, "  "), null);

// ── A simulated install with Bison's numeric-id quirk ────────────────────────
type Lead = { id: number; email: string };
const leads: Lead[] = [
  { id: 360, email: "someone.else@example.com" },
  { id: 1339649, email: "360abc@example.com" },
  { id: 77, email: "john@example.com" },
];
function directGet(path: string): Lead | null {             // GET /api/leads/{path}
  const m = /^(\d+)/.exec(path);
  if (m) return leads.find((l) => l.id === Number(m[1])) ?? null;   // read as an id
  return leads.find((l) => l.email.toLowerCase() === path.toLowerCase()) ?? null;
}
function search(q: string): Lead[] {                           // GET /api/leads?search=q
  return leads.filter((l) => l.email.toLowerCase().includes(q.toLowerCase()));
}
const oldLookup = (email: string) => {
  const hit = directGet(email);
  return hit && hit.email.toLowerCase() === email.toLowerCase() ? hit : null;
};
const newLookup = (email: string) =>
  directLookupUnsafe(email) ? exactEmailMatch(search(email), email) : oldLookup(email);

console.log("\nsimulated install");
eq("old: the direct route returns lead #360, someone else", directGet("360abc@example.com")?.email, "someone.else@example.com");
eq("old: so the lookup finds nothing (the 832 failures)", oldLookup("360abc@example.com"), null);
eq("new: the search finds the right lead", newLookup("360abc@example.com")?.id, 1339649);
eq("new: a plain address still goes direct and is found", newLookup("john@example.com")?.id, 77);
eq("new: a leading-digit address Bison lacks is absent, not someone else", newLookup("999zzz@example.com"), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
