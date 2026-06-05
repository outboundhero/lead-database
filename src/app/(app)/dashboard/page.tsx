"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useHasPermission } from "@/lib/context/role-context";
import { AccessDenied } from "@/components/layout/access-denied";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarDays, RefreshCw } from "lucide-react";
import { StatCards } from "@/components/dashboard/stat-cards";
import { DashboardCharts } from "@/components/dashboard/dashboard-charts";
import type { DashboardSnapshot } from "@/types/database";

type TimeRange = "all" | "7d" | "30d" | "custom";
type TimePoint = { date: string; total: number };

export default function DashboardPage() {
  const canView = useHasPermission("manager");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [timeSeries, setTimeSeries] = useState<TimePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();

    let query = supabase
      .from("dashboard_snapshots")
      .select("*")
      .order("snapshot_date", { ascending: false })
      .limit(1);

    let tsQuery = supabase
      .from("dashboard_snapshots")
      .select("snapshot_date, total_leads")
      .order("snapshot_date", { ascending: true });

    if (timeRange === "7d") {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      const iso = d.toISOString().split("T")[0];
      query = query.gte("snapshot_date", iso);
      tsQuery = tsQuery.gte("snapshot_date", iso);
    } else if (timeRange === "30d") {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      const iso = d.toISOString().split("T")[0];
      query = query.gte("snapshot_date", iso);
      tsQuery = tsQuery.gte("snapshot_date", iso);
    } else if (timeRange === "custom" && customFrom) {
      query = query.gte("snapshot_date", customFrom);
      tsQuery = tsQuery.gte("snapshot_date", customFrom);
      if (customTo) {
        query = query.lte("snapshot_date", customTo);
        tsQuery = tsQuery.lte("snapshot_date", customTo);
      }
    }

    const [{ data: snapData }, { data: tsData }] = await Promise.all([query, tsQuery]);

    setSnapshot((snapData?.[0] as DashboardSnapshot) ?? null);
    setTimeSeries(
      (tsData ?? []).map((row) => ({
        date: row.snapshot_date,
        total: row.total_leads ?? 0,
      }))
    );
    setLoading(false);
  }, [timeRange, customFrom, customTo]);

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
          <div className="inline-flex h-9 items-center rounded-full bg-muted p-0.5">
            {(["all", "7d", "30d"] as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`rounded-full px-3 text-[13px] font-medium transition-all ${
                  timeRange === range
                    ? "bg-card text-foreground shadow-[0_2px_6px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {range === "all" ? "All time" : range === "7d" ? "7 days" : "30 days"}
              </button>
            ))}
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant={timeRange === "custom" ? "default" : "tinted"} size="sm">
                <CalendarDays className="size-3.5" strokeWidth={2} />
                {timeRange === "custom" && customFrom
                  ? `${customFrom}${customTo ? ` — ${customTo}` : ""}`
                  : "Custom"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-3">
              <div className="space-y-1.5">
                <label className="block px-1 text-[12px] font-medium text-muted-foreground">
                  From
                </label>
                <Input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="block px-1 text-[12px] font-medium text-muted-foreground">
                  To
                </label>
                <Input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                className="w-full"
                disabled={!customFrom}
                onClick={() => setTimeRange("custom")}
              >
                Apply
              </Button>
            </PopoverContent>
          </Popover>
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
          <DashboardCharts snapshot={snapshot} timeSeries={timeSeries} />
        </>
      )}
    </div>
  );
}
