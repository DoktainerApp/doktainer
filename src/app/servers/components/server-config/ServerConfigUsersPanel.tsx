"use client";

import { useMemo, useState } from "react";
import {
  Group,
  Loader2,
  LockKeyhole,
  Plus,
  ShieldAlert,
  UserPlus,
} from "lucide-react";
import type { ServerConfigSnapshot, ServerSystemUser } from "@/lib/api";
import {
  ServerUserCard,
  UserBadge,
} from "@/app/servers/components/server-config/ServerConfigPrimitives";
import SearchableSelect from "@/components/SearchableSelect";

interface ServerConfigUsersPanelProps {
  snapshot: ServerConfigSnapshot;
  snapshotLoadError?: string | null;
  canManageSystemAccounts: boolean;
  isActionRunning: (actionKey: string) => boolean;
  getSystemUserUpdateActionKey: (username: string) => string;
  onRequestCreateUserConfirm: (username: string, groups: string[]) => void;
  onRequestCreateGroupConfirm: (groupName: string) => void;
  onRequestUpdateUserConfirm: (
    user: ServerSystemUser,
    groups: string[],
    shell: string,
  ) => void;
}

const accountNamePattern = /^[a-z_][a-z0-9_-]{0,31}$/;
const sensitiveGroups = new Set(["docker", "root", "sudo", "wheel"]);

