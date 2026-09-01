// Read Bison's custom_variables for leads we already hold, and fill in what is
// missing — location first, then category.
//
//   node scripts/backfill-bison-custom-vars.mjs                  # everything pending
//   node scripts/backfill-bison-custom-vars.mjs --max 5000       # bounded trial
//   node scripts/backfill-bison-custom-vars.mjs --dry-run
//
// WHY THIS EXISTS: migration 089 dropped custom_variables from the mirror on the
// reasoning that it was merge data we send TO Bison. It is not — it is where
// Bison keeps the enrichment, and the 368,907 leads imported from it arrived
// with no location and no category as a direct result. Measured across 120 of
// them: city and state on 100%, category on ~5%.
//
// Only ever FILLS BLANKS. A lead that already has a city, or a category set by
// hand, is left exactly as it is.
import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname });

const env = process.env;
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1] ?? true) : d; };
const has = (n) => args.includes(`--${n}`);

const MAX = Number(flag("max")) || Infinity;
const DRY = has("dry-run");
const CONCURRENCY = Math.max(1, Math.min(64, Number(flag("concurrency")) || 24));
const RATE = Math.max(1, Number(flag("rate")) || 40);   // requests/sec per install
const BATCH = 2000;                                      // leads claimed per round

if (!env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
const KEYS = env.EMAILBISON_KEYS ? JSON.parse(env.EMAILBISON_KEYS) : {};
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 12, keepAlive: true });
pool.on("error", (e) => console.log(`   pg pool: ${e.message}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSIENT = /Connection terminated|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|terminating connection|server closed/i;
async function dbQuery(text, params, attempts = 5) {
  for (let a = 1; ; a++) {
    try { return await pool.query(text, params); }
    catch (e) { if (a >= attempts || !TRANSIENT.test(String(e?.message ?? ""))) throw e; await sleep(400 * a * a); }
  }
}

// Per-install pacing, same shape as the push worker's gate.
const nextAt = new Map();
async function gate(domain) {
  const now = Date.now();
  const at = Math.max(now, nextAt.get(domain) ?? 0);
  nextAt.set(domain, at + Math.ceil(1000 / RATE) + 5);
  if (at > now) await sleep(at - now);
}

const CV_KEYS = {
  cv_city: ["city"],
  cv_state: ["state"],
  cv_category: ["category"],
  cv_subcategory: ["sub-category", "subcategory", "sub category"],
  cv_additional_category: ["additional category", "additional-category", "additional_category"],
  cv_domain: ["domain"],
  cv_address: ["address"],
  cv_phone: ["company phone", "phone", "company phone number"],
  cv_google_maps_url: ["google maps url", "google_maps_url", "maps url"],
  cv_question: ["question"],
};
const CV_COLS = Object.keys(CV_KEYS);
const str = (v) => { const s = String(v ?? "").trim(); return s ? s.slice(0, 500) : null; };

function customVars(raw) {
  const flat = {};
  if (Array.isArray(raw)) for (const v of raw) { if (v?.name != null) flat[String(v.name).trim().toLowerCase()] = v.value; }
  else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) flat[String(k).trim().toLowerCase()] = v;
  const out = {};
  for (const [col, names] of Object.entries(CV_KEYS)) {
    let hit = null;
    for (const n of names) if (flat[n] != null && String(flat[n]).trim() !== "") { hit = flat[n]; break; }
    out[col] = str(hit);
  }
  return out;
}

async function fetchLead(domain, email) {
  const key = KEYS[domain];
  if (!key) return null;
  for (let a = 1; a <= 3; a++) {
    await gate(domain);
    try {
      const res = await fetch(`https://${domain}/api/leads/${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 404 || res.status === 422) return null;      // absent, not an error
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      const j = await res.json();
      return j?.data ?? j;
    } catch { if (a === 3) return null; await sleep(500 * a * a); }
  }
  return null;
}

let scanned = 0, fetched = 0, cvFound = 0, leadsFilled = 0, catFilled = 0, locFilled = 0;

