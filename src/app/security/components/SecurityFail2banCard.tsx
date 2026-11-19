import {
  Ban,
  CheckCircle,
  Loader2,
  Plus,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import type { SecuritySnapshot, Server } from "@/lib/api";
import { formatRelativeTime } from "./security-utils";

interface SecurityFail2banCardProps {
  selectedServer: Server;
  snapshot: SecuritySnapshot;
  actionKey: string | null;
  onToggle: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onUnban: (ip: string, jail: string) => void | Promise<void>;
}

export default function SecurityFail2banCard({
  selectedServer,
  snapshot,
  actionKey,
  onToggle,
  onRefresh,
  onUnban,
}: SecurityFail2banCardProps) {
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: "1 1 180px" }}>
          <Ban size={16} style={{ color: "#ef4444", flexShrink: 0 }} />
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <h2
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Fail2ban
            </h2>
            <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Brute force protection on {selectedServer.name}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span
            style={{
              fontSize: 12,
              whiteSpace: "nowrap",
              color: !snapshot.fail2ban.installed
                ? "#f59e0b"
                : snapshot.fail2ban.enabled
                  ? "#10b981"
                  : "#ef4444",
            }}
          >
            {!snapshot.fail2ban.installed
              ? "Not Installed"
              : snapshot.fail2ban.enabled
                ? "Active"
                : "Inactive"}
          </span>
          {!snapshot.fail2ban.installed ? (
            <button
              className="btn btn-primary"
              style={{ fontSize: 11, padding: "5px 10px", whiteSpace: "nowrap" }}
              onClick={() => void onToggle()}
              disabled={actionKey === "fail2ban-toggle"}
            >
              {actionKey === "fail2ban-toggle" ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Plus size={11} />
              )}
              Install & Activate
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onToggle()}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: snapshot.fail2ban.enabled
                  ? "#10b981"
                  : "var(--text-muted)",
              }}
              disabled={actionKey === "fail2ban-toggle"}
            >
              {actionKey === "fail2ban-toggle" ? (
                <Loader2 size={20} className="animate-spin" />
              ) : snapshot.fail2ban.enabled ? (
                <ToggleRight size={24} />
              ) : (
                <ToggleLeft size={24} />
              )}
            </button>
          )}
        </div>
      </div>
      <div style={{ padding: "8px 0" }}>
        <div
          style={{
            padding: "8px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              fontWeight: 500,
            }}
          >
            BANNED IPs ({snapshot.fail2ban.bannedIPs.length})
          </span>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 11, padding: "4px 8px" }}
            onClick={() => void onRefresh()}
          >
            <RefreshCw size={10} /> Refresh
          </button>
        </div>
        {snapshot.fail2ban.bannedIPs.length === 0 ? (
          <div
            style={{
              padding: "30px 20px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            <CheckCircle
              size={28}
              style={{
                color: "#10b981",
                margin: "0 auto 10px",
                display: "block",
              }}
            />
            No banned IPs on {selectedServer.name}
          </div>
        ) : (
          snapshot.fail2ban.bannedIPs.map((item) => (
            <div
              key={item.ip}
              style={{
                padding: "10px 20px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: "1px solid rgba(30,42,61,0.4)",
              }}
            >
              <div>
                <p
                  style={{
                    fontSize: 12,
                    fontFamily: "JetBrains Mono, monospace",
                    color: "#ef4444",
                    fontWeight: 600,
                  }}
                >
                  {item.ip}
                </p>
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    marginTop: 2,
                  }}
                >
                  Jail {item.jail} · banned {formatRelativeTime(item.bannedAt)}
                </p>
              </div>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11, padding: "4px 8px" }}
                onClick={() => void onUnban(item.ip, item.jail)}
                disabled={actionKey === `unban-${item.ip}`}
              >
                {actionKey === `unban-${item.ip}` ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  "Unban"
                )}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
