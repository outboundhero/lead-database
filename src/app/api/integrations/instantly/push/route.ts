import { NextRequest, NextResponse } from "next/server";

// Reserved endpoint for future Instantly integration
// POST /api/integrations/instantly/push — Push leads directly to Instantly campaign
export async function POST(request: NextRequest) {
  return NextResponse.json(
    {
      error: "Not implemented yet",
      message: "This endpoint is reserved for future Instantly integration. It will push leads directly to an Instantly campaign.",
    },
    { status: 501 }
  );
}
