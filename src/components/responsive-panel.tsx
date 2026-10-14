"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useSyncExternalStore } from "react";

const compactQuery = "(max-width: 1100px)";
const subscribe = (onChange: () => void) => {
  const media = window.matchMedia?.(compactQuery);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
};
const getSnapshot = () => window.matchMedia?.(compactQuery).matches ?? false;
const getServerSnapshot = () => false;

/** The same content is an inline region on desktop and a modal sheet on compact screens. */
export function ResponsivePanel({
  as: Element = "div", children, className, id, label, onClose, open, returnFocus,
}: {
  as?: "div" | "aside";
  children: React.ReactNode;
  className: string;
  id?: string;
  label: string;
  onClose: () => void;
  open: boolean;
  returnFocus?: () => HTMLElement | null;
}) {
  const compact = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const previousFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  if (!compact) return <Element className={className} id={id} aria-label={label}>{children}</Element>;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="workspace-panel-overlay" />
        <Dialog.Content
          className={className}
          ref={panel}
          id={id}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            previousFocus.current = document.activeElement as HTMLElement;
            event.preventDefault();
            panel.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = previousFocus.current?.isConnected && previousFocus.current !== document.body
              ? previousFocus.current : returnFocus?.();
            target?.focus();
          }}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
