// Final CWSJ-OS sweep: list each campaign's ACTUAL leads and detach only those
// whose email came from our two batches (July-31 attach-all + today's
// cancelled un-routed push). Anything else in the campaigns is left alone.
import fs from "node:fs";
import pg from "pg";
for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const keys = JSON.parse(process.env.EMAILBISON_KEYS);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows } = await pool.query(
  `SELECT DISTINCT lower(email) AS email FROM push_items
    WHERE batch_id IN ('abf16eaf-deca-4342-b034-15056f9bb979', 'ae8f1f03-17ac-4f26-ae6a-b7e083fecd6e')`);
await pool.end();
const ours = new Set(rows.map((r) => r.email));
console.log(`our emails: ${ours.size}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [domain, ids] of [
  ["personal.cleaningoutbound.com", ["430", "429", "428"]],
  ["app.outboundhero.co", ["1531", "1530", "1529"]],
]) {
  const headers = { Authorization: `Bearer ${keys[domain]}`, "Content-Type": "application/json", Accept: "application/json" };
  for (const cid of ids) {
    let toDetach = [], foreign = 0;
    let url = `https://${domain}/api/campaigns/${cid}/leads`;
    for (let page = 0; url && page < 400; page++) {
      const res = await fetch(url, { headers });
      if (!res.ok) { console.log(`  ${cid}: list fail ${res.status}`); break; }
      const j = await res.json();
      for (const l of j.data ?? []) {
        if (ours.has(String(l.email ?? "").toLowerCase())) toDetach.push(l.id);
        else foreign++;
      }
      url = typeof j?.links?.next === "string" ? j.links.next : null;
      await sleep(150);
    }
    let removed = 0;
    for (let i = 0; i < toDetach.length; i += 100) {
      const chunk = toDetach.slice(i, i + 100);
      const res = await fetch(`https://${domain}/api/campaigns/${cid}/leads`, {
        method: "DELETE", headers, body: JSON.stringify({ lead_ids: chunk }),
      });
      if (res.ok) removed += chunk.length;
      await sleep(200);
    }
    const check = await fetch(`https://${domain}/api/campaigns/${cid}`, { headers });
    const left = (await check.text()).match(/"total_leads":\s*(\d+)/)?.[1];
    console.log(`campaign ${cid} (${domain}): detached ${removed}, foreign kept ${foreign}, total_leads now ${left}`);
  }
}
console.log("sweep done");
