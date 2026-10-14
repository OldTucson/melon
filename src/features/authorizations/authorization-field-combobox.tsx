"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  forwardRef,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AuthorizationFieldDto } from "./api";

function normalizeSearch(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export const AuthorizationFieldCombobox = forwardRef<HTMLInputElement, {
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  fields: AuthorizationFieldDto[];
  onChange: (fieldId: string | null) => void;
  value: string | null;
}>(function AuthorizationFieldCombobox(
  {
    ariaDescribedBy,
    ariaInvalid,
    fields,
    onChange,
    value,
  },
  forwardedRef,
) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = fields.find((field) => field.id === value);
  const [queryDraft, setQueryDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedLabel = selected
    ? `${selected.name}${selected.status === "archived" ? "（已归档）" : ""}`
    : "";
  const visibleDraft = value === null ? queryDraft : null;
  const query = visibleDraft ?? selectedLabel;
  const normalizedQuery = normalizeSearch(visibleDraft ?? "");
  const visibleFields = useMemo(
    () =>
      normalizedQuery
        ? fields.filter((field) =>
            normalizeSearch(field.name).includes(normalizedQuery),
          )
        : fields,
    [fields, normalizedQuery],
  );

  const choose = (field: AuthorizationFieldDto) => {
    if (field.status !== "active") return;
    setQueryDraft(null);
    onChange(field.id);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const move = (direction: 1 | -1) => {
    if (visibleFields.length === 0) return;
    if (!open) {
      setOpen(true);
      setActiveIndex(direction === 1 ? 0 : visibleFields.length - 1);
      return;
    }
    setOpen(true);
    setActiveIndex((current) => {
      if (current === -1) return direction === 1 ? 0 : visibleFields.length - 1;
      const next = current + direction;
      if (next < 0) return visibleFields.length - 1;
      if (next >= visibleFields.length) return 0;
      return next;
    });
  };

  return (
    <div
      className="authorization-field-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="authorization-field-label">授权领域</span>
      <div className="authorization-combobox-input">
        <input
          ref={(node) => {
            inputRef.current = node;
            if (typeof forwardedRef === "function") forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          aria-activedescendant={
            open && visibleFields[activeIndex]
              ? `${listId}-${visibleFields[activeIndex]!.id}`
              : undefined
          }
          aria-autocomplete="list"
          aria-controls={listId}
          aria-describedby={ariaDescribedBy}
          aria-expanded={open}
          aria-invalid={ariaInvalid || undefined}
          aria-label="授权领域"
          autoComplete="off"
          placeholder="搜索或选择领域"
          role="combobox"
          value={query}
          onChange={(event) => {
            setQueryDraft(event.target.value);
            onChange(null);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            setActiveIndex(
              Math.max(
                visibleFields.findIndex((field) => field.id === value),
                -1,
              ),
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              const field = visibleFields[activeIndex];
              if (field) choose(field);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        />
        <ChevronDown aria-hidden="true" />
      </div>
      {open ? (
        <div className="authorization-combobox-list" id={listId} role="listbox">
          {visibleFields.length > 0 ? (
            visibleFields.map((field, index) => (
              <button
                id={`${listId}-${field.id}`}
                key={field.id}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={field.id === value}
                aria-disabled={field.status === "archived" || undefined}
                disabled={field.status === "archived"}
                data-active={index === activeIndex ? "true" : undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => choose(field)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span>
                  {field.name}
                  {field.status === "archived" ? "（已归档）" : ""}
                </span>
                {field.id === value ? <Check aria-hidden="true" /> : null}
              </button>
            ))
          ) : (
            <p>没有匹配的领域</p>
          )}
        </div>
      ) : null}
    </div>
  );
});
