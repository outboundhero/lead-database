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
     */
    "/((?!_next/static|_next/image|favicon.ico|api/uploads/process|api/enrich_email|api/leads/first5|api/leads/search|api/leads/update|api/costing|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
