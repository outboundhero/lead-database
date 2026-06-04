export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { TopBar } from "@/components/layout/top-bar";
import { RoleProvider } from "@/lib/context/role-context";
import type { UserRole } from "@/types/auth";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("full_name, role")
    .eq("id", user.id)
    .single();

  const role = (profile?.role ?? "viewer") as UserRole;

  return (
    <div className="flex h-screen overflow-hidden">
      <SidebarNav
        email={user.email ?? ""}
        fullName={profile?.full_name ?? null}
        role={role}
      />
      <div className="flex flex-1 flex-col min-w-0">
        <TopBar />
        <RoleProvider role={role}>
          <main className="flex-1 overflow-auto p-4">{children}</main>
        </RoleProvider>
      </div>
    </div>
  );
}
