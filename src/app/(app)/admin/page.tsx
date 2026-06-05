"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  UserPlus,
  Users,
  TrendingUp,
  Key,
  Trash2,
  MailCheck,
  HelpCircle,
  Upload,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { UserTable } from "@/components/admin/user-table";
import { InviteUserDialog } from "@/components/admin/invite-user-dialog";
import { BulkDeleteDialog } from "@/components/admin/bulk-delete-dialog";
import { EmailMatchDialog } from "@/components/admin/email-match-dialog";
import { UnknownStatsDialog } from "@/components/admin/unknown-stats-dialog";
import type { UserProfile, UserRole } from "@/types/auth";
import type { AuditLog } from "@/types/database";
import { useHasPermission, useRole } from "@/lib/context/role-context";
import { AccessDenied } from "@/components/layout/access-denied";
import Link from "next/link";

interface AdminStats {
  totalLeads: number;
  newLeadsMonth: number;
  totalUsers: number;
  activeApiTokens: number;
}

const LOGS_PER_PAGE = 4;

export default function AdminPage() {
  const canView = useHasPermission("admin");
  const contextRole = useRole();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [currentUserRole, setCurrentUserRole] = useState<UserRole>(contextRole);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [emailMatchOpen, setEmailMatchOpen] = useState(false);
  const [unknownStatsOpen, setUnknownStatsOpen] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<AdminStats>({
    totalLeads: 0,
    newLeadsMonth: 0,
    totalUsers: 0,
    activeApiTokens: 0,
  });
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [logsPage, setLogsPage] = useState(1);
  const [totalLogs, setTotalLogs] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();

    // Get current user
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role, email")
        .eq("id", user.id)
        .single();
      if (profile) {
        setCurrentUserRole(profile.role as UserRole);
        setCurrentUserEmail(profile.email);
      }
    }

    // Load users
    const { data: usersData } = await supabase
      .from("user_profiles")
      .select("*")
      .order("created_at", { ascending: true });
    if (usersData) setUsers(usersData as UserProfile[]);

    // Load stats in parallel
    const [leadsCount, newLeadsCount, tokensCount] = await Promise.all([
      supabase.from("leads").select("id", { count: "exact", head: true }),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .gte(
          "created_at",
          new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
        ),
      supabase
        .from("api_tokens")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true),
    ]);

    setStats({
      totalLeads: leadsCount.count ?? 0,
      newLeadsMonth: newLeadsCount.count ?? 0,
      totalUsers: usersData?.length ?? 0,
      activeApiTokens: tokensCount.count ?? 0,
    });

    // Load sources for bulk delete
    const { data: srcData } = await supabase.rpc("distinct_values", { col_name: "source" });
    if (srcData) setSources(srcData as string[]);

    setLoading(false);
  }, []);

  const loadAuditLogs = useCallback(async (page: number) => {
    const supabase = createClient();
    const from = (page - 1) * LOGS_PER_PAGE;
    const to = from + LOGS_PER_PAGE - 1;

    const { data, count } = await supabase
      .from("audit_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (data) setAuditLogs(data as AuditLog[]);
    setTotalLogs(count ?? 0);
  }, []);

  useEffect(() => {
    loadData();
    loadAuditLogs(1);
  }, [loadData, loadAuditLogs]);

  function handlePageChange(page: number) {
    setLogsPage(page);
    loadAuditLogs(page);
  }

  if (!canView) return <AccessDenied />;

  // Use contextRole (from server-side layout) as primary source of truth
  // since client-side profile query may fail due to RLS
  const effectiveRole = currentUserRole !== "viewer" ? currentUserRole : contextRole;
  const canManageUsers =
    effectiveRole === "owner" || effectiveRole === "admin";

  const totalPages = Math.ceil(totalLogs / LOGS_PER_PAGE);
  const monthName = new Date().toLocaleString("en-US", { month: "long" });

  const STAT_TINTS = [
    { tint: "text-[oklch(0.586_0.214_263)]", bg: "bg-[oklch(0.586_0.214_263)]/12" },
    { tint: "text-[oklch(0.745_0.183_145)]", bg: "bg-[oklch(0.745_0.183_145)]/12" },
    { tint: "text-[oklch(0.78_0.175_65)]", bg: "bg-[oklch(0.78_0.175_65)]/12" },
    { tint: "text-[oklch(0.52_0.21_290)]", bg: "bg-[oklch(0.52_0.21_290)]/12" },
  ];

  return (
    <div className="max-w-6xl space-y-6">
      {/* Title + Action Buttons */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Admin</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Manage team, view activity, run maintenance
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setBulkDeleteOpen(true)}>
            <Trash2 className="size-3.5" strokeWidth={2} />
            Bulk delete
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEmailMatchOpen(true)}>
            <MailCheck className="size-3.5" strokeWidth={2} />
            Email match
          </Button>
          <Button variant="outline" size="sm" onClick={() => setUnknownStatsOpen(true)}>
            <HelpCircle className="size-3.5" strokeWidth={2} />
            Unknown stats
          </Button>
          <Button size="sm" asChild>
            <Link href="/uploads">
              <Upload className="size-3.5" strokeWidth={2} />
              Upload leads
            </Link>
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Total leads", value: stats.totalLeads.toLocaleString(), icon: Users },
          { label: `New (${monthName})`, value: stats.newLeadsMonth.toLocaleString(), icon: TrendingUp },
          { label: "Total users", value: stats.totalUsers.toLocaleString(), icon: UserPlus },
          { label: "Active API", value: stats.activeApiTokens.toLocaleString(), icon: Key },
        ].map((stat, i) => (
          <Card key={stat.label} className="gap-3 p-5">
            <div className="flex items-center justify-between">
              <p className="text-[13px] font-medium text-muted-foreground">{stat.label}</p>
              <div className={`flex size-9 items-center justify-center rounded-xl ${STAT_TINTS[i].bg}`}>
                <stat.icon className={`size-[18px] ${STAT_TINTS[i].tint}`} strokeWidth={1.75} />
              </div>
            </div>
            <p className="text-[32px] font-semibold leading-none tracking-tight">{stat.value}</p>
          </Card>
        ))}
      </div>

      {/* Team Manager */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-[17px]">Team manager</CardTitle>
          {canManageUsers && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus className="size-3.5" strokeWidth={2} />
              Add user
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-[14px] text-muted-foreground">Loading…</p>
          ) : (
            <UserTable
              users={users}
              currentUserRole={effectiveRole}
              currentUserEmail={currentUserEmail}
              onRefresh={loadData}
            />
          )}
        </CardContent>
      </Card>

      {/* Recent Activity Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {auditLogs.length === 0 ? (
            <p className="py-8 text-center text-[14px] text-muted-foreground">
              No activity logs yet.
            </p>
          ) : (
            <div className="-mx-6 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Performed by</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium">{log.action}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {log.performed_by ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(log.created_at).toLocaleString("en-US", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {log.details ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination */}
          {totalLogs > 0 && (
            <div className="flex items-center justify-between text-[13px] text-muted-foreground">
              <span>
                Showing {(logsPage - 1) * LOGS_PER_PAGE + 1} to{" "}
                {Math.min(logsPage * LOGS_PER_PAGE, totalLogs)} of {totalLogs} results
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={logsPage <= 1}
                  onClick={() => handlePageChange(logsPage - 1)}
                >
                  <ChevronLeft className="size-4" strokeWidth={2} />
                </Button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const page = i + 1;
                  return (
                    <Button
                      key={page}
                      variant={page === logsPage ? "default" : "ghost"}
                      size="icon-sm"
                      onClick={() => handlePageChange(page)}
                    >
                      {page}
                    </Button>
                  );
                })}
                {totalPages > 5 && (
                  <>
                    <span className="px-1">…</span>
                    <Button
                      variant={totalPages === logsPage ? "default" : "ghost"}
                      size="icon-sm"
                      onClick={() => handlePageChange(totalPages)}
                    >
                      {totalPages}
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={logsPage >= totalPages}
                  onClick={() => handlePageChange(logsPage + 1)}
                >
                  <ChevronRight className="size-4" strokeWidth={2} />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>


      <InviteUserDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={loadData}
      />
      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        onDeleted={loadData}
        sources={sources}
      />
      <EmailMatchDialog
        open={emailMatchOpen}
        onClose={() => setEmailMatchOpen(false)}
      />
      <UnknownStatsDialog
        open={unknownStatsOpen}
        onClose={() => setUnknownStatsOpen(false)}
      />
    </div>
  );
}
