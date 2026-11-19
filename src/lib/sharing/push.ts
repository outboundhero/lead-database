import type { Pool, PoolClient } from "pg";
import { flagOn, normTag, settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import { scoringStatusFor } from "../../../scripts/lib/enrich/fit-push.mjs";
import { PUSH_BATCH_MAX_IDS, PUSH_SOURCE_SHARE, PUSH_SOURCE_TOPUP } from "../../../scripts/lib/overlap-topup.mjs";
import { searchClientCampaigns, type BisonCampaignRow } from "@/lib/bison/client-campaigns";
import { sidesOfLeads, type PushSide } from "@/lib/bison/push-stamp";
import { sharingTx } from "./db";
import { pickShareCampaigns, type ShareCampaign } from "./pick";
import type { SharePushAnswer, SharePushRefusal } from "./types";

// The share push (plan 1.8): one receiving client's queued shares into its
// campaigns. Called by POST /api/sharing/push/auto (the enrich-worker's push
// timer, at most once every push_every_minutes per client) and by the Sharing
// page's "Push shared" (POST /api/sharing/push).
//
// Rows: applied, live lead_shares rows of the client with outcome shared or
// own_topup and push_state queued; with retryHeld also held rows whose
// held_since is within held_retry_days (the worker asks that once a day).
//
//   - sharing switched off: 409, nothing changes (the rows stay queued);
//   - the client cannot receive (fn_client_receive_block, 132) or is not on
//     the push list (flagOn "share_push"): the rows are held with that reason;
//   - the client's campaigns are read live with the export popup's client
//     search (src/lib/bison/client-campaigns.ts). Any error, "partial"
//     included, is a 409 and nothing changes: a list missing one install
//     would send that install's leads nowhere, or to the other side;
//   - the pick (src/lib/sharing/pick.ts): Active or Draft only, then the
//     popup's all-or-none pre-selection. Nothing picked: every row held with
//     the pick's reason. A side with no picked campaign: its leads held ("no
//     B2C campaign"), the other side's pushed;
//   - leads the Bison mirror shows in the picked campaigns are dropped
//     (in_campaign), as the push forecast finds them
//     (src/app/api/bison/push-forecast/route.ts); a lead that is gone or has
//     no email is dropped too (no_lead);
//   - the rest go into push_batches, one per source ("share" or "topup", for
//     own_topup rows) and side, at most PUSH_BATCH_MAX_IDS ids each, with
//     push_options { source, skipAlreadySent: true } and the status the fit
//     gate gives (scoringStatusFor). The same transaction marks exactly those
//     rows pushed with their batch, so a row is pushed at most once, and an
//     empty id list is never inserted (it would gather the client's whole
//     backlog, scripts/push-worker.mjs).
//
// Every read and write of the rows happens in ONE transaction under
// pg_advisory_xact_lock(hashtext('share-push:' || receiver)), so two calls for
// one client never push the same rows. The live campaign search runs before
// that transaction (a Bison read can take a minute, and a transaction must not
// sit open across it); the transaction reads the switch, the receive rule and
// the rows again under the lock.

/** At most this many rows are taken in one call; the rest stay queued for the next. */
export const PUSH_ROWS_PER_CALL = 4 * PUSH_BATCH_MAX_IDS;
/** Ids per Bison mirror statement. */
const MIRROR_CHUNK = 5000;
/** A held row's note when its client is off the push list. */
export const NOT_ON_PUSH_LIST = "not on the push list";

export type CampaignReader = (tag: string) => Promise<{ data: BisonCampaignRow[]; errors: string[] }>;

export type SharePushResult = { status: 200; body: SharePushAnswer } | { status: 409; body: SharePushRefusal };

type Row = { id: string; lead_id: string; outcome: "shared" | "own_topup" };

/** The rows of one receiver a push takes. $1 the tag, $2 retryHeld, $3 held_retry_days. */
const ROWS_WHERE = `s.receiver_tag = $1
   AND s.applied_at IS NOT NULL AND s.undone_at IS NULL
   AND s.outcome IN ('shared', 'own_topup')
   AND (s.push_state = 'queued'
        OR ($2::boolean AND s.push_state = 'held' AND s.held_since > now() - make_interval(days => $3::int)))`;

async function readSwitch(c: PoolClient) {
  const { rows } = await c.query(`SELECT key, value FROM enrich_settings WHERE key = 'overlap_sharing'`);
  return settingsFrom(rows);
}

async function receiveBlock(c: PoolClient, tag: string): Promise<string | null> {
  const { rows } = await c.query(`SELECT public.fn_client_receive_block($1) AS block`, [tag]);
  return (rows[0]?.block as string | null) ?? null;
}

async function queuedLeft(c: PoolClient, tag: string): Promise<number> {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n FROM lead_shares s
      WHERE s.receiver_tag = $1 AND s.push_state = 'queued' AND s.applied_at IS NOT NULL AND s.undone_at IS NULL
        AND s.outcome IN ('shared', 'own_topup')`,
    [tag]
  );
  return rows[0]?.n ?? 0;
}

async function hold(c: PoolClient, ids: string[], note: string) {
  if (!ids.length) return;
  await c.query(
    `UPDATE lead_shares SET push_state = 'held', push_note = $2, held_since = coalesce(held_since, now()), held_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids, note]
  );
}

