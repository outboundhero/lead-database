"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useHasPermission } from "@/lib/context/role-context";
import { AccessDenied } from "@/components/layout/access-denied";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { StatCards } from "@/components/dashboard/stat-cards";
import { DashboardCharts } from "@/components/dashboard/dashboard-charts";
import type { DashboardSnapshot } from "@/types/database";

export default function DashboardPage() {
  const canView = useHasPermission("manager");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("dashboard_snapshots")
      .select("*")
      .order("snapshot_date", { ascending: false })
      .limit(1);
    setSnapshot((data?.[0] as DashboardSnapshot) ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  if (!canView) return <AccessDenied />;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Snapshot of your lead database
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="tinted"
            size="sm"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                const res = await fetch("/api/dashboard/refresh", { method: "POST" });
                if (res.ok) {
                  await loadSnapshot();
                }
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} strokeWidth={2} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-[14px] text-muted-foreground">Loading dashboard…</p>
      ) : !snapshot ? (
        <div className="rounded-2xl bg-card p-8 text-center shadow-ios">
          <p className="text-[14px] text-muted-foreground">
            No dashboard snapshot available. Snapshots are generated periodically.
          </p>
        </div>
      ) : (
        <>
          <StatCards snapshot={snapshot} />
          <DashboardCharts snapshot={snapshot} />
        </>
      )}
    </div>
  );
}