async function round() {
  // Leads that are missing enrichment AND that we can locate in Bison.
  const { rows } = await dbQuery(
    `select b.instance_url, b.email, b.bison_id, l.id as lead_id,
            l.city is null as need_city, l.state is null as need_state,
            (l.category is null or btrim(l.category) = '') as need_category
       from bison_leads b
       join leads l on l.email = b.email
      where b.cv_fetched_at is null
        and (l.city is null or l.state is null or l.category is null or btrim(l.category) = '')
      limit $1`,
    [Math.min(BATCH, MAX - scanned)]
  );
  if (rows.length === 0) return 0;

  const updates = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (i < rows.length) {
      const row = rows[i++];
      const lead = await fetchLead(row.instance_url, row.email);
      fetched++;
      const cv = customVars(lead?.custom_variables);
      if (Object.values(cv).some(Boolean)) cvFound++;
      updates.push({ ...row, cv });
    }
  }));

  if (DRY) {
    const withCity = updates.filter(u => u.cv.cv_city).length;
    const withCat = updates.filter(u => u.cv.cv_category).length;
    console.log(`   [dry] ${updates.length} leads: ${withCity} have city, ${withCat} have category`);
    scanned += rows.length;
    return rows.length;
  }

  // Mirror first, so a crash never re-fetches what was already read.
  for (let k = 0; k < updates.length; k += 500) {
    const chunk = updates.slice(k, k + 500);
    const vals = [], params = [];
    chunk.forEach((u, n) => {
      const b = n * (CV_COLS.length + 2);
      vals.push(`($${b+1},$${b+2},${CV_COLS.map((_, j) => `$${b+3+j}`).join(",")})`);
      params.push(u.instance_url, u.bison_id, ...CV_COLS.map((c) => u.cv[c]));
    });
    await dbQuery(
      `update bison_leads b set ${CV_COLS.map((c, j) => `${c} = coalesce(v.${c}, b.${c})`).join(", ")},
              cv_fetched_at = now()
         from (values ${vals.join(",")}) as v(instance_url, bison_id, ${CV_COLS.join(", ")})
        where b.instance_url = v.instance_url and b.bison_id = v.bison_id::bigint`,
      params
    );
  }

  // Then the leads themselves — BLANKS ONLY, and never over a manual category.
  //
  // ONE statement per chunk of 500, not one per lead. Per-lead this ran at
  // 3 leads/sec (each UPDATE is a ~200ms round trip to Supabase — the same
  // mistake as the push worker's finalize stage), which put 368k leads at 34
  // hours. Batched, the round trip is paid once per 500.
  const toWrite = updates.filter((u) => Object.values(u.cv).some(Boolean));
  for (let k = 0; k < toWrite.length; k += 500) {
    const chunk = toWrite.slice(k, k + 500);
    const vals = [], params = [];
    chunk.forEach((u, n) => {
      const b = n * 12;
      vals.push(`($${b+1}::uuid,$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12})`);
      const c = u.cv;
      params.push(u.lead_id, c.cv_city, c.cv_state, c.cv_domain, c.cv_address, c.cv_phone,
        c.cv_google_maps_url, c.cv_question, c.cv_category, c.cv_subcategory, c.cv_additional_category,
        // Location changed -> the location worker must re-resolve this lead.
        u.need_city && c.cv_city ? "pending" : null);
      leadsFilled++;
      if (u.need_city && c.cv_city) locFilled++;
      if (u.need_category && c.cv_category) catFilled++;
    });
    await dbQuery(
      `update leads l set
         city    = coalesce(nullif(btrim(l.city), ''), v.city),
         state   = coalesce(nullif(btrim(l.state), ''), v.state),
         domain  = coalesce(nullif(btrim(l.domain), ''), v.domain),
         address = coalesce(nullif(btrim(l.address), ''), v.address),
         company_phone   = coalesce(nullif(btrim(l.company_phone), ''), v.phone),
         google_maps_url = coalesce(nullif(btrim(l.google_maps_url), ''), v.gmaps),
         question        = coalesce(nullif(btrim(l.question), ''), v.question),
         category     = case when coalesce(l.category_source,'') = 'manual' then l.category
                             else coalesce(nullif(btrim(l.category), ''), v.category) end,
         subcategory  = case when coalesce(l.category_source,'') = 'manual' then l.subcategory
                             else coalesce(nullif(btrim(l.subcategory), ''), v.subcategory) end,
         additional_category = case when coalesce(l.category_source,'') = 'manual' then l.additional_category
                             else coalesce(nullif(btrim(l.additional_category), ''), v.additional) end,
         category_source = case
             when coalesce(l.category_source,'') = 'manual' then l.category_source
             when nullif(btrim(coalesce(l.category,'')), '') is null and v.category is not null then 'bison'
             else l.category_source end,
         updated_at = now()
       from (values ${vals.join(",")}) as
            v(id, city, state, domain, address, phone, gmaps, question, category, subcategory, additional, loc_flag)
       where l.id = v.id`,
      params
    );
  }

  scanned += rows.length;
  return rows.length;
}

const started = Date.now();
console.log(`backfilling Bison custom_variables — concurrency ${CONCURRENCY}, ${RATE}/s per install${DRY ? ", DRY RUN" : ""}`);
for (;;) {
  if (scanned >= MAX) break;
  const n = await round();
  if (n === 0) break;
  const secs = (Date.now() - started) / 1000;
  console.log(`   ${scanned.toLocaleString()} scanned · ${cvFound.toLocaleString()} had variables · ` +
              `${locFilled.toLocaleString()} got a location · ${catFilled.toLocaleString()} got a category · ` +
              `${(scanned / secs).toFixed(0)}/sec`);
}
const secs = (Date.now() - started) / 1000;
console.log(`\ndone in ${(secs / 60).toFixed(1)} min: ${scanned.toLocaleString()} leads checked, ` +
            `${leadsFilled.toLocaleString()} updated — ${locFilled.toLocaleString()} gained a location, ` +
            `${catFilled.toLocaleString()} gained a category.`);
await pool.end();
