import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { withTx } from "@/lib/enrich/db";
import {
  chunkClientName,
  INTAKE_MAX_BYTES,
  isChunk,
  isTestCall,
  MAPS_TABLE_NAME,
  mapsDelivery,
  mapsTableFor,
  placeRowKey,
  readBodyCapped,
  releaseIntakeSlot,
  takeIntakeSlot,
} from "@/lib/enrich/gmaps";
import { checkName, INTAKE_ANSWERS, isPassingDbError, isToken, normName, REFUSED_NOTES } from "@/lib/enrich/inbound";
import { insertRows } from "@/lib/enrich/insert-rows";
import { locationFilterEcho } from "../../../../../../scripts/lib/enrich/maps-place.mjs";

// POST /api/enrich/intake/<token>: Google Maps places from the GMaps Scraper
// app, one chunk at a time, for the client whose inbound URL this is
// (migration 129). Managers make, show, rotate and revoke the URLs on the Clay
// tab (Inbound URLs, /api/enrich/inbound).
//
// The token is the only auth and decides the client: the session middleware
// lets every path under /api/enrich/intake through (src/middleware.ts), and
// the scraper app sends no other header than Content-Type. The chunk's client
// name (extra.client) must fit the URL's client, or nothing is stored.
//
// Places land in the client's Companies (pipeline) table as held rows. No
// provider is called here, and the worker starts held rows only while the
// client is on the Company pulls switch. A 2xx comes only after the commit,
// so the scraper app may forget a chunk once it has one.
//
// A chunk may carry a location filter (extra.location_filter, migration 139;
// the contract is in src/lib/enrich/gmaps.ts): it is stored, never a reason to
// refuse. A Test that sends one at the top level is told whether it would be
// kept: { location_filter: { accepted, version, note } }.
//
// The answers, and what the scraper app does with each (gmaps-UI src/lib/clay-pool.ts):
//   200  stored now, or a delivery seen before, or a Test    deletes its copy; Test passes
//   404  a malformed, unknown or revoked token               disables the URL for good
//   413  a body over 5 MB                                    one try used
//   422  not JSON, or no postbackData.tasks list             one try used
//   429  no slot within 2 s, or a passing database problem;
//        a client name that doesn't fit, or none; the
//        client's Companies table can't be made              no try used: the chunk waits
//   500  anything else                                       one try used
// Never 410. No answer holds the scraper app's "full" phrases, the chunk's
// client name or the token, and no log line holds the token, a URL or a body.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Answer = { status: number; body: Record<string, unknown> };

const reply = ({ status, body }: Answer) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, error: string): Answer => ({ status, body: { error } });

/** An error for the log: its kind, code and message, with the token cut out, never the body. */
function errorSummary(err: unknown, token: string): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message.split(token).join("<token>").slice(0, 300) : "";
  return `${typeof e?.name === "string" ? e.name : "Error"}${typeof e?.code === "string" ? ` ${e.code}` : ""}: ${message}`;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isToken(token)) return reply(refuse(404, INTAKE_ANSWERS.unknown));
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > INTAKE_MAX_BYTES) return reply(refuse(413, INTAKE_ANSWERS.tooLarge));
  let raw: string | null;
  try {
    raw = await readBodyCapped(req);
  } catch (err) {
    console.error("Enrich intake: the body could not be read:", errorSummary(err, token));
    return reply(refuse(500, INTAKE_ANSWERS.failed));
  }
  if (raw === null) return reply(refuse(413, INTAKE_ANSWERS.tooLarge));
  const text = raw;

  if (!(await takeIntakeSlot())) return reply(refuse(429, INTAKE_ANSWERS.busy));
  try {
    return reply(await withTx((c) => receive(c, token, text), { timeoutMs: 15_000 }));
  } catch (err) {
    if (isPassingDbError(err)) return reply(refuse(429, INTAKE_ANSWERS.busy));
    console.error("Enrich intake failed:", errorSummary(err, token));
    return reply(refuse(500, INTAKE_ANSWERS.failed));
  } finally {
    releaseIntakeSlot();
  }
}

