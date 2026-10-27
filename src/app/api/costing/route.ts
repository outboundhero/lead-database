import { NextRequest, NextResponse } from "next/server";
import { getCostingPool } from "@/lib/costing/db";
import { costingKeyStatus, FeedIntegrityError, parsePeriod, queryFeed } from "@/lib/costing/feed";

// GET /api/costing?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Authorization: Bearer <COSTING_API_KEY>
//
// This product's exact costs for ReplyRouter's Costing section ("Costing feed —
// spec for product endpoints v1.0"). Reads the stored cost table only
// (cost_line_items, migration 121) — no provider calls here. Excluded from the
// session middleware: the Bearer key is the only auth.
//   400 bad range · 401 wrong/missing key · 500 anything else (incl. a missing
//   server key, a feed that would not add up, or no answer within 9 s).

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// statement_timeout only runs while Postgres is executing a statement. A
// connection that goes silent (half-open TCP to the pooler) would otherwise hold
// the request — and one of the pool's two connections — indefinitely. Counted
// from the start of the request, so the wait for a connection (at most 5 s,
// src/lib/costing/db.ts) comes out of it.
const DEADLINE_MS = 9_000;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function GET(req: NextRequest) {
  const started = Date.now();
  const key = costingKeyStatus(req.headers.get("authorization"), process.env.COSTING_API_KEY);
  if (key === "not_configured") {
    console.error("Costing feed: COSTING_API_KEY is not set (or shorter than 32 characters)");
    return json({ error: "costing feed is not configured" }, 500);
  }
  if (key === "unauthorized") return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

  const now = new Date();
  const period = parsePeriod(req.nextUrl.searchParams, now);
  if ("error" in period) return json({ error: period.error }, 400);

  const client = await getCostingPool().connect().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  if (client instanceof Error) {
    console.error("Costing feed: no database connection:", client.message);
    return json({ error: "database unavailable" }, 500);
  }
  // A checked-out client emits 'error' when the server drops the connection, and
  // with no listener that is an uncaught exception. The pending query fails with
  // the same error, which the catch below turns into a 500.
  const onClientError = (e: Error) => console.error("Costing feed: connection lost:", e.message);
  client.on("error", onClientError);
  // Releasing with an error makes the pool destroy the socket, which fails the
  // pending query into the catch below. `released` guards against a second
  // release (pg-pool throws on one).
  let released = false, timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = released = true;
    client.release(new Error("costing feed deadline"));
  }, Math.max(0, DEADLINE_MS - (Date.now() - started)));
  try {
    // One snapshot for the items and their totals, so they always agree.
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout = '8s'");
    const feed = await queryFeed(client, period, now, process.env.COSTING_ENVIRONMENT || "production");
    await client.query("COMMIT");
    return new NextResponse(JSON.stringify(feed), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (!released) await client.query("ROLLBACK").catch(() => {});
    console.error("Costing feed error:", err);
    const code = (err as { code?: string } | null)?.code;
    if (err instanceof FeedIntegrityError) return json({ error: `costing feed failed its own check: ${err.message}` }, 500);
    if (timedOut || code === "57014") return json({ error: "costing feed timed out" }, 500);
    return json({ error: "costing feed failed" }, 500);
  } finally {
    clearTimeout(deadline);
    client.off("error", onClientError);
    if (!released) client.release();
  }
}
