import { NextResponse } from "next/server";

// The Sharing page's apply, undo and retry run the share step's own actions
// (scripts/lib/share/actions.mjs). They throw ShareActionError(status,
// message) for a refusal; this turns one into the route's answer. Any other
// error is the route's to log.

export function shareActionRefusal(err: unknown) {
  const e = err as { name?: unknown; status?: unknown; message?: unknown } | null;
  if (!e || e.name !== "ShareActionError" || typeof e.status !== "number") return null;
  const status = e.status >= 400 && e.status <= 599 ? e.status : 500;
  return NextResponse.json({ error: typeof e.message === "string" ? e.message : "Refused" }, { status });
}

/** The body's batchId and optional receiver, or the 400 to answer. */
export function jobTarget(body: unknown): { batchId: string; receiver: string | null } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be an object" };
  const b = body as { batchId?: unknown; receiver?: unknown };
  const batchId = typeof b.batchId === "string" ? b.batchId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) return { error: "batchId must be a share job's id" };
  if (b.receiver === undefined || b.receiver === null) return { batchId, receiver: null };
  const t = typeof b.receiver === "string" ? b.receiver.trim().toUpperCase() : "";
  if (!/^[A-Z0-9][A-Z0-9_&-]{0,63}$/.test(t)) return { error: "receiver must be a client tag" };
  return { batchId, receiver: t };
}