async function drop(c: PoolClient, ids: string[], note: string) {
  if (!ids.length) return;
  await c.query(`UPDATE lead_shares SET push_state = 'dropped', push_note = $2 WHERE id = ANY($1::bigint[])`, [ids, note]);
}

/**
 * Of these leads, the ones the Bison mirror (bison_leads.campaign_ids) shows
 * in any of these campaigns, as the push forecast checks it; and the installs
 * the mirror holds nothing for (no lead there could be checked).
 */
async function inCampaigns(c: PoolClient, leadIds: string[], campaigns: ShareCampaign[]) {
  const byInstall = new Map<string, number[]>();
  for (const cp of campaigns) {
    const id = Number(cp.id);
    if (!Number.isFinite(id)) continue;
    byInstall.set(cp.instance_url, [...(byInstall.get(cp.instance_url) ?? []), id]);
  }
  const installs = [...byInstall.keys()];
  const { rows: cov } = await c.query(
    `SELECT i.instance_url FROM unnest($1::text[]) AS i(instance_url)
      WHERE EXISTS (SELECT 1 FROM bison_leads b WHERE b.instance_url = i.instance_url)`,
    [installs]
  );
  const covered = new Set(cov.map((r) => r.instance_url as string));
  const uncovered = installs.filter((i) => !covered.has(i));
  const hits = new Set<string>();
  if (!covered.size || !leadIds.length) return { hits, uncovered };
  const params: unknown[] = [null];
  const clauses: string[] = [];
  for (const [inst, ids] of byInstall) {
    if (!covered.has(inst)) continue;
    params.push(inst, ids);
    clauses.push(`(b.instance_url = $${params.length - 1} AND b.campaign_ids && $${params.length}::bigint[])`);
  }
  for (let i = 0; i < leadIds.length; i += MIRROR_CHUNK) {
    params[0] = leadIds.slice(i, i + MIRROR_CHUNK);
    const { rows } = await c.query(
      `SELECT l.id FROM leads l
        WHERE l.id = ANY($1::uuid[])
          AND EXISTS (SELECT 1 FROM bison_leads b WHERE b.email = l.email AND (${clauses.join(" OR ")}))`,
      params
    );
    for (const r of rows) hits.add(r.id as string);
  }
  return { hits, uncovered };
}

const sideName = (s: PushSide) => (s === "b2c" ? "B2C" : "B2B");
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/**
 * Pushes one receiving client's queued shares (see the note at the top).
 *
 * @param pool the web app's pg pool
 * @param opts.receiver the receiving client's tag
 * @param opts.retryHeld also take held rows still inside held_retry_days
 * @param opts.readCampaigns the live campaign read; tests pass a stand-in
 */
