"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import type { LeadHistory as LeadHistoryType } from "@/types/database";

interface LeadHistoryProps {
  leadId: string;
}

const EVENT_STYLES: Record<string, { label: string; color: string }> = {
  created: { label: "Created", color: "bg-green-500" },
  updated: { label: "Updated", color: "bg-blue-500" },
  scraped: { label: "Scraped", color: "bg-purple-500" },
  exported: { label: "Exported", color: "bg-orange-500" },
};

export function LeadHistory({ leadId }: LeadHistoryProps) {
  const [history, setHistory] = useState<LeadHistoryType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchHistory() {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from("lead_history")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(50);

      if (!cancelled) {
        setHistory((data as LeadHistoryType[]) ?? []);
        setLoading(false);
      }
    }
    fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No history recorded.</p>
    );
  }

  return (
    <div className="space-y-3">
      {history.map((entry) => {
        const style = EVENT_STYLES[entry.event_type] ?? {
          label: entry.event_type,
          color: "bg-gray-500",
        };
        return (
          <div key={entry.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={`h-2 w-2 rounded-full mt-1.5 ${style.color}`} />
              <div className="flex-1 w-px bg-border" />
            </div>
            <div className="flex-1 pb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{style.label}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.created_at).toLocaleString()}
                </span>
              </div>
              {entry.performed_by_name && (
                <p className="text-xs text-muted-foreground">
                  by {entry.performed_by_name}
                </p>
              )}
              {entry.notes && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {entry.notes}
                </p>
              )}
              {entry.changed_fields && (
                <div className="mt-1 text-xs">
                  {Object.entries(entry.changed_fields).map(([field, change]) => (
                    <div key={field} className="text-muted-foreground">
                      <span className="font-medium">{field}:</span>{" "}
                      <span className="line-through">{String(change.old ?? "—")}</span>
                      {" → "}
                      <span>{String(change.new ?? "—")}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
