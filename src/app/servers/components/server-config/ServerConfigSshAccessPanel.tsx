"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RotateCcw,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import type {
  Server as ServerType,
  ServerConfigSnapshot,
  ServerSshAccessUpdateBody,
} from "@/lib/api";
import { UserBadge } from "@/app/servers/components/server-config/ServerConfigPrimitives";

interface ServerConfigSshAccessPanelProps {
  server: ServerType;
  snapshot: ServerConfigSnapshot;
  snapshotLoadError?: string | null;
  canManageSystemAccounts: boolean;
  actionRunning: boolean;
  onRequestApplyConfirm: (options: ServerSshAccessUpdateBody) => void;
  onRequestPasswordConfirm: (options: {
    username: string;
    action: "set";
    password: string;
    requireChange: boolean;
    noticeTab?: "ssh-access";
  }) => void;
}

function PolicySwitch({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        flex: "0 0 auto",
        padding: 2,
        borderRadius: 999,
        border: checked
          ? "1px solid rgba(16,185,129,0.5)"
          : "1px solid var(--border)",
        background: checked ? "rgba(16,185,129,0.2)" : "var(--bg-input)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          display: "block",
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: checked ? "#10b981" : "var(--text-muted)",
          transform: checked ? "translateX(17px)" : "translateX(0)",
          transition: "transform 150ms ease",
        }}
      />
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 14,
        padding: "12px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <strong
          style={{ display: "block", color: "var(--text-primary)", fontSize: 13 }}
        >
          {title}
        </strong>
        <span
          style={{
            display: "block",
            marginTop: 4,
            color: "var(--text-muted)",
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          {description}
        </span>
      </div>
      {children}
    </div>
  );
}

type LoginPreset = "key-only" | "key-password" | "temporary";

