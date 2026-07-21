import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeFilterState } from "@/types/filters";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { bisonAuthFor, normalizeDomain } from "@/lib/bison/keys";
import { getPool } from "@/lib/db/pool";

// POST /api/bison/send-preview — the split-preview step of the Send-to-Bison
// wizard. Given a client tag + the current filters (or explicit selectedIds),
// it returns the EXACT number of business-email (B2B) vs personal/freemail
// (B2C) leads that would actually be pushed, plus the candidate Bison
// campaigns on each side's instance and a suggested campaign per side.
//
// Counts run directly against `leads` via fn_lead_filter_conditions (the same
// trusted-fragment builder the export/push pipeline uses) so the preview
// matches what scripts/push-worker.mjs will gather: the eligibility gate below
// mirrors fn_export_leads (non-bounced, not-yet-invalid, non-empty email) and
// the emailSide domain split mirrors the RPC helper's b2b/b2c branch.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SELECTED_IDS = 100000;
const MAX_PAGES = 50;

// Matches the worker's ELIGIBLE gate + fn_export_leads: non-empty email,
// not bounced, and not (yet) invalid.
const ELIGIBLE =
  "l.email is not null and l.email <> '' and l.is_bounced = false " +
  "and (l.validation_status in ('valid','catch_all') or l.validation_status is null)";

// Domain split — must mirror fn_lead_filter_conditions' emailSide branch.
const B2C_DOMAIN = "split_part(lower(l.email), '@', 2) in (select domain from freemail_domains)";
const B2B_DOMAIN = "split_part(lower(l.email), '@', 2) not in (select domain from freemail_domains)";

interface BisonCampaignLite {
  id: number | string;
  name?: string;
  instance_url?: string;
  workspace_name?: string;
  created_at?: string;
  [k: string]: unknown;
}

