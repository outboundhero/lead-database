#!/usr/bin/env node
import "dotenv/config";
/**
 * Refresh dashboard snapshot via the fn_dashboard_stats SQL RPC.
 * The RPC does proper SQL GROUP BY aggregations against the full leads table
 * (no sampling), and writes today's row to dashboard_snapshots.
 *
 * The cron job fn_refresh_dashboard_cron() runs the same logic + ANALYZE daily
 * at 2 AM UTC. Use this script to manually trigger an immediate refresh.
 *
 * Usage: node scripts/refresh-dashboard.mjs
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: { schema: "public" },
});

const today = new Date().toISOString().split("T")[0];
console.log(`\n🔄 Refreshing dashboard snapshot for ${today}...\n`);

const start = Date.now();
const { error } = await supabase.rpc("fn_dashboard_stats");

if (error) {
  console.error(`❌ Failed: ${error.message}`);
  process.exit(1);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`✅ Snapshot refreshed in ${elapsed}s\n`);
