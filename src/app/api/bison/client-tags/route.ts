import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import type { ClientTagRow } from "@/lib/clients/roster";

// GET /api/bison/client-tags: the client list (client_tags, migration 053), each client with its cached
// contactable count (client_stats). Every client dropdown reads it through one cached list
// (src/lib/clients/roster.ts: fetched once, kept per signed-in user, refreshed in the background). The
// Send-to-Bison wizard also needs each tag's b2b_instance / b2c_instance (the two Bison installs the
// split routes to) and the `churned` flag; the Uploads page's People send, the name.
//
// The session is checked first (auth.getUser, as before). Then ONE statement through the shared pg
// pool, autocommit and no SET, where two supabase-js reads used to cost two more HTTP round trips: the
// statement itself takes under a millisecond. The table's RLS policy lets every signed-in user read
// every row, so the pool's role reads what the session did. Server-Timing says where the time went:
// auth (the session check), db (the statement), total.

export type { ClientTagRow };

const ROSTER_SQL = `SELECT t.tag, t.name, t.group_no, t.b2b_instance, t.b2c_instance, t.owner, t.status, t.client_type, s.contactable
  FROM client_tags t LEFT JOIN client_stats s ON s.tag = t.tag
 ORDER BY t.tag`;

type RosterRow = {
  tag: string;
  name: string | null;
  group_no: number | null;
  b2b_instance: string | null;
  b2c_instance: string | null;
  owner: string | null;
  status: string | null;
  client_type: string | null;
  contactable: string | number | null; // bigint: pg gives a string; null without a client_stats row
};

const ms = (n: number) => n.toFixed(1);

/** Every answer's headers: where the time went, and never cached anywhere. */
function headers(authMs: number, dbMs: number, started: number): Record<string, string> {
  return {
    "Server-Timing": `auth;dur=${ms(authMs)}, db;dur=${ms(dbMs)}, total;dur=${ms(performance.now() - started)}`,
    "Cache-Control": "private, no-store",
  };
}

export async function GET() {
  const started = performance.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const authMs = performance.now() - started;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: headers(authMs, 0, started) });
  }

  const dbStarted = performance.now();
  let rows: RosterRow[];
  try {
    rows = (await getPool().query<RosterRow>(ROSTER_SQL)).rows;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: headers(authMs, performance.now() - dbStarted, started) },
    );
  }
  const dbMs = performance.now() - dbStarted;

  const tags: ClientTagRow[] = rows.map((r) => ({
    tag: r.tag,
    name: r.name ?? null,
    group_no: r.group_no ?? null,
    b2b_instance: r.b2b_instance ?? null,
    b2c_instance: r.b2c_instance ?? null,
    owner: r.owner ?? null,
    status: r.status ?? null,
    client_type: r.client_type ?? null,
    // "Confirmed Churn", "Churned", etc.
    churned: typeof r.status === "string" && r.status.toLowerCase().includes("churn"),
    // Only clients with an instance mapping can actually receive a push.
    sendable: !!r.b2b_instance || !!r.b2c_instance,
    // client_stats.contactable is NOT NULL: null here means the client has no stats row.
    contactable: r.contactable == null ? null : Number(r.contactable),
  }));

  // Sendable + active first; churned/unmapped sink to the bottom.
  tags.sort((a, b) => {
    const rank = (t: ClientTagRow) => (t.sendable ? 0 : 1) + (t.churned ? 1 : 0);
    return rank(a) - rank(b) || a.tag.localeCompare(b.tag);
  });

  return NextResponse.json({ tags }, { headers: headers(authMs, dbMs, started) });
}
