"use client";

import { ShieldOff } from "lucide-react";

export function AccessDenied() {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-3 text-center">
      <ShieldOff className="h-10 w-10 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Access Denied</h2>
      <p className="text-sm text-muted-foreground max-w-xs">
        You don&apos;t have permission to view this page. Contact your admin to request access.
      </p>
    </div>
  );
}
