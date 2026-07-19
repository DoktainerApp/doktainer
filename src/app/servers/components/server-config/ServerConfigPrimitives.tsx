"use client";

import type { ReactNode } from "react";
import { LockKeyhole, Pencil, ShieldCheck } from "lucide-react";
import type { ServerSystemUser } from "@/lib/api";
import type { UserBadgeTone } from "@/app/servers/components/server-config-utils";

export function ConfigInfoRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr",
        gap: 10,
        alignItems: "start",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
      <span
        style={{
          fontSize: 13,
          color: "var(--text-primary)",
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function UserBadge({
  label,
  tone,
}: {
  label: string;
  tone: UserBadgeTone;
}) {
  const palette = {
    danger: {
      color: "#ef4444",
      background: "rgba(239,68,68,0.08)",
      border: "rgba(239,68,68,0.2)",
    },
    success: {
      color: "#10b981",
      background: "rgba(16,185,129,0.08)",
      border: "rgba(16,185,129,0.2)",
    },
    neutral: {
      color: "var(--text-secondary)",
      background: "var(--bg-input)",
      border: "var(--border)",
    },
    warning: {
      color: "#f59e0b",
      background: "rgba(245,158,11,0.08)",
      border: "rgba(245,158,11,0.2)",
    },
    info: {
      color: "#3b82f6",
      background: "rgba(59,130,246,0.08)",
      border: "rgba(59,130,246,0.2)",
    },
  } as const;
  const style = palette[tone];

  return (
    <span
      className="ui-badge"
      title={label}
      style={{
        color: style.color,
        background: style.background,
        border: `1px solid ${style.border}`,
      }}
    >
      {label}
    </span>
  );
}

export function ServiceStatusBadge({ state }: { state: string }) {
  const normalized = state.toLowerCase();
  const tone =
    normalized === "active"
      ? "success"
      : normalized === "enabled"
        ? "info"
        : normalized === "inactive"
          ? "danger"
          : "warning";

  return <UserBadge label={state} tone={tone} />;
}

export function ServerUserCard({
  user,
  canEdit = false,
  isEditing = false,
  onEdit,
  children,
}: {
  user: ServerSystemUser;
  canEdit?: boolean;
  isEditing?: boolean;
  onEdit?: () => void;
  children?: ReactNode;
}) {
  const accountLabel = user.isRoot ? "root" : "non-root";
  const accountTone = user.isRoot ? "danger" : "info";

  return (
    <div
      className="card"
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              {user.username}
            </strong>
            <UserBadge label={accountLabel} tone={accountTone} />
            {user.isSshUser ? (
              <UserBadge label="SSH LOGIN" tone="neutral" />
            ) : null}
          </div>
          <p style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
            UID {user.uid ?? "—"} • GID {user.gid ?? "—"}
          </p>
        </div>
        {user.isRoot ? (
          <span
            className="ui-badge"
            title="Root account is protected and cannot be edited here"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "#ef4444",
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.2)",
            }}
          >
            <LockKeyhole size={13} /> Protected
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onEdit}
            disabled={!canEdit}
            aria-expanded={isEditing}
            title={
              canEdit
                ? user.isSshUser
                  ? "Edit access with SSH login protections"
                  : "Edit user access"
                : "Operator or Super Admin role required"
            }
            style={{
              color: user.isSshUser ? "#f59e0b" : "#3b82f6",
              border: user.isSshUser
                ? "1px solid rgba(245,158,11,0.2)"
                : "1px solid rgba(59,130,246,0.2)",
              background: user.isSshUser
                ? "rgba(245,158,11,0.08)"
                : "rgba(59,130,246,0.08)",
            }}
          >
            {user.isSshUser ? (
              <ShieldCheck size={13} />
            ) : (
              <Pencil size={13} />
            )}
            {user.isSshUser ? "Edit access" : "Edit"}
          </button>
        )}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <ConfigInfoRow label="Home" value={user.home ?? "—"} />
        <ConfigInfoRow label="Shell" value={user.shell ?? "—"} />
        <ConfigInfoRow
          label="Primary group"
          value={user.primaryGroup ?? "—"}
        />
        <ConfigInfoRow
          label="All groups"
          value={user.groups.length > 0 ? user.groups.join(", ") : "—"}
        />
      </div>
      {children}
    </div>
  );
}
