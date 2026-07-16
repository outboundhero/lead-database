"use client";

import { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Lead } from "@/types/database";

function SortHeader({ column, label }: { column: any; label: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label}
      <ArrowUpDown className="ml-1 size-3" strokeWidth={2} />
    </Button>
  );
}

export const leadColumns: ColumnDef<Lead>[] = [
  {
    accessorKey: "first_name",
    header: ({ column }) => <SortHeader column={column} label="First Name" />,
    cell: ({ getValue }) => (
      <span className="text-[14px] font-medium">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "last_name",
    header: ({ column }) => <SortHeader column={column} label="Last Name" />,
    cell: ({ getValue }) => (
      <span className="text-[14px] font-medium">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "email",
    header: ({ column }) => <SortHeader column={column} label="Email" />,
    cell: ({ getValue }) => (
      <span className="text-[13px] text-muted-foreground">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "source",
    header: ({ column }) => <SortHeader column={column} label="Source" />,
    cell: ({ getValue }) => {
      const val = getValue() as string | null;
      if (!val) return <span className="text-[13px] text-muted-foreground">—</span>;
      return <Badge variant="tinted">{val}</Badge>;
    },
  },
  {
    accessorKey: "title",
    header: ({ column }) => <SortHeader column={column} label="Title" />,
    cell: ({ getValue }) => {
      const raw = getValue() as string | null;
      if (!raw) return <span className="text-[13px] text-muted-foreground">—</span>;
      let titles: string[] = [];
      const trimmed = raw.trim();
      if (trimmed.startsWith("[")) {
        try {
          // Try JSON parse first (valid JSON arrays)
          titles = JSON.parse(trimmed);
        } catch {
          // Handle Python-style arrays like ['ceo', 'founder']
          titles = trimmed
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
            .filter(Boolean);
        }
      } else {
        titles = [raw];
      }
      const display = titles
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => t.split(" ").map((w) => w === w.toUpperCase() && w.length <= 4 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" "))
        .join(", ");
      return (
        <span className="block max-w-[160px] truncate text-[13px]">
          {display || "—"}
        </span>
      );
    },
  },
  {
    accessorKey: "company",
    header: ({ column }) => <SortHeader column={column} label="Company" />,
    cell: ({ getValue }) => (
      <span className="block max-w-[180px] truncate text-[13px]">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "city",
    header: ({ column }) => <SortHeader column={column} label="City" />,
    cell: ({ getValue }) => (
      <span className="text-[13px]">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "state",
    header: ({ column }) => <SortHeader column={column} label="State" />,
    cell: ({ getValue }) => (
      <span className="text-[13px] tabular-nums">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "email_type",
    header: ({ column }) => <SortHeader column={column} label="Type" />,
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      if (!v) return <span className="text-[13px] text-muted-foreground">—</span>;
      return <Badge variant={v === "personal" ? "tinted" : "secondary"}>{v}</Badge>;
    },
  },
  {
    accessorKey: "esp",
    header: ({ column }) => <SortHeader column={column} label="ESP" />,
    cell: ({ getValue }) => (
      <span className="text-[13px]">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "category",
    header: ({ column }) => <SortHeader column={column} label="Category" />,
    cell: ({ getValue }) => (
      <span className="text-[13px]">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "validation_status",
    header: ({ column }) => <SortHeader column={column} label="Validation" />,
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      if (!v) return <span className="text-[13px] text-muted-foreground">—</span>;
      // risky/unknown/pending are inconclusive, not dead — amber, not red.
      const variant = v === "valid" ? "success"
        : ["catch_all", "risky", "unknown", "pending"].includes(v) ? "warning"
        : "destructive";
      return <Badge variant={variant}>{v}</Badge>;
    },
  },
  {
    accessorKey: "replies",
    header: ({ column }) => <SortHeader column={column} label="Replies" />,
    cell: ({ getValue }) => {
      const v = getValue() as number | null;
      return <span className="text-[13px] tabular-nums">{v != null ? v.toLocaleString() : "—"}</span>;
    },
  },
];
