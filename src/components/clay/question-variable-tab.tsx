"use client";

// The Question variable tab of the Clay tab's Client setup sheet
// (client-setup-sheet.tsx). A placeholder until a client's question variable
// can be chosen and edited here; the editor that replaces it keeps this export
// and these props.

export function QuestionVariableTab({ tag }: { tag: string }) {
  return <p className="py-6 text-center text-[13px] text-muted-foreground">The question variable for {tag} is not available here yet.</p>;
}
