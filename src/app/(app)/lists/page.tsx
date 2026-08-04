"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { TagInput } from "@/components/ui/ios/tag-input";
import { toast } from "sonner";

// Editable term lists (client req #4): commercial-cleaning titles, competitor
// keywords, big-brand domains, security gateways — apply/edit/duplicate/create
// without a developer. "Commercial cleaning titles" is two-way synced with the
// commercial_cleaning_excluded_titles gate table.

interface TermList {
  id: string;
  name: string;
  kind: "titles" | "keywords" | "domains" | "gateways" | "competitors";
  items: string[];
  description: string | null;
  built_in: boolean;
  updated_at: string;
}

const KIND_LABEL: Record<TermList["kind"], string> = {
  titles: "Job titles — applied to Title exclude",
  keywords: "Keywords — applied to Keywords exclude",
  competitors: "Company keywords — applied to Keywords exclude",
  domains: "Domains — applied to Website/Domain exclude",
  gateways: "ESP values — applied to ESP exclude",
};

export default function ListsPage() {
  const [lists, setLists] = useState<TermList[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<TermList | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/lists")
      .then((r) => r.json())
      .then((d) => setLists(d.lists ?? []))
      .catch(() => toast.error("Failed to load lists"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  async function duplicate(list: TermList) {
    const res = await fetch("/api/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${list.name} (copy)`, kind: list.kind, items: list.items, description: list.description }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(d.error ?? "Duplicate failed"); return; }
    toast.success(`Duplicated as "${d.list.name}"`);
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Lists</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Reusable exclusion lists — edit them here, apply them from the Leads filter bar. No developer needed.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New list</Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {lists.map((l) => (
            <Card key={l.id} className="cursor-pointer transition-shadow hover:shadow-md" onClick={() => setEditing(l)}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-medium">{l.name}</span>
                  {l.built_in && <Badge variant="secondary">built-in</Badge>}
                  <span className="ml-auto text-[13px] tabular-nums text-muted-foreground">
                    {l.items.length} items
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">{KIND_LABEL[l.kind]}</p>
                {l.description && <p className="mt-1 text-[12px] text-muted-foreground">{l.description}</p>}
                <p className="mt-2 truncate text-[11px] text-muted-foreground/70">
                  {l.items.slice(0, 8).join(", ")}{l.items.length > 8 ? "…" : ""}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); setEditing(l); }}>
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); duplicate(l); }}>
                    Duplicate
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ListEditorDialog
        list={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
      <NewListDialog open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />
    </div>
  );
}

function ListEditorDialog({ list, onClose, onSaved }: { list: TermList | null; onClose: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!list) return;
    setItems(list.items);
    setName(list.name);
    setDescription(list.description ?? "");
  }, [list]);

  async function save() {
    if (!list) return;
    setSaving(true);
    try {
      const res = await fetch("/api/lists", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: list.id, name, items, description }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Save failed");
      toast.success(
        list.name === "Commercial cleaning titles"
          ? "Saved — the Commercial Cleaning toggle and push gate now use this list."
          : `"${d.list.name}" saved`
      );
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!list || list.built_in) return;
    if (!window.confirm(`Delete the list "${list.name}"?`)) return;
    const res = await fetch("/api/lists", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: list.id }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(d.error ?? "Delete failed"); return; }
    toast.success("List deleted");
    onSaved();
  }

  return (
    <Dialog open={!!list} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit list{list?.built_in ? " (built-in)" : ""}</DialogTitle>
        </DialogHeader>
        {list && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={list.built_in} className="flex-1" />
              <Badge variant="secondary" className="self-center">{list.kind}</Badge>
            </div>
            <Input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
            <div className="max-h-[45vh] overflow-y-auto rounded-xl border p-2">
              <TagInput values={items} placeholder="Add a term, press Enter (paste comma/newline lists too)" onChange={setItems} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {items.length} items.{" "}
              {list.name === "Commercial cleaning titles"
                ? "Saving updates the Commercial Cleaning filter toggle AND the push-time title gate."
                : "Apply this list from the Leads page filter bar (Lists chip)."}
            </p>
          </div>
        )}
        <DialogFooter className="flex-row justify-between sm:justify-between">
          <div>
            {list && !list.built_in && (
              <Button variant="ghost" className="text-destructive" onClick={remove} disabled={saving}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving || items.length === 0}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewListDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TermList["kind"]>("keywords");
  const [items, setItems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(""); setKind("keywords"); setItems([]);
  }, [open]);

  async function create() {
    setSaving(true);
    try {
      const res = await fetch("/api/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind, items }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Create failed");
      toast.success(`"${d.list.name}" created`);
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>New list</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="List name" value={name} onChange={(e) => setName(e.target.value)} />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as TermList["kind"])}
            className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
          >
            <option value="keywords">Keywords (→ Keywords exclude)</option>
            <option value="competitors">Company keywords (→ Keywords exclude)</option>
            <option value="titles">Job titles (→ Title exclude)</option>
            <option value="domains">Domains (→ Website/Domain exclude)</option>
            <option value="gateways">ESP values (→ ESP exclude)</option>
          </select>
          <div className="max-h-[40vh] overflow-y-auto rounded-xl border p-2">
            <TagInput values={items} placeholder="Add terms…" onChange={setItems} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={create} disabled={saving || !name.trim() || items.length === 0}>
            {saving ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
