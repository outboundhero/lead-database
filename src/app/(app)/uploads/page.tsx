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
import { DuplicateStrategy, parseTags } from "@/components/uploads/duplicate-strategy";
import { UploadProgress, HoldbackLinks } from "@/components/uploads/upload-progress";
import { detectDelimiter, type ParseResult } from "@/lib/uploads/parse-csv";
import type { FieldMapping } from "@/lib/uploads/normalize-row";
import { detectBisonFormat } from "@/lib/uploads/parse-bison";
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
  const [format, setFormat] = useState<"generic" | "bison">("generic");
  const [strategy, setStrategy] = useState<"skip" | "merge" | "replace">("skip");
  const [addTags, setAddTags] = useState("");
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
    // Email Bison exports have a fixed shape (custom_variables JSON, lead id, etc.)
    // — auto-detect and skip the manual field-mapping step.
    if (detectBisonFormat(result.headers)) {
      setFormat("bison");
      setStep("strategy");
    } else {
      setFormat("generic");
      setStep("map");
    }
  }

  function handleMappingConfirm(mapping: FieldMapping) {
    setFieldMapping(mapping);
    setStep("strategy");
  }

  async function uploadFile(file: File, mapping: FieldMapping, headers: string[]) {
    const [csvText, delimiter] = await Promise.all([file.text(), detectDelimiter(file)]);
    const res = await fetch("/api/uploads/process", {
      method: "POST",
      headers: {
        "Content-Type": "text/csv",
        // URI-encoded: header values must be Latin-1, filenames/CSV headers often are not.
        "X-Upload-Config": encodeURIComponent(JSON.stringify({
          headers,
          fieldMapping: mapping,
          duplicateStrategy: strategy,
          overrideFields: strategy === "replace" ? overrideFields : [],
          filename: file.name,
          format,
          delimiter,
          addTags: parseTags(addTags),
        })),
      },
      body: csvText,
    });
    // A proxy/timeout error page is not JSON; surface its text instead of a SyntaxError.
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    const data = isJson ? await res.json() : { error: (await res.text()).slice(0, 300) || res.statusText };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data.batchId as string;
  }

  // Wait for a batch's final status. The import runs on the server after the
  // POST returns; if its progress stops moving for STALL_MS (server restarted
  // mid-import) give up polling rather than spin forever.
  const STALL_MS = 15 * 60_000;
  async function waitForBatch(id: string): Promise<void> {
    const supabase = createClient();
    let lastProcessed = -1, lastChange = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data } = await supabase.from("upload_batches").select("status, processed_rows").eq("id", id).single();
      if (!data) continue;
      if (data.status === "complete" || data.status === "error") return;
      if (data.processed_rows !== lastProcessed) { lastProcessed = data.processed_rows; lastChange = Date.now(); }
      else if (Date.now() - lastChange > STALL_MS) {
        toast.error("This import has not progressed for 15 minutes — it may have stalled. Check Upload history later; rows imported so far are kept.");
        return;
      }
    }
  }

  async function handleStartUpload() {
    if (!parseResult || csvFiles.length === 0) return;
    setStep("processing");
    setCurrentFileIndex(0);

    // Process files sequentially; the panel follows the batch that is running.
    let lastId: string | null = null;
    for (let i = 0; i < csvFiles.length; i++) {
      setCurrentFileIndex(i);
      setBatchId(null);
      try {
        const id = await uploadFile(csvFiles[i], fieldMapping, parseResult.headers);
        setBatchId(id);
        lastId = id;
        await waitForBatch(id);
      } catch (err) {
        toast.error(`Failed on ${csvFiles[i].name}: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }

    loadHistory();
    // Leave the last batch's result on screen ("Upload Another" resets);
    // if nothing was even started there is nothing to show.
    if (!lastId) resetWizard();
  }

  function resetWizard() {
    setStep("drop");
    setParseResult(null);
    setCsvFiles([]);
    setCurrentFileIndex(0);
    setFieldMapping({});
    setFormat("generic");
    setStrategy("skip");
    setAddTags("");
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
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">Uploads</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Import leads from CSV files
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[17px]">
            <Upload className="size-5 text-primary" strokeWidth={1.75} />
            Upload CSV
            {parseResult && step !== "drop" && (
              <Badge variant="tinted" className="ml-2">
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
            <div className="space-y-4">
              {format === "bison" && (
                <div className="flex items-start gap-3 rounded-2xl bg-primary/10 px-4 py-3">
                  <Badge variant="tinted">Email Bison</Badge>
                  <p className="text-[13px] text-muted-foreground">
                    Detected an Email Bison export — fields are auto-mapped (incl. city/state/domain/question
                    from custom variables, ESP from tags). Rows that already bounced are flagged automatically.
                  </p>
                </div>
              )}
              <DuplicateStrategy
                value={strategy}
                onChange={setStrategy}
                overrideFields={overrideFields}
                onOverrideFieldsChange={setOverrideFields}
                mappedFields={Object.values(fieldMapping).filter(Boolean) as string[]}
                addTags={addTags}
                onAddTagsChange={setAddTags}
                onConfirm={handleStartUpload}
                onBack={() => setStep(format === "bison" ? "drop" : "map")}
              />
            </div>
          )}
          {step === "processing" && batchId && (
            <div className="space-y-2">
              {csvFiles.length > 1 && (
                <p className="text-xs text-muted-foreground">
                  Processing file {currentFileIndex + 1} of {csvFiles.length}: {csvFiles[currentFileIndex]?.name}
                </p>
              )}
              <UploadProgress batchId={batchId} onDone={currentFileIndex >= csvFiles.length - 1 ? resetWizard : undefined} />
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
            <CardTitle className="text-[17px]">Upload history</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="-mx-6 -mb-6 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>New</TableHead>
                    <TableHead>Merged</TableHead>
                    <TableHead>Locations</TableHead>
                    <TableHead>No email</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell className="font-medium">
                        {batch.filename ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            batch.status === "complete"
                              ? "success"
                              : batch.status === "error"
                              ? "destructive"
                              : "warning"
                          }
                        >
                          {batch.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {batch.total_rows?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {(batch.inserted_rows ?? 0).toLocaleString()}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {batch.merged_rows.toLocaleString()}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {(batch.locations_added ?? 0).toLocaleString()}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {(batch.no_email_rows ?? 0) > 0 ? (
                          <span className="inline-flex items-center gap-2">
                            {batch.no_email_rows.toLocaleString()}
                            <HoldbackLinks batch={batch} compact />
                          </span>
                        ) : "0"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
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
