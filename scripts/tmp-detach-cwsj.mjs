// One-off: detach OUR July-31 leads from the CWSJ-OS draft campaigns on
// app.outboundhero.co. A single invalid (since-deleted) lead id 422s a whole
// DELETE chunk, so failing chunks bisect down to singles and skip only those.
import fs from "node:fs";
import pg from "pg";
for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const keys = JSON.parse(process.env.EMAILBISON_KEYS);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function detachChunk(domain, headers, campaignId, ids, stats) {
  if (ids.length === 0) return;
  const res = await fetch(`https://${domain}/api/campaigns/${campaignId}/leads`, {
    method: "DELETE", headers, body: JSON.stringify({ lead_ids: ids }),
  });
  await sleep(220);
  if (res.ok) { stats.removed += ids.length; return; }
  const body = await res.text();
  if (res.status === 422 && ids.length > 1) {
    const mid = Math.ceil(ids.length / 2);
    await detachChunk(domain, headers, campaignId, ids.slice(0, mid), stats);
    await detachChunk(domain, headers, campaignId, ids.slice(mid), stats);
    return;
  }
  stats.skipped += ids.length;
  if (stats.skipped <= 10) console.log(`  skip id ${ids.join(",")} -> ${res.status} ${body.slice(0, 80)}`);
}

for (const c of [
  { id: "1531", domain: "app.outboundhero.co" },
  { id: "1530", domain: "app.outboundhero.co" },
  { id: "1529", domain: "app.outboundhero.co" },
]) {
  const { rows } = await pool.query(
    `SELECT (bison_ids->>$1) AS bid FROM push_items
      WHERE batch_id = 'abf16eaf-deca-4342-b034-15056f9bb979'
        AND $2 = ANY(attached_ids) AND bison_ids ? $1`,
    [c.domain, c.id]);
  const ids = rows.map((r) => Number(r.bid)).filter(Boolean);
  const headers = { Authorization: `Bearer ${keys[c.domain]}`, "Content-Type": "application/json", Accept: "application/json" };
  const stats = { removed: 0, skipped: 0 };
  for (let i = 0; i < ids.length; i += 100) {
    await detachChunk(c.domain, headers, c.id, ids.slice(i, i + 100), stats);
    if ((i / 100) % 20 === 0) console.log(`  ${c.id}: ${i}/${ids.length}…`);
  }
  console.log(`campaign ${c.id}: detached ${stats.removed}, skipped ${stats.skipped} of ${ids.length}`);
}
await pool.end();
console.log("done");
