"use client";

import DashboardLayout from "@/components/DashboardLayout";
import SearchField from "@/components/SearchField";
import ToastViewport from "@/components/ToastViewport";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import TablePagination from "@/components/TablePagination";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Network,
  Trash2,
  RefreshCw,
  Layers,
  ArrowLeftRight,
  Loader2,
  Plus,
  Eye,
  X,
} from "lucide-react";
import {
  networks as networksApi,
  NetworkDetails,
  servers as serversApi,
  NetworkRecord,
  Server,
} from "@/lib/api";
import {
  readCachedPageData,
  readStoredServerSelection,
  storeServerSelection,
  writeCachedPageData,
} from "@/lib/page-state";
import { useTablePagination } from "@/lib/use-table-pagination";
import { useToastManager } from "@/lib/use-toast-manager";

const PAGE_KEY = "networks";

const driverColors: Record<string, string> = {
  bridge: "#3b82f6",
  overlay: "#8b5cf6",
  host: "#10b981",
  macvlan: "#f59e0b",
};

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

function formatRelativeDate(value: string): string {
  const timestamp = new Date(value).getTime();
  const diffMs = Date.now() - timestamp;
  const diffDays = Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function AddNetworkModal({
  serverList,
  onClose,
  onAdded,
}: {
  serverList: Server[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    driver: "bridge",
    scope: "local",
    subnet: "",
    gateway: "",
    serverId: serverList[0]?.id ?? "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await networksApi.create({
        ...form,
        subnet: form.subnet || undefined,
        gateway: form.gateway || undefined,
      });
      onAdded();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create network");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-shell" style={{ maxWidth: 520 }}>
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label="Close create network modal"
        >
          <X size={22} />
        </button>
      <div
        className="modal animate-slide-in"
        style={{ width: "100%", maxWidth: 520, padding: 24 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 18,
            paddingRight: 36,
          }}
        >
          <div>
            <h3
              style={{
                color: "var(--text-primary)",
                fontWeight: 700,
                fontSize: 16,
              }}
            >
              Create Network
            </h3>
            <p
              style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}
            >
              Create a Docker network on the selected server and save it in the
              database.
            </p>
          </div>
        </div>

        {error && (
          <div
            style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 14,
              fontSize: 13,
              color: "#ef4444",
            }}
          >
            {error}
          </div>
        )}

        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <div>
            <label
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                display: "block",
                marginBottom: 6,
              }}
            >
              Target Server *
            </label>
            <select
              className="input"
              value={form.serverId}
              onChange={(e) =>
                setForm((current) => ({ ...current, serverId: e.target.value }))
              }
              style={{ width: "100%" }}
              required
            >
              <option value="">Select server</option>
              {serverList.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} ({server.ip})
                </option>
              ))}
            </select>
          </div>

          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Name *
              </label>
              <input
                className="input"
                value={form.name}
                onChange={(e) =>
                  setForm((current) => ({ ...current, name: e.target.value }))
                }
                placeholder="app-network"
                style={{ width: "100%" }}
                required
              />
            </div>
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Driver
              </label>
              <select
                className="input"
                value={form.driver}
                onChange={(e) =>
                  setForm((current) => ({ ...current, driver: e.target.value }))
                }
                style={{ width: "100%" }}
              >
                {["bridge", "overlay", "host", "macvlan"].map((driver) => (
                  <option key={driver} value={driver}>
                    {driver}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
            }}
          >
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Scope
              </label>
              <input
                className="input"
                value={form.scope}
                onChange={(e) =>
                  setForm((current) => ({ ...current, scope: e.target.value }))
                }
                placeholder="local"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Subnet
              </label>
              <input
                className="input"
                value={form.subnet}
                onChange={(e) =>
                  setForm((current) => ({ ...current, subnet: e.target.value }))
                }
                placeholder="172.18.0.0/16"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Gateway
              </label>
              <input
                className="input"
                value={form.gateway}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    gateway: e.target.value,
                  }))
                }
                placeholder="172.18.0.1"
                style={{ width: "100%" }}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              className="btn"
              style={{ flex: 1 }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              style={{
                flex: 1.5,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              Create Network
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  );
}

function NetworkDetailsModal({
  network,
  onClose,
}: {
  network: NetworkRecord;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<NetworkDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<
    "overview" | "containers" | "inspect"
  >("overview");

  useEffect(() => {
    networksApi
      .details(network.id)
      .then((res) => setDetail(res.data ?? null))
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Failed to load network details",
        );
      })
      .finally(() => setLoading(false));
  }, [network.id]);

  const tabs: Array<{
    id: "overview" | "containers" | "inspect";
    label: string;
  }> = [
    { id: "overview", label: "Overview" },
    { id: "containers", label: "Containers" },
    { id: "inspect", label: "Inspect" },
  ];

  const liveNetwork = detail?.detail;
  const containers = liveNetwork?.containers ?? [];
  const flagItems: Array<{ label: string; enabled: boolean }> = [
    { label: "Internal", enabled: Boolean(liveNetwork?.internal) },
    { label: "Attachable", enabled: Boolean(liveNetwork?.attachable) },
    { label: "Ingress", enabled: Boolean(liveNetwork?.ingress) },
  ];
  const summaryCards = [
    {
      label: "Driver",
      value: liveNetwork?.driver ?? network.driver,
      subvalue: `Scope: ${liveNetwork?.scope ?? network.scope}`,
    },
    {
      label: "Subnet",
      value: liveNetwork?.subnet ?? network.subnet ?? "-",
      subvalue: `Gateway: ${liveNetwork?.gateway ?? network.gateway ?? "-"}`,
    },
    {
      label: "Connected Containers",
      value: String(containers.length || network.containers),
      subvalue: liveNetwork?.internal ? "Internal network" : "External network",
    },
    {
      label: "Network ID",
      value: liveNetwork?.id?.slice(0, 12) ?? "-",
      subvalue: `Created: ${formatDateTime(liveNetwork?.created ?? null)}`,
    },
  ];

  return (
    <div className="modal-overlay">
      <div className="modal-shell" style={{ maxWidth: 1040 }}>
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label="Close network detail modal"
        >
          <X size={22} />
        </button>
        <div
        className="modal animate-slide-in"
        style={{
          width: "100%",
          maxWidth: 1040,
          maxHeight: "90vh",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "18px 22px",
            paddingRight: 56,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h3
                style={{
                  color: "var(--text-primary)",
                  fontWeight: 700,
                  fontSize: 16,
                }}
              >
                {network.name}
              </h3>
              <span
                style={{
                  background: "rgba(59,130,246,0.12)",
                  color: "#3b82f6",
                  border: "1px solid rgba(59,130,246,0.24)",
                  padding: "3px 8px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {liveNetwork?.driver ?? network.driver}
              </span>
            </div>
            <p
              style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}
            >
              {detail?.server
                ? `${detail.server.name} (${detail.server.ip})`
                : network.server
                  ? `${network.server.name} (${network.server.ip})`
                  : "Unknown server"}
            </p>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "14px 22px",
            borderBottom: "1px solid var(--border)",
            background: "rgba(255,255,255,0.02)",
            flexWrap: "wrap",
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="btn btn-ghost"
              style={{
                fontSize: 12,
                border:
                  activeTab === tab.id
                    ? "1px solid rgba(59,130,246,0.35)"
                    : "1px solid transparent",
                background:
                  activeTab === tab.id ? "rgba(59,130,246,0.12)" : undefined,
                color: activeTab === tab.id ? "#3b82f6" : undefined,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 22 }}>
          {loading ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <Loader2
                size={28}
                className="animate-spin"
                style={{ color: "var(--accent)", margin: "0 auto 12px" }}
              />
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                Loading network details...
              </p>
            </div>
          ) : error ? (
            <div
              style={{
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 10,
                padding: 16,
                color: "#ef4444",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          ) : detail ? (
            <>
              {activeTab === "overview" && (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 18 }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: 12,
                    }}
                  >
                    {summaryCards.map((card) => (
                      <div
                        key={card.label}
                        className="card"
                        style={{
                          padding: 16,
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{ fontSize: 11, color: "var(--text-muted)" }}
                        >
                          {card.label}
                        </span>
                        <span
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: "var(--text-primary)",
                            wordBreak: "break-word",
                          }}
                        >
                          {card.value}
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                          }}
                        >
                          {card.subvalue}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(240px, 1fr))",
                      gap: 16,
                    }}
                  >
                    <div className="card" style={{ padding: 16 }}>
                      <h4
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--text-primary)",
                          marginBottom: 12,
                        }}
                      >
                        Network Details
                      </h4>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                          fontSize: 13,
                        }}
                      >
                        {[
                          ["Name", liveNetwork?.name ?? network.name],
                          ["Scope", liveNetwork?.scope ?? network.scope],
                          ["Driver", liveNetwork?.driver ?? network.driver],
                          [
                            "Subnet",
                            liveNetwork?.subnet ?? network.subnet ?? "-",
                          ],
                          [
                            "Gateway",
                            liveNetwork?.gateway ?? network.gateway ?? "-",
                          ],
                          [
                            "IPv4",
                            liveNetwork?.enableIPv4 === null
                              ? "-"
                              : liveNetwork?.enableIPv4
                                ? "Enabled"
                                : "Disabled",
                          ],
                          [
                            "IPv6",
                            liveNetwork?.enableIPv6 === null
                              ? "-"
                              : liveNetwork?.enableIPv6
                                ? "Enabled"
                                : "Disabled",
                          ],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 12,
                              paddingBottom: 8,
                              borderBottom: "1px solid rgba(255,255,255,0.05)",
                            }}
                          >
                            <span style={{ color: "var(--text-muted)" }}>
                              {label}
                            </span>
                            <span
                              style={{
                                color: "var(--text-primary)",
                                fontWeight: 600,
                                textAlign: "right",
                                wordBreak: "break-word",
                              }}
                            >
                              {value}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="card" style={{ padding: 16 }}>
                      <h4
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--text-primary)",
                          marginBottom: 12,
                        }}
                      >
                        Flags & Metadata
                      </h4>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 12,
                        }}
                      >
                        <div
                          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                        >
                          {flagItems.map(({ label, enabled }) => (
                            <span
                              key={label}
                              style={{
                                padding: "4px 9px",
                                borderRadius: 999,
                                fontSize: 11,
                                fontWeight: 700,
                                background: enabled
                                  ? "rgba(16,185,129,0.12)"
                                  : "rgba(148,163,184,0.12)",
                                color: enabled
                                  ? "#10b981"
                                  : "var(--text-muted)",
                                border: enabled
                                  ? "1px solid rgba(16,185,129,0.24)"
                                  : "1px solid rgba(148,163,184,0.2)",
                              }}
                            >
                              {label}: {enabled ? "Yes" : "No"}
                            </span>
                          ))}
                        </div>

                        <div>
                          <p
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              marginBottom: 8,
                            }}
                          >
                            Labels
                          </p>
                          {Object.keys(liveNetwork?.labels ?? {}).length ===
                          0 ? (
                            <p
                              style={{
                                fontSize: 12,
                                color: "var(--text-secondary)",
                              }}
                            >
                              No labels found.
                            </p>
                          ) : (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                              }}
                            >
                              {Object.entries(liveNetwork?.labels ?? {}).map(
                                ([key, value]) => (
                                  <div
                                    key={key}
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      gap: 12,
                                      fontSize: 12,
                                    }}
                                  >
                                    <span
                                      style={{ color: "var(--text-muted)" }}
                                    >
                                      {key}
                                    </span>
                                    <span
                                      style={{
                                        color: "var(--text-primary)",
                                        textAlign: "right",
                                      }}
                                    >
                                      {value}
                                    </span>
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                        </div>

                        <div>
                          <p
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              marginBottom: 8,
                            }}
                          >
                            Options
                          </p>
                          {Object.keys(liveNetwork?.options ?? {}).length ===
                          0 ? (
                            <p
                              style={{
                                fontSize: 12,
                                color: "var(--text-secondary)",
                              }}
                            >
                              No network options found.
                            </p>
                          ) : (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                              }}
                            >
                              {Object.entries(liveNetwork?.options ?? {}).map(
                                ([key, value]) => (
                                  <div
                                    key={key}
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      gap: 12,
                                      fontSize: 12,
                                    }}
                                  >
                                    <span
                                      style={{ color: "var(--text-muted)" }}
                                    >
                                      {key}
                                    </span>
                                    <span
                                      style={{
                                        color: "var(--text-primary)",
                                        textAlign: "right",
                                      }}
                                    >
                                      {value}
                                    </span>
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "containers" && (
                <div className="card" style={{ overflow: "hidden" }}>
                  {containers.length === 0 ? (
                    <div style={{ padding: 28, textAlign: "center" }}>
                      <ArrowLeftRight
                        size={28}
                        style={{
                          color: "var(--text-muted)",
                          margin: "0 auto 10px",
                          opacity: 0.45,
                        }}
                      />
                      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                        No containers are attached to this network.
                      </p>
                    </div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Container ID</th>
                            <th>IPv4</th>
                            <th>IPv6</th>
                            <th>MAC</th>
                          </tr>
                        </thead>
                        <tbody>
                          {containers.map((container) => (
                            <tr key={container.id}>
                              <td
                                style={{
                                  color: "var(--text-primary)",
                                  fontWeight: 600,
                                }}
                              >
                                {container.name}
                              </td>
                              <td
                                style={{
                                  fontSize: 11,
                                  fontFamily: "JetBrains Mono, monospace",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                {container.id.slice(0, 12)}
                              </td>
                              <td
                                style={{
                                  fontSize: 11,
                                  fontFamily: "JetBrains Mono, monospace",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                {container.ipv4Address ?? "-"}
                              </td>
                              <td
                                style={{
                                  fontSize: 11,
                                  fontFamily: "JetBrains Mono, monospace",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                {container.ipv6Address ?? "-"}
                              </td>
                              <td
                                style={{
                                  fontSize: 11,
                                  fontFamily: "JetBrains Mono, monospace",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                {container.macAddress ?? "-"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "inspect" && (
                <div
                  className="card"
                  style={{ padding: 0, overflow: "hidden" }}
                >
                  <pre
                    style={{
                      margin: 0,
                      padding: 18,
                      fontSize: 12,
                      lineHeight: 1.55,
                      color: "var(--text-primary)",
                      maxHeight: "58vh",
                      overflow: "auto",
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    {JSON.stringify(detail.detail.raw, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : null}
        </div>
        </div>
      </div>
    </div>
  );
}

export default function NetworksPage() {
  const { toasts, pushToast, dismissToast } = useToastManager();
  const [items, setItems] = useState<NetworkRecord[]>([]);
  const [serverList, setServerList] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [detailFor, setDetailFor] = useState<NetworkRecord | null>(null);
  const [search, setSearch] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);

  const applyCachedState = useCallback((serverId: string) => {
    const cached = readCachedPageData<{
      items: NetworkRecord[];
      serverList: Server[];
    }>(PAGE_KEY, serverId);

    if (!cached) return false;

    setItems(cached.items);
    setServerList(cached.serverList);
    setLoading(false);
    return true;
  }, []);

  const load = useCallback(
    async (options?: { sync?: boolean; serverId?: string }) => {
      setLoading(true);
      try {
        const resolvedServerId = options?.serverId ?? "";
        const serversRes = await serversApi.list();
        const nextServers = serversRes.data ?? [];

        const networksRes = options?.sync
          ? await networksApi.sync(
              resolvedServerId ? { serverId: resolvedServerId } : undefined,
            )
          : await networksApi.list(resolvedServerId || undefined);

        setItems(networksRes.data ?? []);
        setServerList(nextServers);
        setSelectedServerId(resolvedServerId);
        storeServerSelection(PAGE_KEY, resolvedServerId);
        writeCachedPageData(
          PAGE_KEY,
          {
            items: networksRes.data ?? [],
            serverList: nextServers,
          },
          resolvedServerId,
        );
      } catch {
        if (options?.sync) {
          try {
            const resolvedServerId = options?.serverId ?? "";
            const serversRes = await serversApi.list();
            const nextServers = serversRes.data ?? [];
            const networksRes = await networksApi.list(
              resolvedServerId || undefined,
            );
            setItems(networksRes.data ?? []);
            setServerList(nextServers);
            setSelectedServerId(resolvedServerId);
            storeServerSelection(PAGE_KEY, resolvedServerId);
            writeCachedPageData(
              PAGE_KEY,
              {
                items: networksRes.data ?? [],
                serverList: nextServers,
              },
              resolvedServerId,
            );
          } catch {
            /* ignore */
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const storedServerId = readStoredServerSelection(PAGE_KEY);
    setSelectedServerId(storedServerId);
    const hasCache = applyCachedState(storedServerId);
    if (!hasCache) {
      void load({ sync: false, serverId: storedServerId });
    }
  }, [applyCachedState, load]);

  const stats = useMemo(
    () => ({
      total: items.length,
      bridge: items.filter((item) => item.driver === "bridge").length,
      containers: items.reduce((acc, item) => acc + item.containers, 0),
    }),
    [items],
  );
  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;

    return items.filter((item) =>
      [
        item.name,
        item.driver,
        item.scope,
        item.subnet ?? "",
        item.gateway ?? "",
        item.server?.name ?? "",
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [items, search]);
  const pagination = useTablePagination({
    items: filteredItems,
    resetKey: `${selectedServerId}|${search}`,
  });

  const deleteNetwork = async (id: string) => {
    setDeletingId(id);
    try {
      await networksApi.delete(id);
      setItems((current) => current.filter((item) => item.id !== id));
      pushToast({
        tone: "success",
        message: "Network deleted successfully",
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Delete Failed",
        message:
          err instanceof Error ? err.message : "Failed to delete network",
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleDelete = (id: string) => {
    const network = items.find((item) => item.id === id);
    setConfirmDialog({
      title: "Delete Network",
      description: network
        ? `Delete network "${network.name}" from the inventory?`
        : "Delete this network record?",
      confirmLabel: "Delete Network",
      tone: "danger",
      note: "This removes the network record from the dashboard list.",
      onConfirm: () => {
        void deleteNetwork(id);
      },
    });
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await load({ sync: true, serverId: selectedServerId });
      pushToast({
        tone: "success",
        title: "Sync Complete",
        message: "Docker networks refreshed successfully",
      });
    } catch (err: unknown) {
      pushToast({
        tone: "error",
        title: "Sync Failed",
        message:
          err instanceof Error ? err.message : "Failed to sync Docker networks",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleServerChange = async (serverId: string) => {
    if (serverId === selectedServerId) return;
    storeServerSelection(PAGE_KEY, serverId);
    setSelectedServerId(serverId);
    const hasCache = applyCachedState(serverId);
    if (!hasCache) {
      await load({ sync: false, serverId });
    }
  };

  return (
    <DashboardLayout
      title="Networks"
      subtitle="Manage network records stored in the database"
    >
      <ConfirmActionDialog
        open={confirmDialog !== null}
        title={confirmDialog?.title ?? ""}
        description={confirmDialog?.description ?? ""}
        confirmLabel={confirmDialog?.confirmLabel ?? "Confirm"}
        tone={confirmDialog?.tone ?? "danger"}
        note={confirmDialog?.note}
        onClose={() => setConfirmDialog(null)}
        onConfirm={() => {
          const current = confirmDialog;
          setConfirmDialog(null);
          current?.onConfirm();
        }}
      />
      <ToastViewport toasts={toasts} onClose={dismissToast} />
      {showAdd && (
        <AddNetworkModal
          serverList={serverList}
          onClose={() => setShowAdd(false)}
          onAdded={() => void load()}
        />
      )}
      {detailFor && (
        <NetworkDetailsModal
          key={detailFor.id}
          network={detailFor}
          onClose={() => setDetailFor(null)}
        />
      )}

      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          {[
            {
              label: "Total Networks",
              value: stats.total,
              color: "#3b82f6",
              icon: Network,
            },
            {
              label: "Bridge",
              value: stats.bridge,
              color: "#8b5cf6",
              icon: Layers,
            },
            {
              label: "Connected Containers",
              value: stats.containers,
              color: "#10b981",
              icon: ArrowLeftRight,
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.label}
                className="card"
                style={{
                  padding: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 10,
                    background: `${item.color}15`,
                    border: `1px solid ${item.color}25`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={18} style={{ color: item.color }} />
                </div>
                <div>
                  <p
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      lineHeight: 1,
                    }}
                  >
                    {item.value}
                  </p>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 3,
                    }}
                  >
                    {item.label}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div
          className="card ui-responsive-toolbar"
          style={{
            padding: "12px 16px",
          }}
        >
          <div className="ui-inline-cluster">
            <Layers size={14} style={{ color: "var(--text-muted)" }} />
            <span
              className="ui-inline-label"
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                fontWeight: 500,
              }}
            >
              Server:
            </span>
            <div className="ui-chip-scroll no-scrollbar">
              <button
                key="all-servers"
                onClick={() => void handleServerChange("")}
                style={{
                  padding: "5px 14px",
                  borderRadius: 7,
                  border: "none",
                  cursor: "pointer",
                  background:
                    selectedServerId === ""
                      ? "rgba(59,130,246,0.15)"
                      : "var(--bg-input)",
                  color:
                    selectedServerId === "" ? "#3b82f6" : "var(--text-muted)",
                  fontSize: 12,
                  fontWeight: 500,
                  outline:
                    selectedServerId === ""
                      ? "1px solid rgba(59,130,246,0.3)"
                      : "1px solid var(--border)",
                }}
              >
                All Servers
              </button>
              {serverList.map((server) => (
                <button
                  key={server.id}
                  onClick={() => void handleServerChange(server.id)}
                  style={{
                    padding: "5px 14px",
                    borderRadius: 7,
                    border: "none",
                    cursor: "pointer",
                    background:
                      selectedServerId === server.id
                        ? "rgba(59,130,246,0.15)"
                        : "var(--bg-input)",
                    color:
                      selectedServerId === server.id
                        ? "#3b82f6"
                        : "var(--text-muted)",
                    fontSize: 12,
                    fontWeight: 500,
                    outline:
                      selectedServerId === server.id
                        ? "1px solid rgba(59,130,246,0.3)"
                        : "1px solid var(--border)",
                  }}
                >
                  {server.name}
                </button>
              ))}
            </div>
          </div>
          {/* <p
            className="ui-toolbar-note"
            style={{ fontSize: 12, color: "var(--text-muted)" }}
          >
            {selectedServerId
              ? "Sync network just for the selected server. This may take a few seconds."
              : "Mode default: display all networks from all servers."}
          </p> */}
        </div>

        <div
          className="card ui-responsive-toolbar"
          style={{
            padding: "12px 16px",
          }}
        >
          <SearchField
            placeholder="Search networks..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            containerStyle={{ flex: "1 1 360px", minWidth: 240 }}
          />
          <div className="ui-toolbar-actions">
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void handleSync()}
              disabled={syncing}
            >
              {syncing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Sync from Docker
            </button>
            <button
              className="btn btn-primary"
              style={{ fontSize: 12 }}
              onClick={() => setShowAdd(true)}
            >
              <Plus size={12} /> Create Network
            </button>
          </div>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: 42, textAlign: "center" }}>
              <Loader2
                size={24}
                className="animate-spin"
                style={{ color: "var(--accent)", margin: "0 auto 10px" }}
              />
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                Loading networks...
              </p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div style={{ padding: 42, textAlign: "center" }}>
              <Network
                size={34}
                style={{
                  color: "var(--text-muted)",
                  margin: "0 auto 10px",
                  opacity: 0.4,
                }}
              />
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                {search
                  ? "No network records match your search."
                  : "No network records found."}
              </p>
            </div>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Network</th>
                      <th>Driver</th>
                      <th>Scope</th>
                      <th>Server</th>
                      <th>Subnet</th>
                      <th>Gateway</th>
                      <th>Containers</th>
                      <th>Created</th>
                      <th style={{ textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagination.paginatedItems.map((item) => {
                      const driverColor =
                        driverColors[item.driver] || "#3b82f6";
                      return (
                        <tr key={item.id}>
                          <td>
                            <span
                              style={{
                                color: "var(--text-primary)",
                                fontWeight: 600,
                              }}
                            >
                              {item.name}
                            </span>
                          </td>
                          <td>
                            <span
                              style={{
                                background: `${driverColor}12`,
                                color: driverColor,
                                border: `1px solid ${driverColor}25`,
                                padding: "2px 8px",
                                borderRadius: 5,
                                fontSize: 11,
                                fontWeight: 600,
                              }}
                            >
                              {item.driver}
                            </span>
                          </td>
                          <td
                            style={{ fontSize: 11, color: "var(--text-muted)" }}
                          >
                            {item.scope}
                          </td>
                          <td>
                            <span
                              style={{
                                fontSize: 11,
                                background: "rgba(59,130,246,0.08)",
                                color: "#3b82f6",
                                padding: "2px 7px",
                                borderRadius: 4,
                                border: "1px solid rgba(59,130,246,0.2)",
                              }}
                            >
                              {item.server?.name ?? "Unknown server"}
                            </span>
                          </td>
                          <td
                            style={{
                              fontSize: 11,
                              fontFamily: "JetBrains Mono, monospace",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {item.subnet ?? "-"}
                          </td>
                          <td
                            style={{
                              fontSize: 11,
                              fontFamily: "JetBrains Mono, monospace",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {item.gateway ?? "-"}
                          </td>
                          <td>
                            <span
                              style={{
                                background: "rgba(59,130,246,0.1)",
                                color: "#3b82f6",
                                padding: "2px 8px",
                                borderRadius: 5,
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              {item.containers}
                            </span>
                          </td>
                          <td
                            style={{ fontSize: 11, color: "var(--text-muted)" }}
                          >
                            {formatRelativeDate(item.createdAt)}
                          </td>
                          <td>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "flex-end",
                                gap: 5,
                              }}
                            >
                              <button
                                title="Details"
                                onClick={() => setDetailFor(item)}
                                className="btn btn-ghost"
                                style={{ padding: "5px 8px", fontSize: 11 }}
                              >
                                <Eye size={11} />
                              </button>
                              <button
                                className="btn btn-danger"
                                style={{ padding: "5px 8px" }}
                                onClick={() => void handleDelete(item.id)}
                                disabled={deletingId === item.id}
                              >
                                {deletingId === item.id ? (
                                  <Loader2 size={11} className="animate-spin" />
                                ) : (
                                  <Trash2 size={11} />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <TablePagination
                currentPage={pagination.currentPage}
                totalPages={pagination.totalPages}
                totalItems={pagination.totalItems}
                startItem={pagination.startItem}
                endItem={pagination.endItem}
                itemLabel="networks"
                onPageChange={pagination.setCurrentPage}
              />
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}


