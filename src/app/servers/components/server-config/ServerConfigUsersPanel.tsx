"use client";

import { useMemo, useState } from "react";
import {
  Eye,
  EyeOff,
  Fingerprint,
  Group,
  KeyRound,
  Loader2,
  LockKeyhole,
  Plus,
  ShieldAlert,
  Trash2,
  UserPlus,
} from "lucide-react";
import type {
  ServerConfigSnapshot,
  ServerSystemUser,
  ServerSystemUserCreateBody,
} from "@/lib/api";
import {
  ServerUserCard,
  UserBadge,
} from "@/app/servers/components/server-config/ServerConfigPrimitives";
import SearchableSelect from "@/components/SearchableSelect";

interface ServerConfigUsersPanelProps {
  snapshot: ServerConfigSnapshot;
  snapshotLoadError?: string | null;
  serverAuthType: "PASSWORD" | "SSH_KEY";
  canManageSystemAccounts: boolean;
  isActionRunning: (actionKey: string) => boolean;
  getSystemUserUpdateActionKey: (username: string) => string;
  onRequestCreateUserConfirm: (
    options: Omit<ServerSystemUserCreateBody, "acknowledgePrivilegedGroups">,
  ) => void;
  onRequestCreateGroupConfirm: (groupName: string) => void;
  onRequestUpdateUserConfirm: (
    user: ServerSystemUser,
    groups: string[],
    shell: string,
  ) => void;
  onRequestPasswordConfirm: (options: {
    username: string;
    action: "set" | "disable";
    password?: string;
    requireChange?: boolean;
  }) => void;
  onRequestSshKeyAddConfirm: (options: {
    username: string;
    publicKey: string;
    label?: string;
    expectedRevision: string;
  }) => void;
  onRequestSshKeyRevokeConfirm: (options: {
    username: string;
    fingerprint: string;
    expectedRevision: string;
  }) => void;
  onRequestDeleteUserConfirm: (options: {
    user: ServerSystemUser;
    confirmation: string;
    removeHome: boolean;
  }) => void;
  onRequestDeleteGroupConfirm: (options: {
    groupName: string;
    gid: number;
    members: string[];
    primaryUsers: string[];
    confirmation: string;
  }) => void;
}

const accountNamePattern = /^[a-z_][a-z0-9_-]{0,31}$/;
const sensitiveGroups = new Set(["docker", "root", "sudo", "wheel"]);
const protectedGroupNames = new Set([
  "root",
  "sudo",
  "wheel",
  "docker",
  "adm",
  "www-data",
  "systemd-journal",
  "ssh",
  "sshd",
]);
const publicKeyPattern = /^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(?:\s+.*)?$/;

