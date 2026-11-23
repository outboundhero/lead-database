import { after } from "next/server";
import { enrichPool, withTx } from "@/lib/enrich/db";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { importRows, type ImportCounters } from "@/lib/uploads/import-rows";
import {
  beginPromote,
  finishPromote,
  PROMOTE_COLUMNS,
  PROMOTE_EXTRA_FIELDS,
  PROMOTE_STALE_HOURS,
  promotionAllowed,
} from "../../../scripts/lib/enrich/promote.mjs";
import { pushColumnsReady } from "../../../scripts/lib/enrich/promote-push.mjs";
import { readFitSettings } from "@/lib/companies/fit";
import type { PromoteKind } from "./fit-types";

// Pipeline emails into leads (2B.5; switch promotion.promote_to_leads with its
// client list, on the Companies tab's settings sheet, shipped OFF and covering
// no client). As the AI Ark add does (src/lib/aiark/add-run.ts):
// one round per client at a time (an advisory lock on the client), the
// contacts that may be promoted taken in one query (scripts/lib/enrich/promote.mjs),
// those the database already holds settled at once, the rest imported through
// the Uploads page's engine as one upload batch per kind (duplicates skipped,
// never merged, the client's tag added, the pipeline's source label), then
// each contact settled, with 3 tries. A round is two batches, inboxes then
// people, at most promotion.batch_max (1,000) contacts each. The answer comes
// as soon as the batches exist; the imports run after it (Next `after()`).
//
// Refused while promotion is off or the client is not on its list, and while a
// batch of the client is still being imported. Fit scoring is not needed (kept
// for v2, switched off): no rule, model, gate or score is asked for.
//
// While the automatic push is on for the client (promotion.auto_push,
// migration 140), each contact a batch settles as a lead it made is queued for
// the push into the client's campaigns (scripts/lib/enrich/promote-push.mjs,
// src/lib/companies/promote-push.ts). A batch's final status is written only
// after its contacts are settled: until then it is live, so another round
// never retakes them and settles them as already in the database, and the
// push never takes a round that is still being settled.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KINDS: PromoteKind[] = ["general", "person"];
const KIND_WORD: Record<PromoteKind, string> = { general: "general inboxes", person: "people" };

interface Started {
  kind: PromoteKind;
  batchId: string;
  batchAt: string;
  filename: string;
  rows: string[][];
  contacts: Array<{ row_id: number; table_id: string; email: string }>;
}