/** One delivery, inside its transaction. A refusal notes why on the URL and commits that note; nothing else is written. */
async function receive(c: PoolClient, token: string, raw: string): Promise<Answer> {
  const { rows: [url] } = await c.query<{ id: string; client_tag: string; accepted_names: string[] | null; revoked: boolean }>(
    `SELECT id, client_tag, accepted_names, revoked_at IS NOT NULL AS revoked FROM enrich_inbound_urls WHERE token = $1`,
    [token]
  );
  if (!url) return refuse(404, INTAKE_ANSWERS.unknown);
  const note = (why: string, refusedName?: string | null) =>
    refusedName === undefined
      ? c.query(`UPDATE enrich_inbound_urls SET last_refused = $2, last_refused_at = now() WHERE id = $1`, [url.id, why])
      : c.query(`UPDATE enrich_inbound_urls SET last_refused = $2, last_refused_at = now(), refused_name = $3 WHERE id = $1`, [url.id, why, refusedName]);
  if (url.revoked) {
    await note(REFUSED_NOTES.revoked);
    return refuse(404, INTAKE_ANSWERS.unknown);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    await note(REFUSED_NOTES.notJson);
    return refuse(422, INTAKE_ANSWERS.notChunk);
  }
  const tag = url.client_tag;
  const accepted = url.accepted_names ?? [];

  // The scraper app's Test: notes when and with what name (it sends none today), makes nothing.
  if (isTestCall(body)) {
    const sent = (body as Record<string, unknown>).client;
    await c.query(`UPDATE enrich_inbound_urls SET last_test_at = now(), last_test_name = $2 WHERE id = $1`, [url.id, normName(sent) || null]);
    const { rows: [s] } = await c.query<{ on: boolean }>(`SELECT public.fn_enrich_company_switch_on($1) AS on`, [tag]);
    const answer: Record<string, unknown> = { ok: true, test: true, client_tag: tag, table: MAPS_TABLE_NAME, switched_on: s?.on === true };
    if (sent !== undefined) {
      const fit = checkName(sent, tag, accepted);
      answer.name_check = { fits: fit.ok, how: fit.how };
    }
    // A location filter sent with the Test: would it be kept? Nothing is stored.
    if (Object.hasOwn(body as object, "location_filter")) answer.location_filter = locationFilterEcho((body as Record<string, unknown>).location_filter);
    return { status: 200, body: answer };
  }

  if (!isChunk(body)) {
    await note(REFUSED_NOTES.notChunk);
    return refuse(422, INTAKE_ANSWERS.notChunk);
  }
  const fit = checkName(chunkClientName(body), tag, accepted);
  if (!fit.ok) {
    await note(fit.name === null ? REFUSED_NOTES.noName : REFUSED_NOTES.nameMismatch, fit.name);
    return refuse(429, INTAKE_ANSWERS.nameMismatch);
  }
  const table = await mapsTableFor(c, tag);
  if (!table) {
    await note(REFUSED_NOTES.notReady);
    return refuse(429, INTAKE_ANSWERS.notReady);
  }

  const delivery = mapsDelivery(body, tag, fit.how);
  const out = await insertRows(c, {
    tableId: table.id,
    inputKeys: table.inputKeys,
    rows: delivery.rows,
    runStatus: "held",
    rowKey: (inputs) => placeRowKey(inputs.place_id),
    inboundUrlId: url.id,
    source: { kind: "maps", externalId: delivery.chunkId, label: delivery.label, meta: delivery.meta },
  });
  await c.query(
    `UPDATE enrich_inbound_urls SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [url.id]
  );
  return {
    status: 200,
    body: {
      ok: true,
      client_tag: tag,
      received: out.received,
      created: out.created,
      duplicates: out.duplicates,
      skipped: out.skipped,
      duplicate_delivery: out.duplicateDelivery,
      held: true,
    },
  };
}
