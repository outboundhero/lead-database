"use client";

import { useCallback, useEffect, useState } from "react";
import { Save, Trash2, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import type { FilterState } from "@/types/filters";
import type { FilterPreset } from "@/types/database";

interface FilterPresetsProps {
  currentFilters: FilterState;
  onLoadPreset: (filters: FilterState) => void;
}

export function FilterPresets({ currentFilters, onLoadPreset }: FilterPresetsProps) {
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [newName, setNewName] = useState("");
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

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  async function handleSave() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/filters/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), filters: currentFilters }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Preset "${newName.trim()}" saved`);
      setNewName("");
      loadPresets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save preset");
    } finally {
      setSaving(false);
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

  function handleLoad(preset: FilterPreset) {
    onLoadPreset(preset.filters as unknown as FilterState);
    toast.success(`Loaded preset "${preset.name}"`);
  }

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
      <PopoverContent align="start" className="w-72 p-3 space-y-3">
        {/* Save current filters */}
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

        {/* Preset list */}
        {presets.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">
            No saved presets yet.
          </p>
        ) : (
          <div className="max-h-48 overflow-y-auto space-y-1">
            {presets.map((preset) => (
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
                  className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-destructive"
                  onClick={() => handleDelete(preset.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
