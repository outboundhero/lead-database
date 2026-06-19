"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface UserMenuProps {
  email: string;
  fullName: string | null;
}

export function UserMenu({ email, fullName }: UserMenuProps) {
  const router = useRouter();
  const supabase = createClient();

  // Mount guard — Radix's useId generates different ids on server vs client when
  // the trigger sits inside a streaming RSC tree, which triggers a hydration
  // mismatch on the `id` attribute. Rendering only after mount avoids this.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const initials = fullName
    ? fullName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : email[0].toUpperCase();

  const triggerContent = (
    <>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[oklch(0.52_0.21_290)] text-[13px] font-semibold text-primary-foreground">
        {initials}
      </div>
      <div className="min-w-0 flex-1 text-left">
        <p className="truncate text-[13px] font-medium leading-tight">
          {fullName ?? email.split("@")[0]}
        </p>
        <p className="truncate text-[11px] leading-tight text-muted-foreground">
          {email}
        </p>
      </div>
    </>
  );

  // Static placeholder during SSR + first paint — same visual footprint, no Radix
  if (!mounted) {
    return (
      <div className="flex w-full items-center gap-2.5 rounded-xl p-1.5">
        {triggerContent}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-xl p-1.5 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          {triggerContent}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-0.5">
            {fullName && (
              <p className="text-[14px] font-semibold leading-tight">{fullName}</p>
            )}
            <p className="text-[12px] leading-tight text-muted-foreground">
              {email}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout} variant="destructive">
          <LogOut className="size-4" strokeWidth={2} />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
