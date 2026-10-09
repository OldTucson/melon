"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";

export type ThemePreference = "system" | "light" | "dark";

type AuthenticatedThemeContextValue = {
  error: boolean;
  preference: ThemePreference;
  selectPreference: (preference: ThemePreference) => void;
};

const AuthenticatedThemeContext =
  createContext<AuthenticatedThemeContextValue | null>(null);

export function useAuthenticatedTheme() {
  const value = useContext(AuthenticatedThemeContext);

  if (!value) {
    throw new Error("Theme controls require an authenticated theme provider.");
  }

  return value;
}

export function AuthenticatedThemeProvider({
  children,
  serverPreference,
  userId,
}: {
  children: React.ReactNode;
  serverPreference: ThemePreference;
  userId: string;
}) {
  return (
    <AuthenticatedThemeCoordinator
      key={userId}
      serverPreference={serverPreference}
    >
      {children}
    </AuthenticatedThemeCoordinator>
  );
}

function AuthenticatedThemeCoordinator({
  children,
  serverPreference,
}: {
  children: React.ReactNode;
  serverPreference: ThemePreference;
}) {
  const { setTheme } = useTheme();
  const [preference, setPreference] = useState(serverPreference);
  const [error, setError] = useState(false);
  const confirmedPreference = useRef(serverPreference);
  const inFlight = useRef(false);
  const latestIntent = useRef(serverPreference);
  const mounted = useRef(true);
  const pendingPreference = useRef<ThemePreference | null>(null);

  useEffect(() => {
    confirmedPreference.current = serverPreference;

    if (inFlight.current || pendingPreference.current !== null) {
      return;
    }

    latestIntent.current = serverPreference;
    setError(false);
    setPreference(serverPreference);
    setTheme(serverPreference);
  }, [serverPreference, setTheme]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingPreference.current = null;
    };
  }, []);

  const persistPreference = async (targetPreference: ThemePreference) => {
    inFlight.current = true;
    let saved = false;

    try {
      const response = await fetch("/api/settings/theme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themePreference: targetPreference }),
      });

      if (!response.ok) {
        throw new Error("Theme preference was not saved");
      }

      saved = true;
    } catch {
      saved = false;
    }

    if (!mounted.current) {
      inFlight.current = false;
      return;
    }

    if (saved) {
      confirmedPreference.current = targetPreference;
    }

    const pending = pendingPreference.current;
    pendingPreference.current = null;
    inFlight.current = false;

    if (pending !== null) {
      if (pending !== confirmedPreference.current) {
        void persistPreference(pending);
      }
      return;
    }

    if (!saved && latestIntent.current === targetPreference) {
      const rollbackPreference = confirmedPreference.current;
      setPreference(rollbackPreference);
      setTheme(rollbackPreference);
      setError(true);
    }
  };

  const selectPreference = (nextPreference: ThemePreference) => {
    latestIntent.current = nextPreference;
    setError(false);
    setPreference(nextPreference);
    setTheme(nextPreference);

    if (inFlight.current) {
      pendingPreference.current = nextPreference;
      return;
    }

    void persistPreference(nextPreference);
  };

  return (
    <AuthenticatedThemeContext
      value={{ error, preference, selectPreference }}
    >
      {children}
    </AuthenticatedThemeContext>
  );
}
