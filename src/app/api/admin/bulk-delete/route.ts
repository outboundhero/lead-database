import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/api/log-audit";
import { getPool } from "@/lib/db/pool";
import { normalizeFilterState } from "@/types/filters";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";

const MAX_DELETE_PER_REQUEST = 100000; // Safety cap
const DELETE_CHUNK = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BulkDeleteBody {
  // New: delete an explicit set of lead ids (table selection).
  ids?: string[];
  // New: delete everything matching a FilterState (the "select all N filtered"
  // path — resolved server-side via fn_lead_filter_conditions).
  filters?: unknown;
  // Legacy paths (admin page bulk-delete-dialog).
  emails?: string[];
  source?: string;
  uploadDate?: string;
  preview?: boolean;
}

export async function POST(request: NextRequest) {
  // Auth check
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Role check — only owner and admin can bulk delete
  const supabase = createAdminClient();
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !["owner", "admin"].includes(profile.role)) {
    return NextResponse.json({ error: "Only owners and admins can bulk delete" }, { status: 403 });
  }

  let body: BulkDeleteBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { ids, filters, emails, source, uploadDate, preview } = body;

  const hasIds = Array.isArray(ids) && ids.length > 0;
  const hasFilters = filters !== undefined && filters !== null;

  try {
    // ── New path A: delete an explicit set of lead ids ──────────────────────
    if (hasIds) {
      const cleanIds = (ids as string[]).filter(
        (id) => typeof id === "string" && UUID_RE.test(id)
      );
      if (cleanIds.length === 0) {
        return NextResponse.json({ error: "No valid lead ids provided" }, { status: 400 });
      }

      if (preview) {
        return NextResponse.json({ preview: true, estimatedCount: cleanIds.length, exact: true });
      }

      if (cleanIds.length > MAX_DELETE_PER_REQUEST) {
        return NextResponse.json(
          { error: `Cannot delete more than ${MAX_DELETE_PER_REQUEST.toLocaleString()} leads at once. Split into smaller batches.` },
          { status: 400 }
        );
      }

      const pool = getPool();
      let totalDeleted = 0;
      for (let i = 0; i < cleanIds.length; i += DELETE_CHUNK) {
        const chunk = cleanIds.slice(i, i + DELETE_CHUNK);
        // Junction rows first (no cascade on lead_job_titles).
        await pool.query(`delete from lead_job_titles where lead_id = any($1::uuid[])`, [chunk]);
        const del = await pool.query(`delete from leads where id = any($1::uuid[])`, [chunk]);
        totalDeleted += del.rowCount ?? 0;
      }

      await logAudit({
        action: "Bulk Delete",
        performedBy: user.email,
        details: `Deleted ${totalDeleted} leads by selection (${cleanIds.length} ids submitted).`,
      });

      return NextResponse.json({ success: true, deleted: totalDeleted });
    }

    // ── New path B: delete everything matching a FilterState ────────────────
    if (hasFilters) {
      const pool = getPool();
      const normalized = normalizeFilterState(filters);
      const p_filters = buildRpcFilters(normalized);

      // fn_lead_filter_conditions returns trusted SQL fragments (the same helper
      // the export / push pipeline uses). It does NOT gate on is_bounced, so add
      // that gate here to mirror what the table shows (unless includeBounced).
      const { rows: [c] } = await pool.query(
        `select fn_lead_filter_conditions($1::jsonb) as conds`,
        [JSON.stringify(p_filters)]
      );
      const conds = (c?.conds ?? []) as string[];

      // Never allow an unfiltered "delete everything" — require real conditions.
      if (conds.length === 0) {
        return NextResponse.json(
          { error: "Refusing to delete with no active filter conditions. Add at least one filter." },
          { status: 400 }
        );
      }

      const gates = [...conds];
      if (!normalized.includeBounced) gates.push("l.is_bounced = false");
      const whereClause = gates.join(" and ");

      // Exact count of the filtered set.
      const { rows: [countRow] } = await pool.query(
        `select count(*)::bigint as n from leads l where ${whereClause}`
      );
      const matchCount = Number(countRow?.n ?? 0);

      if (preview) {
        return NextResponse.json({ preview: true, estimatedCount: matchCount, exact: true });
      }

      if (matchCount > MAX_DELETE_PER_REQUEST) {
        return NextResponse.json(
          { error: `This would delete ${matchCount.toLocaleString()} leads. Maximum is ${MAX_DELETE_PER_REQUEST.toLocaleString()} per request. Narrow the filters.` },
          { status: 400 }
        );
      }

      let totalDeleted = 0;
      // Deleted rows drop out of the match set, so repeatedly grabbing the first
      // page of ids and deleting them by id drains the whole set. Cap is enforced
      // by the pre-count above.
      for (;;) {
        const { rows: idRows } = await pool.query(
          `select l.id from leads l where ${whereClause} order by l.id limit $1`,
          [DELETE_CHUNK]
        );
        if (idRows.length === 0) break;
        const chunkIds = idRows.map((r) => r.id as string);
        await pool.query(`delete from lead_job_titles where lead_id = any($1::uuid[])`, [chunkIds]);
        const del = await pool.query(`delete from leads where id = any($1::uuid[])`, [chunkIds]);
        totalDeleted += del.rowCount ?? 0;
        if (totalDeleted >= MAX_DELETE_PER_REQUEST) break;
      }

      await logAudit({
        action: "Bulk Delete",
        performedBy: user.email,
        details: `Deleted ${totalDeleted} leads by filter (matched ${matchCount}). Filters: ${JSON.stringify(p_filters)}`,
      });

      return NextResponse.json({ success: true, deleted: totalDeleted });
    }

    // ── Legacy paths: emails / source / uploadDate ──────────────────────────
    if (!emails?.length && !source && !uploadDate) {
      return NextResponse.json(
        { error: "Provide at least one filter: ids, filters, emails, source, or uploadDate" },
        { status: 400 }
      );
    }

    // Preview mode — count how many would be deleted without actually deleting
    if (preview) {
      let countQuery = supabase.from("leads").select("id", { count: "exact", head: true });

      if (emails && emails.length > 0) {
        // Can't do .in() with head:true for large arrays, estimate instead
        const sampleChunk = emails.slice(0, 1000);
        const { count } = await supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .in("email", sampleChunk);

        const estimated = emails.length > 1000
          ? Math.round((count ?? 0) * (emails.length / 1000))
          : (count ?? 0);

        return NextResponse.json({ preview: true, estimatedCount: estimated });
      }

      if (source) countQuery = countQuery.eq("source", source);
      if (uploadDate) {
        countQuery = countQuery
          .gte("created_at", `${uploadDate}T00:00:00.000Z`)
          .lte("created_at", `${uploadDate}T23:59:59.999Z`);
      }

      const { count } = await countQuery;
      return NextResponse.json({ preview: true, estimatedCount: count ?? 0 });
    }

    // Actual delete
    let totalDeleted = 0;

    if (emails && emails.length > 0) {
      // Safety cap
      if (emails.length > MAX_DELETE_PER_REQUEST) {
        return NextResponse.json(
          { error: `Cannot delete more than ${MAX_DELETE_PER_REQUEST.toLocaleString()} leads at once. Split into smaller batches.` },
          { status: 400 }
        );
      }

      for (let i = 0; i < emails.length; i += 500) {
        const chunk = emails.slice(i, i + 500);

        // Delete from junction table first
        const { data: leadIds } = await supabase
          .from("leads")
          .select("id")
          .in("email", chunk);

        if (leadIds && leadIds.length > 0) {
          const ids = leadIds.map((r) => r.id);
          await supabase.from("lead_job_titles").delete().in("lead_id", ids);
        }

        // Then delete leads
        const { count, error } = await supabase
          .from("leads")
          .delete({ count: "exact" })
          .in("email", chunk);

        if (error) throw new Error(error.message);
        totalDeleted += count ?? 0;
      }
    } else {
      // Count first to enforce safety cap
      let countQuery = supabase.from("leads").select("id", { count: "exact", head: true });
      if (source) countQuery = countQuery.eq("source", source);
      if (uploadDate) {
        countQuery = countQuery
          .gte("created_at", `${uploadDate}T00:00:00.000Z`)
          .lte("created_at", `${uploadDate}T23:59:59.999Z`);
      }

      const { count: matchCount } = await countQuery;
      if ((matchCount ?? 0) > MAX_DELETE_PER_REQUEST) {
        return NextResponse.json(
          { error: `This would delete ${(matchCount ?? 0).toLocaleString()} leads. Maximum is ${MAX_DELETE_PER_REQUEST.toLocaleString()} per request. Add more filters to narrow down.` },
          { status: 400 }
        );
      }

      // Delete junction table entries first
      // Use a subquery approach — delete job titles for matching leads
      if (source || uploadDate) {
        let leadQuery = supabase.from("leads").select("id");
        if (source) leadQuery = leadQuery.eq("source", source);
        if (uploadDate) {
          leadQuery = leadQuery
            .gte("created_at", `${uploadDate}T00:00:00.000Z`)
            .lte("created_at", `${uploadDate}T23:59:59.999Z`);
        }
        const { data: leadIds } = await leadQuery.limit(MAX_DELETE_PER_REQUEST);
        if (leadIds && leadIds.length > 0) {
          // Delete in chunks to avoid query size limits
          for (let i = 0; i < leadIds.length; i += 1000) {
            const ids = leadIds.slice(i, i + 1000).map((r) => r.id);
            await supabase.from("lead_job_titles").delete().in("lead_id", ids);
          }
        }
      }

      // Delete leads
      let deleteQuery = supabase.from("leads").delete({ count: "exact" });
      if (source) deleteQuery = deleteQuery.eq("source", source);
      if (uploadDate) {
        deleteQuery = deleteQuery
          .gte("created_at", `${uploadDate}T00:00:00.000Z`)
          .lte("created_at", `${uploadDate}T23:59:59.999Z`);
      }

      const { count, error } = await deleteQuery;
      if (error) throw new Error(error.message);
      totalDeleted = count ?? 0;
    }

    // Audit log
    await logAudit({
      action: "Bulk Delete",
      performedBy: user.email,
      details: `Deleted ${totalDeleted} leads. Filters: ${
        emails?.length ? `${emails.length} emails` : ""
      }${source ? ` Source: ${source}` : ""}${uploadDate ? ` Date: ${uploadDate}` : ""}`,
    });

    return NextResponse.json({ success: true, deleted: totalDeleted });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed" },
      { status: 500 }
    );
  }
}
