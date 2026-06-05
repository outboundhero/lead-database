"use client";

import { ShieldOff } from "lucide-react";

export function AccessDenied() {
  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-destructive/12">
        <ShieldOff className="size-7 text-destructive" strokeWidth={1.75} />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-[20px] font-semibold tracking-tight">Access denied</h2>
        <p className="max-w-xs text-[14px] text-muted-foreground">
          You don&apos;t have permission to view this page. Contact your admin to request access.
        </p>
      </div>
    </div>
  );
}
