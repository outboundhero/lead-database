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
      className="h-8 -ml-3 text-xs"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label}
      <ArrowUpDown className="ml-1 h-3 w-3" />
    </Button>
  );
}

export const leadColumns: ColumnDef<Lead>[] = [
  {
    accessorKey: "first_name",
    header: ({ column }) => <SortHeader column={column} label="First Name" />,
    cell: ({ getValue }) => (
      <span className="text-xs font-medium">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "last_name",
    header: ({ column }) => <SortHeader column={column} label="Last Name" />,
    cell: ({ getValue }) => (
      <span className="text-xs font-medium">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "email",
    header: ({ column }) => <SortHeader column={column} label="Email" />,
    cell: ({ getValue }) => (
      <span className="text-xs text-muted-foreground">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "source",
    header: ({ column }) => <SortHeader column={column} label="Source" />,
    cell: ({ getValue }) => {
      const val = getValue() as string | null;
      if (!val) return <span className="text-xs text-muted-foreground">—</span>;
      return <Badge variant="secondary" className="text-xs">{val}</Badge>;
    },
  },
  {
    accessorKey: "job_title",
    header: ({ column }) => <SortHeader column={column} label="Job Title" />,
    cell: ({ getValue }) => {
      const raw = getValue() as string | null;
      if (!raw) return <span className="text-xs text-muted-foreground">—</span>;
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
        <span className="text-xs truncate max-w-[160px] block">
          {display || "—"}
        </span>
      );
    },
  },
  {
    accessorKey: "company_name_raw",
    header: ({ column }) => <SortHeader column={column} label="Company Name" />,
    cell: ({ getValue }) => (
      <span className="text-xs">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "general_industry",
    header: ({ column }) => <SortHeader column={column} label="General Industry" />,
    cell: ({ getValue }) => (
      <span className="text-xs truncate max-w-[140px] block">
        {(getValue() as string) ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "specific_industry",
    header: ({ column }) => <SortHeader column={column} label="Specific Industry" />,
    cell: ({ getValue }) => (
      <span className="text-xs truncate max-w-[140px] block">
        {(getValue() as string) ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "phone",
    header: ({ column }) => <SortHeader column={column} label="Phone" />,
    cell: ({ getValue }) => (
      <span className="text-xs">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "company_size",
    header: ({ column }) => <SortHeader column={column} label="Company Size" />,
    cell: ({ getValue }) => {
      const v = getValue() as number | null;
      return <span className="text-xs">{v != null ? v.toLocaleString() : "—"}</span>;
    },
  },
  {
    accessorKey: "annual_revenue",
    header: ({ column }) => <SortHeader column={column} label="Annual Revenue" />,
    cell: ({ getValue }) => {
      const v = getValue() as number | null;
      if (v == null) return <span className="text-xs">—</span>;
      if (v >= 1e9) return <span className="text-xs">${(v / 1e9).toFixed(1)}B</span>;
      if (v >= 1e6) return <span className="text-xs">${(v / 1e6).toFixed(1)}M</span>;
      if (v >= 1e3) return <span className="text-xs">${(v / 1e3).toFixed(0)}K</span>;
      return <span className="text-xs">${v.toLocaleString()}</span>;
    },
  },
  {
    accessorKey: "esp",
    header: ({ column }) => <SortHeader column={column} label="ESP" />,
    cell: ({ getValue }) => (
      <span className="text-xs">{(getValue() as string) ?? "—"}</span>
    ),
  },
  {
    accessorKey: "website",
    header: ({ column }) => <SortHeader column={column} label="Website" />,
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      if (!v) return <span className="text-xs text-muted-foreground">—</span>;
      const href = v.startsWith("http") ? v : `https://${v}`;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline truncate max-w-[160px] block"
          onClick={(e) => e.stopPropagation()}
        >
          {v}
        </a>
      );
    },
  },
];
