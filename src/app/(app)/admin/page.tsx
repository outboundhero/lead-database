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

  return (
    <div className="space-y-6 p-4 max-w-6xl">
      {/* Title + Action Buttons */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-semibold">Admin Dashboard</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setBulkDeleteOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" />
            Bulk Delete Leads
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setEmailMatchOpen(true)}>
            <MailCheck className="h-3.5 w-3.5" />
            Email Match Checker
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setUnknownStatsOpen(true)}>
            <HelpCircle className="h-3.5 w-3.5" />
            Unknown Lead Stats
          </Button>
          <Button size="sm" className="gap-1.5 text-xs" asChild>
            <Link href="/uploads">
              <Upload className="h-3.5 w-3.5" />
              Upload Leads
            </Link>
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                <Users className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Leads</p>
                <p className="text-2xl font-bold">{stats.totalLeads.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">New Leads ({monthName})</p>
                <p className="text-2xl font-bold">{stats.newLeadsMonth.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                <UserPlus className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Users</p>
                <p className="text-2xl font-bold">{stats.totalUsers}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                <Key className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Active API</p>
                <p className="text-2xl font-bold">{stats.activeApiTokens}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Team Manager */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Team Manager</CardTitle>
          {canManageUsers && (
            <Button size="sm" onClick={() => setInviteOpen(true)} className="gap-1.5">
              <UserPlus className="h-3.5 w-3.5" />
              Add User
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
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
          <CardTitle className="text-base">Recent Activity Logs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {auditLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity logs yet.</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Action</TableHead>
                    <TableHead className="text-xs">Performed By</TableHead>
                    <TableHead className="text-xs">Time</TableHead>
                    <TableHead className="text-xs">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-xs font-medium">{log.action}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {log.performed_by ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(log.created_at).toLocaleString("en-US", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
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
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Showing {(logsPage - 1) * LOGS_PER_PAGE + 1} to{" "}
                {Math.min(logsPage * LOGS_PER_PAGE, totalLogs)} of {totalLogs} results
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0"
                  disabled={logsPage <= 1}
                  onClick={() => handlePageChange(logsPage - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const page = i + 1;
                  return (
                    <Button
                      key={page}
                      variant={page === logsPage ? "default" : "outline"}
                      size="sm"
                      className="h-7 w-7 p-0 text-xs"
                      onClick={() => handlePageChange(page)}
                    >
                      {page}
                    </Button>
                  );
                })}
                {totalPages > 5 && (
                  <>
                    <span className="px-1">...</span>
                    <Button
                      variant={totalPages === logsPage ? "default" : "outline"}
                      size="sm"
                      className="h-7 w-7 p-0 text-xs"
                      onClick={() => handlePageChange(totalPages)}
                    >
                      {totalPages}
                    </Button>
                  </>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0"
                  disabled={logsPage >= totalPages}
                  onClick={() => handlePageChange(logsPage + 1)}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
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
