"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";
import type { DashboardSnapshot } from "@/types/database";
import { COMPANY_SIZE_BUCKETS } from "@/types/database";

type TimePoint = { date: string; total: number };

interface DashboardChartsProps {
  snapshot: DashboardSnapshot | null;
  timeSeries: TimePoint[];
}

function NoData() {
  return <p className="text-xs text-muted-foreground py-8 text-center">No data available</p>;
}

export function DashboardCharts({ snapshot, timeSeries }: DashboardChartsProps) {
  const jobTitleData = (snapshot?.leads_by_job_title ?? [])
    .sort((a, b) => b.count - a.count);

  const industryData = (snapshot?.leads_by_general_industry ?? [])
    .sort((a, b) => b.count - a.count);

  // Order company size by the defined bucket order
  const rawSizeData = snapshot?.leads_by_company_size ?? [];
  const companySizeData = COMPANY_SIZE_BUCKETS.map((bucket) => {
    const found = rawSizeData.find((d) => d.size === bucket);
    return { size: bucket, count: found?.count ?? 0 };
  }).filter((d) => d.count > 0);

  const timeSeriesData = timeSeries.map((p) => ({
    date: new Date(p.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    total: p.total,
  }));

  return (
    <div className="space-y-4 text-foreground">
      {/* Row 1: Job Title + Industry (horizontal bars) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Leads per Job Title */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px]">Leads per Job Title</CardTitle>
          </CardHeader>
          <CardContent>
            {jobTitleData.length === 0 ? (
              <NoData />
            ) : (
              <div className="max-h-[500px] overflow-y-auto">
                <ResponsiveContainer width="100%" height={jobTitleData.length * 40 + 40}>
                  <BarChart
                    data={jobTitleData}
                    layout="vertical"
                    margin={{ left: 12, right: 24, top: 4, bottom: 4 }}
                    barCategoryGap="24%"
                  >
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "currentColor" }} tickFormatter={(v: number) => v.toLocaleString()} />
                    <YAxis
                      dataKey="title"
                      type="category"
                      width={150}
                      tick={{ fontSize: 11, fill: "currentColor" }}
                      tickLine={false}
                      interval={0}
                    />
                    <Tooltip
                      formatter={(v: number) => [v.toLocaleString(), "Leads"]}
                      contentStyle={{ fontSize: 12, backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                    />
                    <Bar dataKey="count" fill="#007AFF" radius={[0, 8, 8, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Leads per General Industry */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px]">Leads per General Industry</CardTitle>
          </CardHeader>
          <CardContent>
            {industryData.length === 0 ? (
              <NoData />
            ) : (
              <div className="max-h-[500px] overflow-y-auto">
                <ResponsiveContainer width="100%" height={industryData.length * 40 + 40}>
                  <BarChart
                    data={industryData}
                    layout="vertical"
                    margin={{ left: 12, right: 24, top: 4, bottom: 4 }}
                    barCategoryGap="24%"
                  >
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "currentColor" }} tickFormatter={(v: number) => v.toLocaleString()} />
                    <YAxis
                      dataKey="industry"
                      type="category"
                      width={160}
                      tick={{ fontSize: 11, fill: "currentColor" }}
                      tickLine={false}
                      interval={0}
                    />
                    <Tooltip
                      formatter={(v: number) => [v.toLocaleString(), "Leads"]}
                      contentStyle={{ fontSize: 12, backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                    />
                    <Bar dataKey="count" fill="#34C759" radius={[0, 8, 8, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Company Size (vertical bar) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px]">Total Leads per Company Size</CardTitle>
        </CardHeader>
        <CardContent>
          {companySizeData.length === 0 ? (
            <NoData />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={companySizeData}
                margin={{ left: 8, right: 24, top: 4, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="size" tick={{ fontSize: 11, fill: "currentColor" }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "currentColor" }} tickFormatter={(v: number) => v.toLocaleString()} />
                <Tooltip
                  formatter={(v: number) => [v.toLocaleString(), "Leads"]}
                  contentStyle={{ fontSize: 12, backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                />
                <Bar dataKey="count" fill="#FF9500" radius={[8, 8, 0, 0]} maxBarSize={60} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Row 3: Total Leads Over Time (line/area chart) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px]">Total Leads Over Time</CardTitle>
        </CardHeader>
        <CardContent>
          {timeSeriesData.length < 2 ? (
            <div className="py-8 text-center">
              <p className="text-xs text-muted-foreground">
                {timeSeriesData.length === 0
                  ? "No snapshot history yet."
                  : "Only one snapshot recorded — more data points appear as snapshots accumulate daily."}
              </p>
              {timeSeriesData.length === 1 && (
                <p className="text-sm font-semibold mt-1">
                  {timeSeriesData[0].total.toLocaleString()} leads as of {timeSeriesData[0].date}
                </p>
              )}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={timeSeriesData} margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="leadsGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#007AFF" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#007AFF" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "currentColor" }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "currentColor" }} tickFormatter={(v: number) => v.toLocaleString()} />
                <Tooltip
                  formatter={(v: number) => [v.toLocaleString(), "Total Leads"]}
                  contentStyle={{ fontSize: 12, backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="#007AFF"
                  strokeWidth={2}
                  fill="url(#leadsGradient)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