export async function pushReceiverShares(
  pool: Pool,
  { receiver, retryHeld = false, readCampaigns = searchClientCampaigns }: { receiver: string; retryHeld?: boolean; readCampaigns?: CampaignReader }
): Promise<SharePushResult> {
  const tag = normTag(receiver);
  const answer = (o: Partial<SharePushAnswer>): SharePushResult => ({
    status: 200,
    body: { receiver: tag, pushed: 0, batches: [], held: 0, dropped: 0, left: 0, note: null, ...o },
  });

  // Before the campaign search: is there anything to do, and may it be done?
  const first = await sharingTx(
    pool,
    async (c) => {
      const settings = await readSwitch(c);
      const block = await receiveBlock(c, tag);
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM lead_shares s WHERE ${ROWS_WHERE}`, [
        tag, retryHeld, settings.overlap_sharing.held_retry_days,
      ]);
      return { settings, block, rows: (rows[0]?.n as number) ?? 0 };
    },
    { readOnly: true, timeoutMs: 15_000 }
  );
  if (!first.settings.overlap_sharing.enabled) {
    return { status: 409, body: { error: "Sharing is switched off, so nothing was pushed. The shares stay queued.", kept: first.rows } };
  }
  if (first.rows === 0) return answer({ note: "nothing to push" });

  const holdFirst = first.block ? `cannot receive: ${first.block}` : flagOn(first.settings, "share_push", tag) ? null : NOT_ON_PUSH_LIST;
  let campaigns: BisonCampaignRow[] | null = null;
  if (!holdFirst) {
    let read: { data: BisonCampaignRow[]; errors: string[] };
    try {
      read = await readCampaigns(tag);
    } catch (e) {
      read = { data: [], errors: [e instanceof Error ? e.message : String(e)] };
    }
    if (read.errors.length) {
      return {
        status: 409,
        body: {
          error: `The campaign search for ${tag} reported an error, so nothing was pushed this round: ${read.errors.join("; ")}`,
          kept: first.rows,
        },
      };
    }
    campaigns = read.data;
  }

  return sharingTx(
    pool,
    async (c): Promise<SharePushResult> => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('share-push:' || $1))`, [tag]);
      const settings = await readSwitch(c);
      const heldDays = settings.overlap_sharing.held_retry_days;
      const { rows } = await c.query<Row>(
        `SELECT s.id::text AS id, s.lead_id::text AS lead_id, s.outcome
           FROM lead_shares s WHERE ${ROWS_WHERE}
          ORDER BY s.id LIMIT $4 FOR UPDATE OF s`,
        [tag, retryHeld, heldDays, PUSH_ROWS_PER_CALL]
      );
      if (!settings.overlap_sharing.enabled) {
        return { status: 409, body: { error: "Sharing is switched off, so nothing was pushed. The shares stay queued.", kept: rows.length } };
      }
      if (!rows.length) return answer({ note: "nothing to push", left: await queuedLeft(c, tag) });
      const ids = rows.map((r) => r.id);

      const block = await receiveBlock(c, tag);
      const why = block ? `cannot receive: ${block}` : flagOn(settings, "share_push", tag) ? null : NOT_ON_PUSH_LIST;
      if (why) {
        await hold(c, ids, why);
        return answer({ held: ids.length, note: why, left: await queuedLeft(c, tag) });
      }
      if (!campaigns) {
        // The client could not receive when this round began, and can now: the next round reads its campaigns.
        return answer({ note: "the client can receive again; the next round pushes", left: await queuedLeft(c, tag) });
      }

      const { rows: [ct] } = await c.query(`SELECT b2b_instance, b2c_instance FROM client_tags WHERE tag = $1`, [tag]);
      const pick = pickShareCampaigns(campaigns, tag, ct ?? null);
      if (pick.blocked) {
        await hold(c, ids, pick.blocked);
        return answer({ held: ids.length, note: pick.blocked, left: await queuedLeft(c, tag) });
      }

      // Each lead to its own side; a side with no picked campaign holds its leads.
      const sides = await sidesOfLeads(c, [...new Set(rows.map((r) => r.lead_id))]);
      const gone = rows.filter((r) => !sides.has(r.lead_id));
      const heldBySide: Record<PushSide, string[]> = { b2b: [], b2c: [] };
      const kept: Array<Row & { side: PushSide }> = [];
      for (const r of rows) {
        const side = sides.get(r.lead_id);
        if (!side) continue;
        if (pick.bySide[side].length === 0) heldBySide[side].push(r.id);
        else kept.push({ ...r, side });
      }
      await drop(c, gone.map((r) => r.id), "no_lead");
      for (const side of ["b2b", "b2c"] as const) await hold(c, heldBySide[side], `no ${sideName(side)} campaign`);

      // Leads already in the picked campaigns, by the Bison mirror.
      const picked = [...pick.bySide.b2b, ...pick.bySide.b2c];
      const { hits, uncovered } = await inCampaigns(c, [...new Set(kept.map((r) => r.lead_id))], picked);
      const inCampaign = kept.filter((r) => hits.has(r.lead_id));
      await drop(c, inCampaign.map((r) => r.id), "in_campaign");
      const toPush = kept.filter((r) => !hits.has(r.lead_id));

      // One batch per source and side, at most PUSH_BATCH_MAX_IDS ids each.
      const batches: string[] = [];
      if (toPush.length) {
        const status = await scoringStatusFor(c, tag);
        const { rows: [tm] } = await c.query(
          `SELECT countries, include_locations, exclude_locations, exclude_industries, exclude_keywords, require_location,
                  allow_inferred_location, commercial_cleaning
             FROM client_targeting WHERE client_tag = $1`,
          [tag]
        );
        const placed = new Map<string, string>(); // lead id -> the batch it went into
        for (const source of [PUSH_SOURCE_SHARE, PUSH_SOURCE_TOPUP] as const) {
          for (const side of ["b2b", "b2c"] as const) {
            const group = toPush.filter((r) => (r.outcome === "own_topup" ? PUSH_SOURCE_TOPUP : PUSH_SOURCE_SHARE) === source && r.side === side);
            if (!group.length) continue;
            const fresh = [...new Set(group.map((r) => r.lead_id).filter((id) => !placed.has(id)))];
            for (let i = 0; i < fresh.length; i += PUSH_BATCH_MAX_IDS) {
              const slice = fresh.slice(i, i + PUSH_BATCH_MAX_IDS);
              const { rows: [b] } = await c.query(
                `INSERT INTO push_batches (created_by, campaigns, filters, target_market, selected_ids, client_tag, email_side, push_options, status)
                 VALUES (NULL, $1::jsonb, NULL, $2::jsonb, $3::uuid[], $4, $5, $6::jsonb, $7)
                 RETURNING id`,
                [
                  JSON.stringify(pick.bySide[side]),
                  tm ? JSON.stringify(tm) : null,
                  slice,
                  tag,
                  side,
                  JSON.stringify({ source, skipAlreadySent: true }),
                  status,
                ]
              );
              batches.push(b.id as string);
              for (const id of slice) placed.set(id, b.id as string);
            }
            // Every row of the group, a lead that went into an earlier batch included, is marked with its batch.
            const byBatch = new Map<string, string[]>();
            for (const r of group) {
              const batch = placed.get(r.lead_id)!;
              const list = byBatch.get(batch);
              if (list) list.push(r.id);
              else byBatch.set(batch, [r.id]);
            }
            for (const [batch, shareIds] of byBatch) {
              await c.query(
                `UPDATE lead_shares SET push_state = 'pushed', push_batch_id = $2, pushed_at = now(), push_note = NULL
                  WHERE id = ANY($1::bigint[])`,
                [shareIds, batch]
              );
            }
          }
        }
      }

      const heldRows = heldBySide.b2b.length + heldBySide.b2c.length;
      const notes: string[] = [];
      if (heldBySide.b2c.length) notes.push(`${plural(heldBySide.b2c.length, "lead")} held: no B2C campaign`);
      if (heldBySide.b2b.length) notes.push(`${plural(heldBySide.b2b.length, "lead")} held: no B2B campaign`);
      if (inCampaign.length) notes.push(`${plural(inCampaign.length, "lead")} already in the picked campaigns`);
      if (gone.length) notes.push(`${plural(gone.length, "lead")} gone or with no email`);
      if (uncovered.length) notes.push(`the Bison mirror holds nothing for ${uncovered.join(", ")}, so leads already in campaigns there could not be left out`);
      return answer({
        pushed: toPush.length,
        batches,
        held: heldRows,
        dropped: inCampaign.length + gone.length,
        left: await queuedLeft(c, tag),
        note: notes.length ? notes.join("; ") : null,
      });
    },
    { timeoutMs: 120_000 }
  );
}
