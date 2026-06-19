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
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import type { DashboardSnapshot } from "@/types/database";

interface DashboardChartsProps {
  snapshot: DashboardSnapshot | null;
}

const IOS = ["#007AFF", "#34C759", "#FF9500", "#FF3B30", "#5856D6", "#AF52DE", "#5AC8FA"];

function NoData() {
  return <p className="py-8 text-center text-[13px] text-muted-foreground">No data available</p>;
}

const TOOLTIP_STYLE = {
  fontSize: 12,
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  color: "var(--foreground)",
};

export function DashboardCharts({ snapshot }: DashboardChartsProps) {
  const s = snapshot?.stats;
  if (!s) return null;

  const byState = (s.by_state ?? []).slice(0, 15);
  const byEsp = s.by_esp ?? [];
  const eng = s.engagement ?? { emails_sent: 0, opens: 0, replies: 0, bounces: 0 };
  const timeData = (s.leads_over_time ?? []).map((p) => ({
    date: new Date(p.date + "-01").toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
    count: p.count,
  }));

  const engTiles = [
    { label: "Emails sent", value: eng.emails_sent, tint: "text-[oklch(0.586_0.214_263)]" },
    { label: "Opens", value: eng.opens, tint: "text-[oklch(0.745_0.183_145)]" },
    { label: "Replies", value: eng.replies, tint: "text-[oklch(0.78_0.175_65)]" },
    { label: "Bounces", value: eng.bounces, tint: "text-[oklch(0.65_0.235_25)]" },
  ];

  return (
    <div className="space-y-4 text-foreground">
      {/* Engagement summary tiles */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px]">Campaign Engagement (Email Bison)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {engTiles.map((t) => (
              <div key={t.label} className="rounded-2xl bg-muted/40 p-4">
                <p className="text-[12px] font-medium text-muted-foreground">{t.label}</p>
                <p className={`mt-1 text-[26px] font-semibold leading-none tracking-tight ${t.tint}`}>
                  {t.value.toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Leads by State */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px]">Leads by State (top 15)</CardTitle>
          </CardHeader>
          <CardContent>
            {byState.length === 0 ? (
              <NoData />
            ) : (
              <div className="max-h-[460px] overflow-y-auto">
                <ResponsiveContainer width="100%" height={byState.length * 32 + 30}>
                  <BarChart data={byState} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }} barCategoryGap="22%">
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "currentColor" }} tickFormatter={(v: number) => v.toLocaleString()} />
                    <YAxis dataKey="state" type="category" width={56} tick={{ fontSize: 11, fill: "currentColor" }} tickLine={false} interval={0} />
                    <Tooltip formatter={(v: number) => [v.toLocaleString(), "Leads"]} contentStyle={TOOLTIP_STYLE} />
                    <Bar dataKey="count" fill="#007AFF" radius={[0, 8, 8, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Leads by ESP (pie) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px]">Leads by ESP</CardTitle>
          </CardHeader>
          <CardContent>
            {byEsp.length === 0 ? (
              <NoData />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={byEsp} dataKey="count" nameKey="esp" cx="50%" cy="50%" outerRadius={90} label={(e) => e.esp}>
                    {byEsp.map((_, i) => (
                      <Cell key={i} fill={IOS[i % IOS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => [v.toLocaleString(), "Leads"]} contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Leads over time */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px]">Leads Added Over Time</CardTitle>
        </CardHeader>
        <CardContent>
          {timeData.length < 1 ? (
            <NoData />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={timeData} margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="leadsGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#007AFF" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#007AFF" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "currentColor" }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "currentColor" }} tickFormatter={(v: number) => v.toLocaleString()} />
                <Tooltip formatter={(v: number) => [v.toLocaleString(), "Leads"]} contentStyle={TOOLTIP_STYLE} />
                <Area type="monotone" dataKey="count" stroke="#007AFF" strokeWidth={2} fill="url(#leadsGradient)" dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
