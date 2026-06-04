import { createAdminClient } from "@/lib/supabase/admin";

export async function logAudit(params: {
  action: string;
  performedBy?: string | null;
  details?: string | null;
}) {
  const supabase = createAdminClient();
  const { error } = await supabase.from("audit_logs").insert({
    action: params.action,
    performed_by: params.performedBy ?? null,
    details: params.details ?? null,
  });
  if (error) console.error("Audit log insert failed:", error.message);
}
