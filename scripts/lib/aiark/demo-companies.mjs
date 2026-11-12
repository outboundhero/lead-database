// Made-up companies for demo pulls on the Companies tab and for the tests.
// Nothing here is real: names come from short stock lists, every website and
// address is under the reserved ".example" top-level domain (RFC 2606), and
// phone numbers use 555-0100 to 555-0199, which are set aside for fiction.
//
// A company belongs to a place: the same place string always gives the same
// companies, with the same ids, whoever asks. So two made-up clients that share
// a place share companies (the registry copy has something to copy), and a
// demo pull can be repeated, resumed and tested.
//
// The records follow AI Ark's Company Search shape, including the odd forms its
// own docs show: a state written "nj - new jersey", a city written
// "Madison, Wi" with no state, a head office with no country, a scheme on
// link.domain, a headcount outside its band.

import { demoId, hash32 } from "./demo-people.mjs";

const CO_A = ["Northgate", "Bluestone", "Summit", "Harborview", "Cedar Ridge", "Ironwood", "Lakeshore", "Silver Oak",
  "Brightline", "Meadowbrook", "Granite Peak", "Riverbend", "Westfield", "Copperleaf", "Fairhaven", "Kingsley", "Maple Hollow"];
const CO_B = [
  ["Dental Group", "dental"], ["Medical Partners", "hospitals and health care"], ["Property Management", "property management"],
  ["Office Suites", "commercial real estate"], ["Law Offices", "law practice"], ["Accounting", "accounting"],
  ["Family Clinic", "medical practices"], ["Business Center", "commercial real estate"], ["Realty", "real estate"],
  ["Logistics", "truck transportation"], ["Learning Center", "education"], ["Fitness Club", "wellness and fitness services"],
  ["Veterinary Hospital", "veterinary services"], ["Janitorial Services", "janitorial service"], ["Auto Repair", "automotive"],
];
// Names holding a short exclusion word inside a longer one: bar, cafe, pub, law.
const INSIDE_WORDS = ["Barrington", "Cafeteria Row", "Pubco", "Lawson"];
const STREETS = ["Main Street", "Oak Avenue", "Market Street", "Commerce Drive", "Lake Road", "Park Place", "Mill Street", "Elm Street"];
// For a search by state alone: towns many states have.
const TOWNS = ["Centerville", "Fairview", "Riverside", "Franklin", "Greenville", "Clinton", "Salem", "Georgetown"];
// For a search by country alone.
const COUNTRY_PLACES = [["Columbus", "Ohio"], ["Austin", "Texas"], ["Denver", "Colorado"], ["Raleigh", "North Carolina"], ["Tampa", "Florida"]];
// Places no client list should contain: these companies show the office re-check.
const DECOYS = [["Bismarck", "North Dakota"], ["Cheyenne", "Wyoming"], ["Juneau", "Alaska"], ["Billings", "Montana"]];
const SIZES = [[2, 10], [11, 50], [51, 200], [201, 500], [501, 1000]];
const AREA_CODES = ["217", "309", "614", "512", "303", "919", "813", "701"];

// US state names and codes, for the "nj - new jersey" and "Madison, Wi" shapes.
const US_STATES = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT",
  Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI",
  Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
  Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV",
  Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC",
};
const COUNTRIES = new Set(["United States", "Canada", "United Kingdom", "Australia", "New Zealand", "Ireland"]);

const pick = (list, n) => list[n % list.length];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A place string as AI Ark gets it ("Springfield, Illinois", "Illinois", "United States") -> {city, state, country}. */
export function parsePlace(s) {
  const t = String(s ?? "").trim();
  const at = t.lastIndexOf(",");
  if (at > 0) return { city: t.slice(0, at).trim(), state: t.slice(at + 1).trim(), country: "United States" };
  if (COUNTRIES.has(t)) return { city: null, state: null, country: t };
  return { city: null, state: t, country: "United States" };
}

function office(r, city, state, { country = "United States", shape = "plain" } = {}) {
  const street = `${100 + (r % 900)} ${pick(STREETS, r >>> 4)}`;
  const postal = String(10000 + (r % 89999)).padStart(5, "0");
  const code = US_STATES[state];
  let o;
  if (shape === "no_state" && code) o = { city: `${city}, ${code[0]}${code[1].toLowerCase()}` }; // "Madison, Wi", as AI Ark's own example
  else if (shape === "code_name" && code) o = { state: `${code.toLowerCase()} - ${state.toLowerCase()}`, city: city.toLowerCase() };
  else o = { state, city };
  const hasCountry = shape !== "no_country";
  return {
    continent: "North America",
    ...(hasCountry ? { country } : {}),
    ...o,
    street,
    postal_code: postal,
    raw_address: [o.state, o.city, street].filter(Boolean).join(", "),
  };
}

/**
 * Company `i` of a place: the same place and index always give the same
 * company, whoever searches. ~4% have a name holding a common exclusion word
 * inside a longer one ("Barrington" holds "bar"), which AI Ark's whole-word
 * match lets through and the lead database's anywhere-in-the-text rule does not.
 */
