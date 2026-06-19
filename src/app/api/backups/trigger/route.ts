import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const supabase = createAdminClient();

  try {
    // Generate a CSV backup of the leads table
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
    const fileName = `OutboundHeroDB_Backup_${timestamp}.csv`;

    // Fetch all leads in chunks
    const allRows: string[] = [];
    let page = 0;
    const pageSize = 10000;
    let hasMore = true;

    // CSV header
    const columns = [
      "id", "email", "first_name", "last_name", "title",
      "seniority", "company", "company_size", "annual_revenue",
      "general_industry", "specific_industry", "phone", "website",
      "person_linkedin", "company_linkedin", "source", "status", "esp",
      "tags", "city", "state", "country", "domain", "company_overview",
      "email_type", "validation_status", "is_bounced",
      "workspace_name", "emails_sent", "opens", "replies", "bounces",
      "address", "question", "company_phone", "google_maps_url",
      "created_at", "updated_at",
    ];
    allRows.push(columns.join(","));

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;

      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .range(from, to)
        .order("created_at", { ascending: true });

      if (error) throw new Error(error.message);
      if (!data || data.length === 0) {
        hasMore = false;
        break;
      }

      for (const row of data) {
        const csvRow = columns.map((col) => {
          const val = row[col];
          if (val === null || val === undefined) return "";
          const str = Array.isArray(val) ? val.join("; ") : String(val);
          if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        });
        allRows.push(csvRow.join(","));
      }

      hasMore = data.length === pageSize;
      page++;
    }

    const csvContent = allRows.join("\n");
    const totalLeads = allRows.length - 1; // minus header

    // Upload to Supabase Storage (backups bucket)
    const { error: uploadError } = await supabase.storage
      .from("backups")
      .upload(fileName, csvContent, {
        contentType: "text/csv",
        upsert: true,
      });

    if (uploadError) {
      // If bucket doesn't exist, try creating it
      if (uploadError.message.includes("not found") || uploadError.message.includes("Bucket")) {
        await supabase.storage.createBucket("backups", { public: false });
        const { error: retryError } = await supabase.storage
          .from("backups")
          .upload(fileName, csvContent, {
            contentType: "text/csv",
            upsert: true,
          });
        if (retryError) throw new Error(retryError.message);
      } else {
        throw new Error(uploadError.message);
      }
    }

    return NextResponse.json({
      success: true,
      fileName,
      totalLeads,
      sizeBytes: new Blob([csvContent]).size,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Backup failed" },
      { status: 500 }
    );
  }
}
