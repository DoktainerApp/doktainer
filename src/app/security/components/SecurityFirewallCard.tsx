import TablePagination from "@/components/TablePagination";
import {
  Flame,
  Loader2,
  Plus,
  ToggleLeft,
  ToggleRight,
  Trash2,
} from "lucide-react";
import type { SecurityFirewallRule, SecuritySnapshot, Server } from "@/lib/api";

interface SecurityFirewallCardProps {
  selectedServer: Server;
  snapshot: SecuritySnapshot;
  actionKey: string | null;
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startItem: number;
  endItem: number;
  paginatedItems: SecurityFirewallRule[];
  onPageChange: (page: number) => void;
  onToggleFirewall: () => void | Promise<void>;
  onOpenAddRule: () => void;
  onToggleRule: (rule: SecurityFirewallRule) => void | Promise<void>;
  onDeleteRule: (ruleNum: number) => void | Promise<void>;
  onDeleteSavedRule: (ruleId: string) => void | Promise<void>;
}

export default function SecurityFirewallCard({
  selectedServer,
  snapshot,
  actionKey,
  currentPage,
  totalPages,
  totalItems,
  startItem,
  endItem,
  paginatedItems,
  onPageChange,
  onToggleFirewall,
  onOpenAddRule,
  onToggleRule,
  onDeleteRule,
  onDeleteSavedRule,
}: SecurityFirewallCardProps) {
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
          <Flame size={16} style={{ color: "#f59e0b", flexShrink: 0 }} />
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <h2
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Firewall (UFW)
            </h2>
            <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {selectedServer.name} · {selectedServer.ip}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span
            style={{
              fontSize: 12,
              whiteSpace: "nowrap",
              color: snapshot.firewall.enabled ? "#10b981" : "#ef4444",
            }}
          >
            {snapshot.firewall.enabled ? "Enabled" : "Disabled"}
          </span>
          <button
            type="button"
            onClick={() => void onToggleFirewall()}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: snapshot.firewall.enabled
                ? "#10b981"
                : "var(--text-muted)",
            }}
            disabled={actionKey === "firewall-toggle"}
          >
            {actionKey === "firewall-toggle" ? (
              <Loader2 size={20} className="animate-spin" />
            ) : snapshot.firewall.enabled ? (
              <ToggleRight size={24} />
            ) : (
              <ToggleLeft size={24} />
            )}
          </button>
          <button
            className="btn btn-primary"
            style={{ fontSize: 11, padding: "5px 10px", whiteSpace: "nowrap" }}
            onClick={onOpenAddRule}
          >
            <Plus size={11} /> Add Rule
          </button>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Rule</th>
              <th>Action</th>
              <th>From</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snapshot.firewall.rules.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  style={{
                    textAlign: "center",
                    padding: 24,
                    color: "var(--text-muted)",
                  }}
                >
                  No firewall rules detected.
                </td>
              </tr>
            ) : (
              paginatedItems.map((rule) => (
                <tr key={rule.id ?? `${rule.number}-${rule.rule}`}>
                  <td style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {rule.number === null ? "Saved" : `#${rule.number}`}
                  </td>
                  <td>
                    <span
                      style={{
                        background: rule.enabled
                          ? "rgba(16,185,129,0.1)"
                          : "rgba(148,163,184,0.12)",
                        color: rule.enabled ? "#10b981" : "#94a3b8",
                        border: `1px solid ${rule.enabled ? "rgba(16,185,129,0.3)" : "rgba(148,163,184,0.25)"}`,
                        padding: "2px 8px",
                        borderRadius: 5,
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {rule.enabled ? "ACTIVE" : "DISABLED"}
                    </span>
                  </td>
                  <td
                    style={{
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 12,
                      color: rule.enabled
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                      fontWeight: 600,
                      opacity: rule.enabled ? 1 : 0.75,
                    }}
                  >
                    {rule.rule}
                  </td>
                  <td>
                    <span
                      style={{
                        background:
                          rule.action === "ALLOW"
                            ? "rgba(16,185,129,0.1)"
                            : "rgba(239,68,68,0.1)",
                        color: rule.action === "ALLOW" ? "#10b981" : "#ef4444",
                        border: `1px solid ${rule.action === "ALLOW" ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                        padding: "2px 8px",
                        borderRadius: 5,
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {rule.action}
                    </span>
                  </td>
                  <td style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {rule.from}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: "4px 7px", marginRight: 6 }}
                      onClick={() => void onToggleRule(rule)}
                      disabled={
                        actionKey === `toggle-rule-${rule.id ?? rule.number}`
                      }
                    >
                      {actionKey === `toggle-rule-${rule.id ?? rule.number}` ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : rule.enabled ? (
                        <ToggleRight size={14} />
                      ) : (
                        <ToggleLeft size={14} />
                      )}
                    </button>
                    <button
                      className="btn btn-danger"
                      style={{ padding: "4px 7px" }}
                      onClick={() => {
                        if (rule.enabled && rule.number !== null) {
                          void onDeleteRule(rule.number);
                          return;
                        }

                        if (rule.id) {
                          void onDeleteSavedRule(rule.id);
                        }
                      }}
                      disabled={
                        rule.enabled
                          ? actionKey === `delete-rule-${rule.number}`
                          : actionKey === `delete-saved-rule-${rule.id}`
                      }
                    >
                      {(
                        rule.enabled
                          ? actionKey === `delete-rule-${rule.number}`
                          : actionKey === `delete-saved-rule-${rule.id}`
                      ) ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Trash2 size={11} />
                      )}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <TablePagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={totalItems}
        startItem={startItem}
        endItem={endItem}
        itemLabel="rules"
        onPageChange={onPageChange}
      />
    </div>
  );
}