export async function startPromote({
  tag,
  kind = null,
  userId,
  automatic = false,
}: {
  tag: string;
  kind?: PromoteKind | null;
  userId: string | null;
  automatic?: boolean;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const kinds = kind ? [kind] : KINDS;
  let out:
    | { error: string; status: number }
    | {
        started: Started[];
        settled: number;
        refused: number;
        held: Record<string, number>;
        busy: PromoteKind[];
        label: string;
        queuePush: boolean;
        pushOff: string | null;
      };
  try {
    out = await withTx(
      async (c) => {
        // One round per client at a time: a second press waits here, then finds the first under way.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('company-promote:' || $1))`, [tag]);
        const settings = await readFitSettings(c);
        const allowed = promotionAllowed(settings, tag);
        if (!allowed.ok) return { status: 409, error: `${allowed.why}. Nothing was promoted.` };
        // Batches that never got a final status (a restart) are dead, as the Uploads page treats them.
        await c.query(
          `UPDATE upload_batches SET status = 'error', error_log = $1::jsonb, completed_at = now()
            WHERE status = 'processing' AND created_at < now() - make_interval(hours => $2)
              AND id IN (SELECT batch_id FROM enrich_contacts WHERE client_tag = $3 AND promote_state = 'running')`,
          [
            JSON.stringify([`Stalled: no final status after ${PROMOTE_STALE_HOURS} hours (server restarted?). Rows imported before that point are kept.`]),
            PROMOTE_STALE_HOURS,
            tag,
          ]
        );
        const started: Started[] = [];
        const busy: PromoteKind[] = [];
        const held: Record<string, number> = {};
        let settled = 0;
        let refused = 0;
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        for (const k of kinds) {
          const filename = `Companies pipeline · ${tag} · ${KIND_WORD[k]} · ${stamp} UTC`;
          const begun = await beginPromote(c, {
            tag,
            kind: k,
            userId,
            settings,
            button: !automatic,
            filename,
          });
          if (begun.busy) {
            busy.push(k);
            continue;
          }
          settled += begun.settled ?? 0;
          refused += begun.refused ?? 0;
          for (const [why, n] of Object.entries((begun.held ?? {}) as Record<string, number>)) held[why] = (held[why] ?? 0) + n;
          if (begun.batchId && begun.batchAt) {
            started.push({
              kind: k,
              batchId: begun.batchId,
              batchAt: begun.batchAt,
              filename,
              rows: begun.rows as string[][],
              contacts: begun.contacts as Started["contacts"],
            });
          }
        }
        if (busy.length === kinds.length) {
          return { status: 409, error: `${tag}'s contacts are being promoted already. Wait for that round to finish.` };
        }
        // The automatic push needs migration 140's columns: without them the round runs as before and queues nothing.
        const pushOn = settings.flagOn("promotion_push", tag);
        const queuePush = pushOn && (await pushColumnsReady(c));
        const pushOff = pushOn && !queuePush ? "the automatic push is on but migration 140 is not applied, so nothing is queued for it" : null;
        return { started, settled, refused, held, busy, label: settings.promotion.source_label, queuePush, pushOff };
      },
      { timeoutMs: 60_000 }
    );
  } catch (err) {
    console.error("companies/promote:", err);
    return { status: 500, body: { error: "Could not start promoting the client's contacts" } };
  }
  if ("error" in out) return { status: out.status, body: { error: out.error } };

  const { started, settled, refused, held, busy, label, queuePush, pushOff } = out;
  if (pushOff) console.warn(`[companies/promote] ${tag}: ${pushOff}`);
  if (started.length) {
    after(async () => {
      // Inboxes first, then people: one batch at a time, as the design's round.
      for (const b of started) await importAndSettle(tag, b, label, queuePush);
    });
  }
  const adding = started.reduce((n, b) => n + b.contacts.length, 0);
  const heldCount = Object.values(held).reduce((a, b) => a + b, 0);
  // A worker's round that found nothing to do leaves no audit row.
  if (!automatic || adding + settled + refused + heldCount > 0) await logAudit({
    action: "company_promote",
    performedBy: userId,
    details:
      `${tag}: ${automatic ? "automatic " : ""}promotion round, ${adding} to add, ${settled} already in the database, ` +
      `${refused} refused, ${heldCount} held back` +
      (started.length ? `, upload ${started.map((b) => b.batchId).join(", ")}` : "") +
      (started.length && queuePush ? ", its new leads queued for the automatic push" : "") +
      (pushOff ? `; ${pushOff}` : ""),
  });
  return {
    status: 202,
    body: {
      batches: started.map((b) => ({ kind: b.kind, batchId: b.batchId, adding: b.contacts.length })),
      adding,
      settled,
      refused,
      held,
      busy,
    },
  };
}

/**
 * One batch: the import, then each contact settled (3 tries), then the
 * batch's counters and final status. The status comes last: see the note at
 * the top.
 */
async function importAndSettle(tag: string, b: Started, label: string, queuePush: boolean) {
  let final: { counters: ImportCounters; status: "complete" | "error" } | { failed: string };
  try {
    const counters = await importRows(getPool(), b.rows, {
      batchId: b.batchId,
      filename: b.filename,
      headers: PROMOTE_COLUMNS.map(([h]) => h),
      fieldMapping: Object.fromEntries(PROMOTE_COLUMNS.map(([, k], i) => [i, k])),
      duplicateStrategy: "skip",
      overrideFields: [],
      addTags: [tag],
      extraFields: [...PROMOTE_EXTRA_FIELDS],
      onProgress: (c) => writeProgress(b.batchId, c),
    });
    const nothingLanded = counters.inserted + counters.skipped === 0;
    final = { counters, status: counters.errors > 0 && nothingLanded ? "error" : "complete" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[companies/promote] import ${b.batchId} failed: ${msg}`);
    final = { failed: msg };
  }
  // Whatever the import did, each contact's cell says so and stops reading as being added.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await finishPromote(enrichPool(), { batchId: b.batchId, batchAt: b.batchAt, contacts: b.contacts, label, queuePush });
      break;
    } catch (err) {
      console.error(`[companies/promote] settling ${b.batchId} failed: ${err instanceof Error ? err.message : err}`);
      await sleep(2_000 * attempt);
    }
  }
  if ("failed" in final) {
    await enrichPool()
      .query(`UPDATE upload_batches SET status = 'error', error_log = $2::jsonb, completed_at = now() WHERE id = $1`, [b.batchId, JSON.stringify([final.failed])])
      .catch(() => {});
  } else {
    await writeProgress(b.batchId, final.counters, final.status);
  }
}

/** The batch's counters, as the Uploads page shows them. The last write (with a status) stops its polling, so it is retried. */
async function writeProgress(batchId: string, c: ImportCounters, status?: "complete" | "error") {
  for (let attempt = 1; ; attempt++) {
    try {
      await enrichPool().query(
        `UPDATE upload_batches
            SET processed_rows = $2, inserted_rows = $3, merged_rows = $4, replaced_rows = $5, skipped_rows = $6,
                no_email_rows = $7, in_file_duplicates = $8, locations_added = $9, esp_detected = $10, error_rows = $11,
                error_log = $12::jsonb, status = coalesce($13::text, status),
                completed_at = CASE WHEN $13::text IS NULL THEN completed_at ELSE now() END
          WHERE id = $1`,
        [
          batchId, c.processed, c.inserted, c.merged, c.replaced, c.skipped, c.no_email, c.in_file_duplicates,
          c.locations_added, c.esp_detected, c.errors, c.error_log.length ? JSON.stringify(c.error_log) : null, status ?? null,
        ]
      );
      return;
    } catch (err) {
      if (!status || attempt >= 3) {
        console.error(`[companies/promote] progress write failed for ${batchId}: ${err instanceof Error ? err.message : err}`);
        return;
      }
      await sleep(2_000 * attempt);
    }
  }
}
