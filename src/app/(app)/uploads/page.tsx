"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload } from "lucide-react";
import { CSVDropzone } from "@/components/uploads/csv-dropzone";
import { FieldMapper } from "@/components/uploads/field-mapper";
import { DuplicateStrategy } from "@/components/uploads/duplicate-strategy";
import { UploadProgress } from "@/components/uploads/upload-progress";
import type { ParseResult } from "@/lib/uploads/parse-csv";
import type { FieldMapping } from "@/lib/uploads/normalize-row";
import type { UploadBatch } from "@/types/database";
import { useHasPermission } from "@/lib/context/role-context";
import { AccessDenied } from "@/components/layout/access-denied";

type Step = "drop" | "map" | "strategy" | "processing";

export default function UploadsPage() {
  const canView = useHasPermission("admin");
  const [step, setStep] = useState<Step>("drop");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [csvFiles, setCsvFiles] = useState<File[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [fieldMapping, setFieldMapping] = useState<FieldMapping>({});
  const [strategy, setStrategy] = useState<"skip" | "merge" | "replace">("skip");
  const [overrideFields, setOverrideFields] = useState<string[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [history, setHistory] = useState<UploadBatch[]>([]);

  const loadHistory = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("upload_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    if (data) setHistory(data as UploadBatch[]);
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  function handleFilesParsed(result: ParseResult, files: File[]) {
    setParseResult(result);
    setCsvFiles(files);
    setCurrentFileIndex(0);
    setStep("map");
  }

  function handleMappingConfirm(mapping: FieldMapping) {
    setFieldMapping(mapping);
    setStep("strategy");
  }

  async function uploadFile(file: File, mapping: FieldMapping, headers: string[]) {
    const csvText = await file.text();
    const res = await fetch("/api/uploads/process", {
      method: "POST",
      headers: {
        "Content-Type": "text/csv",
        "X-Upload-Config": JSON.stringify({
          headers,
          fieldMapping: mapping,
          duplicateStrategy: strategy,
          overrideFields: strategy === "replace" ? overrideFields : [],
          filename: file.name,
        }),
      },
      body: csvText,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.batchId as string;
  }

  async function handleStartUpload() {
    if (!parseResult || csvFiles.length === 0) return;
    setStep("processing");
    setCurrentFileIndex(0);

    // Process files sequentially
    for (let i = 0; i < csvFiles.length; i++) {
      setCurrentFileIndex(i);
      try {
        const id = await uploadFile(csvFiles[i], fieldMapping, parseResult.headers);
        setBatchId(id);
        // Wait for this batch to finish before starting next
        // UploadProgress handles polling; for multi-file we await via a Promise
        await new Promise<void>((resolve) => {
          const interval = setInterval(async () => {
            const supabase = (await import("@/lib/supabase/client")).createClient();
            const { data } = await supabase
              .from("upload_batches")
              .select("status")
              .eq("id", id)
              .single();
            if (data?.status === "complete" || data?.status === "error") {
              clearInterval(interval);
              resolve();
            }
          }, 2000);
        });
      } catch (err) {
        toast.error(`Failed on ${csvFiles[i].name}: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }

    loadHistory();
    resetWizard();
  }

  function resetWizard() {
    setStep("drop");
    setParseResult(null);
    setCsvFiles([]);
    setCurrentFileIndex(0);
    setFieldMapping({});
    setStrategy("skip");
    setOverrideFields([]);
    setBatchId(null);
    loadHistory();
  }

  const fileLabel = csvFiles.length > 1
    ? `${csvFiles.length} files · ${parseResult?.totalRows.toLocaleString() ?? 0} rows (first file)`
    : csvFiles[0]
    ? `${csvFiles[0].name} — ${parseResult?.totalRows.toLocaleString() ?? 0} rows`
    : "";

  if (!canView) return <AccessDenied />;

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-lg font-semibold">Uploads</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="h-4 w-4" />
            Upload CSV
            {parseResult && step !== "drop" && (
              <Badge variant="secondary" className="text-xs ml-2">
                {fileLabel}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {step === "drop" && (
            <CSVDropzone
              onFilesParsed={handleFilesParsed}
              onError={(msg) => toast.error(msg)}
            />
          )}
          {step === "map" && parseResult && (
            <FieldMapper
              headers={parseResult.headers}
              preview={parseResult.preview}
              onConfirm={handleMappingConfirm}
              onBack={() => setStep("drop")}
            />
          )}
          {step === "strategy" && (
            <DuplicateStrategy
              value={strategy}
              onChange={setStrategy}
              overrideFields={overrideFields}
              onOverrideFieldsChange={setOverrideFields}
              mappedFields={Object.values(fieldMapping).filter(Boolean) as string[]}
              onConfirm={handleStartUpload}
              onBack={() => setStep("map")}
            />
          )}
          {step === "processing" && batchId && (
            <div className="space-y-2">
              {csvFiles.length > 1 && (
                <p className="text-xs text-muted-foreground">
                  Processing file {currentFileIndex + 1} of {csvFiles.length}: {csvFiles[currentFileIndex]?.name}
                </p>
              )}
              <UploadProgress batchId={batchId} onDone={() => {}} />
            </div>
          )}
          {step === "processing" && !batchId && (
            <p className="text-sm text-muted-foreground">Starting upload...</p>
          )}
        </CardContent>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">File</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Total</TableHead>
                    <TableHead className="text-xs">Skipped</TableHead>
                    <TableHead className="text-xs">Merged</TableHead>
                    <TableHead className="text-xs">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell className="text-xs">
                        {batch.filename ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            batch.status === "complete"
                              ? "default"
                              : batch.status === "error"
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-xs"
                        >
                          {batch.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {batch.total_rows?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {batch.skipped_rows.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        {batch.merged_rows.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        {new Date(batch.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
