import { redirect } from "next/navigation";

import { requireUser } from "@/features/auth/session";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  return <div className="workspace-shell">{children}</div>;
}
