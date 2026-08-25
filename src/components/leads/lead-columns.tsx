"use client";

import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import type { Lead } from "@/types/database";
// Sorting and the per-column value filter both live here now, and both act on
// the WHOLE filtered set rather than the loaded page. The old local SortHeader
// called column.toggleSorting(), which only reordered the ~50 rows on screen.
import { SortHeader } from "./column-header-controls";

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

/**
 * "Main Campaigns" — shows Pushed when this lead has already been sent to a
 * MAIN (non-Nurture) campaign for the CURRENTLY SELECTED client.
 *
 * A factory rather than a static entry because it closes over live state: the
 * pushed set arrives from /api/leads/push-status after the rows render, so the
 * column must re-render when it lands. Only added when a client is selected —
 * "pushed" is meaningless without one.
 *
 * `loaded` distinguishes "we know this lead was not pushed" (—) from "we have
 * not heard back yet" (blank), so an in-flight lookup never reads as a No.
 */
export function mainCampaignsColumn(
  pushedIds: Set<string>,
  loaded: boolean
): ColumnDef<Lead> {
  return {
    id: "main_campaigns",
    header: () => <span className="text-[13px] font-medium">Main Campaigns</span>,
    enableSorting: false,
    cell: ({ row }) => {
      if (!loaded) return <span className="text-[13px] text-muted-foreground/40">·</span>;
      return pushedIds.has(row.original.id) ? (
        <Badge variant="success">Pushed</Badge>
      ) : (
        <span className="text-[13px] text-muted-foreground">—</span>
      );
    },
  };
}
