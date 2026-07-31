#!/usr/bin/env node
import "dotenv/config";

/**
 * Ensure every Bison instance has the full custom-variable set the push-worker
 * sends. Bison 422-rejects an entire lead when a variable isn't defined on the
 * instance, so this runs BEFORE pushes (and any time the set changes).
 *
 *   GET  /api/custom-variables            — list (paginated)
 *   POST /api/custom-variables {name}     — create missing
 *
 * The variable set mirrors the Clay "Create or update lead" mapping plus the
 * category bundle: person linkedin url, category, sub-category,
 * additional category, city, state, domain, address, question, company phone,
 * google maps url.
 *
 * Usage: node --env-file=.env.local scripts/sync-bison-custom-variables.mjs [--dry-run]
 */

const DRY = process.argv.includes("--dry-run");

// The canonical set (also exported for the push-worker payload).
export const BISON_CUSTOM_VARIABLES = [
  "person linkedin url",
  "category",
  "sub-category",
  "additional category",
  "city",
  "state",
  "domain",
  "address",
  "question",
  "company phone",
  "google maps url",
];

const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (IS_MAIN) {
  const keys = JSON.parse(process.env.EMAILBISON_KEYS || "{}");
  if (!Object.keys(keys).length) { console.error("EMAILBISON_KEYS not set"); process.exit(1); }

  for (const [domain, token] of Object.entries(keys)) {
    const base = `https://${domain}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };

    // list all (paginate)
    const existing = new Set();
    let url = `${base}/api/custom-variables`;
    let pages = 0;
    try {
      while (url && pages < 20) {
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`GET custom-variables -> ${res.status}: ${(await res.text()).slice(0, 120)}`);
        const json = await res.json();
        for (const v of json?.data ?? []) if (v?.name) existing.add(String(v.name).trim().toLowerCase());
        url = typeof json?.links?.next === "string" ? json.links.next : null;
        pages++;
      }
    } catch (e) {
      console.error(`${domain}: ${e.message}`);
      continue;
    }

    const missing = BISON_CUSTOM_VARIABLES.filter((n) => !existing.has(n.toLowerCase()));
    console.log(`${domain}: has ${existing.size} variables [${[...existing].join(", ")}]`);
    if (!missing.length) { console.log(`  all ${BISON_CUSTOM_VARIABLES.length} present ✓`); continue; }
    console.log(`  missing: ${missing.join(", ")}${DRY ? " [dry-run — not creating]" : ""}`);
    if (DRY) continue;
    for (const name of missing) {
      const res = await fetch(`${base}/api/custom-variables`, {
        method: "POST", headers, body: JSON.stringify({ name }),
      });
      if (!res.ok) console.error(`  CREATE "${name}" failed -> ${res.status}: ${(await res.text()).slice(0, 120)}`);
      else console.log(`  created "${name}"`);
      await new Promise((r) => setTimeout(r, 250)); // gentle on the API
    }
  }
}
