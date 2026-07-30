#!/usr/bin/env node
import "dotenv/config";

/**
 * Locate leads that have NO location data, from company evidence — cheapest
 * tier first (per client spec: lowest practical cost, no guessing):
 *
 *   C1 propagation — same company (name key) already has located leads:
 *      adopt the company's dominant location. Free, highest precision.
 *   C2 area codes — company_phone/phone NANP area code -> state+country
 *      (partial: state-level). Free, deterministic.
 *   C3 ccTLD — .ca/.co.uk/.com.au/.co.nz/.ie domain -> country only. Free.
 *   C4 AI — gpt-4o-mini per DISTINCT company (name+domain), answers validated
 *      against geo_locations (an invented place is rejected) and cached in
 *      company_locations forever.
 *
 * Everything written is tagged location_source='company-<tier>' so clients
 * can opt out of inferred locations (client_targeting.allow_inferred_location).
 *
 * Usage: node --env-file=.env.local scripts/infer-company-locations.mjs
 *          [--dry-run] [--skip-ai] [--ai-limit=N]
 */

import pg from "pg";

const DRY = process.argv.includes("--dry-run");
const SKIP_AI = process.argv.includes("--skip-ai");
const AI_LIMIT = Number((process.argv.find((a) => a.startsWith("--ai-limit=")) || "").split("=")[1]) || Infinity;
const KEY = process.env.OPENAI_API_KEY;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));
// The propagation scan groups millions of rows — the role's 30s default
// statement_timeout kills it (57014). Lift it for every pooled connection.
pool.on("connect", (c) => c.query("SET statement_timeout = 0").catch(() => {}));
async function q(text, params, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(text, params); }
    catch (err) {
      const transient = /ECONNRESET|termin|timeout|socket|EPIPE|server closed/i.test(err.message || "");
      if (!transient || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
const ck = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const companyKey = (s) => String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");

// NANP area code -> US state / CA province (deterministic; geographic codes only)
const AREA_CODES = {
  // US
  AL:["205","251","256","334","659","938"], AK:["907"], AZ:["480","520","602","623","928"],
  AR:["327","479","501","870"], CA:["209","213","279","310","323","341","350","408","415","424","442","510","530","559","562","619","626","628","650","657","661","669","707","714","747","760","805","818","820","831","840","858","909","916","925","949","951"],
  CO:["303","719","720","970","983"], CT:["203","475","860","959"], DE:["302"],
  DC:["202","771"], FL:["239","305","321","352","386","407","448","561","645","656","689","727","754","772","786","813","850","863","904","941","954"],
  GA:["229","404","470","478","678","706","762","770","912","943"], HI:["808"],
  ID:["208","986"], IL:["217","224","309","312","331","447","618","630","708","773","779","815","847","861","872"],
  IN:["219","260","317","463","574","765","812","930"], IA:["319","515","563","641","712"],
  KS:["316","620","785","913"], KY:["270","364","502","606","859"],
  LA:["225","318","337","504","985"], ME:["207"], MD:["240","301","410","443","667"],
  MA:["339","351","413","508","617","774","781","857","978"],
  MI:["231","248","269","313","517","586","616","679","734","810","906","947","989"],
  MN:["218","320","507","612","651","763","924","952"], MS:["228","601","662","769"],
  MO:["314","417","557","573","636","660","816","975"], MT:["406"],
  NE:["308","402","531"], NV:["702","725","775"], NH:["603"],
  NJ:["201","551","609","640","732","848","856","862","908","973"],
  NM:["505","575"], NY:["212","315","329","332","347","363","516","518","585","607","624","631","646","680","716","718","838","845","914","917","929","934"],
  NC:["252","336","472","704","743","828","910","919","980","984"], ND:["701"],
  OH:["216","220","234","283","326","330","380","419","440","513","567","614","740","937"],
  OK:["405","539","572","580","918"], OR:["458","503","541","971"],
  PA:["215","223","267","272","412","445","484","570","582","610","717","724","814","835","878"],
  RI:["401"], SC:["803","821","839","843","854","864"], SD:["605"],
  TN:["423","615","629","731","865","901","931"],
  TX:["210","214","254","281","325","346","361","409","430","432","469","512","682","713","726","737","806","817","830","903","915","936","940","945","956","972","979"],
  UT:["385","435","801"], VT:["802"], VA:["276","434","540","571","686","703","757","804","826","948"],
  WA:["206","253","360","425","509","564"], WV:["304","681"],
  WI:["262","274","414","534","608","715","920"], WY:["307"],
};
const CA_AREA = {
  AB:["368","403","587","780","825"], BC:["236","250","257","604","672","778"],
  MB:["204","431","584"], NB:["428","506"], NL:["709","879"], NS:["782","902"],
  ON:["226","249","289","343","365","382","416","437","519","548","613","647","683","705","742","753","807","905","942"],
  PE:["782","902"], QC:["263","354","367","418","438","450","468","514","579","581","819","873"],
  SK:["306","474","639"], YT:["867"], NT:["867"], NU:["867"],
};
const AREA_TO_STATE = new Map();
for (const [st, codes] of Object.entries(AREA_CODES)) for (const c of codes) AREA_TO_STATE.set(c, { state: st, country: "US" });
for (const [st, codes] of Object.entries(CA_AREA)) for (const c of codes) {
  if (!AREA_TO_STATE.has(c)) AREA_TO_STATE.set(c, { state: st, country: "CA" });
  else if (AREA_TO_STATE.get(c).country === "CA") AREA_TO_STATE.delete(c); // shared CA codes (867/902/782) ambiguous province -> keep country-level
}
for (const c of ["867", "902", "782"]) AREA_TO_STATE.set(c, { state: null, country: "CA" });

const CCTLD = [
  [/\.ca$/, "CA"], [/\.(co|org|ac|gov|net|com)\.uk$/, "GB"], [/\.uk$/, "GB"],
  [/\.(com|net|org|edu|gov)\.au$/, "AU"], [/\.(co|org|net|govt|ac)\.nz$/, "NZ"], [/\.ie$/, "IE"],
];

// display maps
const admin1 = new Map(); // `${country}|${state_code}` -> name
for (const r of (await q(`SELECT country_code, state_code, name FROM geo_admin1`)).rows) {
  if (!admin1.has(`${r.country_code}|${r.state_code}`)) admin1.set(`${r.country_code}|${r.state_code}`, r.name);
}
const countryDisp = new Map();
for (const r of (await q(`SELECT code, display_name FROM supported_countries`)).rows) countryDisp.set(r.code, r.display_name);

// geo validation for AI answers
async function validateCity(city, stateCode, country) {
  const r = await q(`
    SELECT g.geoname_id, g.city FROM geo_locations g
    JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
    WHERE g.city_key = $1 AND g.country_code = $2 AND a.state_code = $3
    ORDER BY g.population DESC LIMIT 1`, [ck(city), country, stateCode]);
  return r.rows[0] ?? null;
}

// ── the no-location cohort, grouped by company ──
console.log("collecting no-location leads...");
const leads = (await q(`
  SELECT id, company, phone, company_phone, domain, email
  FROM leads
  WHERE location_status IS NULL AND state_code IS NULL
    AND (city IS NULL OR btrim(city) = '')`)).rows;
console.log(`no-location leads: ${leads.length}`);

const byCompany = new Map();
for (const l of leads) {
  const k = companyKey(l.company);
  if (!k) continue;
  if (!byCompany.has(k)) byCompany.set(k, []);
  byCompany.get(k).push(l);
}
console.log(`distinct companies: ${byCompany.size}`);

// ── C1: propagation from located leads of the same company ──
console.log("C1: company propagation...");
const propagated = new Map(); // company_key -> {city, state_code, country, geoname_id, granularity}
{
  const CH = 100000; let off = 0;
  const dist = new Map(); // company_key -> Map(`${city}|${state_code}|${country}` -> {n, sample})
  for (;;) {
    const rs = (await q(`
      SELECT lower(btrim(company)) k, city, state_code, country_code, location_id, count(*) n
      FROM leads
      WHERE state_code IS NOT NULL AND company IS NOT NULL AND btrim(company) <> ''
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 1 LIMIT ${CH} OFFSET ${off}`)).rows;
    if (!rs.length) break;
    for (const r of rs) {
      if (!byCompany.has(r.k)) continue;             // only companies we need
      if (!dist.has(r.k)) dist.set(r.k, []);
      dist.get(r.k).push(r);
    }
    off += CH; process.stdout.write(`\r  scanned located-company groups: ${off}`);
  }
  console.log("");
  for (const [k, rows] of dist) {
    const total = rows.reduce((a, b) => a + Number(b.n), 0);
    rows.sort((a, b) => Number(b.n) - Number(a.n));
    const top = rows[0];
    // dominant location must cover >=70% of the company's located leads
    if (Number(top.n) / total >= 0.7) {
      propagated.set(k, {
        city: top.city, state_code: top.state_code, country: top.country_code,
        geoname_id: top.location_id ? Number(top.location_id) : null,
        granularity: top.city ? "city" : "state", source: "propagation",
      });
    }
  }
  console.log(`  companies resolvable by propagation: ${propagated.size}`);
}

// ── resolve remaining companies via cache, then C2/C3/C4 ──
const cached = new Map();
for (const r of (await q(`SELECT company_key, geoname_id, city, state_code, country_code, granularity, source FROM company_locations`)).rows) {
  cached.set(r.company_key, { city: r.city, state_code: r.state_code, country: r.country_code, geoname_id: r.geoname_id ? Number(r.geoname_id) : null, granularity: r.granularity, source: r.source });
}
console.log(`company_locations cache: ${cached.size}`);

function areaCodeOf(l) {
  const p = String(l.company_phone || l.phone || "");
  const m = p.replace(/[^0-9]/g, "").replace(/^1/, "").match(/^([2-9][0-9]{2})[2-9][0-9]{2}[0-9]{4}/);
  return m ? m[1] : null;
}
function cctldOf(l) {
  const d = String(l.domain || (l.email || "").split("@")[1] || "").toLowerCase();
  for (const [re, c] of CCTLD) if (re.test(d)) return c;
  return null;
}

const needAI = [];
const resolution = new Map(); // company_key -> resolution
for (const [k, group] of byCompany) {
  const hit = propagated.get(k) ?? cached.get(k);
  if (hit) { resolution.set(k, hit); continue; }
  // C2: any lead in the group with a usable area code (company_phone preferred)
  let ac = null;
  for (const l of group) { ac = areaCodeOf(l); if (ac) break; }
  if (ac && AREA_TO_STATE.has(ac)) {
    const { state, country } = AREA_TO_STATE.get(ac);
    resolution.set(k, { city: null, state_code: state, country, geoname_id: null, granularity: state ? "state" : "country", source: "area-code" });
    continue;
  }
  // C3: ccTLD
  let cc = null;
  for (const l of group) { cc = cctldOf(l); if (cc) break; }
  if (cc) { resolution.set(k, { city: null, state_code: null, country: cc, geoname_id: null, granularity: "country", source: "cctld" }); continue; }
  needAI.push(k);
}
console.log(`resolved pre-AI: ${resolution.size}  need AI: ${needAI.length}`);

// ── C4: AI per distinct company ──
if (!SKIP_AI && KEY && needAI.length) {
  const SYSTEM = `You determine the headquarters/primary location of businesses for a B2B database limited to: USA, Canada, Australia, New Zealand, United Kingdom, Ireland.

For each company you get: name, domain. Use location words embedded in names/domains ("MiamiCleaners.com" -> Miami FL) and your knowledge of known companies.
Rules:
- Answer ONLY when confident. confidence "high" means you are sure of at least the state/province.
- If the company is outside the six supported countries, use country "OTHER".
- If you cannot tell, answer UNKNOWN.
Respond JSON: {"results":[{"i":<index>,"city":string|null,"state_code":string|null,"country":"US"|"CA"|"AU"|"NZ"|"GB"|"IE"|"OTHER"|"UNKNOWN","confidence":"high"|"low"}]} — every index exactly once.`;
  const list = needAI.slice(0, AI_LIMIT === Infinity ? needAI.length : AI_LIMIT);
  const BATCH = 25, CONC = 8;
  const batches = [];
  for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
  let done = 0, aiResolved = 0, aiUnknown = 0;
  const queue = [...batches];
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const b = queue.shift(); if (!b) return;
      const payload = b.map((k, i) => {
        const l = byCompany.get(k)[0];
        return { i, name: l.company, domain: l.domain || (l.email || "").split("@")[1] || null };
      });
      let out = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
            body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" },
              messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(payload) }] }),
          });
          if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error.message);
          out = JSON.parse(data.choices[0].message.content);
          break;
        } catch (err) {
          if (attempt === 5) console.warn(`  AI batch failed: ${err.message}`);
          else await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      const byIdx = new Map((out?.results ?? []).map((r) => [r.i, r]));
      for (let i = 0; i < b.length; i++) {
        const r = byIdx.get(i);
        if (!r || r.confidence !== "high" || !r.country || r.country === "UNKNOWN") { aiUnknown++; continue; }
        if (r.country === "OTHER") {
          resolution.set(b[i], { city: null, state_code: null, country: "OTHER", geoname_id: null, granularity: "country", source: "ai" });
          aiResolved++; continue;
        }
        let geonameId = null, cityDisp = null;
        if (r.city && r.state_code) {
          const v = await validateCity(r.city, r.state_code, r.country);
          if (v) { geonameId = Number(v.geoname_id); cityDisp = v.city; }
          else { aiUnknown++; continue; }              // invented place -> reject whole answer
        } else if (r.state_code && !admin1.has(`${r.country}|${r.state_code}`)) { aiUnknown++; continue; }
        resolution.set(b[i], {
          city: cityDisp, state_code: r.state_code ?? null, country: r.country,
          geoname_id: geonameId, granularity: cityDisp ? "city" : r.state_code ? "state" : "country", source: "ai",
        });
        aiResolved++;
      }
      done++;
      process.stdout.write(`\r  AI batches ${done}/${batches.length} resolved=${aiResolved} unknown=${aiUnknown}`);
    }
  }));
  console.log("");
} else if (needAI.length) {
  console.log(`AI tier skipped (${SKIP_AI ? "--skip-ai" : "no OPENAI_API_KEY"})`);
}

