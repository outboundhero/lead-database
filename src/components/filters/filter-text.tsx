"use client";

import { Input } from "@/components/ui/input";

interface FilterTextProps {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}

export function FilterText({ placeholder, value, onChange }: FilterTextProps) {
  return (
    <Input
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 text-sm"
    />
  );
}
