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
     * - api/enrich/intake (GMaps Scraper places for the Clay tab — Bearer ENRICH_INTAKE_KEY only)
     * - api/aiark/webhook (AI Ark's export callback — answers 204 and reads nothing)
     */
    "/((?!_next/static|_next/image|favicon.ico|api/uploads/process|api/enrich_email|api/leads/first5|api/leads/search|api/leads/update|api/costing|api/enrich/intake|api/aiark/webhook|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
