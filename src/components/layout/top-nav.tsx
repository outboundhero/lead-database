"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Users,
  LayoutDashboard,
  Upload,
  Download,
  Shield,
  Sparkles,
  KeyRound,
} from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/types/auth";
import type { UserRole } from "@/types/auth";

const navItems = [
  { title: "Leads", href: "/leads", icon: Users, minRole: "viewer" as UserRole },
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, minRole: "manager" as UserRole },
  { title: "Exports", href: "/exports", icon: Download, minRole: "manager" as UserRole },
  { title: "Uploads", href: "/uploads", icon: Upload, minRole: "admin" as UserRole },
  { title: "API Keys", href: "/api-keys", icon: KeyRound, minRole: "admin" as UserRole },
  { title: "Admin", href: "/admin", icon: Shield, minRole: "admin" as UserRole },
];

interface TopNavProps {
  email: string;
  fullName: string | null;
  role: UserRole;
}

export function TopNav({ email, fullName, role }: TopNavProps) {
  const pathname = usePathname();
  const visibleItems = navItems.filter((item) => hasPermission(role, item.minRole));

  return (
    <header className="sticky top-0 z-40 ios-frost border-b border-border/50">
      <div className="flex h-14 items-center gap-4 px-4">
        <Link href="/leads" className="flex shrink-0 items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="size-[16px]" strokeWidth={2.2} />
          </div>
          <span className="hidden text-[17px] font-semibold tracking-tight sm:inline">
            OutboundHero
          </span>
        </Link>

        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {visibleItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                  isActive
                    ? "bg-primary/12 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <item.icon className="size-4" strokeWidth={1.75} />
                <span>{item.title}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <UserMenu email={email} fullName={fullName} />
        </div>
      </div>
    </header>
  );
}