export default function ServerConfigSshAccessPanel({
  server,
  snapshot,
  snapshotLoadError,
  canManageSystemAccounts,
  actionRunning,
  onRequestApplyConfirm,
  onRequestPasswordConfirm,
}: ServerConfigSshAccessPanelProps) {
  const current = snapshot.sshAccess;
  const initialPubkey = current.pubkeyAuthentication ?? true;
  const initialPassword =
    current.passwordAuthentication ?? server.authType === "PASSWORD";
  const initialRoot =
    current.permitRootLogin === "prohibit-password"
      ? "prohibit-password"
      : server.username === "root" && server.authType === "SSH_KEY"
        ? "prohibit-password"
        : "no";
  const [publicKeyAuthentication, setPublicKeyAuthentication] =
    useState(initialPubkey);
  const [passwordAuthentication, setPasswordAuthentication] =
    useState(initialPassword);
  const [permitRootLogin, setPermitRootLogin] = useState<
    "no" | "prohibit-password"
  >(initialRoot);
  const [selectedPreset, setSelectedPreset] = useState<LoginPreset>(() =>
    current.temporaryRollbackScheduled
      ? "temporary"
      : initialPassword
        ? "key-password"
        : "key-only",
  );
  const [temporaryDuration, setTemporaryDuration] = useState<
    15 | 30 | 60 | 240
  >(15);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [passwordUsername, setPasswordUsername] = useState(
    () =>
      snapshot.nonRootUsers.find((user) => !user.isSshUser)?.username ??
      snapshot.nonRootUsers[0]?.username ??
      "",
  );
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [confirmTemporaryPassword, setConfirmTemporaryPassword] = useState("");
  const [showTemporaryPassword, setShowTemporaryPassword] = useState(false);
  const [forcePasswordChange, setForcePasswordChange] = useState(true);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const activeMethodLocked =
    (server.authType === "PASSWORD" && !passwordAuthentication) ||
    (server.authType === "SSH_KEY" && !publicKeyAuthentication);
  const rootConnectionBlocked =
    server.username === "root" &&
    (permitRootLogin === "no" || server.authType === "PASSWORD");
  const noAuthenticationMethod =
    !publicKeyAuthentication && !passwordAuthentication;
  const temporaryUnsupported = server.authType !== "SSH_KEY";
  const temporaryPresetBlocked =
    temporaryUnsupported ||
    (current.passwordAuthentication === true &&
      !current.temporaryRollbackScheduled);
  const temporaryAlreadyEnabled =
    selectedPreset === "temporary" && current.passwordAuthentication === true;
  const temporaryMinutes =
    selectedPreset === "temporary" && !temporaryAlreadyEnabled
      ? temporaryDuration
      : null;
  const hasChanges =
    publicKeyAuthentication !== current.pubkeyAuthentication ||
    passwordAuthentication !== current.passwordAuthentication ||
    permitRootLogin !== current.permitRootLogin ||
    temporaryMinutes != null ||
    (current.temporaryRollbackScheduled && selectedPreset !== "temporary");
  const formBlocked =
    !current.available ||
    !current.revision ||
    activeMethodLocked ||
    rootConnectionBlocked ||
    noAuthenticationMethod ||
    (selectedPreset === "temporary" && temporaryPresetBlocked);
  const configPreview = useMemo(
    () =>
      [
        `PubkeyAuthentication ${publicKeyAuthentication ? "yes" : "no"}`,
        `PasswordAuthentication ${passwordAuthentication ? "yes" : "no"}`,
        "KbdInteractiveAuthentication no",
        `PermitRootLogin ${permitRootLogin}`,
        "PermitEmptyPasswords no",
      ].join("\n"),
    [passwordAuthentication, permitRootLogin, publicKeyAuthentication],
  );

  const selectPreset = (preset: LoginPreset) => {
    if (preset === "temporary" && temporaryPresetBlocked) return;
    setSelectedPreset(preset);
    setPublicKeyAuthentication(true);
    setPasswordAuthentication(preset !== "key-only");
  };

  const resetForm = () => {
    setPublicKeyAuthentication(initialPubkey);
    setPasswordAuthentication(initialPassword);
    setPermitRootLogin(initialRoot);
    setSelectedPreset(
      current.temporaryRollbackScheduled
        ? "temporary"
        : initialPassword
          ? "key-password"
          : "key-only",
    );
    setTemporaryDuration(15);
  };

  const reviewTemporaryPassword = () => {
    if (!passwordUsername) {
      setPasswordError("Select a non-root user first.");
      return;
    }
    if (temporaryPassword.length < 12 || temporaryPassword.length > 128) {
      setPasswordError("Use a password between 12 and 128 characters.");
      return;
    }
    if (
      temporaryPassword.toLowerCase().includes(passwordUsername.toLowerCase())
    ) {
      setPasswordError("The password must not contain the username.");
      return;
    }
    if (temporaryPassword !== confirmTemporaryPassword) {
      setPasswordError("Password confirmation does not match.");
      return;
    }
    onRequestPasswordConfirm({
      username: passwordUsername,
      action: "set",
      password: temporaryPassword,
      requireChange: forcePasswordChange,
      noticeTab: "ssh-access",
    });
    setTemporaryPassword("");
    setConfirmTemporaryPassword("");
    setShowTemporaryPassword(false);
    setPasswordError(null);
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        className="card"
        style={{
          padding: 18,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 14,
          flexWrap: "wrap",
          borderColor: "rgba(59,130,246,0.24)",
          background:
            "linear-gradient(135deg, rgba(59,130,246,0.08), rgba(16,185,129,0.04))",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <ShieldCheck size={18} color="#3b82f6" style={{ marginTop: 1 }} />
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              SSH Access
            </strong>
            <p
              style={{
                maxWidth: 650,
                marginTop: 6,
                color: "var(--text-muted)",
                fontSize: 13,
                lineHeight: 1.55,
              }}
            >
              Manage host-wide SSH authentication without changing the SSH
              port. Every apply is validated, reloaded, reconnected, and audited.
            </p>
          </div>
        </div>
        <UserBadge
          label={current.managed ? "Managed by Doktainer" : "Host policy"}
          tone={current.available ? "success" : "warning"}
        />
      </div>

      {snapshotLoadError || !current.available ? (
        <div
          className="card"
          style={{
            padding: 12,
            color: "#b45309",
            background: "rgba(245,158,11,0.08)",
            borderColor: "rgba(245,158,11,0.22)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {current.error || snapshotLoadError ||
            "The effective SSH policy is unavailable. No change can be applied."}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(210px, 100%), 1fr))",
          gap: 12,
        }}
      >
        {[
          {
            label: "Connected user",
            value: snapshot.currentUser ?? server.username,
            detail:
              server.authType === "SSH_KEY"
                ? "Doktainer uses an SSH key"
                : "Doktainer uses a password",
          },
          {
            label: "Connection port",
            value: String(server.sshPort),
            detail: "Port changes are excluded",
          },
          {
            label: "Effective login",
            value: current.passwordAuthentication ? "Key + password" : "Key only",
            detail: "Read with sshd -T",
          },
          {
            label: "Root login",
            value:
              current.permitRootLogin === "no"
                ? "Blocked"
                : current.permitRootLogin === "prohibit-password"
                  ? "Keys only"
                  : "Allowed",
            detail: "Empty passwords are always blocked",
          },
        ].map((item) => (
          <div
            key={item.label}
            className="card"
            style={{ padding: 14, display: "grid", gap: 5 }}
          >
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
              {item.label}
            </span>
            <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>
              {item.value}
            </strong>
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
              {item.detail}
            </span>
          </div>
        ))}
      </div>

      {current.temporaryRollbackScheduled ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 9,
            padding: 12,
            borderRadius: 9,
            color: "#b45309",
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.22)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <AlertTriangle size={15} style={{ flex: "0 0 auto" }} />
          A host-side timer is scheduled to restore the previous SSH policy.
          Applying a permanent policy will cancel that timer.
        </div>
      ) : null}

      <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <div>
          <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
            How should users sign in?
          </strong>
          <p style={{ marginTop: 5, color: "var(--text-muted)", fontSize: 12 }}>
            Choose a preset first. Advanced settings remain available below.
          </p>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(210px, 100%), 1fr))",
            gap: 10,
          }}
        >
          {[
            {
              value: "key-only" as const,
              title: "Key only",
              badge: "Recommended",
              description: "Production policy using authorized public keys.",
              disabled: server.authType === "PASSWORD",
            },
            {
              value: "key-password" as const,
              title: "Key and password",
              badge: "Easy setup",
              description: "Allow either a public key or account password.",
              disabled: false,
            },
            {
              value: "temporary" as const,
              title: "Temporary password",
              badge: `${temporaryDuration} min`,
              description: "Enable password login with host-side rollback.",
              disabled: temporaryPresetBlocked,
            },
          ].map((preset) => {
            const selected = selectedPreset === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                className="btn"
                disabled={preset.disabled}
                onClick={() => selectPreset(preset.value)}
                title={
                  preset.disabled
                    ? "Change Doktainer to an SSH key connection before selecting this policy"
                    : undefined
                }
                style={{
                  minHeight: 96,
                  height: "auto",
                  padding: 12,
                  display: "grid",
                  justifyItems: "start",
                  alignContent: "center",
                  gap: 6,
                  textAlign: "left",
                  opacity: preset.disabled ? 0.6 : 1,
                  borderColor: selected
                    ? "rgba(59,130,246,0.5)"
                    : "var(--border)",
                  background: selected
                    ? "rgba(59,130,246,0.1)"
                    : "var(--bg-input)",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                  }}
                >
                  <strong
                    style={{
                      color: selected ? "#3b82f6" : "var(--text-primary)",
                      fontSize: 13,
                    }}
                  >
                    {preset.title}
                  </strong>
                  <UserBadge
                    label={preset.badge}
                    tone={
                      preset.value === "key-only"
                        ? "success"
                        : preset.value === "temporary"
                          ? "warning"
                          : "info"
                    }
                  />
                </span>
                <span
                  style={{ color: "var(--text-muted)", fontSize: 10, lineHeight: 1.45 }}
                >
                  {preset.description}
                </span>
              </button>
            );
          })}
        </div>
        {selectedPreset === "temporary" && !temporaryAlreadyEnabled ? (
          <label
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(130px, 180px)",
              alignItems: "center",
              gap: 12,
              padding: 10,
              borderRadius: 8,
              background: "rgba(245,158,11,0.07)",
              border: "1px solid rgba(245,158,11,0.2)",
            }}
          >
            <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
              Restore the previous policy after
            </span>
            <select
              className="input"
              value={temporaryDuration}
              onChange={(event) =>
                setTemporaryDuration(
                  Number(event.target.value) as 15 | 30 | 60 | 240,
                )
              }
            >
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
            </select>
          </label>
        ) : null}
      </div>

      {selectedPreset === "temporary" ? (
        <div
          className="card"
          style={{
            padding: 18,
            display: "grid",
            gap: 12,
            borderColor: "rgba(245,158,11,0.28)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <KeyRound size={15} color="#f59e0b" />
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              Optional account password
            </strong>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
            Enabling password authentication does not create an account password.
            Set one here only when the selected user does not already have it.
          </p>
          {snapshot.nonRootUsers.length > 0 ? (
            <>
              <select
                className="input"
                value={passwordUsername}
                onChange={(event) => {
                  setPasswordUsername(event.target.value);
                  setPasswordError(null);
                }}
              >
                {snapshot.nonRootUsers.map((user) => (
                  <option key={user.username} value={user.username}>
                    {user.username}
                    {user.passwordStatus === "set" ? " (password configured)" : ""}
                  </option>
                ))}
              </select>
              <div style={{ position: "relative" }}>
                <input
                  className="input"
                  type={showTemporaryPassword ? "text" : "password"}
                  value={temporaryPassword}
                  maxLength={128}
                  autoComplete="new-password"
                  onChange={(event) => {
                    setTemporaryPassword(event.target.value);
                    setPasswordError(null);
                  }}
                  placeholder="Password (minimum 12 characters)"
                  style={{ width: "100%", paddingRight: 40 }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowTemporaryPassword((value) => !value)}
                  aria-label={showTemporaryPassword ? "Hide password" : "Show password"}
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
                  {showTemporaryPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <input
                className="input"
                type={showTemporaryPassword ? "text" : "password"}
                value={confirmTemporaryPassword}
                maxLength={128}
                autoComplete="new-password"
                onChange={(event) => {
                  setConfirmTemporaryPassword(event.target.value);
                  setPasswordError(null);
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
                  checked={forcePasswordChange}
                  onChange={(event) => setForcePasswordChange(event.target.checked)}
                />
                Require password change at next login
              </label>
              {passwordError ? (
                <p role="alert" style={{ color: "#ef4444", fontSize: 11 }}>
                  {passwordError}
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn-sm"
                disabled={!temporaryPassword || !confirmTemporaryPassword}
                onClick={reviewTemporaryPassword}
                style={{ justifyContent: "center" }}
              >
                <KeyRound size={13} /> Review Password Change
              </button>
            </>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
              Create a non-root user from the Users tab first.
            </p>
          )}
        </div>
      ) : null}

      <button
        type="button"
        className="btn"
        onClick={() => setAdvancedOpen((value) => !value)}
        aria-expanded={advancedOpen}
        style={{ width: "100%", justifyContent: "space-between", padding: "10px 14px" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ServerCog size={14} /> Advanced SSH configuration
        </span>
        {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {advancedOpen ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(320px, 100%), 1fr))",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div className="card" style={{ padding: 18, display: "grid", gap: 2 }}>
            <SettingRow
              title="Public key authentication"
              description="Required while Doktainer connects with an SSH key."
            >
              <PolicySwitch
                checked={publicKeyAuthentication}
                disabled={server.authType === "SSH_KEY"}
                label="Public key authentication"
                onChange={setPublicKeyAuthentication}
              />
            </SettingRow>
            <SettingRow
              title="Password authentication"
              description="Required while Doktainer connects with a password."
            >
              <PolicySwitch
                checked={passwordAuthentication}
                disabled={server.authType === "PASSWORD"}
                label="Password authentication"
                onChange={setPasswordAuthentication}
              />
            </SettingRow>
            <SettingRow
              title="Permit root login"
              description="Direct root password login is never offered."
            >
              <select
                className="input"
                value={permitRootLogin}
                onChange={(event) =>
                  setPermitRootLogin(
                    event.target.value as "no" | "prohibit-password",
                  )
                }
                style={{ width: 150, minWidth: 150, fontSize: 12 }}
              >
                <option value="no">No</option>
                <option value="prohibit-password">Keys only</option>
              </select>
            </SettingRow>
            <SettingRow
              title="Permit empty passwords"
              description="Hard-disabled and unavailable for editing."
            >
              <PolicySwitch
                checked={false}
                disabled
                label="Permit empty passwords"
                onChange={() => undefined}
              />
            </SettingRow>
          </div>
          <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              Managed drop-in
            </strong>
            <code
              style={{
                display: "block",
                padding: 12,
                borderRadius: 8,
                color: "var(--text-primary)",
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                fontSize: 11,
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
              }}
            >
              {configPreview}
            </code>
          </div>
        </div>
      ) : null}

      {(activeMethodLocked || rootConnectionBlocked || noAuthenticationMethod) ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 9,
            padding: 12,
            borderRadius: 9,
            color: "#b45309",
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.22)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <AlertTriangle size={15} style={{ flex: "0 0 auto" }} />
          {rootConnectionBlocked
            ? "The saved Doktainer connection still uses root. Move it to a non-root account before disabling root login."
            : activeMethodLocked
              ? "The authentication method used by Doktainer must remain enabled."
              : "At least one authentication method must remain enabled."}
        </div>
      ) : null}

      <div
        className="card"
        style={{
          padding: 18,
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(280px, 100%), 1fr))",
          gap: 16,
          alignItems: "center",
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          {[
            "Write /etc/ssh/sshd_config.d/00-doktainer.conf atomically",
            "Validate combined configuration with sshd -t and sshd -T",
            "Reload SSH without restarting the daemon",
            "Verify a fresh connection and rollback on failure",
          ].map((step) => (
            <span
              key={step}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                color: "var(--text-secondary)",
                fontSize: 11,
              }}
            >
              <CheckCircle2 size={13} color="#10b981" /> {step}
            </span>
          ))}
        </div>
        <div style={{ display: "grid", gap: 9 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              formBlocked ||
              !hasChanges ||
              actionRunning ||
              !canManageSystemAccounts
            }
            onClick={() => {
              if (!current.revision) return;
              onRequestApplyConfirm({
                expectedRevision: current.revision,
                pubkeyAuthentication: publicKeyAuthentication,
                passwordAuthentication,
                permitRootLogin,
                permitEmptyPasswords: false,
                temporaryMinutes,
              });
            }}
            style={{ justifyContent: "center" }}
          >
            {actionRunning ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ShieldCheck size={14} />
            )}
            Review & Apply SSH Policy
          </button>
          <button
            type="button"
            className="btn"
            disabled={actionRunning}
            onClick={resetForm}
            style={{ justifyContent: "center" }}
          >
            <RotateCcw size={14} /> Reset to Effective Policy
          </button>
        </div>
      </div>

      <div
        className="card"
        style={{
          padding: 14,
          display: "flex",
          alignItems: "flex-start",
          gap: 9,
          color: "var(--text-secondary)",
          fontSize: 11,
          lineHeight: 1.55,
        }}
      >
        <KeyRound size={15} color="#3b82f6" style={{ flex: "0 0 auto" }} />
        Public keys remain managed per account from Users → Edit → Login Access.
        This tab controls the host-wide authentication policy only.
      </div>
    </div>
  );
}
