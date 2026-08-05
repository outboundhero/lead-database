// One-off: queue the CWSJ-OS routed test push (client request 2026-08-05).
// Loads the "CWSJ-OS" saved search, converts it to the RPC filter shape with
// the app's own transform, and queues TWO batches exactly as the wizard would:
//   b2c -> personal.cleaningoutbound.com  430 SEGs / 429 Outlook / 428 Google+Custom
//   b2b -> app.outboundhero.co            1531 SEGs / 1530 Outlook / 1529 Google+Custom
// Campaigns carry routing buckets, so the deployed push-worker attaches each
// lead ONLY to the campaign matching its email provider.
import fs from "node:fs";
import pg from "pg";
import { buildRpcFilters, normalizeFilterState } from "./tmp-rpc-filters.mjs";

for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const { rows: [preset] } = await pool.query(`SELECT filters FROM filter_presets WHERE name = 'CWSJ-OS'`);
if (!preset) { console.error("Preset CWSJ-OS not found"); process.exit(1); }
const rpc = buildRpcFilters(normalizeFilterState(preset.filters));

const SIDES = [
  {
    side: "b2c",
    campaigns: [
      { id: 430, name: "CWSJ-OS: SEGs (Cleaning Client)", instance_url: "personal.cleaningoutbound.com", bucket: "seg" },
      { id: 429, name: "CWSJ-OS: Outlook (Cleaning Client)", instance_url: "personal.cleaningoutbound.com", bucket: "outlook" },
      { id: 428, name: "CWSJ-OS: Google + Custom (Cleaning Client)", instance_url: "personal.cleaningoutbound.com", bucket: "default" },
    ],
  },
  {
    side: "b2b",
    campaigns: [
      { id: 1531, name: "CWSJ-OS: SEGs (Non-Cleaning Client)", instance_url: "app.outboundhero.co", bucket: "seg" },
      { id: 1530, name: "CWSJ-OS: Outlook (Non-Cleaning Client)", instance_url: "app.outboundhero.co", bucket: "outlook" },
      { id: 1529, name: "CWSJ-OS: Google + Custom (Non-Cleaning Client)", instance_url: "app.outboundhero.co", bucket: "default" },
    ],
  },
];

for (const s of SIDES) {
  const p_filters = { ...rpc, emailSide: s.side, applyClientTargeting: "CWSJ-OS" };
  const { rows: [b] } = await pool.query(
    `INSERT INTO push_batches (campaigns, filters, client_tag, email_side, push_options, status)
     VALUES ($1::jsonb, $2::jsonb, 'CWSJ-OS', $3, '{"includeAlreadyPushed": false}'::jsonb, 'pending')
     RETURNING id`,
    [JSON.stringify(s.campaigns), JSON.stringify(p_filters), s.side]
  );
  console.log(`queued ${s.side} batch ${b.id} -> ${s.campaigns.map((c) => c.name).join(" | ")}`);
}
await pool.end();
console.log("Both batches queued — the Railway push-worker picks them up within seconds.");
