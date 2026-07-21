"use client";

import { useCallback, useEffect, useState } from "react";
import { Save, Trash2, FolderOpen, RotateCw, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { normalizeFilterState, type FilterState } from "@/types/filters";
import type { FilterPreset } from "@/types/database";

// filter_presets.client_tag (migration 053) isn't in the shared FilterPreset
// type yet — carry it locally.
type Preset = FilterPreset & { client_tag?: string | null };
type ClientTag = { tag: string; group_no: number; owner: string | null; status: string | null };

const NO_TAG = "__none__"; // Radix Select can't use "" as an item value

interface FilterPresetsProps {
  currentFilters: FilterState;
  onLoadPreset: (filters: FilterState) => void;
}

export function FilterPresets({ currentFilters, onLoadPreset }: FilterPresetsProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [clientTags, setClientTags] = useState<ClientTag[]>([]);
  const [newName, setNewName] = useState("");
  const [newTag, setNewTag] = useState<string>(NO_TAG);
  const [saving, setSaving] = useState(false);

  const loadPresets = useCallback(async () => {
    try {
      const res = await fetch("/api/filters/presets");
      const data = await res.json();
      if (res.ok) setPresets(data.presets ?? []);
    } catch {
      // silent
    }
  }, []);

  const loadClientTags = useCallback(async () => {
    try {
      const res = await fetch("/api/bison/client-tags");
      const data = await res.json();
      if (res.ok) setClientTags(data.tags ?? []);
    } catch {
      // silent — tag scoping is optional
    }
  }, []);

  useEffect(() => {
    loadPresets();
    loadClientTags();
  }, [loadPresets, loadClientTags]);

  async function handleSave() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/filters/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          filters: currentFilters,
          client_tag: newTag === NO_TAG ? null : newTag,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Preset "${newName.trim()}" saved`);
      setNewName("");
      setNewTag(NO_TAG);
      loadPresets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save preset");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(preset: Preset) {
    try {
      const res = await fetch("/api/filters/presets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: preset.id, filters: currentFilters }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Preset "${preset.name}" updated to current filters`);
      loadPresets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update preset");
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/filters/presets?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      toast.success("Preset deleted");
      loadPresets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete preset");
    }
  }

  function handleLoad(preset: Preset) {
    onLoadPreset(normalizeFilterState(preset.filters));
    toast.success(`Loaded preset "${preset.name}"`);
  }

  // Group presets by client tag; untagged bucket sorts last.
  const groups = new Map<string, Preset[]>();
  for (const p of presets) {
    const key = p.client_tag?.trim() || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const groupKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
          <FolderOpen className="h-3 w-3" />
          Presets
          {presets.length > 0 && (
            <span className="ml-0.5 text-muted-foreground">({presets.length})</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3 space-y-3">
        {/* Save current filters */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Input
              placeholder="Preset name..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="h-7 text-xs flex-1"
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
            <Button
              size="sm"
              className="h-7 text-xs gap-1 px-2"
              disabled={!newName.trim() || saving}
              onClick={handleSave}
            >
              <Save className="h-3 w-3" />
              Save
            </Button>
          </div>
          {clientTags.length > 0 && (
            <Select value={newTag} onValueChange={setNewTag}>
              <SelectTrigger className="h-7 text-xs w-full">
                <Tag className="h-3 w-3 text-muted-foreground" />
                <SelectValue placeholder="No client tag" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TAG} className="text-xs">
                  No client tag
                </SelectItem>
                {clientTags.map((t) => (
                  <SelectItem key={t.tag} value={t.tag} className="text-xs">
                    {t.tag}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Preset list */}
        {presets.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">
            No saved presets yet.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto space-y-2">
            {groupKeys.map((key) => (
              <div key={key || NO_TAG} className="space-y-1">
                <p className="px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {key || "No client tag"}
                </p>
                {groups.get(key)!.map((preset) => (
                  <div
                    key={preset.id}
                    className="flex items-center gap-1.5 rounded px-2 py-1.5 hover:bg-muted/50 group"
                  >
                    <button
                      className="flex-1 text-left text-xs truncate"
                      onClick={() => handleLoad(preset)}
                    >
                      {preset.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                      title="Re-save current filters onto this preset"
                      onClick={() => handleUpdate(preset)}
                    >
                      <RotateCw className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-destructive"
                      title="Delete preset"
                      onClick={() => handleDelete(preset.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
