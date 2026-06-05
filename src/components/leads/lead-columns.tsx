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
    accessorKey: "job_title",
    header: ({ column }) => <SortHeader column={column} label="Job Title" />,
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
    accessorKey: "company_name_raw",
    header: ({ column }) => <SortHeader column={column} label="Company Name" />,
    cell: ({ getValue }) => (
      <span className="text-[13px]">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "general_industry",
    header: ({ column }) => <SortHeader column={column} label="General Industry" />,
    cell: ({ getValue }) => (
      <span className="block max-w-[140px] truncate text-[13px]">
        {(getValue() as string) ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "specific_industry",
    header: ({ column }) => <SortHeader column={column} label="Specific Industry" />,
    cell: ({ getValue }) => (
      <span className="block max-w-[140px] truncate text-[13px]">
        {(getValue() as string) ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "phone",
    header: ({ column }) => <SortHeader column={column} label="Phone" />,
    cell: ({ getValue }) => (
      <span className="text-[13px]">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "company_size",
    header: ({ column }) => <SortHeader column={column} label="Company Size" />,
    cell: ({ getValue }) => {
      const v = getValue() as number | null;
      return <span className="text-[13px] tabular-nums">{v != null ? v.toLocaleString() : "—"}</span>;
    },
  },
  {
    accessorKey: "annual_revenue",
    header: ({ column }) => <SortHeader column={column} label="Annual Revenue" />,
    cell: ({ getValue }) => {
      const v = getValue() as number | null;
      if (v == null) return <span className="text-[13px]">—</span>;
      if (v >= 1e9) return <span className="text-[13px] tabular-nums">${(v / 1e9).toFixed(1)}B</span>;
      if (v >= 1e6) return <span className="text-[13px] tabular-nums">${(v / 1e6).toFixed(1)}M</span>;
      if (v >= 1e3) return <span className="text-[13px] tabular-nums">${(v / 1e3).toFixed(0)}K</span>;
      return <span className="text-[13px] tabular-nums">${v.toLocaleString()}</span>;
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
    accessorKey: "website",
    header: ({ column }) => <SortHeader column={column} label="Website" />,
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      if (!v) return <span className="text-[13px] text-muted-foreground">—</span>;
      const href = v.startsWith("http") ? v : `https://${v}`;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="block max-w-[160px] truncate text-[13px] font-medium text-primary hover:opacity-80"
          onClick={(e) => e.stopPropagation()}
        >
          {v}
        </a>
      );
    },
  },
];
