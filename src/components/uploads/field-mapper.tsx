"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
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

export function FieldMapper({
  headers,
  preview,
  onConfirm,
  onBack,
}: FieldMapperProps) {
  const [mapping, setMapping] = useState<Record<number, string>>({});

  // Auto-match on mount
  useEffect(() => {
    const auto: Record<number, string> = {};
    headers.forEach((header, idx) => {
      const match = autoMatchField(header);
      if (match) auto[idx] = match;
    });
    setMapping(auto);
  }, [headers]);

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
              <TableHead>Preview</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {headers.map((header, idx) => (
              <TableRow key={idx}>
                <TableCell className="font-medium text-xs">{header}</TableCell>
                <TableCell>
                  <Select
                    value={mapping[idx] ?? SKIP_VALUE}
                    onValueChange={(v) => setField(idx, v)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Skip" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP_VALUE} className="text-xs">
                        — Skip —
                      </SelectItem>
                      {LEAD_FIELDS.map((field) => (
                        <SelectItem
                          key={field.key}
                          value={field.key}
                          className="text-xs"
                          disabled={
                            usedFields.has(field.key) &&
                            mapping[idx] !== field.key
                          }
                        >
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground truncate max-w-[300px]">
                  {preview
                    .slice(0, 3)
                    .map((row) => row[idx] ?? "")
                    .join(" | ")}
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
