#!/usr/bin/env node
// Exercises POST /api/enrich/intake the way the GMaps Scraper will call it, and
// leaves a small demo delivery in the client's Clay-tab Companies table.
//
//   node scripts/test-enrich-intake.mjs --tag=<client tag> [--url=http://localhost:3000]
//
// The client must have a Companies table on the Clay tab.
//
// Checks: a wrong key is refused (401), a chunk without the search's city /
// state / category is refused (422, Clay dropped those too), an unknown client
// is refused (404), a real chunk is stored (place ids de-duplicated inside the
// chunk), and the same chunk delivered again adds nothing.
//
// The places are MADE UP (names say "demo", websites are reserved example
// domains or deliberately broken), chosen so every Phase 1 step has something
// to show: in area / out of area, an excluded keyword, a big brand, a blocked
// listing website, no website, a dead website. Delete them from the Clay tab
// (select → Delete) whenever you like.

import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const arg = (name, d) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? d;
const URL_BASE = arg("url", "http://localhost:3000");
const TAG = arg("tag", "").toUpperCase();
if (!TAG) {
  console.error("Pass --tag=<client tag>: a client with a Companies table on the Clay tab");
  process.exit(1);
}
const KEY = process.env.ENRICH_INTAKE_KEY;
if (!KEY) {
  console.error("ENRICH_INTAKE_KEY is not set in .env.local");
  process.exit(1);
}

const place = (id, title, city, region, category, url, extra = {}) => ({
  place_id: `demo-${id}`,
  title,
  url,
  domain: url ? new URL(url).hostname.replace(/^www\./, "") : undefined,
  address: `${100 + id} Demo Street, ${city}, ${region}`,
  phone: null,
  category,
  category_ids: [category.toLowerCase().replace(/\W+/g, "_")],
  additional_categories: [],
  address_info: { city, region },
  ...extra,
});

const items = [
  place(1, "Demo Dental Studio", "Manhattan", "New York", "Dentist", "https://example.com/"),
  place(2, "Demo Janitorial Services", "Queens", "New York", "Janitorial service", undefined),
  place(3, "Walmart Supercenter (demo row)", "Yonkers", "New York", "Department store", "https://www.walmart.com/store/demo"),
  place(4, "Demo Pizza", "Albany", "New York", "Pizza restaurant", "https://example.org/"),
  place(5, "Demo Accounting Group", "White Plains", "New York", "Accountant", "https://www.yelp.com/biz/demo-accounting"),
  place(6, "Demo Fitness Club", "Stamford", "Connecticut", "Gym", undefined),
  place(7, "Demo Medical Clinic", "Bronx", "New York", "Medical clinic", "https://no-such-site.invalid/"),
  place(8, "Demo Architects", "New Rochelle", "New York", "Architect", "https://example.net/"),
  place(9, "Demo Insurance Agency", "Greenwich", "Connecticut", "Insurance agency", "https://www.iana.org/"),
];
items.push({ ...items[0] }); // the same place twice in one chunk

const chunk = {
  taskId: "demo-task-0001-0",
  originalTaskId: "demo-task-0001",
  extra: { client: TAG, keyword: "offices (demo)", city: "New York", state: "NY", category: "Demo", scrape_queue_id: "demo" },
  postbackData: { tasks: [{ id: "demo-task-0001", data: { keyword: "offices (demo)" }, result: [{ items }] }] },
};

async function post(body, { key = KEY, tag = TAG, bufferId = "demo-buffer-0001" } = {}) {
  const res = await fetch(`${URL_BASE}/api/enrich/intake`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "x-client-tag": tag,
      "x-gmaps-buffer-id": bufferId,
      "x-source-label": "Demo - made-up places (safe to delete)", // header values must be Latin-1
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const wrongKey = await post(chunk, { key: "x".repeat(40) });
check("wrong key is refused with 401", wrongKey.status === 401, wrongKey);

const noCity = await post({ ...chunk, extra: { ...chunk.extra, city: "" } }, { bufferId: "demo-buffer-nocity" });
check("chunk without extra.city is refused with 422", noCity.status === 422, noCity);

const unknown = await post(chunk, { tag: "NO-SUCH-CLIENT", bufferId: "demo-buffer-unknown" });
check("client without a Clay table is refused with 404", unknown.status === 404, unknown);

const first = await post(chunk);
const firstOk = first.status === 200 && first.body?.received === items.length;
check(`delivery stored: ${first.body?.created} new, ${first.body?.duplicates} duplicate(s)`, firstOk, first);

const again = await post(chunk);
check(
  "the same chunk delivered again adds nothing",
  again.status === 200 && again.body?.duplicateDelivery === true && again.body?.created === 0,
  again
);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
