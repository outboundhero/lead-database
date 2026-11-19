// What the Sharing page's routes ask of the share step: preview a job again,
// apply it, undo it, retry it. The share build fills these in
// (scripts/lib/share/); until then every call answers 503, so the routes can
// be built and checked against this shape.
//
// Each function takes a pg Pool (it runs its own transactions) and answers a
// plain object, or throws ShareActionError with the HTTP status and the reason
// in plain words. receiver null means every receiver of the job.

export class ShareActionError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "ShareActionError";
    this.status = status;
  }
}

const notBuilt = () => new ShareActionError(503, "Sharing is not built in this copy of the app yet.");

/**
 * Decides a previewed job again with the current rules and says what changed
 * since the preview, for the Apply confirm. Writes nothing.
 * @param {unknown} pool
 * @param {{ batchId: string, receiver?: string | null }} opts
 * @returns {Promise<{ batchId: string, receivers: Array<{ tag: string, before: Record<string, number>, now: Record<string, number>, overCap: boolean }> }>}
 */
export async function previewShareJob(pool, opts) {
  void pool;
  void opts;
  throw notBuilt();
}

/**
 * Applies a job (or one receiver of it) by hand: decides again, then logs the
 * shares as applied, in chunks; queues their push when the receiver is on
 * push_tags. An admin may apply a receiver over a cap.
 * @param {unknown} pool
 * @param {{ batchId: string, receiver?: string | null, userId: string }} opts
 * @returns {Promise<{ batchId: string, applied: Record<string, number>, queued: Record<string, number>, skipped: Record<string, string> }>}
 */
export async function applyShareJob(pool, opts) {
  void pool;
  void opts;
  throw notBuilt();
}

/**
 * Undoes a job (or one receiver of it): marks its shares undone, takes off
 * the tags it wrote (paced), cancels its share pushes not gathered yet, and
 * says how many leads were already pushed (taking them out of campaigns is a
 * separate step).
 * @param {unknown} pool
 * @param {{ batchId: string, receiver?: string | null, userId: string }} opts
 * @returns {Promise<{ batchId: string, undone: number, tagsToRemove: number, cancelledPushes: string[], pushedLeads: number }>}
 */
export async function undoShareJob(pool, opts) {
  void pool;
  void opts;
  throw notBuilt();
}

/**
 * Sends a job in error, or one that waited the place limit, round again.
 * @param {unknown} pool
 * @param {{ batchId: string, userId: string }} opts
 * @returns {Promise<{ batchId: string, state: string }>}
 */
export async function retryShareJob(pool, opts) {
  void pool;
  void opts;
  throw notBuilt();
}
