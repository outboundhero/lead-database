"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Users,
  LayoutDashboard,
  Upload,
  Download,
  Shield,
  Database,
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
    <header className="flex h-14 shrink-0 items-center border-b px-4 gap-6">
      <Link href="/leads" className="flex items-center gap-2 shrink-0">
        <Database className="h-5 w-5" />
        <span className="font-semibold text-lg hidden sm:inline">OutboundHero</span>
      </Link>

      <nav className="flex items-center gap-1 flex-1 overflow-x-auto">
        {visibleItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              <span>{item.title}</span>
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-2 shrink-0">
        <ThemeToggle />
        <UserMenu email={email} fullName={fullName} />
      </div>
    </header>
  );
}
