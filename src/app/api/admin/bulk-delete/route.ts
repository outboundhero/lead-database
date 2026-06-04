import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/api/log-audit";

const MAX_DELETE_PER_REQUEST = 100000; // Safety cap

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

  let body: { emails?: string[]; source?: string; uploadDate?: string; preview?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { emails, source, uploadDate, preview } = body;

  if (!emails?.length && !source && !uploadDate) {
    return NextResponse.json(
      { error: "Provide at least one filter: emails, source, or uploadDate" },
      { status: 400 }
    );
  }

  try {
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
