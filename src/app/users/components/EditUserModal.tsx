"use client";

import { AlertCircle, Edit3, Loader2, X } from "lucide-react";
import { useState } from "react";
import type { Server as ServerRecord, UserRecord, UserRole } from "@/lib/api";
import ServerAccessSelector from "@/app/users/components/ServerAccessSelector";
import { manageableRoles } from "@/app/users/components/user-role-config";

export interface UpdateUserBody {
  name: string;
  email: string;
  role: Exclude<UserRole, "SUPER_ADMIN">;
  allServersAccess: boolean;
  serverIds: string[];
  password?: string;
}

interface EditUserModalProps {
  user: UserRecord;
  availableServers: ServerRecord[];
  onClose: () => void;
  onSubmit: (payload: UpdateUserBody) => Promise<void>;
  submitting: boolean;
  error: string;
}

export default function EditUserModal({
  user,
  availableServers,
  onClose,
  onSubmit,
  submitting,
  error,
}: EditUserModalProps) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Exclude<UserRole, "SUPER_ADMIN">>(
    user.role as Exclude<UserRole, "SUPER_ADMIN">,
  );
  const [allServersAccess, setAllServersAccess] = useState(
    user.allServersAccess,
  );
  const [serverIds, setServerIds] = useState(
    user.serverAssignments.map((assignment) => assignment.serverId),
  );
  const [password, setPassword] = useState("");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-shell"
        style={{ maxWidth: 640 }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label="Close edit user modal"
        >
          <X size={22} />
        </button>
        <div className="modal" style={{ maxWidth: 640 }}>
          <div style={{ marginBottom: 20, paddingRight: 36 }}>
            <h3
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              Edit User
            </h3>
            <p
              style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}
            >
              Update this organization user&apos;s access and sign-in details.
            </p>
          </div>

          {error ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                color: "#ef4444",
                padding: "10px 12px",
                borderRadius: 8,
                fontSize: 12,
                marginBottom: 12,
              }}
            >
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          ) : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 12,
            }}
          >
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              Name
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={2}
                required
              />
            </label>
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              Email
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
          </div>

          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 12,
              color: "var(--text-secondary)",
              marginTop: 12,
            }}
          >
            New password{" "}
            <span style={{ color: "var(--text-muted)" }}>
              (leave blank to keep current)
            </span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              autoComplete="new-password"
            />
          </label>

          <div style={{ marginTop: 16 }}>
            <p
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-secondary)",
                marginBottom: 8,
              }}
            >
              Role
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 8,
              }}
            >
              {manageableRoles.map((item) => (
                <label
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "9px 10px",
                    borderRadius: 8,
                    border: `1px solid ${role === item.id ? item.color : "var(--border)"}`,
                    background: "var(--bg-input)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  <input
                    type="radio"
                    name="role"
                    checked={role === item.id}
                    onChange={() =>
                      setRole(item.id as Exclude<UserRole, "SUPER_ADMIN">)
                    }
                    style={{ accentColor: item.color }}
                  />
                  {item.label}
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <p
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-secondary)",
                marginBottom: 8,
              }}
            >
              Server Access
            </p>
            <ServerAccessSelector
              availableServers={availableServers}
              allServersAccess={allServersAccess}
              selectedServerIds={serverIds}
              onAllServersChange={(value) => {
                setAllServersAccess(value);
                if (value) setServerIds([]);
              }}
              onSelectionChange={setServerIds}
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button
              className="btn btn-ghost"
              style={{ flex: 1 }}
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() =>
                void onSubmit({
                  name: name.trim(),
                  email: email.trim(),
                  role,
                  allServersAccess,
                  serverIds,
                  ...(password ? { password } : {}),
                })
              }
              disabled={submitting || name.trim().length < 2 || !email.trim()}
            >
              {submitting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Edit3 size={12} />
              )}
              Save User
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