export default function ServerConfigUsersPanel({
  snapshot,
  snapshotLoadError,
  canManageSystemAccounts,
  isActionRunning,
  getSystemUserUpdateActionKey,
  onRequestCreateUserConfirm,
  onRequestCreateGroupConfirm,
  onRequestUpdateUserConfirm,
}: ServerConfigUsersPanelProps) {
  const [previewMode, setPreviewMode] = useState<"user" | "group">("user");
  const [previewUsername, setPreviewUsername] = useState("deploy");
  const [previewGroupName, setPreviewGroupName] = useState("docker");
  const [selectedGroups, setSelectedGroups] = useState<string[]>(() =>
    snapshot.systemGroups.includes("docker") ? ["docker"] : [],
  );
  const [editingUsername, setEditingUsername] = useState<string | null>(null);
  const [editDraftGroups, setEditDraftGroups] = useState<string[]>([]);
  const [editDraftShell, setEditDraftShell] = useState("/bin/bash");
  const users = useMemo(
    () => [
      ...(snapshot.rootUser ? [snapshot.rootUser] : []),
      ...snapshot.nonRootUsers,
    ],
    [snapshot.nonRootUsers, snapshot.rootUser],
  );
  const detectedGroups = useMemo(
    () =>
      Array.from(
        new Set(
          users.flatMap((user) => user.groups).filter((group) => group.trim()),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [users],
  );
  const commonGroups = ["docker", "sudo", "wheel", "root", "www-data", "adm"];
  const groupOptions = Array.from(
    new Set([...commonGroups, ...detectedGroups, ...snapshot.systemGroups]),
  ).filter(
    (group) =>
      snapshot.systemGroups.includes(group) && accountNamePattern.test(group),
  );
  const selectedSensitiveGroups = selectedGroups.filter((group) =>
    sensitiveGroups.has(group),
  );
  const privilegedSelection =
    previewMode === "user"
      ? selectedSensitiveGroups.length > 0
      : sensitiveGroups.has(previewGroupName.trim());
  const quickGroupOptions = Array.from(
    new Set([...selectedGroups, ...groupOptions.slice(0, 8)]),
  );
  const normalizedUsername = previewUsername.trim();
  const normalizedGroupName = previewGroupName.trim();
  const usernameExists = users.some(
    (user) => user.username === normalizedUsername,
  );
  const groupExists = snapshot.systemGroups.includes(normalizedGroupName);
  const usernameError = !accountNamePattern.test(normalizedUsername)
    ? "Use 1–32 lowercase letters, numbers, underscores, or hyphens; start with a letter or underscore."
    : normalizedUsername === "root"
      ? "The root account cannot be created or replaced."
      : usernameExists
        ? "This user already exists on the host."
        : null;
  const groupNameError = !accountNamePattern.test(normalizedGroupName)
    ? "Use 1–32 lowercase letters, numbers, underscores, or hyphens; start with a letter or underscore."
    : groupExists
      ? "This group already exists on the host."
      : null;
  const actionKey =
    previewMode === "user" ? "system-user:create" : "system-group:create";
  const actionRunning = isActionRunning(actionKey);
  const formInvalid =
    previewMode === "user" ? Boolean(usernameError) : Boolean(groupNameError);
  const previewCommand =
    previewMode === "user"
      ? [
          `useradd -m -s /bin/bash${
            selectedGroups.length > 0
              ? ` -G ${selectedGroups.join(",")}`
              : ""
          } ${previewUsername || "<username>"}`,
        ]
          .filter(Boolean)
          .join(" && ")
      : `groupadd ${previewGroupName || "<group>"}`;

  const toggleGroup = (group: string) => {
    setSelectedGroups((current) =>
      current.includes(group)
        ? current.filter((item) => item !== group)
        : current.length < 16
          ? [...current, group]
          : current,
    );
  };

  const beginEdit = (user: ServerSystemUser) => {
    if (user.isRoot) return;
    if (editingUsername === user.username) {
      setEditingUsername(null);
      return;
    }

    setEditingUsername(user.username);
    setEditDraftGroups(user.groups);
    setEditDraftShell(user.shell ?? "/bin/bash");
  };

  const toggleEditGroup = (group: string, sourceUser: ServerSystemUser) => {
    setEditDraftGroups((current) => {
      if (current.includes(group)) {
        const isPrimaryGroup = group === sourceUser.primaryGroup;
        const isProtectedSshGroup =
          sourceUser.isSshUser && sourceUser.groups.includes(group);
        if (isPrimaryGroup || isProtectedSshGroup) {
          return current;
        }
        return current.filter((item) => item !== group);
      }
      return current.length < 16 ? [...current, group] : current;
    });
  };

  const requestEditConfirmation = (user: ServerSystemUser) => {
    setEditingUsername(null);
    onRequestUpdateUserConfirm(
      user,
      editDraftGroups,
      user.isSshUser ? user.shell ?? editDraftShell : editDraftShell,
    );
  };

  return (
    <div
      style={{ display: "grid", gap: 16 }}
      hidden={snapshotLoadError != null}
    >
      <div className="card" style={{ padding: 18 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              User Inventory
            </strong>
            <p
              style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 13 }}
            >
              Showing root and non-root accounts together with their detected
              groups.
            </p>
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <UserBadge
              label={`${snapshot.hasRootUser ? 1 : 0} root`}
              tone="danger"
            />
            <UserBadge
              label={`${snapshot.nonRootUsers.length} non-root`}
              tone="info"
            />
          </div>
        </div>
      </div>
      <div
        className="card"
        style={{
          padding: 18,
          display: "grid",
          gap: 16,
          borderColor: "rgba(59,130,246,0.24)",
          background:
            "linear-gradient(180deg, rgba(59,130,246,0.045), var(--bg-card) 68%)",
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
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              User & Group Management
            </strong>
            <p
              style={{
                marginTop: 6,
                color: "var(--text-muted)",
                fontSize: 13,
                maxWidth: 620,
              }}
            >
              Create passwordless host accounts, create groups, and assign
              supplementary group access without opening a terminal.
            </p>
          </div>
          <UserBadge label="Audited action" tone="success" />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                height: 40,
                alignSelf: "start",
              }}
            >
              {[
                { key: "user", label: "Add User", icon: UserPlus },
                { key: "group", label: "Add Group", icon: Group },
              ].map((item) => {
                const Icon = item.icon;
                const active = previewMode === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className="btn"
                    onClick={() => setPreviewMode(item.key as "user" | "group")}
                    style={{
                      height: 40,
                      minHeight: 40,
                      padding: "0 12px",
                      justifyContent: "center",
                      borderColor: active ? "var(--accent)" : "var(--border)",
                      background: active
                        ? "rgba(59,130,246,0.12)"
                        : "var(--bg-input)",
                      color: active ? "var(--accent)" : "var(--text-primary)",
                    }}
                  >
                    <Icon size={14} />
                    {item.label}
                  </button>
                );
              })}
            </div>

            {previewMode === "user" ? (
              <>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Username
                  </span>
                  <input
                    className="input"
                    value={previewUsername}
                    onChange={(event) =>
                      setPreviewUsername(event.target.value)
                    }
                    placeholder="deploy"
                    autoComplete="off"
                    aria-invalid={Boolean(usernameError)}
                  />
                  {usernameError ? (
                    <span style={{ color: "#ef4444", fontSize: 12 }}>
                      {usernameError}
                    </span>
                  ) : null}
                </label>
                <div style={{ display: "grid", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Initial groups ({selectedGroups.length}/16)
                  </span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {quickGroupOptions.map((group) => {
                      const active = selectedGroups.includes(group);
                      const sensitive = sensitiveGroups.has(group);
                      return (
                        <button
                          key={group}
                          type="button"
                          className="btn"
                          onClick={() => toggleGroup(group)}
                          style={{
                            padding: "5px 10px",
                            fontSize: 12,
                            borderColor: active
                              ? sensitive
                                ? "rgba(245,158,11,0.38)"
                                : "rgba(59,130,246,0.38)"
                              : "var(--border)",
                            background: active
                              ? sensitive
                                ? "rgba(245,158,11,0.1)"
                                : "rgba(59,130,246,0.1)"
                              : "var(--bg-input)",
                            color: active
                              ? sensitive
                                ? "#f59e0b"
                                : "var(--accent)"
                              : "var(--text-secondary)",
                          }}
                        >
                          {group}
                        </button>
                      );
                    })}
                  </div>
                  {groupOptions.some(
                    (group) => !selectedGroups.includes(group),
                  ) ? (
                    <SearchableSelect
                      value=""
                      options={groupOptions
                        .filter((group) => !selectedGroups.includes(group))
                        .map((group) => ({
                          value: group,
                          label: group,
                          description: sensitiveGroups.has(group)
                            ? "Privileged"
                            : undefined,
                        }))}
                      onChange={(value) => {
                        if (value) toggleGroup(value);
                      }}
                      placeholder="Select another existing group..."
                      searchPlaceholder="Search group..."
                      emptyText="No matching group found"
                    />
                  ) : null}
                </div>
              </>
            ) : (
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Group name
                </span>
                <input
                  className="input"
                  value={previewGroupName}
                  onChange={(event) => setPreviewGroupName(event.target.value)}
                  placeholder="docker"
                  autoComplete="off"
                  aria-invalid={Boolean(groupNameError)}
                />
                {groupNameError ? (
                  <span style={{ color: "#ef4444", fontSize: 12 }}>
                    {groupNameError}
                  </span>
                ) : null}
              </label>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gap: 12,
              alignContent: "start",
            }}
          >
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 14,
                background: "var(--bg-input)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <strong
                  style={{ color: "var(--text-primary)", fontSize: 13 }}
                >
                  Planned host change
                </strong>
                {privilegedSelection ? (
                  <UserBadge label="Needs confirm" tone="warning" />
                ) : (
                  <UserBadge label="Low risk" tone="success" />
                )}
              </div>
              <code
                style={{
                  display: "block",
                  marginTop: 12,
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  lineHeight: 1.6,
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}
              >
                {previewCommand}
              </code>
              {previewMode === "user" ? (
                <p
                  style={{
                    marginTop: 10,
                    color: "var(--text-muted)",
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  No password is set. Configure an SSH public key separately
                  before using this account for remote login.
                </p>
              ) : null}
            </div>

            {privilegedSelection ? (
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  padding: 12,
                  borderRadius: 8,
                  color: "#b45309",
                  background: "rgba(245,158,11,0.09)",
                  border: "1px solid rgba(245,158,11,0.22)",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <ShieldAlert size={16} style={{ flex: "0 0 auto" }} />
                <span>
                  {previewMode === "user"
                    ? `Membership in ${selectedSensitiveGroups.join(", ")} can grant administrative or root-equivalent access.`
                    : `The ${normalizedGroupName} group is treated as privileged.`}{" "}
                  An explicit confirmation and audit event are required.
                </span>
              </div>
            ) : null}

            <button
              type="button"
              className="btn btn-primary"
              disabled={formInvalid || actionRunning || !canManageSystemAccounts}
              onClick={() => {
                if (previewMode === "user") {
                  onRequestCreateUserConfirm(normalizedUsername, selectedGroups);
                } else {
                  onRequestCreateGroupConfirm(normalizedGroupName);
                }
              }}
              style={{
                justifyContent: "center",
                opacity:
                  formInvalid || actionRunning || !canManageSystemAccounts
                    ? 0.65
                    : 1,
              }}
              title={
                canManageSystemAccounts
                  ? undefined
                  : "Operator or Super Admin role required"
              }
            >
              {actionRunning ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              {previewMode === "user" ? "Create User" : "Create Group"}
            </button>
            {!canManageSystemAccounts ? (
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                Operator or Super Admin role is required for host account
                changes.
              </p>
            ) : null}
          </div>
        </div>
      </div>
      {users.length > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fill, minmax(min(380px, 100%), 1fr))",
            gap: 16,
          }}
        >
          {users.map((user) => {
            const sourceUser = user;
            const isEditing = editingUsername === user.username;
            const updateActionKey = getSystemUserUpdateActionKey(user.username);
            const updateRunning = isActionRunning(updateActionKey);
            const editGroupOptions = Array.from(
              new Set([...editDraftGroups, ...groupOptions.slice(0, 10)]),
            );
            const selectedPrivilegedEditGroups = editDraftGroups.filter(
              (group) =>
                sensitiveGroups.has(group) && !sourceUser.groups.includes(group),
            );
            const groupChanges =
              editDraftGroups.length !== sourceUser.groups.length ||
              editDraftGroups.some(
                (group) => !sourceUser.groups.includes(group),
              );
            const shellChanges =
              !sourceUser.isSshUser && editDraftShell !== sourceUser.shell;
            const hasChanges = groupChanges || shellChanges;

            return (
              <ServerUserCard
                key={user.username}
                user={user}
                canEdit={canManageSystemAccounts && !updateRunning}
                isEditing={isEditing}
                onEdit={() => beginEdit(sourceUser)}
              >
                {isEditing ? (
                  <div
                    style={{
                      display: "grid",
                      gap: 12,
                      paddingTop: 14,
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <strong
                        style={{ color: "var(--text-primary)", fontSize: 13 }}
                      >
                        {sourceUser.isSshUser
                          ? "Edit SSH user access"
                          : "Edit user access"}
                      </strong>
                      <UserBadge label="Confirmation required" tone="warning" />
                    </div>

                    {sourceUser.isSshUser ? (
                      <div
                        style={{
                          padding: 10,
                          borderRadius: 8,
                          color: "#b45309",
                          background: "rgba(245,158,11,0.08)",
                          border: "1px solid rgba(245,158,11,0.2)",
                          fontSize: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        The active SSH login keeps its current shell and groups.
                        You can only add supplementary groups. Changes apply to
                        new SSH sessions after confirmation.
                      </div>
                    ) : null}

                    <label style={{ display: "grid", gap: 6 }}>
                      <span
                        style={{ fontSize: 12, color: "var(--text-muted)" }}
                      >
                        Login shell
                      </span>
                      <select
                        className="input"
                        value={editDraftShell}
                        disabled={sourceUser.isSshUser}
                        onChange={(event) =>
                          setEditDraftShell(event.target.value)
                        }
                      >
                        {Array.from(
                          new Set([
                            sourceUser.shell ?? "/bin/bash",
                            "/bin/bash",
                            "/bin/sh",
                            "/usr/sbin/nologin",
                          ]),
                        ).map((shell) => (
                          <option key={shell} value={shell}>
                            {shell}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div style={{ display: "grid", gap: 8 }}>
                      <span
                        style={{ fontSize: 12, color: "var(--text-muted)" }}
                      >
                        Group memberships ({editDraftGroups.length}/16)
                      </span>
                      <div
                        style={{ display: "flex", gap: 7, flexWrap: "wrap" }}
                      >
                        {editGroupOptions.map((group) => {
                          const selected = editDraftGroups.includes(group);
                          const locked =
                            group === sourceUser.primaryGroup ||
                            (sourceUser.isSshUser &&
                              sourceUser.groups.includes(group));
                          const privileged = sensitiveGroups.has(group);
                          return (
                            <button
                              key={group}
                              type="button"
                              className="btn"
                              onClick={() =>
                                toggleEditGroup(group, sourceUser)
                              }
                              title={
                                locked
                                  ? group === sourceUser.primaryGroup
                                    ? "The primary group cannot be removed"
                                    : "Current SSH login groups cannot be removed"
                                  : undefined
                              }
                              style={{
                                padding: "4px 9px",
                                fontSize: 12,
                                color: selected
                                  ? privileged
                                    ? "#f59e0b"
                                    : "#3b82f6"
                                  : "var(--text-secondary)",
                                borderColor: selected
                                  ? privileged
                                    ? "rgba(245,158,11,0.35)"
                                    : "rgba(59,130,246,0.35)"
                                  : "var(--border)",
                                background: selected
                                  ? privileged
                                    ? "rgba(245,158,11,0.08)"
                                    : "rgba(59,130,246,0.08)"
                                  : "var(--bg-input)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                              }}
                            >
                              {locked ? <LockKeyhole size={11} /> : null}
                              {group}
                            </button>
                          );
                        })}
                      </div>
                      {groupOptions.some(
                        (group) => !editDraftGroups.includes(group),
                      ) ? (
                        <SearchableSelect
                          value=""
                          options={groupOptions
                            .filter(
                              (group) => !editDraftGroups.includes(group),
                            )
                            .map((group) => ({
                              value: group,
                              label: group,
                              description: sensitiveGroups.has(group)
                                ? "Privileged"
                                : undefined,
                            }))}
                          onChange={(value) => {
                            if (value) {
                              toggleEditGroup(value, sourceUser);
                            }
                          }}
                          placeholder="Add another existing group..."
                          searchPlaceholder="Search group..."
                          emptyText="No matching group found"
                        />
                      ) : null}
                    </div>

                    {selectedPrivilegedEditGroups.length > 0 ? (
                      <div
                        style={{
                          color: "#b45309",
                          fontSize: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        New privileged access selected:{" "}
                        {selectedPrivilegedEditGroups.join(", ")}. The live
                        action requires explicit confirmation and is audited.
                      </div>
                    ) : null}

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setEditingUsername(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!hasChanges || updateRunning}
                        onClick={() => requestEditConfirmation(sourceUser)}
                        style={{ opacity: !hasChanges || updateRunning ? 0.65 : 1 }}
                      >
                        {updateRunning ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : null}
                        Save Changes
                      </button>
                    </div>
                  </div>
                ) : null}
              </ServerUserCard>
            );
          })}
        </div>
      ) : (
        <div
          className="card"
          style={{ padding: 20, color: "var(--text-muted)", fontSize: 13 }}
        >
          {snapshotLoadError
            ? "User inventory could not be fetched because the live server snapshot is unavailable."
            : "No users were included in the current snapshot."}
        </div>
      )}
    </div>
  );
}
