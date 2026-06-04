"use client";

import { createContext, useContext } from "react";
import type { UserRole } from "@/types/auth";
import { hasPermission } from "@/types/auth";

interface RoleContextValue {
  role: UserRole;
}

const RoleContext = createContext<RoleContextValue>({ role: "viewer" });

export function RoleProvider({
  role,
  children,
}: {
  role: UserRole;
  children: React.ReactNode;
}) {
  return (
    <RoleContext.Provider value={{ role }}>{children}</RoleContext.Provider>
  );
}

export function useRole(): UserRole {
  return useContext(RoleContext).role;
}

export function useHasPermission(requiredRole: UserRole): boolean {
  const role = useRole();
  return hasPermission(role, requiredRole);
}
