"use client";

import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LEAD_FIELDS, autoMatchField } from "@/lib/uploads/constants";
import type { FieldMapping } from "@/lib/uploads/normalize-row";

interface FieldMapperProps {
  headers: string[];
  preview: string[][];
  onConfirm: (mapping: FieldMapping) => void;
  onBack: () => void;
}

const SKIP_VALUE = "__skip__";
const PREVIEW_ROWS = 3;

function autoMap(headers: string[]): Record<number, string> {
  const auto: Record<number, string> = {};
  headers.forEach((header, idx) => {
    const match = autoMatchField(header);
    if (match) auto[idx] = match;
  });
  return auto;
}

// Searchable "Map to" picker. The target list is ~30 fields; the old plain
// dropdown meant scrolling the whole list for every column (client request,
// 2026-09-17: "use search to quickly locate fields instead of scrolling").
function FieldPicker({
  value,
  used,
  onChange,
}: {
  value: string | undefined;
  used: Set<string>;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const current = value ? LEAD_FIELDS.find((f) => f.key === value) : undefined;
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => LEAD_FIELDS.filter((f) => !q || f.label.toLowerCase().includes(q) || f.key.includes(q)),
    [q]
  );

  function pick(key: string) {
    onChange(key);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-8 w-[200px] justify-between text-xs font-normal ${current ? "" : "text-muted-foreground"}`}
        >
          <span className="truncate">{current ? current.label : "— Skip —"}</span>
          <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-2" onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}>
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter picks the first selectable match; Escape closes (Popover default).
              if (e.key === "Enter") {
                const first = matches.find((f) => !used.has(f.key) || f.key === value);
                if (first) pick(first.key);
              }
            }}
            placeholder="Search fields…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {!q && (
            <button
              type="button"
              onClick={() => pick(SKIP_VALUE)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
            >
              <span className="text-muted-foreground">— Skip —</span>
              {!value && <Check className="h-3.5 w-3.5" />}
            </button>
          )}
          {matches.map((f) => {
            const taken = used.has(f.key) && f.key !== value;
            const selected = f.key === value;
            return (
              <button
                key={f.key}
                type="button"
                disabled={taken}
                onClick={() => pick(f.key)}
                title={taken ? "Already mapped to another column" : undefined}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs ${
                  taken ? "cursor-not-allowed text-muted-foreground/50" : "hover:bg-muted"
                } ${selected ? "bg-muted" : ""}`}
              >
                <span>{f.label}</span>
                {selected && <Check className="h-3.5 w-3.5" />}
              </button>
            );
          })}
          {matches.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No field matches “{query}”</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FieldMapper({
  headers,
  preview,
  onConfirm,
  onBack,
}: FieldMapperProps) {
  // Auto-match once per set of headers. Derived-state reset during render
  // (the React-documented pattern) rather than a setState-in-effect, which
  // renders twice and trips react-hooks/set-state-in-effect.
  const [mapping, setMapping] = useState<Record<number, string>>(() => autoMap(headers));
  const [seenHeaders, setSeenHeaders] = useState(headers);
  if (seenHeaders !== headers) {
    setSeenHeaders(headers);
    setMapping(autoMap(headers));
  }

  function setField(index: number, value: string) {
    setMapping((prev) => {
      const next = { ...prev };
      if (value === SKIP_VALUE) {
        delete next[index];
      } else {
        next[index] = value;
      }
      return next;
    });
  }

  const hasEmail = Object.values(mapping).includes("email");
  const usedFields = new Set(Object.values(mapping));

  function handleConfirm() {
    const filtered: FieldMapping = {};
    for (const [idx, field] of Object.entries(mapping)) {
      filtered[Number(idx)] = field;
    }
    onConfirm(filtered);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">CSV Column</TableHead>
              <TableHead className="w-[220px]">Map To</TableHead>
              <TableHead>
                Preview
                <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground">
                  first {PREVIEW_ROWS} rows, one chip each — exactly as they appear in the file
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {headers.map((header, idx) => (
              <TableRow key={idx}>
                <TableCell className="font-medium text-xs">{header}</TableCell>
                <TableCell>
                  <FieldPicker
                    value={mapping[idx]}
                    used={usedFields}
                    onChange={(v) => setField(idx, v)}
                  />
                </TableCell>
                <TableCell className="text-xs">
                  {/* One chip per sample row. The old preview joined the three
                      values with " | ", which read as if the FILE contained
                      pipes — the exact artifact the client asked us to watch
                      for. Blanks are labelled so a missing value is visible. */}
                  <div className="flex max-w-[640px] flex-wrap gap-1">
                    {preview.slice(0, PREVIEW_ROWS).map((row, r) => {
                      const v = (row[idx] ?? "").trim();
                      return v ? (
                        <span
                          key={r}
                          title={v}
                          className="max-w-[300px] truncate rounded-md bg-muted px-1.5 py-0.5 text-foreground/80"
                        >
                          {v}
                        </span>
                      ) : (
                        <span key={r} className="rounded-md border border-dashed px-1.5 py-0.5 italic text-muted-foreground">
                          empty
                        </span>
                      );
                    })}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {!hasEmail && (
        <p className="text-xs text-destructive">
          Email column must be mapped — it is required for deduplication.
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={handleConfirm} disabled={!hasEmail}>
          Continue
        </Button>
      </div>
    </div>
  );
}
