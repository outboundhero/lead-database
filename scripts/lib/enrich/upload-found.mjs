// The worker's side of adding an upload's found emails to leads (migration 130).
//
// A person from an upload's no-email rows whose email the People steps found
// and approved (Outcome "Approved email") is added to leads by the web app,
// through the Uploads page's own import, with the upload's duplicate rule, tags
// and fields. The import engine is TypeScript the worker can't load, so, as for
// the AI Ark add and promotion, the worker only asks.
//
// Every minute the worker asks which uploads have someone still to add
// (FOUND_DUE_SQL: an approved person with no add_to_database cell, or one left
// running by a round that died, and no live round of that upload), and asks the
// web app for a round of each (POST /api/uploads/found/auto { batch }, Bearer
// AIARK_AUTO_ADD_KEY), at most once per upload every FOUND_EVERY_MS, whatever
// the answer. The web app marks each person it takes (their add_to_database
// cell, running with the round's batch), so a person is taken once; people a
// round left running when it died are taken again by a later round. A request
// that fails writes nothing, so the worker simply asks again after
// FOUND_EVERY_MS.
//
// Off unless AIARK_AUTO_ADD_URL and AIARK_AUTO_ADD_KEY are both set (the same
// pair starts the AI Ark pulls' automatic add). Without them the Uploads page's
// button adds the found emails.

import { FOUND_DUE_SQL, FOUND_EVERY_MS } from "./upload-people.mjs";

/** Where the web app takes a round of found emails. */
export const FOUND_AUTO_PATH = "/api/uploads/found/auto";
/** The web route refuses a shorter key (intakeKeyStatus). */
const AUTO_KEY_MIN = 32;
/** How long a request may take: the route answers once the round's people are marked, before the import runs. */
const FOUND_WAIT_MS = 30_000;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 * @typedef {{ url: string, key: string }} FoundConfig
 */

/**
 * Where the worker asks for a round: the AIARK_AUTO_ADD_URL origin and
 * FOUND_AUTO_PATH, with AIARK_AUTO_ADD_KEY (32 characters or more), as
 * promoteAutoConfig() reads them. Null, and the automatic adding off, when
 * either is missing or the key is too short.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {FoundConfig | null}
 */
export function foundAutoConfig(env = process.env) {
  const base = String(env?.AIARK_AUTO_ADD_URL ?? "").trim();
  const key = String(env?.AIARK_AUTO_ADD_KEY ?? "").trim();
  if (!base || key.length < AUTO_KEY_MIN) return null;
  try {
    return { url: new URL(FOUND_AUTO_PATH, base).toString(), key };
  } catch {
    return null;
  }
}

/**
 * The uploads with a found person still to add and no round of their own under
 * way, oldest first (FOUND_DUE_SQL).
 *
 * @param {Db} db
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ batch_id: string, client_tag: string }>>}
 */
export async function foundDue(db, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 20));
  const { rows } = await db.query(FOUND_DUE_SQL, [n]);
  return rows.map((r) => ({ batch_id: r.batch_id, client_tag: r.client_tag }));
}

/**
 * Asks the web app for one round of an upload's found emails. Never throws:
 * a refusal, an error or no answer in 30 seconds comes back as { ok: false }.
 *
 * @param {FoundConfig} config
 * @param {string} batchId  the upload's batch id
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, status: number | null, why: string | null }>}
 */
export async function requestFound(config, batchId, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ batch: batchId }),
      signal: AbortSignal.timeout(FOUND_WAIT_MS),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, why: res.ok ? null : String(json?.error ?? "no reason given").slice(0, 300) };
  } catch (e) {
    const err = /** @type {{ name?: string, cause?: { code?: string }, message?: string }} */ (e);
    return { ok: false, status: null, why: String(err?.name === "TimeoutError" ? "no answer in time" : err?.cause?.code ?? err?.message ?? e).slice(0, 300) };
  }
}

/**
 * One pass of the worker's found-email timer: the uploads due (foundDue), and
 * one request for each upload not asked within everyMs. The time of each ask
 * is kept in askedAt whatever the answer, so an upload is asked at most once
 * every everyMs, and a failed request is tried again after that. Entries older
 * than everyMs are dropped. Throws only when the question itself fails.
 *
 * @param {Db} db
 * @param {{ config: FoundConfig | null, askedAt: Map<string, number>, everyMs?: number, limit?: number,
 *           now?: () => number, fetchImpl?: typeof fetch, log?: (line: string) => void }} opts
 * @returns {Promise<Array<{ batch_id: string, client_tag: string, ok: boolean, status: number | null, why: string | null }>>}
 *   the requests made in this pass
 */
export async function askForFound(db, { config, askedAt, everyMs = FOUND_EVERY_MS, limit = 20, now = Date.now, fetchImpl = fetch, log = () => {} }) {
  if (!config) return [];
  const t = now();
  for (const [id, at] of askedAt) if (t - at >= everyMs) askedAt.delete(id);
  const asked = [];
  for (const u of await foundDue(db, { limit })) {
    if (askedAt.has(u.batch_id)) continue;
    askedAt.set(u.batch_id, now());
    const r = await requestFound(config, u.batch_id, fetchImpl);
    log(`found emails of upload ${String(u.batch_id).slice(0, 8)} (${u.client_tag}): ${r.ok ? "adding started" : `not started, ${r.status ?? "no answer"}: ${r.why}`}`);
    asked.push({ ...u, ...r });
  }
  return asked;
}
