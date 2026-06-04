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
  Database,
  ChevronLeft,
  ChevronRight,
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
      { title: "Leads", href: "/leads", icon: Users, minRole: "viewer" as UserRole },
      { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, minRole: "manager" as UserRole },
      { title: "Exports", href: "/exports", icon: Download, minRole: "manager" as UserRole },
      { title: "Uploads", href: "/uploads", icon: Upload, minRole: "admin" as UserRole },
    ],
  },
  {
    label: "Developer",
    items: [
      { title: "API Keys", href: "/api-keys", icon: KeyRound, minRole: "admin" as UserRole },
    ],
  },
  {
    label: "Settings",
    items: [
      { title: "Admin", href: "/admin", icon: Shield, minRole: "admin" as UserRole },
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

  return (
    <aside
      className={cn(
        "flex flex-col h-full border-r bg-background transition-all duration-200",
        collapsed ? "w-16" : "w-56"
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 h-14 px-4 border-b shrink-0">
        <Database className="h-5 w-5 shrink-0" />
        {!collapsed && (
          <span className="font-semibold text-sm truncate">OutboundHero</span>
        )}
      </div>

      {/* Nav sections */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-5">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter((item) =>
            hasPermission(role, item.minRole)
          );
          if (visibleItems.length === 0) return null;
          return (
            <div key={section.label}>
              {!collapsed && (
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 mb-1.5">
                  {section.label}
                </p>
              )}
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const isActive = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? item.title : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      {!collapsed && <span className="truncate">{item.title}</span>}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Bottom: user + collapse */}
      <div className="border-t px-2 py-2 space-y-1 shrink-0">
        <div className={cn("flex items-center", collapsed ? "justify-center" : "px-1")}>
          <UserMenu email={email} fullName={fullName} />
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center justify-center w-full rounded-md py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
