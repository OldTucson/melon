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

  useEffect(() => {
    setTheme(serverPreference);
  }, [serverPreference, setTheme]);

  const updatePreference = async (nextPreference: ThemePreference) => {
    const rollbackPreference = confirmedPreference.current;
    setError(false);
    setPreference(nextPreference);
    setTheme(nextPreference);

    try {
      const response = await fetch("/api/settings/theme", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themePreference: nextPreference }),
      });

      if (!response.ok) {
        throw new Error("Theme preference was not saved");
      }

      confirmedPreference.current = nextPreference;
    } catch {
      setPreference(rollbackPreference);
      setTheme(rollbackPreference);
      setError(true);
    }
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
