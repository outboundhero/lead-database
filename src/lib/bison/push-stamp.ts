import { suggestBucketFromName, type EspBucket } from "./esp-bucket";
import { normalizeDomain } from "./keys";

// The routing a push batch carries, decided once when it is queued: each
// campaign's ESP bucket and side, and the split of a lead id list by side.
// One place for the export push route (src/app/api/bison/push-batch/route.ts)
// and the share push (src/lib/sharing/push.ts), so both route a lead the same
// way. CLAUDE.md "Campaign routing: side + bucket" explains the two axes.
//
//   bucket: from the campaign NAME ("JPCA: SEGs" is seg), unless the caller
//           gave one; a name that names no bucket gets none.
//   side:   b2b or b2c, from the campaign's install against the client's saved
//           installs (client_tags.b2b_instance, b2c_instance). A campaign on
//           neither keeps no side here; the caller sides it by its install's
//           fixed role when every install is in one group
//           (sideCampaignsByInstall, scripts/lib/bison-groups.mjs).
//   split:  a lead is B2C when its address is on a freemail domain
//           (freemail_domains), else B2B, as the push worker and
//           fn_lead_filter_conditions decide it.

export type PushSide = "b2b" | "b2c";

export interface StampableCampaign {
  name?: string;
  instance_url: string;
  bucket?: EspBucket;
  side?: PushSide;
}

export interface SavedInstalls {
  b2b_instance?: string | null;
  b2c_instance?: string | null;
}

/** Something that runs a query: a pg Pool or a client inside a transaction. */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Stamps each campaign's bucket (from its name, unless it has one) and side
 * (from the client's saved installs). Mutates the campaigns; returns the saved
 * installs as bare domains ("" when not saved).
 */
export function stampCampaigns<C extends StampableCampaign>(campaigns: C[], installs: SavedInstalls): { b2b: string; b2c: string } {
  const b2b = normalizeDomain(String(installs.b2b_instance ?? ""));
  const b2c = normalizeDomain(String(installs.b2c_instance ?? ""));
  for (const c of campaigns) {
    if (!c.bucket) {
      const guess = suggestBucketFromName(c.name);
      if (guess) c.bucket = guess;
    }
    if (b2b && c.instance_url === b2b) c.side = "b2b";
    else if (b2c && c.instance_url === b2c) c.side = "b2c";
    // No side when the campaign is on neither of the client's installs: see the note above.
  }
  return { b2b, b2c };
}

const FREEMAIL = `split_part(lower(l.email), '@', 2) in (select domain from freemail_domains)`;

/**
 * Of these lead ids, the ones whose address is on this side (the export push
 * route's emailSide split). A lead that is gone, or has no email, is on
 * neither side.
 */
export async function idsOfSide(db: Queryable, ids: string[], side: PushSide): Promise<string[]> {
  const inOrNot = side === "b2c" ? "in" : "not in";
  const { rows } = await db.query(
    `select l.id from leads l
      where l.id = any($1::uuid[])
        and split_part(lower(l.email), '@', 2) ${inOrNot} (select domain from freemail_domains)`,
    [ids]
  );
  return rows.map((r) => r.id as string);
}

/**
 * The side of each of these leads, by the same split. A lead that is gone, or
 * has no email, is left out of the map.
 */
export async function sidesOfLeads(db: Queryable, ids: string[]): Promise<Map<string, PushSide>> {
  const out = new Map<string, PushSide>();
  if (!ids.length) return out;
  const { rows } = await db.query(
    `select l.id, ${FREEMAIL} as b2c
       from leads l
      where l.id = any($1::uuid[]) and l.email is not null and l.email <> ''`,
    [ids]
  );
  for (const r of rows) {
    if (r.b2c === true) out.set(r.id as string, "b2c");
    else if (r.b2c === false) out.set(r.id as string, "b2b");
  }
  return out;
}
