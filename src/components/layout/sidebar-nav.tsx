"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Users,
  LayoutDashboard,
  Upload,
  Download,
  Shield,
  KeyRound,
  MailX,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/types/auth";
import type { UserRole } from "@/types/auth";
import { useState } from "react";
import { UserMenu } from "./user-menu";

const NAV_SECTIONS = [
  {
    label: "Main",
    items: [
      { title: "Leads", href: "/leads", icon: Users, minRole: "viewer" as UserRole, tint: "text-[oklch(0.586_0.214_263)]" },
      { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, minRole: "manager" as UserRole, tint: "text-[oklch(0.745_0.183_145)]" },
      { title: "Exports", href: "/exports", icon: Download, minRole: "manager" as UserRole, tint: "text-[oklch(0.78_0.175_65)]" },
      { title: "Uploads", href: "/uploads", icon: Upload, minRole: "admin" as UserRole, tint: "text-[oklch(0.52_0.21_290)]" },
      { title: "Bounces", href: "/uploads/bounces", icon: MailX, minRole: "admin" as UserRole, tint: "text-[oklch(0.65_0.235_25)]" },
    ],
  },
  {
    label: "Developer",
    items: [
      { title: "API Keys", href: "/api-keys", icon: KeyRound, minRole: "admin" as UserRole, tint: "text-[oklch(0.65_0.235_25)]" },
    ],
  },
  {
    label: "Settings",
    items: [
      { title: "Admin", href: "/admin", icon: Shield, minRole: "admin" as UserRole, tint: "text-muted-foreground" },
    ],
  },
];

interface SidebarNavProps {
  email: string;
  fullName: string | null;
  role: UserRole;
}

export function SidebarNav({ email, fullName, role }: SidebarNavProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Highlight exactly one item: the most specific (longest) matching href.
  // Without this, being on /uploads/bounces lights up BOTH "Uploads" (/uploads)
  // and "Bounces" (/uploads/bounces), since one href is a prefix of the other.
  const activeHref =
    NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href))
      .filter((h) => pathname === h || pathname.startsWith(h + "/"))
      .sort((a, b) => b.length - a.length)[0] ?? "";

  return (
    <aside
      className={cn(
        "flex h-full flex-col bg-sidebar transition-all duration-200",
        collapsed ? "w-[72px]" : "w-64"
      )}
    >
      {/* Logo */}
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Sparkles className="size-[18px]" strokeWidth={2.2} />
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold tracking-tight">OutboundHero</p>
            <p className="truncate text-[11px] text-muted-foreground">Lead database</p>
          </div>
        )}
      </div>

      {/* Nav sections — iOS grouped list style */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter((item) =>
            hasPermission(role, item.minRole)
          );
          if (visibleItems.length === 0) return null;
          return (
            <div key={section.label}>
              {!collapsed && (
                <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </p>
              )}
              <div className="overflow-hidden rounded-2xl bg-card shadow-ios">
                {visibleItems.map((item, idx) => {
                  const isActive = item.href === activeHref;
                  const isFirst = idx === 0;
                  const isLast = idx === visibleItems.length - 1;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? item.title : undefined}
                      className={cn(
                        "relative flex items-center gap-3 px-3.5 py-2.5 text-[15px] font-medium transition-colors",
                        isActive
                          ? "bg-accent text-primary"
                          : "text-foreground hover:bg-muted/60 active:bg-muted",
                        isFirst && "rounded-t-2xl",
                        isLast && "rounded-b-2xl",
                        // hairline separator
                        !isFirst &&
                          "before:absolute before:left-12 before:right-0 before:top-0 before:h-px before:bg-border",
                        collapsed && "justify-center px-2"
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center",
                          isActive ? "text-primary" : item.tint
                        )}
                      >
                        <item.icon className="size-[18px]" strokeWidth={1.75} />
                      </span>
                      {!collapsed && <span className="truncate">{item.title}</span>}
                      {!collapsed && isActive && (
                        <span className="ml-auto size-1.5 rounded-full bg-primary" />
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Bottom: user + collapse */}
      <div className="space-y-2 px-3 pb-4">
        <div className="overflow-hidden rounded-2xl bg-card p-2 shadow-ios">
          <div className={cn("flex items-center", collapsed ? "justify-center" : "px-1")}>
            <UserMenu email={email} fullName={fullName} />
          </div>
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center justify-center rounded-xl py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
      </div>
    </aside>
  );
}
