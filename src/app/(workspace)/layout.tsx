import { redirect } from "next/navigation";

import { requireUser } from "@/features/auth/session";
import { AuthenticatedThemeSync } from "@/features/theme/authenticated-theme-sync";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  return (
    <div className="workspace-shell">
      <AuthenticatedThemeSync
        userId={user.id}
        preference={user.themePreference}
      />
      {children}
    </div>
  );
}