export default function ServerConfigUsersPanel({
  snapshot,
  snapshotLoadError,
  serverAuthType,
  canManageSystemAccounts,
  isActionRunning,
  getSystemUserUpdateActionKey,
  onRequestCreateUserConfirm,
  onRequestCreateGroupConfirm,
  onRequestUpdateUserConfirm,
  onRequestPasswordConfirm,
  onRequestSshKeyAddConfirm,
  onRequestSshKeyRevokeConfirm,
  onRequestDeleteUserConfirm,
  onRequestDeleteGroupConfirm,
}: ServerConfigUsersPanelProps) {
  const [previewMode, setPreviewMode] = useState<"user" | "group">("user");
  const [previewUsername, setPreviewUsername] = useState("deploy");
  const [previewGroupName, setPreviewGroupName] = useState("docker");
  const [userPurpose, setUserPurpose] = useState<"ssh" | "local">("ssh");
  const [loginMethod, setLoginMethod] = useState<"password" | "key">(
    "password",
  );
  const [setupPassword, setSetupPassword] = useState("");
  const [setupPasswordConfirm, setSetupPasswordConfirm] = useState("");
  const [showSetupPassword, setShowSetupPassword] = useState(false);
  const [setupPublicKey, setSetupPublicKey] = useState("");
  const [requirePasswordChange, setRequirePasswordChange] = useState(true);
  const [guidedSetupError, setGuidedSetupError] = useState<string | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<string[]>(() =>
    snapshot.systemGroups.includes("docker") ? ["docker"] : [],
  );
  const [editingUsername, setEditingUsername] = useState<string | null>(null);
  const [editDraftGroups, setEditDraftGroups] = useState<string[]>([]);
  const [editDraftShell, setEditDraftShell] = useState("/bin/bash");
  const [editSection, setEditSection] = useState<
    "account" | "login" | "danger"
  >(
    "account",
  );
  const [deleteUserConfirmation, setDeleteUserConfirmation] = useState("");
  const [deleteUserHome, setDeleteUserHome] = useState(false);
  const [managedGroup, setManagedGroup] = useState(
    snapshot.systemGroups.includes("docker")
      ? "docker"
      : snapshot.systemGroups[0] ?? "",
  );
  const [deleteGroupConfirmation, setDeleteGroupConfirmation] = useState("");
  const [passwordEditorOpen, setPasswordEditorOpen] = useState(false);
  const [editPassword, setEditPassword] = useState("");
  const [editPasswordConfirm, setEditPasswordConfirm] = useState("");
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [editPasswordError, setEditPasswordError] = useState<string | null>(null);
  const [forceEditPasswordChange, setForceEditPasswordChange] = useState(true);
  const [sshKeyEditorOpen, setSshKeyEditorOpen] = useState(false);
  const [sshKeyLabel, setSshKeyLabel] = useState("Personal laptop");
  const [sshPublicKey, setSshPublicKey] = useState("");
  const [sshKeyError, setSshKeyError] = useState<string | null>(null);
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
  const guidedSetupSummary =
    userPurpose === "local"
      ? `Create ${normalizedUsername || "<username>"} as a local/service account with remote login disabled.`
      : loginMethod === "password"
        ? `Create ${normalizedUsername || "<username>"} and prepare password-based SSH login.`
        : `Create ${normalizedUsername || "<username>"} and install an SSH public key.`;
  const managedGroupDetails = snapshot.systemGroupDetails.find(
    (group) => group.name === managedGroup,
  );
  const managedGroupUsers = managedGroupDetails?.members ?? [];
  const managedGroupPrimaryUsers = managedGroupDetails?.primaryUsers ?? [];
  const managedGroupBlockReason = !managedGroup
    ? "Select a group to inspect."
    : !managedGroupDetails || snapshot.gidMin == null
      ? "Group metadata or the host GID_MIN policy is unavailable. Refresh Server Config."
    : protectedGroupNames.has(managedGroup)
      ? `${managedGroup} is protected because it is a system or privileged group.`
      : managedGroupDetails.gid < snapshot.gidMin
        ? `GID ${managedGroupDetails.gid} is below the host GID_MIN (${snapshot.gidMin}).`
      : managedGroupPrimaryUsers.length > 0
        ? `This is the primary group for ${managedGroupPrimaryUsers.join(", ")}.`
        : managedGroupUsers.length > 0
          ? `Remove its members first: ${managedGroupUsers.join(", ")}.`
          : null;

  const toggleGroup = (group: string) => {
    setSelectedGroups((current) =>
      current.includes(group)
        ? current.filter((item) => item !== group)
        : current.length < 16
          ? [...current, group]
          : current,
    );
  };

  const stageGuidedUserSetup = () => {
    if (usernameError) {
      setGuidedSetupError(usernameError);
      return;
    }
    if (userPurpose === "ssh" && loginMethod === "password") {
      if (setupPassword.length < 12 || setupPassword.length > 128) {
        setGuidedSetupError("Use a password between 12 and 128 characters.");
        return;
      }
      if (setupPassword.toLowerCase().includes(normalizedUsername.toLowerCase())) {
        setGuidedSetupError("The password must not contain the username.");
        return;
      }
      if (setupPassword !== setupPasswordConfirm) {
        setGuidedSetupError("Password confirmation does not match.");
        return;
      }
    }
    if (
      userPurpose === "ssh" &&
      loginMethod === "key" &&
      !publicKeyPattern.test(setupPublicKey.trim().replace(/\s+/g, " "))
    ) {
      setGuidedSetupError("Paste a supported OpenSSH public key.");
      return;
    }

    const remoteLogin = userPurpose === "ssh";
    const credential: ServerSystemUserCreateBody["credential"] = !remoteLogin
      ? { type: "none" }
      : loginMethod === "password"
        ? {
            type: "password",
            password: setupPassword,
            requireChange: requirePasswordChange,
          }
        : { type: "ssh-key", publicKey: setupPublicKey.trim() };
    onRequestCreateUserConfirm({
      username: normalizedUsername,
      groups: selectedGroups,
      remoteLogin,
      credential,
    });
    setGuidedSetupError(null);
    setSetupPassword("");
    setSetupPasswordConfirm("");
    setSetupPublicKey("");
    setShowSetupPassword(false);
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
    setEditSection("account");
    setPasswordEditorOpen(false);
    setEditPassword("");
    setEditPasswordConfirm("");
    setShowEditPassword(false);
    setEditPasswordError(null);
    setForceEditPasswordChange(true);
    setSshKeyEditorOpen(false);
    setSshKeyLabel("Personal laptop");
    setSshPublicKey("");
    setSshKeyError(null);
    setDeleteUserConfirmation("");
    setDeleteUserHome(false);
  };

  const stageEditedPassword = (username: string) => {
    if (editPassword.length < 12 || editPassword.length > 128) {
      setEditPasswordError("Use a password between 12 and 128 characters.");
      return;
    }
    if (editPassword.toLowerCase().includes(username.toLowerCase())) {
      setEditPasswordError("The password must not contain the username.");
      return;
    }
    if (editPassword !== editPasswordConfirm) {
      setEditPasswordError("Password confirmation does not match.");
      return;
    }

    onRequestPasswordConfirm({
      username,
      action: "set",
      password: editPassword,
      requireChange: forceEditPasswordChange,
    });
    setPasswordEditorOpen(false);
    setEditPassword("");
    setEditPasswordConfirm("");
    setShowEditPassword(false);
    setEditPasswordError(null);
  };

  const requestSshKeyAdd = (user: ServerSystemUser) => {
    const normalizedKey = sshPublicKey.trim();
    const normalizedLabel = sshKeyLabel.trim();

    if (!normalizedLabel || normalizedLabel.length > 64) {
      setSshKeyError("Use a key label between 1 and 64 characters.");
      return;
    }
    if (normalizedKey.length > 16_384 || !publicKeyPattern.test(normalizedKey)) {
      setSshKeyError("Paste a supported OpenSSH public key, for example ssh-ed25519 or ssh-rsa.");
      return;
    }
    if (!user.authorizedKeysRevision) {
      setSshKeyError(
        "SSH key state is unavailable. Refresh after verifying non-interactive sudo access.",
      );
      return;
    }
    onRequestSshKeyAddConfirm({
      username: user.username,
      publicKey: normalizedKey,
      label: normalizedLabel,
      expectedRevision: user.authorizedKeysRevision,
    });
    setSshKeyError(null);
    setSshPublicKey("");
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
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-start",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <UserBadge
                    label="Guided user setup"
                    tone="info"
                  />
                </div>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Username
                  </span>
                  <input
                    className="input"
                    value={previewUsername}
                    onChange={(event) => {
                      setPreviewUsername(event.target.value);
                      setGuidedSetupError(null);
                    }}
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
                <div style={{ display: "grid", gap: 12 }}>
                    <div style={{ display: "grid", gap: 7 }}>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        What is this account for?
                      </span>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
                          gap: 8,
                        }}
                      >
                        {[
                          {
                            value: "ssh" as const,
                            title: "SSH login user",
                            description: "Can sign in and work on this server.",
                          },
                          {
                            value: "local" as const,
                            title: "Local/service user",
                            description: "Used by apps without remote login.",
                          },
                        ].map((option) => {
                          const selected = userPurpose === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              className="btn"
                              onClick={() => {
                                setUserPurpose(option.value);
                                setGuidedSetupError(null);
                              }}
                              style={{
                                minHeight: 68,
                                height: "auto",
                                padding: 10,
                                display: "grid",
                                justifyItems: "start",
                                alignContent: "center",
                                gap: 4,
                                textAlign: "left",
                                borderColor: selected
                                  ? "rgba(59,130,246,0.45)"
                                  : "var(--border)",
                                background: selected
                                  ? "rgba(59,130,246,0.1)"
                                  : "var(--bg-input)",
                              }}
                            >
                              <strong
                                style={{
                                  color: selected ? "#3b82f6" : "var(--text-primary)",
                                  fontSize: 12,
                                }}
                              >
                                {option.title}
                              </strong>
                              <span
                                style={{
                                  color: "var(--text-muted)",
                                  fontSize: 10,
                                  lineHeight: 1.4,
                                }}
                              >
                                {option.description}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {userPurpose === "ssh" ? (
                      <div style={{ display: "grid", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          How will this user sign in?
                        </span>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 8,
                          }}
                        >
                          {[
                            {
                              value: "password" as const,
                              title: "Password",
                              description: "Familiar for initial VPS setup.",
                            },
                            {
                              value: "key" as const,
                              title: "SSH public key",
                              description: "Recommended for better security.",
                            },
                          ].map((option) => {
                            const selected = loginMethod === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                className="btn"
                                onClick={() => {
                                  setLoginMethod(option.value);
                                  setGuidedSetupError(null);
                                }}
                                style={{
                                  minHeight: 62,
                                  height: "auto",
                                  padding: 9,
                                  display: "grid",
                                  justifyItems: "start",
                                  alignContent: "center",
                                  gap: 3,
                                  textAlign: "left",
                                  borderColor: selected
                                    ? "rgba(16,185,129,0.42)"
                                    : "var(--border)",
                                  background: selected
                                    ? "rgba(16,185,129,0.08)"
                                    : "var(--bg-input)",
                                }}
                              >
                                <strong
                                  style={{
                                    color: selected ? "#10b981" : "var(--text-primary)",
                                    fontSize: 12,
                                  }}
                                >
                                  {option.title}
                                </strong>
                                <span
                                  style={{
                                    color: "var(--text-muted)",
                                    fontSize: 10,
                                    lineHeight: 1.35,
                                  }}
                                >
                                  {option.description}
                                </span>
                              </button>
                            );
                          })}
                        </div>

                        {loginMethod === "password" ? (
                          <div style={{ display: "grid", gap: 8 }}>
                            <div style={{ position: "relative" }}>
                              <input
                                className="input"
                                type={showSetupPassword ? "text" : "password"}
                                value={setupPassword}
                                autoComplete="new-password"
                                maxLength={128}
                                onChange={(event) => {
                                  setSetupPassword(event.target.value);
                                  setGuidedSetupError(null);
                                }}
                                placeholder="Password (minimum 12 characters)"
                                style={{ width: "100%", paddingRight: 40 }}
                              />
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() =>
                                  setShowSetupPassword((current) => !current)
                                }
                                aria-label={
                                  showSetupPassword ? "Hide password" : "Show password"
                                }
                                style={{
                                  position: "absolute",
                                  top: "50%",
                                  right: 5,
                                  width: 28,
                                  minWidth: 28,
                                  height: 28,
                                  padding: 0,
                                  transform: "translateY(-50%)",
                                }}
                              >
                                {showSetupPassword ? (
                                  <EyeOff size={13} />
                                ) : (
                                  <Eye size={13} />
                                )}
                              </button>
                            </div>
                            <input
                              className="input"
                              type={showSetupPassword ? "text" : "password"}
                              value={setupPasswordConfirm}
                              autoComplete="new-password"
                              maxLength={128}
                              onChange={(event) => {
                                setSetupPasswordConfirm(event.target.value);
                                setGuidedSetupError(null);
                              }}
                              placeholder="Confirm password"
                            />
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                color: "var(--text-secondary)",
                                fontSize: 11,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={requirePasswordChange}
                                onChange={(event) =>
                                  setRequirePasswordChange(event.target.checked)
                                }
                              />
                              Require password change at first login
                            </label>
                            <p
                              style={{
                                color: "var(--text-muted)",
                                fontSize: 10,
                                lineHeight: 1.45,
                              }}
                            >
                              Doktainer will set the account password. SSH login
                              also depends on the host&apos;s current password-authentication policy.
                            </p>
                          </div>
                        ) : (
                          <textarea
                            className="input"
                            value={setupPublicKey}
                            rows={3}
                            spellCheck={false}
                            onChange={(event) => {
                              setSetupPublicKey(event.target.value);
                              setGuidedSetupError(null);
                            }}
                            placeholder="ssh-ed25519 AAAAC3... developer@laptop"
                            style={{
                              resize: "vertical",
                              minHeight: 76,
                              fontFamily: "monospace",
                              fontSize: 10,
                            }}
                          />
                        )}
                      </div>
                    ) : (
                      <div
                        style={{
                          padding: 10,
                          borderRadius: 8,
                          color: "var(--text-secondary)",
                          background: "var(--bg-input)",
                          fontSize: 11,
                          lineHeight: 1.5,
                        }}
                      >
                        Remote login will be disabled for this service account.
                      </div>
                    )}

                    {guidedSetupError ? (
                      <p role="alert" style={{ color: "#ef4444", fontSize: 11 }}>
                        {guidedSetupError}
                      </p>
                    ) : null}
                  </div>
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
                  {previewMode === "user"
                    ? "User setup summary"
                    : "Planned host change"}
                </strong>
                {previewMode === "user" ? (
                  <UserBadge label="Confirmation required" tone="warning" />
                ) : privilegedSelection ? (
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
                {previewMode === "user"
                  ? guidedSetupSummary
                  : previewCommand}
              </code>
              {previewMode === "user" ? (
                <div
                  style={{
                    display: "grid",
                    gap: 5,
                    marginTop: 10,
                    color: "var(--text-muted)",
                    fontSize: 11,
                    lineHeight: 1.5,
                  }}
                >
                  <span>✓ Create the account and home directory</span>
                  <span>✓ Add selected groups</span>
                  <span>✓ Configure the selected initial login credential</span>
                  <span>✓ Keep secrets out of command arguments and audit logs</span>
                </div>
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
                  stageGuidedUserSetup();
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
              {previewMode === "user"
                ? "Review & Create User"
                : "Create Group"}
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
      <div
        className="card"
        style={{
          padding: 18,
          display: "grid",
          gap: 14,
          borderColor: "rgba(239,68,68,0.18)",
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
              Existing Groups
            </strong>
            <p
              style={{
                marginTop: 5,
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Inspect group usage before opening the protected delete flow.
            </p>
          </div>
          <UserBadge label="Audited action" tone="success" />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 14,
            alignItems: "start",
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <SearchableSelect
              value={managedGroup}
              options={snapshot.systemGroupDetails.map((group) => ({
                value: group.name,
                label: group.name,
                description: protectedGroupNames.has(group.name) ||
                  (snapshot.gidMin != null && group.gid < snapshot.gidMin)
                  ? "Protected group"
                  : group.members.length > 0 || group.primaryUsers.length > 0
                    ? "In use"
                    : `GID ${group.gid} · eligible for review`,
              }))}
              onChange={(value) => {
                setManagedGroup(value);
                setDeleteGroupConfirmation("");
              }}
              placeholder="Select an existing group..."
              searchPlaceholder="Search group..."
              emptyText="No matching group found"
            />
            {managedGroup ? (
              <div
                style={{
                  display: "flex",
                  gap: 7,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <UserBadge
                  label={managedGroupBlockReason ? "Deletion locked" : "Candidate"}
                  tone={managedGroupBlockReason ? "warning" : "success"}
                />
                <UserBadge
                  label={`${managedGroupUsers.length} detected member${managedGroupUsers.length === 1 ? "" : "s"}`}
                  tone="neutral"
                />
              </div>
            ) : null}
          </div>

          <div
            style={{
              display: "grid",
              gap: 10,
              padding: 12,
              borderRadius: 9,
              border: managedGroupBlockReason
                ? "1px solid rgba(245,158,11,0.24)"
                : "1px solid rgba(239,68,68,0.24)",
              background: managedGroupBlockReason
                ? "rgba(245,158,11,0.055)"
                : "rgba(239,68,68,0.035)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {managedGroupBlockReason ? (
                <LockKeyhole size={15} color="#f59e0b" />
              ) : (
                <Trash2 size={15} color="#ef4444" />
              )}
              <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>
                Delete group
              </strong>
            </div>
            <p
              style={{
                color: managedGroupBlockReason ? "#b45309" : "var(--text-muted)",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              {managedGroupBlockReason ??
                "No members were detected. The live feature will re-check GID_MIN, primary-group usage, and membership on the host immediately before deletion."}
            </p>
            {!managedGroupBlockReason && managedGroup ? (
              <>
                <input
                  className="input"
                  value={deleteGroupConfirmation}
                  onChange={(event) =>
                    setDeleteGroupConfirmation(event.target.value)
                  }
                  placeholder={`Type ${managedGroup} to confirm`}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={
                    deleteGroupConfirmation !== managedGroup ||
                    !canManageSystemAccounts ||
                    !managedGroupDetails ||
                    isActionRunning(`system-group:delete:${managedGroup}`)
                  }
                  onClick={() => {
                    if (!managedGroupDetails) return;
                    onRequestDeleteGroupConfirm({
                      groupName: managedGroupDetails.name,
                      gid: managedGroupDetails.gid,
                      members: managedGroupDetails.members,
                      primaryUsers: managedGroupDetails.primaryUsers,
                      confirmation: deleteGroupConfirmation,
                    });
                  }}
                  style={{
                    justifyContent: "center",
                    color: "#ef4444",
                    borderColor: "rgba(239,68,68,0.32)",
                  }}
                >
                  <Trash2 size={13} /> Review Group Deletion
                </button>
              </>
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
            const passwordCredentialProtected =
              sourceUser.isSshUser && serverAuthType === "PASSWORD";
            const sshKeyCredentialProtected =
              sourceUser.isSshUser && serverAuthType === "SSH_KEY";
            const passwordStatusLabel = {
              set: "Configured",
              locked: "Locked",
              "not-set": "Not set",
              unknown: "Unavailable",
            }[sourceUser.passwordStatus];
            const userDeleteBlockReason = sourceUser.isRoot
              ? "The root account and UID 0 can never be deleted."
              : sourceUser.isSshUser
                ? "This account is used by Doktainer for the current SSH connection."
                : sourceUser.uid == null
                  ? "The account UID could not be verified. Refresh the server snapshot."
                  : snapshot.uidMin == null
                    ? "The host UID_MIN policy is unavailable. Refresh Server Config."
                  : sourceUser.uid < snapshot.uidMin
                    ? `UID ${sourceUser.uid} is below the host UID_MIN (${snapshot.uidMin}).`
                    : null;
            const canRemoveStandardHome =
              sourceUser.home === `/home/${sourceUser.username}`;

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

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(3, 1fr)",
                        gap: 7,
                        padding: 4,
                        borderRadius: 8,
                        background: "var(--bg-input)",
                      }}
                    >
                      {[
                        { value: "account" as const, label: "Account & Groups" },
                        { value: "login" as const, label: "Login Access" },
                        { value: "danger" as const, label: "Danger Zone" },
                      ].map((section) => (
                        <button
                          key={section.value}
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setEditSection(section.value)}
                          style={{
                            justifyContent: "center",
                            color:
                              editSection === section.value
                                ? section.value === "danger"
                                  ? "#ef4444"
                                  : "#3b82f6"
                                : "var(--text-secondary)",
                            background:
                              editSection === section.value
                                ? section.value === "danger"
                                  ? "rgba(239,68,68,0.08)"
                                  : "rgba(59,130,246,0.12)"
                                : "transparent",
                            border:
                              editSection === section.value
                                ? section.value === "danger"
                                  ? "1px solid rgba(239,68,68,0.22)"
                                  : "1px solid rgba(59,130,246,0.25)"
                                : "1px solid transparent",
                          }}
                        >
                          {section.label}
                        </button>
                      ))}
                    </div>

                    {editSection === "account" ? (
                      <>
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

                      </>
                    ) : editSection === "login" ? (
                      <div style={{ display: "grid", gap: 12 }}>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns:
                              "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
                            gap: 8,
                          }}
                        >
                          <div
                            style={{
                              padding: 10,
                              borderRadius: 8,
                              border: "1px solid var(--border)",
                              background: "var(--bg-input)",
                            }}
                          >
                            <span
                              style={{ color: "var(--text-muted)", fontSize: 10 }}
                            >
                              Remote login
                            </span>
                            <strong
                              style={{
                                display: "block",
                                marginTop: 4,
                                color:
                                  sourceUser.shell === "/usr/sbin/nologin"
                                    ? "#f59e0b"
                                    : "#10b981",
                                fontSize: 12,
                              }}
                            >
                              {sourceUser.shell === "/usr/sbin/nologin"
                                ? "Disabled by login shell"
                                : "Enabled"}
                            </strong>
                          </div>
                          <div
                            style={{
                              padding: 10,
                              borderRadius: 8,
                              border: "1px solid var(--border)",
                              background: "var(--bg-input)",
                            }}
                          >
                            <span
                              style={{ color: "var(--text-muted)", fontSize: 10 }}
                            >
                              Doktainer connection
                            </span>
                            <strong
                              style={{
                                display: "block",
                                marginTop: 4,
                                color: "var(--text-primary)",
                                fontSize: 12,
                              }}
                            >
                              {serverAuthType === "PASSWORD"
                                ? "Uses password"
                                : "Uses SSH key"}
                            </strong>
                          </div>
                        </div>

                        <div
                          style={{
                            display: "grid",
                            gap: 12,
                            padding: 12,
                            borderRadius: 10,
                            border: "1px solid rgba(245,158,11,0.22)",
                            background: "rgba(245,158,11,0.035)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: 10,
                              flexWrap: "wrap",
                            }}
                          >
                            <div>
                              <strong
                                style={{
                                  display: "block",
                                  color: "var(--text-primary)",
                                  fontSize: 13,
                                }}
                              >
                                Password
                              </strong>
                              <span
                                style={{ color: "var(--text-muted)", fontSize: 10 }}
                              >
                                Independent from SSH public keys
                              </span>
                            </div>
                            <UserBadge
                              label={passwordStatusLabel}
                              tone={
                                sourceUser.passwordStatus === "set"
                                  ? "success"
                                  : sourceUser.passwordStatus === "locked"
                                    ? "warning"
                                    : "neutral"
                              }
                            />
                          </div>

                          <p
                            style={{
                              color: "var(--text-muted)",
                              fontSize: 11,
                              lineHeight: 1.5,
                            }}
                          >
                            Existing passwords are never displayed. Doktainer only
                            reads whether the password is configured, locked, or absent.
                          </p>

                          {sourceUser.isSshUser ? (
                            <div
                              style={{
                                padding: 9,
                                borderRadius: 8,
                                color: "#b45309",
                                background: "rgba(245,158,11,0.08)",
                                fontSize: 10,
                                lineHeight: 1.5,
                              }}
                            >
                              This is the current SSH login. Credential removal
                              would require reconnect verification.
                            </div>
                          ) : null}

                          {passwordEditorOpen ? (
                            <div style={{ display: "grid", gap: 8 }}>
                              <div style={{ position: "relative" }}>
                                <input
                                  className="input"
                                  type={showEditPassword ? "text" : "password"}
                                  value={editPassword}
                                  autoComplete="new-password"
                                  maxLength={128}
                                  onChange={(event) => {
                                    setEditPassword(event.target.value);
                                    setEditPasswordError(null);
                                  }}
                                  placeholder="New password (minimum 12 characters)"
                                  style={{ width: "100%", paddingRight: 40 }}
                                />
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={() =>
                                    setShowEditPassword((current) => !current)
                                  }
                                  aria-label={
                                    showEditPassword
                                      ? "Hide new password"
                                      : "Show new password"
                                  }
                                  style={{
                                    position: "absolute",
                                    top: "50%",
                                    right: 5,
                                    width: 28,
                                    minWidth: 28,
                                    height: 28,
                                    padding: 0,
                                    transform: "translateY(-50%)",
                                  }}
                                >
                                  {showEditPassword ? (
                                    <EyeOff size={13} />
                                  ) : (
                                    <Eye size={13} />
                                  )}
                                </button>
                              </div>
                              <input
                                className="input"
                                type={showEditPassword ? "text" : "password"}
                                value={editPasswordConfirm}
                                autoComplete="new-password"
                                maxLength={128}
                                onChange={(event) => {
                                  setEditPasswordConfirm(event.target.value);
                                  setEditPasswordError(null);
                                }}
                                placeholder="Confirm new password"
                              />
                              <label
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  color: "var(--text-secondary)",
                                  fontSize: 10,
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={forceEditPasswordChange}
                                  onChange={(event) =>
                                    setForceEditPasswordChange(event.target.checked)
                                  }
                                />
                                Require password change at next login
                              </label>
                              {editPasswordError ? (
                                <p
                                  role="alert"
                                  style={{ color: "#ef4444", fontSize: 10 }}
                                >
                                  {editPasswordError}
                                </p>
                              ) : null}
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "flex-end",
                                  gap: 7,
                                }}
                              >
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() => {
                                    setPasswordEditorOpen(false);
                                    setEditPassword("");
                                    setEditPasswordConfirm("");
                                    setEditPasswordError(null);
                                  }}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={!editPassword || !editPasswordConfirm}
                                  onClick={() =>
                                    stageEditedPassword(sourceUser.username)
                                  }
                                >
                                  Review password change
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "flex-end",
                                gap: 7,
                                flexWrap: "wrap",
                              }}
                            >
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() =>
                                  onRequestPasswordConfirm({
                                    username: sourceUser.username,
                                    action: "disable",
                                  })
                                }
                                disabled={
                                  passwordCredentialProtected ||
                                  updateRunning ||
                                  sourceUser.passwordStatus !== "set"
                                }
                                title={
                                  passwordCredentialProtected
                                    ? "Cannot disable the credential used by the current Doktainer connection"
                                    : undefined
                                }
                              >
                                Disable password
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={
                                  passwordCredentialProtected || updateRunning
                                }
                                onClick={() => {
                                  setPasswordEditorOpen(true);
                                }}
                                title={
                                  passwordCredentialProtected
                                    ? "Cannot replace the password used by the current Doktainer connection"
                                    : undefined
                                }
                              >
                                {sourceUser.passwordStatus === "set"
                                  ? "Reset password"
                                  : "Set password"}
                              </button>
                            </div>
                          )}
                        </div>

                    <div
                      style={{
                        display: "grid",
                        gap: 12,
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid rgba(59,130,246,0.22)",
                        background: "rgba(59,130,246,0.035)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 10,
                          flexWrap: "wrap",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 9,
                          }}
                        >
                          <KeyRound size={15} color="#3b82f6" />
                          <div>
                            <strong
                              style={{
                                display: "block",
                                color: "var(--text-primary)",
                                fontSize: 13,
                              }}
                            >
                              SSH public keys
                            </strong>
                            <span
                              style={{
                                color: "var(--text-muted)",
                                fontSize: 11,
                              }}
                            >
                              Passwordless login for {sourceUser.username}
                            </span>
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                          }}
                        >
                          <UserBadge
                            label={
                              sourceUser.authorizedKeysRevision
                                ? `${sourceUser.sshKeys.length} configured`
                                : "Status unavailable"
                            }
                            tone={
                              sourceUser.authorizedKeysRevision
                                ? "info"
                                : "warning"
                            }
                          />
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              setSshKeyEditorOpen((current) => !current)
                            }
                            aria-expanded={sshKeyEditorOpen}
                          >
                            {sshKeyEditorOpen ? "Hide" : "Manage keys"}
                          </button>
                        </div>
                      </div>

                      {sshKeyEditorOpen ? (
                        <div
                          style={{
                            display: "grid",
                            gap: 12,
                            paddingTop: 12,
                            borderTop: "1px solid var(--border)",
                          }}
                        >
                          {sourceUser.sshKeys.length > 0 ? (
                            <div style={{ display: "grid", gap: 8 }}>
                              {sourceUser.sshKeys.map((key) => (
                                <div
                                  key={key.fingerprint}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 10,
                                    padding: 10,
                                    borderRadius: 8,
                                    border: "1px solid var(--border)",
                                    background: "var(--bg-card)",
                                  }}
                                >
                                  <div
                                    style={{
                                      minWidth: 0,
                                      display: "grid",
                                      gap: 4,
                                    }}
                                  >
                                    <strong
                                      style={{
                                        color: "var(--text-primary)",
                                        fontSize: 12,
                                      }}
                                    >
                                      {key.comment || key.keyType}
                                    </strong>
                                    <span
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 5,
                                        color: "var(--text-muted)",
                                        fontFamily: "monospace",
                                        fontSize: 10,
                                        overflowWrap: "anywhere",
                                      }}
                                    >
                                      <Fingerprint size={11} />
                                      {key.fingerprint}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                      if (!sourceUser.authorizedKeysRevision) return;
                                      onRequestSshKeyRevokeConfirm({
                                        username: sourceUser.username,
                                        fingerprint: key.fingerprint,
                                        expectedRevision:
                                          sourceUser.authorizedKeysRevision,
                                      });
                                    }}
                                    disabled={
                                      sshKeyCredentialProtected ||
                                      updateRunning ||
                                      !sourceUser.authorizedKeysRevision
                                    }
                                    title={
                                      sshKeyCredentialProtected
                                        ? "Keys cannot be revoked from the active Doktainer SSH key login"
                                        : "Revoke this SSH public key"
                                    }
                                    aria-label={`Revoke ${key.comment || key.fingerprint}`}
                                    style={{ color: "#ef4444" }}
                                  >
                                    <Trash2 size={13} /> Revoke
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div
                              style={{
                                padding: 10,
                                borderRadius: 8,
                                color: "var(--text-muted)",
                                background: "var(--bg-input)",
                                fontSize: 12,
                                lineHeight: 1.5,
                              }}
                            >
                              {sourceUser.authorizedKeysRevision
                                ? "No supported SSH public keys are configured for this user."
                                : "SSH key inventory is unavailable. Verify non-interactive sudo access and refresh Server Config."}
                            </div>
                          )}

                          <label style={{ display: "grid", gap: 6 }}>
                            <span
                              style={{
                                color: "var(--text-muted)",
                                fontSize: 12,
                              }}
                            >
                              Key label
                            </span>
                            <input
                              className="input"
                              value={sshKeyLabel}
                              maxLength={64}
                              onChange={(event) => {
                                setSshKeyLabel(event.target.value);
                                setSshKeyError(null);
                              }}
                              placeholder="e.g. Personal laptop"
                            />
                          </label>
                          <label style={{ display: "grid", gap: 6 }}>
                            <span
                              style={{
                                color: "var(--text-muted)",
                                fontSize: 12,
                              }}
                            >
                              OpenSSH public key
                            </span>
                            <textarea
                              className="input"
                              value={sshPublicKey}
                              rows={4}
                              spellCheck={false}
                              onChange={(event) => {
                                setSshPublicKey(event.target.value);
                                setSshKeyError(null);
                              }}
                              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@device"
                              style={{
                                resize: "vertical",
                                minHeight: 88,
                                fontFamily: "monospace",
                                fontSize: 11,
                              }}
                            />
                          </label>
                          {sshKeyError ? (
                            <p
                              role="alert"
                              style={{ color: "#ef4444", fontSize: 12 }}
                            >
                              {sshKeyError}
                            </p>
                          ) : null}
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: 10,
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                color: "var(--text-muted)",
                                fontSize: 11,
                                lineHeight: 1.45,
                              }}
                            >
                              Only the public key is accepted. Private keys must
                              never be uploaded.
                            </span>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={
                                !sshKeyLabel.trim() ||
                                !sshPublicKey.trim() ||
                                updateRunning ||
                                !sourceUser.authorizedKeysRevision
                              }
                              onClick={() => requestSshKeyAdd(sourceUser)}
                            >
                              <Plus size={13} />
                              Add public key
                            </button>
                          </div>
                          <div
                            style={{
                              padding: 10,
                              borderRadius: 8,
                              color: "#2563eb",
                              background: "rgba(59,130,246,0.08)",
                              border: "1px solid rgba(59,130,246,0.18)",
                              fontSize: 11,
                              lineHeight: 1.5,
                            }}
                          >
                            Doktainer validates the key, checks the latest file
                            revision, and updates authorized_keys atomically with
                            strict ownership and permissions.
                          </div>
                        </div>
                      ) : null}
                    </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "grid",
                          gap: 12,
                          padding: 13,
                          borderRadius: 10,
                          border: "1px solid rgba(239,68,68,0.24)",
                          background: "rgba(239,68,68,0.035)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 10,
                            flexWrap: "wrap",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            {userDeleteBlockReason ? (
                              <LockKeyhole size={15} color="#f59e0b" />
                            ) : (
                              <Trash2 size={15} color="#ef4444" />
                            )}
                            <strong
                              style={{
                                color: "var(--text-primary)",
                                fontSize: 13,
                              }}
                            >
                              Delete {sourceUser.username}
                            </strong>
                          </div>
                          <UserBadge
                            label={
                              userDeleteBlockReason
                                ? "Deletion locked"
                                : "Eligible for review"
                            }
                            tone={userDeleteBlockReason ? "warning" : "danger"}
                          />
                        </div>

                        {userDeleteBlockReason ? (
                          <div
                            style={{
                              padding: 10,
                              borderRadius: 8,
                              color: "#b45309",
                              background: "rgba(245,158,11,0.08)",
                              border: "1px solid rgba(245,158,11,0.2)",
                              fontSize: 11,
                              lineHeight: 1.5,
                            }}
                          >
                            {userDeleteBlockReason} This protection cannot be
                            bypassed from the panel.
                          </div>
                        ) : (
                          <>
                            <p
                              style={{
                                color: "var(--text-muted)",
                                fontSize: 11,
                                lineHeight: 1.55,
                              }}
                            >
                              The live action will re-check UID_MIN, the current
                              SSH identity, account revision, and active processes
                              immediately before deletion. Active processes will
                              block the action and will not be killed automatically.
                            </p>
                            <label
                              style={{
                                display: "flex",
                                gap: 9,
                                alignItems: "flex-start",
                                padding: 10,
                                borderRadius: 8,
                                border: "1px solid var(--border)",
                                background: "var(--bg-input)",
                                color: "var(--text-secondary)",
                                fontSize: 11,
                                lineHeight: 1.45,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={deleteUserHome}
                                disabled={!canRemoveStandardHome}
                                onChange={(event) =>
                                  setDeleteUserHome(event.target.checked)
                                }
                              />
                              <span>
                                <strong
                                  style={{
                                    display: "block",
                                    color: deleteUserHome
                                      ? "#ef4444"
                                      : "var(--text-primary)",
                                    fontSize: 11,
                                  }}
                                >
                                  Also remove the home directory
                                </strong>
                                {canRemoveStandardHome
                                  ? "Off by default. Keep it off when files may still be needed for recovery."
                                  : "Unavailable because this account does not use the standard /home/<username> path."}
                              </span>
                            </label>
                            {deleteUserHome ? (
                              <div
                                style={{
                                  color: "#b91c1c",
                                  fontSize: 11,
                                  lineHeight: 1.5,
                                }}
                              >
                                Home path scheduled for removal: {sourceUser.home ?? "unavailable"}
                              </div>
                            ) : null}
                            <label style={{ display: "grid", gap: 6 }}>
                              <span
                                style={{
                                  color: "var(--text-muted)",
                                  fontSize: 11,
                                }}
                              >
                                Type <strong>{sourceUser.username}</strong> to confirm
                              </span>
                              <input
                                className="input"
                                value={deleteUserConfirmation}
                                onChange={(event) =>
                                  setDeleteUserConfirmation(event.target.value)
                                }
                                placeholder={sourceUser.username}
                                autoComplete="off"
                              />
                            </label>
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={
                                deleteUserConfirmation !== sourceUser.username ||
                                updateRunning
                              }
                              onClick={() =>
                                onRequestDeleteUserConfirm({
                                  user: sourceUser,
                                  confirmation: deleteUserConfirmation,
                                  removeHome: deleteUserHome,
                                })
                              }
                              style={{
                                justifyContent: "center",
                                color: "#ef4444",
                                borderColor: "rgba(239,68,68,0.34)",
                              }}
                            >
                              <Trash2 size={13} /> Review User Deletion
                            </button>
                          </>
                        )}
                      </div>
                    )}

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
                        {editSection === "account" ? "Cancel" : "Close"}
                      </button>
                      {editSection === "account" ? (
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
                      ) : null}
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
