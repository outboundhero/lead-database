"use client";

// The Location tab of the Clay tab's Client setup sheet (client-setup-sheet.tsx).
// A placeholder until the client's places and service area can be edited here;
// the editor that replaces it keeps this export and these props.

export function LocationTab({ tag }: { tag: string }) {
  return <p className="py-6 text-center text-[13px] text-muted-foreground">Location settings for {tag} are not available here yet.</p>;
}