export function makeCompany(place, i) {
  const r = hash32(`co|${place}#${i}`);
  const roll = (r >>> 17) % 100;
  const a = roll < 4 ? pick(INSIDE_WORDS, r >>> 9) : pick(CO_A, r >>> 9);
  const [b, industry] = pick(CO_B, r >>> 13);
  const name = `${a} ${b}`;

  const p = parsePlace(place);
  let [city, state] = p.city ? [p.city, p.state] : p.state ? [pick(TOWNS, r >>> 3), p.state] : pick(COUNTRY_PLACES, r >>> 3);
  const home = { city, state };
  // ~6%: head office elsewhere, a branch in the place. ~5%: no office in the place at all.
  const elsewhere = roll >= 4 && roll < 15;
  if (elsewhere) [city, state] = pick(DECOYS, r >>> 21);
  const shape = roll >= 15 && roll < 18 ? "no_state" : roll >= 18 && roll < 28 ? "code_name" : roll >= 28 && roll < 38 ? "no_country" : "plain";
  const hq = office(r, city, state, { shape });
  const branches = [];
  if (roll >= 4 && roll < 10) branches.push(office(r >>> 2, home.city, home.state));
  if ((r >>> 25) % 4 === 0) branches.push(office(r >>> 3, pick(DECOYS, r >>> 5)[0], pick(DECOYS, r >>> 5)[1]));

  const domain = `${slug(a)}${slug(b).slice(0, 8)}${i}.example`;
  const webRoll = (r >>> 11) % 100;
  const website = webRoll < 8 ? null : webRoll < 12 ? `https://www.facebook.com/${slug(a)}${slug(b)}${i}` : `https://www.${domain}`;
  const linkDomain = webRoll >= 90 ? null : webRoll >= 80 ? `http://www.${domain}` : domain;
  const mailRoll = (r >>> 19) % 100;
  const email = mailRoll < 55 ? `info@${domain}` : mailRoll < 65 ? `office@${domain}` : mailRoll < 70 ? `contact@${domain}` : null;
  const [start, end] = pick(SIZES, r >>> 15);
  const total = (r >>> 27) % 7 === 0 ? end * 3 : start + ((r >>> 7) % (end - start + 1));
  const typeRoll = (r >>> 23) % 100;
  const type = typeRoll < 4 ? "SELF_EMPLOYED" : typeRoll < 6 ? "GOVERNMENT_AGENCY" : typeRoll < 8 ? "PUBLIC_COMPANY" : "PRIVATELY_HELD";
  const area = pick(AREA_CODES, r >>> 6);
  const line = String(100 + (r % 100)).slice(1).padStart(2, "0");

  return {
    id: demoId(`co|${place}`, i),
    summary: {
      name,
      legal_name: `${name} LLC`,
      description: `${name} is a made-up business generated for an AI Ark demo pull.`,
      founded_year: 1980 + (r % 40),
      type,
      industry,
      staff: { total, range: { start, end } },
      logo: { source: `https://images.example/${slug(name)}.png` },
    },
    link: {
      ...(website ? { website } : {}),
      ...(linkDomain ? { domain: linkDomain } : {}),
      linkedin: `https://linkedin.example/company/${slug(name)}-${i}`,
    },
    contact: { ...(email ? { email } : {}), phone: { raw: `(${area}) 555-01${line}`, sanitized: `${area}55501${line}` } },
    financial: { funding: { type: "SEED", total_amount: 100000 + (r % 50) * 1000 } },
    location: { headquarter: hq, locations: [hq, ...branches] },
    technologies: [{ name: "demo analytics", category: "analytics" }],
    industries: [industry, "business services"],
    keywords: ["made-up", "demo"],
    last_updated: "2026-10-01",
  };
}

/** Does one office sit in a place string? A city with its state, a state, or a country. */
export function officeInPlace(o, place) {
  const p = parsePlace(place);
  const st = String(o?.state ?? "");
  const stateName = Object.keys(US_STATES).find((n) => n.toLowerCase() === st.toLowerCase() || st.toLowerCase().endsWith(` - ${n.toLowerCase()}`))
    ?? Object.keys(US_STATES).find((n) => String(o?.city ?? "").toLowerCase().endsWith(`, ${US_STATES[n].toLowerCase()}`));
  const city = String(o?.city ?? "").replace(/,.*$/, "").trim().toLowerCase();
  if (p.city) return city === p.city.toLowerCase() && stateName === p.state;
  if (p.state) return stateName === p.state;
  return !o?.country || o.country === p.country;
}

/** A company AI Ark would leave out under the request's own exclusions. */
export function excludedByAccount(c, account) {
  const contentOf = (x) => (Array.isArray(x) ? x : Array.isArray(x?.content) ? x.content : []);
  const word = (t, s) => new RegExp(`(^|[^a-z0-9])${escapeRx(String(t).toLowerCase())}($|[^a-z0-9])`, "i").test(String(s ?? ""));
  const offices = [c.location.headquarter, ...c.location.locations];
  if (contentOf(account?.location?.any?.exclude).some((pl) => offices.some((o) => officeInPlace(o, pl)))) return true;
  if (contentOf(account?.type?.any?.exclude).includes(c.summary.type)) return true;
  const industries = [c.summary.industry, ...c.industries].map((s) => s.toLowerCase());
  if (contentOf(account?.industries?.any?.exclude).some((x) => industries.includes(String(x).toLowerCase()))) return true;
  const include = contentOf(account?.industries?.any?.include);
  if (include.length && !include.some((x) => industries.some((s) => word(x, s)))) return true;
  if (contentOf(account?.keyword?.any?.exclude).some((t) => word(t, c.summary.name) || industries.some((s) => word(t, s)) || word(t, c.summary.description))) {
    return true;
  }
  const bands = Array.isArray(account?.employeeSize?.range) ? account.employeeSize.range : [];
  if (bands.length) {
    const n = c.summary.staff.total;
    if (!bands.some((b) => (b.start == null || n >= b.start) && (b.end == null || n <= b.end))) return true;
  }
  return false;
}
