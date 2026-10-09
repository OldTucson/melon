"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

import type { ThemePreference } from "@/features/theme/theme-control";

export function AuthenticatedThemeSync({
  userId,
  preference,
}: {
  userId: string;
  preference: ThemePreference;
}) {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(preference);
  }, [preference, setTheme, userId]);

  return null;
}
