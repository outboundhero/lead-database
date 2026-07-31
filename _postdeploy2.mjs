const T="46d4efa5-5fb1-486e-b366-50e331999b3f", E="80ed7802-75ee-453c-a8d6-b92e233de258", S="f6967bf9-a509-4046-abed-88ec7535f13c";
for (;;) {
  const r = await fetch("https://backboard.railway.com/graphql/v2", {method:"POST",
    headers:{"Content-Type":"application/json","Project-Access-Token":T},
    body: JSON.stringify({query:`query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){ latestDeployment{ status } } }`,variables:{e:E,s:S}})}).then(r=>r.json()).catch(()=>null);
  const st = r?.data?.serviceInstance?.latestDeployment?.status;
  if (st === "SUCCESS") break;
  if (st === "FAILED" || st === "CRASHED") { console.log("DEPLOY " + st); process.exit(1); }
  await new Promise(r=>setTimeout(r, 15000));
}
const pg = (await import("pg")).default;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
await pool.query("SET statement_timeout=0");
const u = await pool.query("UPDATE push_items SET status='pending', attempts=0, error=NULL, claimed_at=NULL, claim_token=NULL WHERE status='failed'");
console.log("deploy SUCCESS; requeued", u.rowCount, "failed items");
// now watch for real progress: sent must climb, then report final counts
let lastSent = -1, stable = 0;
for (let i = 0; i < 240; i++) {
  await new Promise(r=>setTimeout(r, 30000));
  const c = await pool.query("SELECT status, count(*) n FROM push_items GROUP BY 1");
  const m = Object.fromEntries(c.rows.map(x=>[x.status, Number(x.n)]));
  const sent = m.sent ?? 0, failed = m.failed ?? 0, pending = (m.pending ?? 0) + (m.pushing ?? 0);
  if (i === 0 || sent !== lastSent || pending === 0) {
    console.log(`sent=${sent} failed=${failed} in-flight=${pending}`);
  }
  if (pending === 0) { console.log("BATCH DRAINED"); break; }
  stable = sent === lastSent ? stable + 1 : 0;
  if (stable >= 20) { console.log("STALLED: no sent progress for 10min"); break; }
  lastSent = sent;
}
await pool.end();
