"use client";

import { Card } from "@/components/ui/card";
import { Users, UserCheck, Inbox, MailWarning } from "lucide-react";
import type { DashboardSnapshot } from "@/types/database";

interface StatCardsProps {
  snapshot: DashboardSnapshot | null;
}

export function StatCards({ snapshot }: StatCardsProps) {
  const s = snapshot?.stats ?? null;
  const stats = [
    {
      label: "Total Leads",
      value: s?.total_leads ?? snapshot?.total_leads ?? null,
      icon: Users,
      tint: "text-[oklch(0.586_0.214_263)]",
      bg: "bg-[oklch(0.586_0.214_263)]/12",
    },
    {
      label: "Personal (Decision-makers)",
      value: s?.personal ?? null,
      icon: UserCheck,
      tint: "text-[oklch(0.745_0.183_145)]",
      bg: "bg-[oklch(0.745_0.183_145)]/12",
    },
    {
      label: "General (Shared inboxes)",
      value: s?.general ?? null,
      icon: Inbox,
      tint: "text-[oklch(0.78_0.175_65)]",
      bg: "bg-[oklch(0.78_0.175_65)]/12",
    },
    {
      label: "Bounced (excluded)",
      value: s?.bounced ?? null,
      icon: MailWarning,
      tint: "text-[oklch(0.65_0.235_25)]",
      bg: "bg-[oklch(0.65_0.235_25)]/12",
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label} className="gap-3 p-5">
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-medium text-muted-foreground">{stat.label}</p>
            <div className={`flex size-9 items-center justify-center rounded-xl ${stat.bg}`}>
              <stat.icon className={`size-[18px] ${stat.tint}`} strokeWidth={1.75} />
            </div>
          </div>
          <p className="text-[32px] font-semibold leading-none tracking-tight">
            {stat.value != null ? stat.value.toLocaleString() : "—"}
          </p>
        </Card>
      ))}
    </div>
  );
}
