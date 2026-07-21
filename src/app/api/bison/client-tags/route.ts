import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/bison/client-tags — list the synced Bison client tags (client_tags
// table, migration 053). Used by the presets UI to optionally scope a saved
// search to a client AND by the Send-to-Bison wizard, which additionally needs
// each tag's b2b_instance / b2c_instance (the two Bison installs the split
// routes to) plus a `churned` flag. Session-authenticated; the table has an
// authenticated read RLS policy so the caller's own client is enough.

export interface ClientTagRow {
  tag: string;
  group_no: number;
  b2b_instance: string;
  b2c_instance: string;
  owner: string | null;
  status: string | null;
  churned: boolean;
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("client_tags")
    .select("tag, group_no, b2b_instance, b2c_instance, owner, status")
    .order("tag", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const tags: ClientTagRow[] = (data ?? []).map((r) => ({
    tag: r.tag as string,
    group_no: r.group_no as number,
    b2b_instance: r.b2b_instance as string,
    b2c_instance: r.b2c_instance as string,
    owner: (r.owner as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    churned:
      typeof r.status === "string" && r.status.trim().toLowerCase() === "churned",
  }));

  return NextResponse.json({ tags });
}
