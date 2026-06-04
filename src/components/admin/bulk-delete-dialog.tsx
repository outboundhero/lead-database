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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Trash2, Upload, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface BulkDeleteDialogProps {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
  sources: string[];
}

export function BulkDeleteDialog({
  open,
  onClose,
  onDeleted,
  sources,
}: BulkDeleteDialogProps) {
  const [emails, setEmails] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [uploadDate, setUploadDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

      // Find email column
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
      toast.info(`Found ${parsed.length} emails in CSV`);
    };
    reader.readAsText(file);
  }

  async function handleDelete() {
    if (confirmText !== "DELETE") return;

    setLoading(true);
    try {
      const body: Record<string, unknown> = {};
      if (emails.length > 0) body.emails = emails;
      if (source) body.source = source;
      if (uploadDate) body.uploadDate = uploadDate;

      const res = await fetch("/api/admin/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      toast.success(`Deleted ${data.deleted.toLocaleString()} leads`);
      setEmails([]);
      setFileName(null);
      setSource("");
      setUploadDate("");
      setConfirmText("");
      onDeleted();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setLoading(false);
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    setPreviewCount(null);
    try {
      const body: Record<string, unknown> = { preview: true };
      if (emails.length > 0) body.emails = emails;
      if (source) body.source = source;
      if (uploadDate) body.uploadDate = uploadDate;

      const res = await fetch("/api/admin/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPreviewCount(data.estimatedCount);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  function reset() {
    setEmails([]);
    setFileName(null);
    setSource("");
    setUploadDate("");
    setConfirmText("");
    setPreviewCount(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  const hasFilter = emails.length > 0 || source || uploadDate;

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
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            Bulk Delete Leads
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* CSV Upload */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Upload CSV with <strong>email</strong> column (optional):
            </label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-3 w-3" />
                Choose file
              </Button>
              <span className="text-xs text-muted-foreground">
                {fileName
                  ? `${fileName} (${emails.length} emails)`
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
          </div>

          {/* Source filter */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Or select Source (optional):
            </label>
            <Select value={source || "__none__"} onValueChange={(v) => setSource(v === "__none__" ? "" : v)}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="-- Select Source --" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__" className="text-xs">-- All Sources --</SelectItem>
                {sources.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date filter */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Or select Date of Upload (optional):
            </label>
            <Input
              type="date"
              value={uploadDate}
              onChange={(e) => setUploadDate(e.target.value)}
              className="h-9 text-xs"
            />
          </div>

          {/* Preview button */}
          {hasFilter && previewCount === null && (
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={handlePreview}
              disabled={previewing}
            >
              {previewing ? (
                <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Counting...</>
              ) : (
                "Preview — How many leads will be deleted?"
              )}
            </Button>
          )}

          {/* Warning with count */}
          {hasFilter && previewCount !== null && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-medium text-destructive">This action cannot be undone.</p>
                <p className="text-muted-foreground mt-1">
                  <strong>{previewCount.toLocaleString()}</strong> leads will be permanently deleted.
                  {emails.length > 0 && ` (matched from ${emails.length.toLocaleString()} emails in CSV)`}
                  {source && ` Source: ${source}`}
                  {uploadDate && ` Date: ${uploadDate}`}
                </p>
              </div>
            </div>
          )}

          {/* Confirmation — only show after preview */}
          {hasFilter && previewCount !== null && previewCount > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Type <strong>DELETE</strong> to confirm:
              </label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className="h-9 text-xs"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={loading || !hasFilter || confirmText !== "DELETE" || previewCount === null || previewCount === 0}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Delete Matching Leads
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
