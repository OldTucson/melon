"use client";

import {
  type ThemePreference,
  useAuthenticatedTheme,
} from "@/features/theme/authenticated-theme-provider";

const options: ReadonlyArray<{
  value: ThemePreference;
  label: string;
}> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "夜间" },
];

export function ThemeControl() {
  const { error, preference, selectPreference } = useAuthenticatedTheme();

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
              onChange={() => selectPreference(option.value)}
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
