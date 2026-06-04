"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Briefcase, Building2, Factory } from "lucide-react";
import type { DashboardSnapshot } from "@/types/database";

interface StatCardsProps {
  snapshot: DashboardSnapshot | null;
}

export function StatCards({ snapshot }: StatCardsProps) {
  const stats = [
    {
      label: "Total Leads",
      value: snapshot?.total_leads,
      icon: Users,
    },
    {
      label: "Job Titles",
      value: snapshot?.total_job_titles,
      icon: Briefcase,
    },
    {
      label: "General Industries",
      value: snapshot?.total_general_industries,
      icon: Building2,
    },
    {
      label: "Specific Industries",
      value: snapshot?.total_specific_industries,
      icon: Factory,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <Card key={stat.label}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {stat.label}
            </CardTitle>
            <stat.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {stat.value != null ? stat.value.toLocaleString() : "—"}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
