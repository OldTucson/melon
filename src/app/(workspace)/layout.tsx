import { redirect } from "next/navigation";

import { requireUser } from "@/features/auth/session";
import { AuthenticatedThemeProvider } from "@/features/theme/authenticated-theme-provider";

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
      <div className="workspace-shell">{children}</div>
    </AuthenticatedThemeProvider>
  );
}
