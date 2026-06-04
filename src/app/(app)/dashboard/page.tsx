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
    <div className="space-y-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7 gap-1"
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
            <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
          {(["all", "7d", "30d"] as TimeRange[]).map((range) => (
            <Button
              key={range}
              variant={timeRange === range ? "default" : "outline"}
              size="sm"
              className="text-xs h-7"
              onClick={() => setTimeRange(range)}
            >
              {range === "all" ? "All Time" : range === "7d" ? "7 Days" : "30 Days"}
            </Button>
          ))}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={timeRange === "custom" ? "default" : "outline"}
                size="sm"
                className="text-xs h-7 gap-1"
              >
                <CalendarDays className="h-3 w-3" />
                {timeRange === "custom" && customFrom
                  ? `${customFrom}${customTo ? ` — ${customTo}` : ""}`
                  : "Custom Range"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-3 space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">From</label>
                <Input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">To</label>
                <Input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <Button
                size="sm"
                className="w-full text-xs h-7"
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
        <p className="text-sm text-muted-foreground">Loading dashboard...</p>
      ) : !snapshot ? (
        <p className="text-sm text-muted-foreground">
          No dashboard snapshot available. Snapshots are generated periodically.
        </p>
      ) : (
        <>
          <StatCards snapshot={snapshot} />
          <DashboardCharts snapshot={snapshot} timeSeries={timeSeries} />
        </>
      )}
    </div>
  );
}