// ── persist: cache + lead updates ──
const newCache = [...resolution.entries()].filter(([k]) => !cached.has(k));
console.log(`writing ${newCache.length} cache rows, updating leads...`);
if (!DRY) {
  const CH = 2000;
  for (let i = 0; i < newCache.length; i += CH) {
    const b = newCache.slice(i, i + CH);
    await q(`
      INSERT INTO company_locations (company_key, geoname_id, city, state_code, country_code, granularity, source)
      SELECT unnest($1::text[]), unnest($2::bigint[]), unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), unnest($6::text[]), unnest($7::text[])
      ON CONFLICT (company_key) DO NOTHING
    `, [b.map(([k]) => k), b.map(([, v]) => v.geoname_id), b.map(([, v]) => v.city),
        b.map(([, v]) => v.state_code), b.map(([, v]) => v.country === "OTHER" ? null : v.country),
        b.map(([, v]) => v.granularity), b.map(([, v]) => v.source)]);
  }
}

let updated = 0, unsupported = 0;
const ups = [];
for (const [k, v] of resolution) {
  for (const l of byCompany.get(k) ?? []) {
    if (v.country === "OTHER") { ups.push({ id: l.id, status: "unsupported", src: `company-${v.source}` }); unsupported++; continue; }
    const stateName = v.state_code ? admin1.get(`${v.country}|${v.state_code}`) ?? null : null;
    ups.push({
      id: l.id, city: v.city, stateName, stateCode: v.state_code,
      countryDisp: countryDisp.get(v.country) ?? null, countryCode: v.country,
      locId: v.geoname_id, status: v.granularity === "city" ? "resolved" : "partial",
      src: `company-${v.source}`,
    });
    updated++;
  }
}
if (!DRY) {
  const CH = 2000;
  for (let i = 0; i < ups.length; i += CH) {
    const b = ups.slice(i, i + CH);
    await q(`
      UPDATE leads l SET
        city = COALESCE(v.city, l.city), state = COALESCE(v.state_name, l.state),
        state_code = COALESCE(v.state_code, l.state_code),
        country = COALESCE(v.country_disp, l.country), country_code = COALESCE(v.country_code, l.country_code),
        location_id = COALESCE(v.loc_id, l.location_id),
        location_status = v.status, location_source = v.src
      FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) city, unnest($3::text[]) state_name,
                   unnest($4::text[]) state_code, unnest($5::text[]) country_disp, unnest($6::text[]) country_code,
                   unnest($7::bigint[]) loc_id, unnest($8::text[]) status, unnest($9::text[]) src) v
      WHERE l.id = v.id
    `, [b.map((u) => u.id), b.map((u) => u.city ?? null), b.map((u) => u.stateName ?? null),
        b.map((u) => u.stateCode ?? null), b.map((u) => u.countryDisp ?? null), b.map((u) => u.countryCode ?? null),
        b.map((u) => u.locId ?? null), b.map((u) => u.status), b.map((u) => u.src)]);
    process.stdout.write(`\r  leads updated ${Math.min(i + CH, ups.length)}/${ups.length}`);
  }
  console.log("");
}

const bySrc = {};
for (const u of ups) bySrc[u.src] = (bySrc[u.src] || 0) + 1;
console.log(`done: leads located=${updated} unsupported=${unsupported}`);
console.log("by source:", Object.entries(bySrc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  "));
await pool.end();
