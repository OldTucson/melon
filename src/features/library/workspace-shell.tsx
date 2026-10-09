"use client";

import * as Tooltip from "@radix-ui/react-tooltip";

import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function WorkspaceShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user: { displayName: string; email: string };
}) {
  return (
    <Tooltip.Provider delayDuration={350}>
      <div className="workspace">
        <Topbar user={user} />
        <Sidebar />
        <div className="workspace-main">{children}</div>
      </div>
    </Tooltip.Provider>
  );
}
