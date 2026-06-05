"use client";

import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { parse } from "papaparse";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Upload, Mail, X, ArrowLeft, CheckCircle2, AlertTriangle } from "lucide-react";
import { useHasPermission } from "@/lib/context/role-context";
import { AccessDenied } from "@/components/layout/access-denied";
import Link from "next/link";

type Step = "drop" | "map" | "processing" | "done";

interface ParsedCsv {
  headers: string[];
  preview: string[][];
  fullText: string;
  filename: string;
  totalRows: number;
}

interface Result {
  matched: number;
  unmatched: number;
  total: number;
}

export default function BounceUploadsPage() {
  const canView = useHasPermission("admin");
  const [step, setStep] = useState<Step>("drop");
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [emailColumnIndex, setEmailColumnIndex] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "text/csv": [".csv"], "application/vnd.ms-excel": [".csv"] },
    multiple: false,
    onDrop: async (files) => {
      const file = files[0];
      if (!file) return;
      const text = await file.text();
      parse<string[]>(text, {
        skipEmptyLines: true,
        complete: (res) => {
          const rows = res.data as string[][];
          if (rows.length < 1) {
            toast.error("CSV is empty");
            return;
          }
          const headers = rows[0];
          const preview = rows.slice(1, 6);
          // Auto-pick the email column if obvious
          let guess: number | null = null;
          headers.forEach((h, i) => {
            if (guess === null && /email/i.test(h)) guess = i;
          });
          setParsed({
            headers,
            preview,
            fullText: text,
            filename: file.name,
            totalRows: rows.length - 1,
          });
          setEmailColumnIndex(guess);
          setStep("map");
        },
        error: (err: Error) => toast.error(`CSV parse failed: ${err.message}`),
      });
    },
  });

  async function handleStart() {
    if (!parsed || emailColumnIndex === null) {
      toast.error("Pick the email column first");
      return;
    }
    setStep("processing");
    try {
      const res = await fetch("/api/uploads/bounces", {
        method: "POST",
        headers: {
          "Content-Type": "text/csv",
          "X-Upload-Config": JSON.stringify({
            emailColumnIndex,
            filename: parsed.filename,
          }),
        },
        body: parsed.fullText,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Bounce import failed");
        setStep("map");
        return;
      }
      setResult(data as Result);
      setStep("done");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bounce import failed");
      setStep("map");
    }
  }

  function reset() {
    setStep("drop");
    setParsed(null);
    setEmailColumnIndex(null);
    setResult(null);
  }

  if (!canView) return <AccessDenied />;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Bounce upload</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Mark contacts as bounced from an Email Bison bounce export
          </p>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/uploads">
            <ArrowLeft className="size-3.5" strokeWidth={2} />
            All uploads
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[17px]">
            <Mail className="size-5 text-destructive" strokeWidth={1.75} />
            Drop a CSV with an email column
            {parsed && step !== "drop" && (
              <Badge variant="tinted" className="ml-2">
                {parsed.filename} — {parsed.totalRows.toLocaleString()} rows
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {step === "drop" && (
            <div
              {...getRootProps()}
              className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-12 text-center transition-colors ${
                isDragActive
                  ? "border-primary bg-primary/5"
                  : "border-border bg-muted/40 hover:bg-muted/60"
              }`}
            >
              <input {...getInputProps()} />
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                <Upload className="size-7" strokeWidth={1.75} />
              </div>
              <div className="space-y-1">
                <p className="text-[15px] font-semibold">
                  {isDragActive ? "Drop the CSV here" : "Drag & drop a CSV, or click to browse"}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  Only the email column is read. Other columns are ignored.
                </p>
              </div>
            </div>
          )}

          {step === "map" && parsed && (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <label className="block px-1 text-[12px] font-medium text-muted-foreground">
                  Which column has the email?
                </label>
                <Select
                  value={emailColumnIndex !== null ? String(emailColumnIndex) : undefined}
                  onValueChange={(v) => setEmailColumnIndex(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a column…" />
                  </SelectTrigger>
                  <SelectContent>
                    {parsed.headers.map((h, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {h || `Column ${i + 1}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {emailColumnIndex !== null && parsed.preview.length > 0 && (
                <div className="space-y-1.5">
                  <label className="block px-1 text-[12px] font-medium text-muted-foreground">
                    Preview ({parsed.headers[emailColumnIndex] || `Column ${emailColumnIndex + 1}`})
                  </label>
                  <div className="overflow-hidden rounded-xl bg-muted/40 [&>*:not(:first-child)]:border-t [&>*:not(:first-child)]:border-border/40">
                    {parsed.preview.slice(0, 5).map((row, i) => (
                      <div key={i} className="px-4 py-2 text-[13px] tabular-nums">
                        {row[emailColumnIndex] || <span className="text-muted-foreground">—</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={reset}>
                  Cancel
                </Button>
                <Button onClick={handleStart} disabled={emailColumnIndex === null}>
                  Mark {parsed.totalRows.toLocaleString()} as bounced
                </Button>
              </div>
            </div>
          )}

          {step === "processing" && (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
              <div className="size-10 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
              <p className="text-[14px] text-muted-foreground">
                Marking contacts as bounced…
              </p>
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-5">
              <div className="flex items-center gap-3 rounded-2xl bg-[var(--success)]/10 px-4 py-3">
                <CheckCircle2 className="size-6 shrink-0 text-[var(--success)]" strokeWidth={2} />
                <div>
                  <p className="text-[15px] font-semibold">Done</p>
                  <p className="text-[13px] text-muted-foreground">
                    {result.matched.toLocaleString()} contact
                    {result.matched === 1 ? "" : "s"} marked as bounced.
                  </p>
                </div>
              </div>

              {result.unmatched > 0 && (
                <div className="flex items-center gap-3 rounded-2xl bg-[var(--warning)]/10 px-4 py-3">
                  <AlertTriangle className="size-5 shrink-0 text-[var(--warning)]" strokeWidth={2} />
                  <p className="text-[13px] text-muted-foreground">
                    <span className="font-semibold text-foreground">
                      {result.unmatched.toLocaleString()}
                    </span>{" "}
                    email{result.unmatched === 1 ? " was" : "s were"} not found in the
                    database — these were silently skipped.
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={reset}>
                  <X className="size-3.5" strokeWidth={2} />
                  Upload another
                </Button>
                <Button asChild>
                  <Link href="/leads">View leads</Link>
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
