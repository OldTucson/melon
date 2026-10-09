import { redirect } from "next/navigation";

import { requireUser } from "@/features/auth/session";
import { WorkspaceShell } from "@/features/library/workspace-shell";
import { AuthenticatedThemeProvider } from "@/features/theme/authenticated-theme-provider";
import { QueryProvider } from "@/lib/query/provider";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  return (
    <AuthenticatedThemeProvider
      userId={user.id}
      serverPreference={user.themePreference}
    >
      <QueryProvider>
        <WorkspaceShell
          user={{ displayName: user.displayName, email: user.email }}
        >
          {children}
        </WorkspaceShell>
      </QueryProvider>
    </AuthenticatedThemeProvider>
  );
}
