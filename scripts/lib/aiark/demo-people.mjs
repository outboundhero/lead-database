// Made-up people for demo runs of the AI Ark tab. Nothing here is real: names
// come from short stock lists, companies are invented, and every web address
// is under the reserved ".example" top-level domain (RFC 2606), which can
// never belong to a real company or mailbox.
//
// Deterministic: the same seed and index always give the same person, so a
// demo run can be repeated, resumed after a restart, and tested.

import { createHash } from "node:crypto";

const FIRST = ["Avery", "Jordan", "Morgan", "Riley", "Casey", "Taylor", "Jamie", "Quinn", "Drew", "Reese",
  "Harper", "Rowan", "Emerson", "Hayden", "Parker", "Sawyer", "Dakota", "Kendall", "Logan", "Skyler"];
const LAST = ["Abbott", "Barlow", "Calloway", "Delgado", "Ellison", "Fairbanks", "Garrison", "Holloway", "Ingram",
  "Jennings", "Kessler", "Lockwood", "Merritt", "Norwood", "Oakley", "Pemberton", "Quintero", "Radcliffe", "Sterling", "Thornton"];
const CO_A = ["Northgate", "Bluestone", "Summit", "Harborview", "Cedar Ridge", "Ironwood", "Lakeshore", "Silver Oak",
  "Brightline", "Meadowbrook", "Granite Peak", "Riverbend", "Westfield", "Copperleaf", "Fairhaven"];
const CO_B = ["Dental Group", "Medical Partners", "Property Management", "Office Suites", "Law Offices", "Accounting",
  "Family Clinic", "Business Center", "Realty", "Logistics", "Learning Center", "Fitness Club", "Veterinary Hospital"];
const INDUSTRY_FOR = {
  "Dental Group": "dental", "Medical Partners": "hospitals and health care", "Property Management": "property management",
  "Office Suites": "commercial real estate", "Law Offices": "law practice", Accounting: "accounting",
  "Family Clinic": "medical practices", "Business Center": "commercial real estate", Realty: "real estate",
  Logistics: "truck transportation", "Learning Center": "education", "Fitness Club": "wellness and fitness services",
  "Veterinary Hospital": "veterinary services",
};
const DEFAULT_TITLES = ["Office Manager", "Facilities Manager", "Operations Manager", "Owner", "Practice Manager", "General Manager"];
const SENIORITY_FOR_TITLE = [
  [/owner|founder/i, "owner"], [/president|ceo|coo|chief/i, "c_suite"], [/director/i, "director"], [/head/i, "head"],
];
const SIZES = ["2-10", "11-50", "51-200", "201-500"];
// Places no client list should contain: these people show the area re-check.
const DECOYS = [["Springfield", "Missouri"], ["Bismarck", "North Dakota"], ["Cheyenne", "Wyoming"], ["Juneau", "Alaska"]];

const pick = (list, n) => list[n % list.length];
const cap = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A stable 32-bit number for a string. */
export function hash32(s) {
  return createHash("sha1").update(String(s)).digest().readUInt32BE(0);
}

/** A UUID-shaped id that encodes nothing real. */
export function demoId(seed, i) {
  const h = createHash("sha1").update(`${seed}:${i}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The places, titles and seniority a demo search asks for, read from the
 * same filter body a real AI Ark request carries.
 * @param {{places: Array<[string, string|null]>, titles: string[], seniority: string[], industries: string[], excludeTerms: string[]}} ask
 */
export function makePerson(seed, i, ask) {
  const r = hash32(`${seed}#${i}`);
  const first = pick(FIRST, r);
  const last = pick(LAST, r >>> 5);
  const a = pick(CO_A, r >>> 9);
  const b = pick(CO_B, r >>> 13);
  let company = `${a} ${b}`;
  const roll = (r >>> 17) % 100;

  // ~4%: a company name that holds an exclusion term inside a longer word —
  // AI Ark's whole-word exclude lets it through, the database's substring rule does not.
  const term = ask.excludeTerms.find((t) => /^[a-z]{4,}$/i.test(t));
  if (term && roll < 4) company = `${cap(term)}ly ${b}`;

  const place = ask.places.length ? ask.places[(r >>> 3) % ask.places.length] : ["Austin", "Texas"];
  let city = place[0];
  let state = place[1];
  if (roll >= 4 && roll < 11) [city, state] = pick(DECOYS, r >>> 21); // ~7%: same-named or wrong place
  else if (roll >= 11 && roll < 13) [city, state] = [`Greater ${place[0] ?? "Austin"} Area`, null]; // ~2%: a metro, no state

  const title = ask.titles.length ? pick(ask.titles, r >>> 7) : pick(DEFAULT_TITLES, r >>> 7);
  const seniority = SENIORITY_FOR_TITLE.find(([re]) => re.test(title))?.[1] ?? (ask.seniority.length ? pick(ask.seniority, r >>> 11) : "manager");
  const industry = ask.industries.length ? pick(ask.industries, r >>> 15) : INDUSTRY_FOR[b];
  const domain = `${slug(a)}${slug(b).slice(0, 8)}.example`;
  // As AI Ark reports it: ~28% no email (found false, INVALID, no address),
  // ~10% a catch-all domain, the rest a verified mailbox.
  const emailRoll = (r >>> 24) % 100;
  const provider = pick(["g-suite", "microsoft", "microsoft", "other"], r >>> 26);
  const email =
    emailRoll < 28
      ? { found: false, status: "INVALID", subStatus: "MAILBOX_NOT_FOUND", domainType: "UNKNOWN", free: false, generic: false, mx: { found: emailRoll >= 10, provider: emailRoll >= 10 ? provider : null } }
      : {
          found: true,
          address: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
          status: "VALID",
          subStatus: "EMPTY",
          domainType: emailRoll < 38 ? "CATCH_ALL" : "SMTP",
          free: false,
          generic: false,
          mx: { found: true, provider },
        };

  return {
    id: demoId(seed, i),
    first,
    last,
    title,
    seniority,
    department: /facilit/i.test(title) ? "facility_administration" : /office/i.test(title) ? "office_management" : "operations",
    company,
    domain,
    industry,
    staff: pick(SIZES, r >>> 19),
    city,
    state,
    country: "United States",
    description: `${company} is a made-up business generated for an AI Ark demo run.`,
    email,
  };
}
