"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2, KeyRound } from "lucide-react";
import type { UserProfile, UserRole } from "@/types/auth";

interface UserTableProps {
  users: UserProfile[];
  currentUserRole: UserRole;
  currentUserEmail: string | null;
  onRefresh: () => void;
}

const ROLE_BADGE_CLASSES: Record<UserRole, string> = {
  owner: "bg-purple-100 text-purple-700 border-purple-200",
  admin: "bg-green-100 text-green-700 border-green-200",
  manager: "bg-blue-100 text-blue-700 border-blue-200",
  viewer: "bg-amber-100 text-amber-700 border-amber-200",
};

const ALL_ROLES: UserRole[] = ["owner", "admin", "manager", "viewer"];

export function UserTable({ users, currentUserRole, currentUserEmail, onRefresh }: UserTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [changingRole, setChangingRole] = useState<string | null>(null);

  const canManageUsers = currentUserRole === "owner" || currentUserRole === "admin";

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === users.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(users.map((u) => u.id)));
    }
  }

  async function handleDelete(userId: string) {
    if (!confirm("Are you sure you want to delete this user?")) return;
    setDeleting(userId);
    try {
      const res = await fetch("/api/admin/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, performedBy: currentUserEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success("User deleted");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setDeleting(null);
    }
  }

  async function handleResetPassword(userId: string) {
    setResetting(userId);
    try {
      const res = await fetch("/api/admin/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, performedBy: currentUserEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success("Password reset email sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setResetting(null);
    }
  }

  async function handleRoleChange(userId: string, newRole: UserRole) {
    setChangingRole(userId);
    try {
      const res = await fetch("/api/admin/update-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, newRole, performedBy: currentUserEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Role updated to ${newRole}`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setChangingRole(null);
    }
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40px]">
              <Checkbox
                checked={selected.size === users.length && users.length > 0}
                onCheckedChange={toggleAll}
              />
            </TableHead>
            <TableHead className="text-xs w-[50px]">No</TableHead>
            <TableHead className="text-xs">User</TableHead>
            <TableHead className="text-xs">Email</TableHead>
            <TableHead className="text-xs">Role</TableHead>
            <TableHead className="text-xs">Created</TableHead>
            {canManageUsers && <TableHead className="text-xs">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user, idx) => (
            <TableRow key={user.id}>
              <TableCell>
                <Checkbox
                  checked={selected.has(user.id)}
                  onCheckedChange={() => toggleSelect(user.id)}
                />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className="text-xs font-medium">
                {user.full_name ?? "—"}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {user.email ?? "—"}
              </TableCell>
              <TableCell>
                {canManageUsers && user.role !== "owner" ? (
                  <Select
                    value={user.role}
                    onValueChange={(v) => handleRoleChange(user.id, v as UserRole)}
                    disabled={changingRole === user.id}
                  >
                    <SelectTrigger className="h-7 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALL_ROLES.map((role) => (
                        <SelectItem key={role} value={role} className="text-xs">
                          {role.charAt(0).toUpperCase() + role.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge
                    variant="outline"
                    className={`text-xs capitalize ${ROLE_BADGE_CLASSES[user.role]}`}
                  >
                    {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(user.created_at).toLocaleDateString("en-CA")}
              </TableCell>
              {canManageUsers && (
                <TableCell>
                  {user.role !== "owner" && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive hover:text-destructive gap-1"
                        onClick={() => handleDelete(user.id)}
                        disabled={deleting === user.id}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-orange-600 hover:text-orange-600 gap-1"
                        onClick={() => handleResetPassword(user.id)}
                        disabled={resetting === user.id}
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        Reset Password
                      </Button>
                    </div>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
