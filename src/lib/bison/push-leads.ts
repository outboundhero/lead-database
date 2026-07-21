// push-leads.ts — push OutboundHero leads into an Email Bison campaign.
//
// Two-step Bison flow (confirmed against docs.emailbison.com):
//   1. POST /api/leads                              create/upsert lead in Bison
//                                                   (returns the Bison lead id)
//   2. POST /api/campaigns/{id}/leads/attach-leads  { lead_ids: [...] }
//
// Bison lead ids are per-workspace, so we always CREATE the lead in the target
// campaign's workspace (Bison upserts by email within a workspace) and attach
// the fresh id — this avoids attaching a stale id from another workspace even
// for leads we originally imported from Bison. bison_lead_id reuse (when the
// lead's workspace already matches the campaign) is a future optimization.
//
// Live-Bison semantics proven by the corofy enrich-worker (production daily):
// POST /api/leads does NOT upsert — a duplicate email fails with a "taken /
// already exists" validation error, handled by find-by-search + PUT refresh.

import type { Lead } from "@/types/database";

export interface BisonPushLead {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  company?: string | null;
  notes?: string | null;
  bison_lead_id?: number | null;
  // enrichment we send as custom variables
  category?: string | null;
  subcategory?: string | null;
  city?: string | null;
  state?: string | null;
}

export interface BisonPushResult {
  total: number;
  created: number;
  attached: number;
  failed: number; // create failures — disjoint from created
  attachFailed: number; // created in Bison but not attached to the campaign
  errors: string[];
}

const CREATE_CONCURRENCY = 5;
const ATTACH_BATCH = 500;

function baseUrl(instanceUrl?: string | null): string {
  if (instanceUrl) return `https://${instanceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  return (process.env.EMAILBISON_BASE_URL || "https://app.outboundhero.co").replace(/\/$/, "");
}

function customVars(lead: BisonPushLead) {
  const vars: Array<{ name: string; value: string }> = [];
  if (lead.category) vars.push({ name: "category", value: lead.category });
  if (lead.subcategory) vars.push({ name: "subcategory", value: lead.subcategory });
  if (lead.city) vars.push({ name: "city", value: lead.city });
  if (lead.state) vars.push({ name: "state", value: lead.state });
  return vars;
}

function leadBody(lead: BisonPushLead): Record<string, unknown> {
  return {
    first_name: lead.first_name ?? "",
    last_name: lead.last_name ?? "",
    email: lead.email,
    ...(lead.title ? { title: lead.title } : {}),
    ...(lead.company ? { company: lead.company } : {}),
    ...(lead.notes ? { notes: lead.notes } : {}),
    custom_variables: customVars(lead),
  };
}

async function bisonFetch(base: string, apiKey: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Bison auth failed (HTTP ${res.status}) — check EMAILBISON_API_KEY`), { fatal: true });
  }
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const data = json?.data as { message?: string } | undefined;
    const msg = data?.message || (json?.message as string | undefined) || text.slice(0, 160);
    throw new Error(`${method} ${path}: HTTP ${res.status} ${msg}`);
  }
  return json ?? {};
}

async function createLead(base: string, apiKey: string, lead: BisonPushLead): Promise<number | string> {
  try {
    const json = await bisonFetch(base, apiKey, "POST", "/api/leads", leadBody(lead));
    const data = json?.data as { id?: number | string } | undefined;
    const id = data?.id ?? (json?.id as number | string | undefined) ?? (json?.lead as { id?: number | string } | undefined)?.id;
    if (id != null) return id;
    throw new Error(`create ${lead.email}: could not read Bison lead id from response`);
  } catch (err) {
    if ((err as { fatal?: boolean }).fatal) throw err;
    // Only a duplicate email means "find and reuse"; other errors are real.
    if (!/taken|already exists|duplicate/i.test((err as Error).message)) throw err;
  }
  // Duplicate: find the existing lead by search (retrying for indexing delay),
  // refresh its fields with PUT, reuse its id — corofy's production pattern.
  for (let t = 0; t < 3; t++) {
    if (t > 0) await new Promise((r) => setTimeout(r, 2000));
    const found = await bisonFetch(base, apiKey, "GET", `/api/leads?search=${encodeURIComponent(lead.email)}`);
    const rows = (found?.data ?? []) as Array<{ id: number | string; email?: string }>;
    const hit = rows.find((l) => (l.email || "").toLowerCase() === lead.email.toLowerCase());
    if (hit) {
      await bisonFetch(base, apiKey, "PUT", `/api/leads/${hit.id}`, leadBody(lead));
      return hit.id;
    }
  }
  throw new Error(`lead ${lead.email} exists in Bison but was not found by search`);
}

async function attachLeads(base: string, apiKey: string, campaignId: number | string, ids: Array<number | string>): Promise<void> {
  const res = await fetch(`${base}/api/campaigns/${campaignId}/leads/attach-leads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ lead_ids: ids }),
  });
  if (!res.ok) {
    throw new Error(`attach ${ids.length} leads: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
}

/**
 * Create each lead in Bison, then attach the resulting ids to the campaign.
 * onProgress reports (createdSoFar) so the caller can update a job row.
 */
export async function pushLeadsToCampaign(
  leads: BisonPushLead[],
  opts: {
    apiKey: string;
    campaignId: number | string;
    instanceUrl?: string | null;
    onProgress?: (created: number) => void | Promise<void>;
    signal?: AbortSignal;
  }
): Promise<BisonPushResult> {
  const base = baseUrl(opts.instanceUrl);
  const result: BisonPushResult = { total: leads.length, created: 0, attached: 0, failed: 0, attachFailed: 0, errors: [] };
  const ids: Array<number | string> = [];

  // Step 1 — create in Bison (bounded concurrency).
  let next = 0;
  async function worker() {
    while (next < leads.length) {
      if (opts.signal?.aborted) return;
      const i = next++;
      try {
        const id = await createLead(base, opts.apiKey, leads[i]);
        ids.push(id);
        result.created++;
        if (opts.onProgress && result.created % 25 === 0) await opts.onProgress(result.created);
      } catch (err) {
        if ((err as { fatal?: boolean }).fatal) throw err;
        result.failed++;
        if (result.errors.length < 20) result.errors.push((err as Error).message);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CREATE_CONCURRENCY, leads.length) }, worker));
  } catch (err) {
    // Fatal (auth) abort — attach a snapshot of the progress so far so the
    // caller can report how many leads were already created in Bison.
    throw Object.assign(err as Error, { partial: { ...result } });
  }

  // Step 2 — attach all created ids to the campaign, in batches.
  for (let i = 0; i < ids.length; i += ATTACH_BATCH) {
    if (opts.signal?.aborted) break;
    const batch = ids.slice(i, i + ATTACH_BATCH);
    try {
      await attachLeads(base, opts.apiKey, opts.campaignId, batch);
      result.attached += batch.length;
    } catch (err) {
      // These leads are already counted in `created` — track separately so
      // created + failed never exceeds total.
      result.attachFailed += batch.length;
      if (result.errors.length < 20) result.errors.push((err as Error).message);
    }
  }

  return result;
}

// Map a DB Lead row to the push shape.
export function leadToPushLead(l: Partial<Lead>): BisonPushLead {
  return {
    email: l.email!,
    first_name: l.first_name,
    last_name: l.last_name,
    title: l.title,
    company: l.company,
    notes: l.notes,
    bison_lead_id: l.bison_lead_id,
    category: l.category,
    subcategory: l.subcategory,
    city: l.city,
    state: l.state,
  };
}
