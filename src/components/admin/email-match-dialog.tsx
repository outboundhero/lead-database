"use client";

import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, MailCheck, Download, Check, X } from "lucide-react";
import { toast } from "sonner";

interface EmailMatchDialogProps {
  open: boolean;
  onClose: () => void;
}

interface MatchResult {
  total: number;
  found: number;
  notFound: number;
  foundEmails: string[];
  notFoundEmails: string[];
}

export function EmailMatchDialog({ open, onClose }: EmailMatchDialogProps) {
  const [emails, setEmails] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MatchResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

      const header = lines[0].toLowerCase().split(",").map((h) => h.trim().replace(/"/g, ""));
      const emailIdx = header.findIndex((h) => h === "email");

      if (emailIdx === -1) {
        toast.error("CSV must have an 'email' column");
        setEmails([]);
        setFileName(null);
        return;
      }

      const parsed: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map((c) => c.trim().replace(/"/g, ""));
        const email = cols[emailIdx]?.toLowerCase().trim();
        if (email && email.includes("@")) {
          parsed.push(email);
        }
      }

      setEmails(parsed);
      toast.info(`Found ${parsed.length.toLocaleString()} emails in CSV`);
    };
    reader.readAsText(file);
  }

  async function handleCheck() {
    if (emails.length === 0) return;
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("/api/admin/email-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setResult(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Check failed");
    } finally {
      setLoading(false);
    }
  }

  function downloadCsv(type: "found" | "notFound") {
    if (!result) return;
    const list = type === "found" ? result.foundEmails : result.notFoundEmails;
    const csv = "email\n" + list.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `emails_${type === "found" ? "matched" : "not_found"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function reset() {
    setEmails([]);
    setFileName(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MailCheck className="h-5 w-5" />
            Email Match Checker
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Upload a CSV with an <strong>email</strong> column to check which emails exist in the database.
          </p>

          {/* CSV Upload */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-3 w-3" />
              Choose CSV
            </Button>
            <span className="text-xs text-muted-foreground">
              {fileName
                ? `${fileName} (${emails.length.toLocaleString()} emails)`
                : "No file chosen"}
            </span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleFileUpload}
          />

          {/* Results */}
          {result && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border p-3 text-center">
                  <p className="text-lg font-bold">{result.total.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground">Total</p>
                </div>
                <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 text-center">
                  <p className="text-lg font-bold text-green-600">{result.found.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-0.5">
                    <Check className="h-3 w-3" /> Found
                  </p>
                </div>
                <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-center">
                  <p className="text-lg font-bold text-red-600">{result.notFound.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-0.5">
                    <X className="h-3 w-3" /> Not Found
                  </p>
                </div>
              </div>

              <div className="flex gap-2">
                {result.found > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-xs gap-1"
                    onClick={() => downloadCsv("found")}
                  >
                    <Download className="h-3 w-3" />
                    Download Matched ({result.found.toLocaleString()})
                  </Button>
                )}
                {result.notFound > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-xs gap-1"
                    onClick={() => downloadCsv("notFound")}
                  >
                    <Download className="h-3 w-3" />
                    Download Not Found ({result.notFound.toLocaleString()})
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>
            Close
          </Button>
          <Button
            onClick={handleCheck}
            disabled={loading || emails.length === 0}
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Checking...</>
            ) : (
              `Check ${emails.length.toLocaleString()} Emails`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
