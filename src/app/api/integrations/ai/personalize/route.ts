import { NextRequest, NextResponse } from "next/server";

// Reserved endpoint for future AI personalization integration
// POST /api/integrations/ai/personalize — AI personalization enrichment hook
export async function POST(request: NextRequest) {
  return NextResponse.json(
    {
      error: "Not implemented yet",
      message: "This endpoint is reserved for future AI personalization enrichment. It will accept lead data and return personalized content.",
    },
    { status: 501 }
  );
}
