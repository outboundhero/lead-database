"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TRACK_LABELS, type Candidate, type CandidatePick, type CandidateVerdict, type CandidatesPage } from "@/lib/companies/types";

// A people run's candidates: everyone its Look saw, with the free screen's
// verdict and the pick, read in keyset pages of 100 from
// /api/companies/people/runs/candidates. A Preview's last name is masked by
// AI Ark ("Ba***e") and stays so until the person is bought with an email.

export const VERDICT: Record<CandidateVerdict, { label: string; cls: string; hint: string }> = {
  candidate: { label: "Candidate", cls: "bg-primary/12 text-primary", hint: "Passed the screen: may be picked for its track." },
  held: { label: "In the database", cls: "bg-[var(--success)]/15 text-[var(--success)]", hint: "A lead with the same name at the company is already held, so the company is skipped." },
  never_contact: { label: "Never contact", cls: "bg-destructive/12 text-destructive", hint: "On the never-contact list." },
  bounced: { label: "Bounced", cls: "bg-destructive/12 text-destructive", hint: "A lead of theirs bounced." },
  outside: { label: "Outside the area", cls: "bg-muted text-muted-foreground", hint: "Their own place is outside the client's area." },
  excluded: { label: "Excluded", cls: "bg-muted text-muted-foreground", hint: "The company or the title matches the client's exclusions (or, on a LinkedIn run, its LinkedIn keywords)." },
  no_track: { label: "No track", cls: "bg-muted text-muted-foreground", hint: "Their title holds none of the tracks' phrases." },
  bought_before: { label: "Bought before", cls: "bg-[var(--warning)]/15 text-[var(--warning)]", hint: "Another run bought them: copied free with their email, if they had one." },
  no_company: { label: "No company", cls: "bg-muted text-muted-foreground", hint: "AI Ark gives no company for them (LinkedIn runs), so they are never picked." },
};

export const PICK: Record<CandidatePick, string> = {
  none: "",
  picked: "Picked",
  reserve: "Reserve",
  bought: "Bought",
  no_email: "Bought, no email",
  lost: "Answer lost",
};

const place = (c: Candidate) => [c.city, c.region].filter(Boolean).join(", ") || c.country || "";

export function CandidatesList({ runId }: { runId: string }) {
  const [rows, setRows] = useState<Candidate[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ id: runId, ...(after ? { after } : {}) });
        const res = await fetch(`/api/companies/people/runs/candidates?${qs}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Could not load the candidates");
        const page = j as CandidatesPage;
        setRows((r) => (after ? [...r, ...page.rows] : page.rows));
        setNext(page.next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the candidates");
      } finally {
        setLoading(false);
        setStarted(true);
      }
    },
    [runId]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  return (
    <div className="rounded-xl border border-border/60">
      {error && <p className="px-3 py-2 text-[12.5px] text-destructive">{error}</p>}
      {!started && loading ? (
        <div className="flex min-h-[80px] items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-3 py-3 text-[12.5px] text-muted-foreground">Nobody seen yet.</p>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead className="sticky top-0 bg-muted/80 text-left text-[12px] text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-3 py-1.5 font-medium">Company</th>
                <th className="px-3 py-1.5 font-medium">Person</th>
                <th className="px-3 py-1.5 font-medium">Track</th>
                <th className="px-3 py-1.5 font-medium">Screen</th>
                <th className="px-3 py-1.5 font-medium">Pick</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.person_id} className="border-t border-border/40 align-top">
                  <td className="px-3 py-1.5">
                    {c.company || <span className="text-muted-foreground">{c.company_row_id != null ? `row ${c.company_row_id}` : "not in the table yet"}</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <p className="font-medium">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)"}</p>
                    <p className="text-[12px] text-muted-foreground">{[c.title, place(c)].filter(Boolean).join(" · ")}</p>
                  </td>
                  <td className="px-3 py-1.5">{c.track ? `${TRACK_LABELS[c.track]}${c.rank != null ? ` #${c.rank + 1}` : ""}` : <span className="text-muted-foreground">none</span>}</td>
                  <td className="px-3 py-1.5">
                    <span title={VERDICT[c.verdict]?.hint} className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", VERDICT[c.verdict]?.cls)}>
                      {VERDICT[c.verdict]?.label ?? c.verdict}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-[12px]">{PICK[c.pick] || <span className="text-muted-foreground">not picked</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div className="border-t border-border/40 px-3 py-2">
          <Button size="sm" variant="outline" onClick={() => load(next)} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : null} Load more
          </Button>
        </div>
      )}
    </div>
  );
}
