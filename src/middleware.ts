import { updateSession } from "@/lib/supabase/middleware";
import { type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files
     * - api/uploads/process (large file uploads bypass middleware)
     * - token-authenticated public API routes (auth via Bearer token, not session)
     * - api/costing (ReplyRouter's costing pull — Bearer COSTING_API_KEY only)
     * - api/enrich/intake (the GMaps Scraper app's chunks for the Clay tab, at
     *   /api/enrich/intake/<token>: each client's inbound URL token is the only auth)
     * - api/aiark/webhook (AI Ark's export callback — answers 200 and reads nothing)
     * - api/aiark/add/auto (the enrichment worker — Bearer AIARK_AUTO_ADD_KEY only)
     * - api/companies/promote/auto (the enrichment worker's promotion of approved
     *   pipeline emails into leads: Bearer AIARK_AUTO_ADD_KEY only)
     * - api/uploads/found/auto (the enrichment worker's adding of the emails
     *   found for an upload's no-email rows: Bearer AIARK_AUTO_ADD_KEY only)
     * - api/sharing/push/auto (the enrichment worker's push of a client's
     *   queued shares into its campaigns: Bearer SHARE_PUSH_KEY only)
     */
    "/((?!_next/static|_next/image|favicon.ico|api/uploads/process|api/enrich_email|api/leads/first5|api/leads/search|api/leads/update|api/costing|api/enrich/intake|api/aiark/webhook|api/aiark/add/auto|api/companies/promote/auto|api/uploads/found/auto|api/sharing/push/auto|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
