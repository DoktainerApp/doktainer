"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

export type SearchableSelectOption = {
  value: string;
  label: string;
  keywords?: string;
  description?: string;
  disabled?: boolean;
};

type SearchableSelectProps = {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  style?: CSSProperties;
  showSearch?: boolean;
};

// Constants for menu sizing and option row height to ensure consistent layout
const VISIBLE_OPTION_COUNT = 5;
const OPTION_ROW_HEIGHT = 38;

export default function SearchableSelect({
  value,
  options,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled = false,
  style,
  showSearch = true,
}: SearchableSelectProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const filteredOptions = useMemo(() => {
    if (!showSearch) return options;

    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return options;

    return options.filter((option) => {
      const haystack =
        `${option.label} ${option.keywords ?? ""} ${option.description ?? ""}`
          .trim()
          .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [options, query, showSearch]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    if (!showSearch) return;

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open, showSearch]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !wrapperRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }

    const syncMenuPosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      setMenuStyle({
        position: "fixed",
        top: rect.bottom + 6,
        left: rect.left,
        width: rect.width,
        zIndex: 2100,
      });
    };

    syncMenuPosition();
    window.addEventListener("resize", syncMenuPosition);
    window.addEventListener("scroll", syncMenuPosition, true);

    return () => {
      window.removeEventListener("resize", syncMenuPosition);
      window.removeEventListener("scroll", syncMenuPosition, true);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} style={{ position: "relative", ...style }}>
      <button
        ref={triggerRef}
        type="button"
        className="input"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          cursor: disabled ? "not-allowed" : "pointer",
          textAlign: "left",
          opacity: disabled ? 0.7 : 1,
          fontWeight: 400,
        }}
      >
        <span
          style={{
            color: selected ? "var(--text-primary)" : "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={14} style={{ color: "var(--text-muted)" }} />
      </button>

      {open && menuStyle
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                ...menuStyle,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-card)",
                boxShadow: "0 18px 32px rgba(15, 23, 42, 0.18)",
                overflow: "hidden",
              }}
            >
              {showSearch ? (
                <div
                  style={{
                    padding: 6,
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg-card)",
                  }}
                >
                  <div style={{ position: "relative" }}>
                    <Search
                      size={13}
                      style={{
                        position: "absolute",
                        left: 10,
                        top: "50%",
                        transform: "translateY(-50%)",
                        color: "var(--text-muted)",
                        pointerEvents: "none",
                      }}
                    />
                    <input
                      ref={searchInputRef}
                      className="input"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={searchPlaceholder}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      style={{
                        width: "100%",
                        paddingLeft: 30,
                        minHeight: 34,
                        background: "var(--bg-input)",
                        borderColor: "var(--border)",
                        borderRadius: 4,
                        boxShadow: "none",
                      }}
                    />
                  </div>
                </div>
              ) : null}

              <div
                style={{
                  maxHeight: OPTION_ROW_HEIGHT * VISIBLE_OPTION_COUNT,
                  overflowY: "auto",
                  padding: 0,
                  background: "var(--bg-card)",
                }}
              >
                {filteredOptions.length === 0 ? (
                  <div
                    style={{
                      padding: "10px 12px",
                      minHeight: OPTION_ROW_HEIGHT,
                      fontSize: 12,
                      color: "var(--text-muted)",
                    }}
                  >
                    {emptyText}
                  </div>
                ) : (
                  filteredOptions.map((option) => {
                    const active = option.value === value;

                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          if (option.disabled) return;
                          onChange(option.value);
                          setOpen(false);
                        }}
                        disabled={option.disabled}
                        style={{
                          width: "100%",
                          border: "none",
                          borderBottom: "1px solid var(--border)",
                          background: active
                            ? "var(--bg-card-hover)"
                            : "transparent",
                          color: option.disabled
                            ? "var(--text-muted)"
                            : "var(--text-primary)",
                          minHeight: OPTION_ROW_HEIGHT,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                          textAlign: "left",
                          borderRadius: 0,
                          padding: "9px 12px",
                          cursor: option.disabled ? "not-allowed" : "pointer",
                          opacity: option.disabled ? 0.55 : 1,
                        }}
                      >
                        <span style={{ minWidth: 0 }}>
                          <span
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: 13,
                              lineHeight: 1.35,
                              overflow: "hidden",
                            }}
                          >
                            <span
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontWeight: 600,
                              }}
                            >
                              {option.label}
                            </span>
                            {showSearch && option.description ? (
                              <span
                                style={{
                                  flexShrink: 0,
                                  color: "var(--text-secondary)",
                                  fontSize: 11,
                                  fontWeight: 500,
                                }}
                              >
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        {active ? (
                          <Check
                            size={14}
                            style={{ color: "var(--text-primary)" }}
                          />
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
