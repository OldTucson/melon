"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";

export type ThemePreference = "system" | "light" | "dark";

const options: ReadonlyArray<{
  value: ThemePreference;
  label: string;
}> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "夜间" },
];

export function ThemeControl({
  serverPreference,
}: {
  serverPreference: ThemePreference;
}) {
  return (
    <ThemeControlState
      key={serverPreference}
      serverPreference={serverPreference}
    />
  );
}

function ThemeControlState({
  serverPreference,
}: {
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

  const updatePreference = (nextPreference: ThemePreference) => {
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
    <fieldset className="theme-control">
      <legend>主题</legend>
      <div className="theme-options">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="theme-preference"
              value={option.value}
              checked={preference === option.value}
              onChange={() => void updatePreference(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {error ? (
        <p role="alert" aria-label="主题保存失败">
          无法保存主题，请重试。
        </p>
      ) : null}
    </fieldset>
  );
}
