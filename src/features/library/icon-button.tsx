"use client";

import * as Tooltip from "@radix-ui/react-tooltip";

export function IconButton({
  children,
  className = "",
  disabled,
  label,
  onClick,
  pressed,
  type = "button",
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  label: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  pressed?: boolean;
  type?: "button" | "submit";
}) {
  const button = (
    <button
      type={type}
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {disabled ? (
          <span className="disabled-tooltip-trigger">{button}</span>
        ) : (
          button
        )}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={6}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
