"use client";

import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, FileText } from "lucide-react";
import type { ParseResult } from "@/lib/uploads/parse-csv";
import { parseCSVFile } from "@/lib/uploads/parse-csv";

interface CSVDropzoneProps {
  onFilesParsed: (result: ParseResult, files: File[]) => void;
  onError: (message: string) => void;
}

export function CSVDropzone({ onFilesParsed, onError }: CSVDropzoneProps) {
  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return;
      try {
        const result = await parseCSVFile(acceptedFiles[0]);
        if (result.totalRows === 0) {
          onError("First CSV file has no data rows.");
          return;
        }
        onFilesParsed(result, acceptedFiles);
      } catch (err) {
        onError(err instanceof Error ? err.message : "Failed to parse CSV");
      }
    },
    [onFilesParsed, onError]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "text/csv": [".csv"] },
  });

  return (
    <div
      {...getRootProps()}
      className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-12 cursor-pointer transition-colors ${
        isDragActive
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-muted-foreground/50"
      }`}
    >
      <input {...getInputProps()} />
      <Upload className="h-10 w-10 text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium">
          {isDragActive ? "Drop your CSVs here" : "Drag & drop one or more CSV files"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          or click to browse — .csv files only · multiple files supported
        </p>
      </div>
    </div>
  );
}