interface SendPreviewPayload {
  clientTag?: string;
  filters?: unknown;
  selectedIds?: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Newest first — prefer created_at, fall back to numeric id.
function byNewest(a: BisonCampaignLite, b: BisonCampaignLite): number {
  const at = a.created_at ? Date.parse(a.created_at) : NaN;
  const bt = b.created_at ? Date.parse(b.created_at) : NaN;
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return bt - at;
  return Number(b.id) - Number(a.id);
}

async function fetchInstanceCampaigns(
  domain: string
): Promise<{ campaigns: BisonCampaignLite[]; error?: string }> {
  let auth: { base: string; key: string } | null;
  try {
    auth = bisonAuthFor(domain);
  } catch (e) {
    return { campaigns: [], error: e instanceof Error ? e.message : "no key" };
  }
  if (!auth) return { campaigns: [], error: "No Bison key configured" };

  const out: BisonCampaignLite[] = [];
  let url: string | null = `${auth.base}/api/campaigns`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${auth.key}`, Accept: "application/json" },
        cache: "no-store",
      });
    } catch (e) {
      return { campaigns: out, error: e instanceof Error ? e.message : "fetch failed" };
    }
    if (!res.ok) return { campaigns: out, error: `HTTP ${res.status}` };
    const json = await res.json();
    const list: unknown[] = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json)
      ? json
      : [];
    for (const c of list) {
      if (c && typeof c === "object") {
        out.push({ ...(c as BisonCampaignLite), instance_url: domain });
      }
    }
    if (list.length === 0) break;
    url = typeof json?.links?.next === "string" ? json.links.next : null;
  }
  return { campaigns: out };
}

// Newest tag-prefixed ("<TAG>:" / "<TAG> ") campaign that isn't a Nurture.
function suggestCampaign(
  campaigns: BisonCampaignLite[],
  tag: string
): BisonCampaignLite | null {
  const prefixRe = new RegExp("^" + escapeRegex(tag) + "[\\s:]", "i");
  const matching = campaigns
    .filter((c) => typeof c.name === "string" && prefixRe.test(c.name.trim()))
    .sort(byNewest);
  if (matching.length === 0) return null;
  return matching.find((c) => !/nurture/i.test(String(c.name))) ?? matching[0];
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: SendPreviewPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const clientTag = typeof body.clientTag === "string" ? body.clientTag.trim() : "";
  if (!clientTag) {
    return NextResponse.json({ error: "clientTag is required" }, { status: 400 });
  }

  // Resolve the client's two instances.
  const admin = createAdminClient();
  const { data: tagRow, error: tagErr } = await admin
    .from("client_tags")
    .select("tag, b2b_instance, b2c_instance")
    .eq("tag", clientTag)
    .maybeSingle();
  if (tagErr) {
    return NextResponse.json({ error: `Failed to load client tag: ${tagErr.message}` }, { status: 500 });
  }
  if (!tagRow) {
    return NextResponse.json({ error: `Unknown client tag "${clientTag}"` }, { status: 400 });
  }
  const b2bInstance = normalizeDomain(tagRow.b2b_instance as string);
  const b2cInstance = normalizeDomain(tagRow.b2c_instance as string);

  // Source: explicit selectedIds OR the current filters.
  const selectedIds = body.selectedIds;
  const hasSelectedIds = Array.isArray(selectedIds) && selectedIds.length > 0;
  if (selectedIds !== undefined && !Array.isArray(selectedIds)) {
    return NextResponse.json({ error: "selectedIds must be an array" }, { status: 400 });
  }
  if (hasSelectedIds) {
    if (selectedIds.length > MAX_SELECTED_IDS) {
      return NextResponse.json(
        { error: `Too many leads (${selectedIds.length}). Max ${MAX_SELECTED_IDS}.` },
        { status: 400 }
      );
    }
    if (!selectedIds.every((id) => typeof id === "string" && UUID_RE.test(id))) {
      return NextResponse.json({ error: "selectedIds must be uuid strings" }, { status: 400 });
    }
  }
  if (!hasSelectedIds && !body.filters) {
    return NextResponse.json({ error: "Provide selectedIds or filters" }, { status: 400 });
  }

  const pool = getPool();

  async function countSide(side: "b2b" | "b2c"): Promise<number> {
    if (hasSelectedIds) {
      const domainCond = side === "b2c" ? B2C_DOMAIN : B2B_DOMAIN;
      const { rows } = await pool.query(
        `select count(*)::bigint as n from leads l
          where l.id = any($1::uuid[]) and ${ELIGIBLE} and ${domainCond}`,
        [selectedIds]
      );
      return Number(rows[0]?.n ?? 0);
    }
    // Filters path: fn_lead_filter_conditions with emailSide injected returns
    // the full trusted WHERE (including the freemail split); AND the gate.
    const pf = { ...buildRpcFilters(normalizeFilterState(body.filters)), emailSide: side };
    const { rows: condRows } = await pool.query(
      `select fn_lead_filter_conditions($1::jsonb) as conds`,
      [JSON.stringify(pf)]
    );
    const conds: string[] = condRows[0]?.conds ?? [];
    const where = [...conds, ELIGIBLE].join(" and ");
    const { rows } = await pool.query(
      `select count(*)::bigint as n from leads l where ${where}`
    );
    return Number(rows[0]?.n ?? 0);
  }

  let b2bCount: number;
  let b2cCount: number;
  try {
    [b2bCount, b2cCount] = await Promise.all([countSide("b2b"), countSide("b2c")]);
  } catch (e) {
    return NextResponse.json(
      { error: `Count failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }

  // Campaigns live in the two instances (may be the same domain for both sides).
  const uniqueDomains = Array.from(new Set([b2bInstance, b2cInstance]));
  const fetched = new Map<string, { campaigns: BisonCampaignLite[]; error?: string }>();
  await Promise.all(
    uniqueDomains.map(async (d) => {
      fetched.set(d, await fetchInstanceCampaigns(d));
    })
  );
  const b2bFetch = fetched.get(b2bInstance) ?? { campaigns: [] };
  const b2cFetch = fetched.get(b2cInstance) ?? { campaigns: [] };

  return NextResponse.json({
    clientTag,
    b2b: {
      instance: b2bInstance,
      count: b2bCount,
      campaigns: b2bFetch.campaigns,
      suggested: suggestCampaign(b2bFetch.campaigns, clientTag),
      ...(b2bFetch.error ? { error: b2bFetch.error } : {}),
    },
    b2c: {
      instance: b2cInstance,
      count: b2cCount,
      campaigns: b2cFetch.campaigns,
      suggested: suggestCampaign(b2cFetch.campaigns, clientTag),
      ...(b2cFetch.error ? { error: b2cFetch.error } : {}),
    },
  });
}
