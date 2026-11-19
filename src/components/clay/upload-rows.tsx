"use client";

import Link from "next/link";
import { AlertTriangle, CirclePause, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UploadDelivery } from "@/app/api/enrich/table/route";
import type { WorkerState } from "@/lib/enrich/types";

// The strip above a client's People (pipeline) table (migration 130): the
// uploads whose no-email rows the table holds, how many are held and why, and
// a warning while the worker running now does not move or release upload rows
// (it lacks the upload_people capability). Everything comes with the table's
// detail, so it follows the table's live updates.

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The worker's state, as a warning about upload rows, or null when all is well. */
function workerWarning(worker: WorkerState | null): string | null {
  if (!worker) return "No enrichment worker has run yet, so upload rows are not copied here or released.";
  if (!worker.info?.capabilities?.includes("upload_people")) {
    return "The worker running now does not copy upload rows or release held People rows (it predates this build). They wait until the new worker is deployed.";
  }
  return null;
}

export function UploadRowsStrip({
  tag,
  held,
  uploads,
  switchedOn,
  worker,
}: {
  tag: string;
  /** Held rows of the table: in a People table, only uploads' no-email rows are ever held. */
  held: number;
  uploads: UploadDelivery[];
  /** The client is on People runs (people_pipeline). */
  switchedOn: boolean;
  worker: WorkerState | null;
}) {
  if (!uploads.length && !held) return null;
  const warning = workerWarning(worker);
  const why = !held
    ? null
    : !switchedOn
      ? `${fmt(held)} upload row${held === 1 ? "" : "s"} held: ${tag} is not on People runs (in the Companies tab's settings). Nothing runs or is spent on them until it is.`
      : warning
        ? `${fmt(held)} upload row${held === 1 ? "" : "s"} held: ${tag} is on People runs, but the worker running now does not release them yet.`
        : `${fmt(held)} upload row${held === 1 ? "" : "s"} held: ${tag} is on People runs, so the worker releases them as the table has room, 2,000 at a time.`;

  return (
    <div className="space-y-2 rounded-2xl bg-card px-4 py-2.5 shadow-ios">
      <div className="flex flex-wrap items-center gap-2">
        <Upload className="size-4 text-primary" />
        <span className="text-[13px] font-semibold">Upload rows</span>
        <span className="text-[12.5px] text-muted-foreground">
          The no-email rows of {tag}&apos;s uploads. Found emails go to the lead database with each upload&apos;s own rules.
        </span>
        <Button size="xs" variant="outline" className="ml-auto" asChild>
          <Link href="/uploads">Uploads page</Link>
        </Button>
      </div>
      {why && (
        <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          <CirclePause className="mt-0.5 size-3.5 shrink-0" /> {why}
        </p>
      )}
      {warning && (
        <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {warning}
        </p>
      )}
      {uploads.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">Uploads ({fmt(uploads.length)})</summary>
          <table className="mt-1.5 w-full text-left tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-0.5 pr-3 font-medium">Copied</th>
                <th className="py-0.5 pr-3 font-medium">Upload</th>
                <th className="py-0.5 pr-3 font-medium">Rows</th>
                <th className="py-0.5 font-medium">Held</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((u) => (
                <tr key={u.id} className="border-t border-border/50">
                  <td className="py-0.5 pr-3">{when(u.created_at)}</td>
                  <td className="max-w-[320px] truncate py-0.5 pr-3">{u.label ?? "Upload"}</td>
                  <td className="py-0.5 pr-3">{fmt(u.created)}</td>
                  <td className="py-0.5">{fmt(u.held)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
