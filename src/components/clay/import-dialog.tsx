"use client";

import { useCallback, useMemo, useState } from "react";
import Papa from "papaparse";
import { useDropzone } from "react-dropzone";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { EnrichColumn } from "@/lib/enrich/types";

// Import a CSV into a Clay-tab table — typically the client's own Clay table
// exported as CSV. Columns are matched to the table's columns by name. Input
// columns (Company, place_id, Website …) become the new rows; every other
// matched column (Service Area Check, Use Website …) is kept as "Clay had", so
// each cell can show whether the database's run agrees with Clay's.

const CHUNK = 1_000;

type Parsed = { file: string; rows: Record<string, string>[]; headers: string[] };

export function ImportDialog({
  open,
  onOpenChange,
  tableId,
  tableLabel,
  columns,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tableId: string;
  tableLabel: string;
  columns: EnrichColumn[];
  onDone: () => void;
}) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [progress, setProgress] = useState<{ done: number; created: number; duplicates: number; skipped: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const onDrop = useCallback((files: File[]) => {
    const f = files[0];
    if (!f) return;
    Papa.parse<Record<string, string>>(f, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => setParsed({ file: f.name, rows: res.data, headers: res.meta.fields ?? [] }),
      error: (err) => toast.error(`Could not read the CSV: ${err.message}`),
    });
  }, []);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: { "text/csv": [".csv"] }, multiple: false });

  const mapping = useMemo(() => {
    if (!parsed) return null;
    const byName = new Map<string, EnrichColumn>();
    for (const c of columns) {
      byName.set(c.name.trim().toLowerCase(), c);
      byName.set(c.key, c);
    }
    const inputs: [string, EnrichColumn][] = [];
    const reference: [string, EnrichColumn][] = [];
    const ignored: string[] = [];
    for (const h of parsed.headers) {
      const col = byName.get(h.trim().toLowerCase());
      if (!col) ignored.push(h);
      else if (col.kind === "input") inputs.push([h, col]);
      else reference.push([h, col]);
    }
    return { inputs, reference, ignored };
  }, [parsed, columns]);

  const canImport = !!mapping && mapping.inputs.some(([, c]) => c.key === "company" || c.key === "place_id");

  const reset = () => {
    setParsed(null);
    setProgress(null);
  };

  const start = async () => {
    if (!parsed || !mapping) return;
    setBusy(true);
    const total = { done: 0, created: 0, duplicates: 0, skipped: 0 };
    setProgress({ ...total });
    try {
      for (let i = 0; i < parsed.rows.length; i += CHUNK) {
        const rows = parsed.rows.slice(i, i + CHUNK).map((r) => ({
          inputs: Object.fromEntries(mapping.inputs.map(([h, c]) => [c.key, r[h] ?? ""])),
          reference: Object.fromEntries(mapping.reference.map(([h, c]) => [c.key, r[h] ?? ""])),
        }));
        const res = await fetch("/api/enrich/rows", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ table: tableId, label: parsed.file, rows }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `Import stopped at row ${i + 1}`);
        total.done += rows.length;
        total.created += j.created;
        total.duplicates += j.duplicates;
        total.skipped += j.skipped;
        setProgress({ ...total });
      }
      toast.success(`${total.created.toLocaleString("en-US")} rows added — the worker is running them now.`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import CSV into {tableLabel}</DialogTitle>
          <DialogDescription>
            Export the client&apos;s Clay table as CSV and drop it here. Rows are added by place id (or name and address) and run
            through this table&apos;s steps. Clay&apos;s own results are kept beside ours for comparison.
          </DialogDescription>
        </DialogHeader>

        {!parsed ? (
          <div
            {...getRootProps()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
              isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50"
            }`}
          >
            <input {...getInputProps()} />
            <Upload className="size-8 text-muted-foreground" strokeWidth={1.5} />
            <p className="text-[14px] font-medium">{isDragActive ? "Drop the CSV" : "Drag a CSV here, or click to choose one"}</p>
          </div>
        ) : (
          <div className="space-y-3 text-[13px]">
            <div className="flex items-center gap-2 rounded-xl bg-muted/70 px-3 py-2">
              <FileSpreadsheet className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{parsed.file}</span>
              <span className="text-muted-foreground">{parsed.rows.length.toLocaleString("en-US")} rows</span>
            </div>
            {mapping && (
              <div className="space-y-2">
                <p>
                  <span className="font-semibold">New rows from: </span>
                  {mapping.inputs.length ? mapping.inputs.map(([h]) => h).join(", ") : <span className="text-destructive">no matching input columns</span>}
                </p>
                {mapping.reference.length > 0 && (
                  <p className="text-muted-foreground">
                    <span className="font-semibold text-foreground">Kept as &ldquo;Clay had&rdquo;: </span>
                    {mapping.reference.length} columns ({mapping.reference.slice(0, 6).map(([h]) => h).join(", ")}
                    {mapping.reference.length > 6 ? " …" : ""})
                  </p>
                )}
                {mapping.ignored.length > 0 && (
                  <p className="text-muted-foreground">
                    <span className="font-semibold text-foreground">Ignored: </span>
                    {mapping.ignored.slice(0, 8).join(", ")}
                    {mapping.ignored.length > 8 ? ` +${mapping.ignored.length - 8}` : ""}
                  </p>
                )}
                {!canImport && <p className="text-destructive">The CSV needs a Company or place_id column.</p>}
              </div>
            )}
            {progress && (
              <div className="space-y-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${(progress.done / Math.max(1, parsed.rows.length)) * 100}%` }} />
                </div>
                <p className="text-[12px] text-muted-foreground">
                  {progress.done.toLocaleString("en-US")} read · {progress.created.toLocaleString("en-US")} added ·{" "}
                  {progress.duplicates.toLocaleString("en-US")} already in the table · {progress.skipped.toLocaleString("en-US")} unusable
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {parsed && !busy && !progress && (
            <Button variant="ghost" size="sm" onClick={reset}>
              Choose another file
            </Button>
          )}
          {progress && !busy ? (
            <Button size="sm" onClick={() => { reset(); onOpenChange(false); }}>
              Done
            </Button>
          ) : (
            <Button size="sm" disabled={!canImport || busy} onClick={start}>
              {busy && <Loader2 className="animate-spin" />}
              Import {parsed ? parsed.rows.length.toLocaleString("en-US") : ""} rows
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
