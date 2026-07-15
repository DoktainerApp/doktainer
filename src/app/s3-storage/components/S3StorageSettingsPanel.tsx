"use client";

import { useState } from "react";
import {
  Cloud,
  Database,
  HardDrive,
  Key,
  Loader2,
  Pencil,
  Plus,
  Power,
  TestTube2,
  CloudCheck,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import TablePagination from "@/components/TablePagination";
import { FieldLabel } from "@/app/settings/components/SettingsPrimitives";
import type {
  S3StorageDestinationInput,
  S3StorageDestinationRecord,
  S3StorageProvider,
  Server as ServerRecord,
} from "@/lib/api";

interface S3StorageSettingsPanelProps {
  destinations: S3StorageDestinationRecord[];
  servers: ServerRecord[];
  actionLoading: string | null;
  savingDestinationId: string | null;
  onUpsertDestination: (destination: DestinationDraft) => Promise<boolean>;
  onVerifyDestination: (destination: DestinationDraft) => Promise<void>;
  onToggleDestination: (
    destination: S3StorageDestinationRecord,
  ) => Promise<void>;
  onDeleteDestination: (destination: S3StorageDestinationRecord) => void;
}

type DestinationDraft = S3StorageDestinationInput & {
  id?: string;
  hasSecretAccessKey: boolean;
};

const PROVIDER_OPTIONS: Array<{
  value: S3StorageProvider;
  label: string;
  description: string;
  icon: LucideIcon;
  color: string;
}> = [
  {
    value: "awsS3",
    label: "AWS S3",
    description: "Default Amazon S3 region endpoint for primary backups.",
    icon: Database,
    color: "#f59e0b",
  },
  {
    value: "cloudflareR2",
    label: "Cloudflare R2",
    description: "S3-compatible bucket for edge-friendly object storage.",
    icon: Cloud,
    color: "#f97316",
  },
  {
    value: "digitalOceanSpaces",
    label: "DO Spaces",
    description: "DigitalOcean object storage with custom endpoint support.",
    icon: HardDrive,
    color: "#2563eb",
  },
  {
    value: "dreamObjects",
    label: "DreamObjects",
    description: "DreamHost S3-compatible destination for archives.",
    icon: Cloud,
    color: "#10b981",
  },
  {
    value: "googleCloudStorage",
    label: "Google Cloud Storage",
    description: "Use GCS interoperability key for S3-compatible access.",
    icon: Database,
    color: "#0ea5e9",
  },
  {
    value: "ibmCos",
    label: "IBM COS",
    description: "IBM Cloud Object Storage with region-aware endpoint.",
    icon: HardDrive,
    color: "#8b5cf6",
  },
  {
    value: "alibabaOss",
    label: "Alibaba OSS",
    description: "OSS bucket for multi-region storage replication.",
    icon: Cloud,
    color: "#ef4444",
  },
  {
    value: "huaweiObs",
    label: "Huawei OBS",
    description: "Object storage for Huawei Cloud workloads.",
    icon: Database,
    color: "#06b6d4",
  },
  {
    value: "ceph",
    label: "Ceph",
    description: "Private S3-compatible cluster with custom endpoint.",
    icon: HardDrive,
    color: "#64748b",
  },
  {
    value: "custom",
    label: "Custom S3",
    description: "Bring your own S3 endpoint for internal or niche providers.",
    icon: Cloud,
    color: "#14b8a6",
  },
];

const PAGE_SIZE = 6;

function createDraft(): DestinationDraft {
  return {
    name: "",
    provider: "awsS3",
    enabled: true,
    accessKeyId: "",
    secretAccessKey: "",
    hasSecretAccessKey: false,
    region: "ap-southeast-1",
    bucket: "",
    endpoint: "",
    additionalFlags: [],
    retentionDays: null,
    maxBackupCount: null,
    objectPrefix: "",
    serverId: null,
  };
}

function getProviderMeta(provider: S3StorageProvider) {
  return (
    PROVIDER_OPTIONS.find((option) => option.value === provider) ||
    PROVIDER_OPTIONS[0]
  );
}

function getDestinationSummary(destination: DestinationDraft) {
  const parts = [destination.bucket, destination.region]
    .map((value) => value.trim())
    .filter(Boolean);

  if (destination.endpoint?.trim()) {
    parts.push(destination.endpoint.trim());
  }

  return parts.length > 0
    ? parts.join(" â€¢ ")
    : "Bucket dan region belum lengkap";
}

function StatusButton({
  active,
  loading,
  onClick,
}: {
  active: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={onClick}
      disabled={loading}
      style={{
        minWidth: 108,
        justifyContent: "center",
        gap: 8,
        padding: "7px 14px",
        fontSize: 12,
        color: active ? "#10b981" : "var(--text-secondary)",
        borderColor: active ? "rgba(16,185,129,0.24)" : "var(--border)",
        background: active ? "rgba(16,185,129,0.08)" : "transparent",
      }}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Power size={14} />
      )}
      {active ? "Active" : "Inactive"}
    </button>
  );
}

export default function S3StorageSettingsPanel({
  destinations,
  servers,
  actionLoading,
  savingDestinationId,
  onUpsertDestination,
  onVerifyDestination,
  onToggleDestination,
  onDeleteDestination,
}: S3StorageSettingsPanelProps) {
  const [draft, setDraft] = useState<DestinationDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const totalItems = destinations.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const pagedDestinations = destinations.slice(
    startIndex,
    startIndex + PAGE_SIZE,
  );
  const startItem = totalItems === 0 ? 0 : startIndex + 1;
  const endItem = totalItems === 0 ? 0 : startIndex + pagedDestinations.length;

  const openCreateModal = () => {
    setEditingId(null);
    setDraft(createDraft());
  };

  const openEditModal = (destination: S3StorageDestinationRecord) => {
    setEditingId(destination.id);
    setDraft({
      id: destination.id,
      name: destination.name,
      provider: destination.provider,
      enabled: destination.enabled,
      accessKeyId: destination.accessKeyId,
      secretAccessKey: "",
      hasSecretAccessKey: destination.hasSecretAccessKey,
      region: destination.region,
      bucket: destination.bucket,
      endpoint: destination.endpoint,
      additionalFlags: [...destination.additionalFlags],
      retentionDays: destination.retentionDays,
      maxBackupCount: destination.maxBackupCount,
      objectPrefix: destination.objectPrefix,
      serverId: destination.serverId,
    });
  };

  const closeModal = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveDraft = async () => {
    if (!draft) return;

    const success = await onUpsertDestination(draft);
    if (success) {
      closeModal();
    }
  };

  return (
    <>
      <div className="card" style={{ overflow: "hidden" }}>
        <div
          style={{
            padding: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            borderBottom:
              destinations.length > 0 ? "1px solid var(--border)" : "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: 14,
                background: "rgba(14,165,233,0.12)",
                border: "1px solid rgba(14,165,233,0.24)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Database size={18} style={{ color: "#0ea5e9" }} />
            </div>
            <div>
              <h2
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                Storage Destinations
              </h2>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  marginTop: 4,
                }}
              >
                Add and manage multiple S3-compatible storage destinations and
                target specific servers as needed.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={openCreateModal}
            style={{ padding: "8px 14px", fontSize: 12 }}
          >
            <Plus size={14} /> Add Destination
          </button>
        </div>

        {destinations.length === 0 ? (
          <div style={{ padding: 24 }}>
            <div
              style={{
                border: "1px dashed var(--border)",
                borderRadius: 16,
                padding: 24,
                textAlign: "center",
                background: "var(--bg-input)",
              }}
            >
              <HardDrive
                size={18}
                style={{ color: "var(--text-muted)", marginBottom: 10 }}
              />
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                }}
              >
                No storage destinations yet
              </p>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  marginTop: 6,
                }}
              >
                Create your first destination for global backup or specific
                target servers.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Destination</th>
                    <th>Provider</th>
                    <th>Target Server</th>
                    <th>Connection</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedDestinations.map((destination) => {
                    const meta = getProviderMeta(destination.provider);
                    const Icon = meta.icon;
                    const isDeleting =
                      savingDestinationId === `delete-${destination.id}`;
                    const isVerifying =
                      actionLoading === `verify-${destination.id}`;

                    return (
                      <tr key={destination.id}>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                            }}
                          >
                            <div
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: 12,
                                background: `${meta.color}18`,
                                border: `1px solid ${meta.color}33`,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flexShrink: 0,
                              }}
                            >
                              <Icon size={15} style={{ color: meta.color }} />
                            </div>
                            <div>
                              <p
                                style={{
                                  fontSize: 13,
                                  fontWeight: 600,
                                  color: "var(--text-primary)",
                                }}
                              >
                                {destination.name}
                              </p>
                              <p
                                style={{
                                  fontSize: 11,
                                  color: "var(--text-muted)",
                                  marginTop: 4,
                                }}
                              >
                                {destination.accessKeyId ||
                                  "Access key not provided"}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td>
                          <p
                            style={{
                              fontSize: 12,
                              color: "var(--text-secondary)",
                              fontWeight: 500,
                            }}
                          >
                            {meta.label}
                          </p>
                          <p
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              marginTop: 4,
                            }}
                          >
                            {meta.description}
                          </p>
                        </td>
                        <td>
                          <p
                            style={{
                              fontSize: 12,
                              color: "var(--text-secondary)",
                              fontWeight: 500,
                            }}
                          >
                            {destination.targetServer?.name ||
                              "All accessible servers"}
                          </p>
                          <p
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              marginTop: 4,
                            }}
                          >
                            {destination.targetServer?.ip ||
                              "Not restricted to specific servers"}
                          </p>
                        </td>
                        <td>
                          <p
                            style={{
                              fontSize: 12,
                              color: "var(--text-secondary)",
                              fontWeight: 500,
                            }}
                          >
                            {getDestinationSummary(destination)}
                          </p>
                          <p
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              marginTop: 4,
                            }}
                          >
                            {destination.additionalFlags.length > 0
                              ? `${destination.additionalFlags.length} additional flags`
                              : "No additional flags"}
                          </p>
                        </td>
                        <td>
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
                              className="btn btn-ghost"
                              onClick={() =>
                                void onToggleDestination(destination)
                              }
                              style={{ padding: "7px 12px", fontSize: 12 }}
                            >
                              {destination.enabled ? (
                                <Power color="#10b981" size={13} />
                              ) : (
                                <Power color="#ef4444" size={13} />
                              )}
                              {/* {destination.enabled ? "Disable" : "Enable"} */}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => openEditModal(destination)}
                              style={{ padding: "7px 12px", fontSize: 12 }}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() =>
                                void onVerifyDestination({
                                  id: destination.id,
                                  name: destination.name,
                                  provider: destination.provider,
                                  enabled: destination.enabled,
                                  accessKeyId: destination.accessKeyId,
                                  secretAccessKey: "",
                                  hasSecretAccessKey:
                                    destination.hasSecretAccessKey,
                                  region: destination.region,
                                  bucket: destination.bucket,
                                  endpoint: destination.endpoint,
                                  additionalFlags: [
                                    ...destination.additionalFlags,
                                  ],
                                  serverId: destination.serverId,
                                })
                              }
                              disabled={isVerifying}
                              style={{ padding: "7px 12px", fontSize: 12 }}
                            >
                              {isVerifying ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <CloudCheck size={13} />
                              )}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => onDeleteDestination(destination)}
                              disabled={isDeleting}
                              style={{
                                padding: "7px 12px",
                                fontSize: 12,
                                color: "#ef4444",
                              }}
                            >
                              {isDeleting ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <Trash2 size={13} />
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
              currentPage={safePage}
              totalPages={totalPages}
              totalItems={totalItems}
              startItem={startItem}
              endItem={endItem}
              itemLabel="destinations"
              onPageChange={(page) =>
                setCurrentPage(Math.min(Math.max(page, 1), totalPages))
              }
            />
          </>
        )}
      </div>

      {draft ? (
        <div className="modal-overlay">
          <div
            className="modal-shell"
            style={{ width: "min(780px, calc(100% - 48px))", maxWidth: 1100 }}
          >
            <button
              type="button"
              onClick={closeModal}
              className="modal-close"
              aria-label="Close modal"
              title="Close"
            >
              <X size={22} />
            </button>
            <div className="modal modal-wide animate-slide-in">
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  marginBottom: 22,
                  paddingRight: 36,
                }}
              >
                <div>
                  <h3
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    {editingId ? "Update Destination" : "Add Destination"}
                  </h3>
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 6,
                    }}
                  >
                    Set the destination name, bucket, and target server that
                    will use it.
                  </p>
                </div>
              </div>

              <div
                style={{ display: "flex", flexDirection: "column", gap: 20 }}
              >
                <section>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      marginBottom: 12,
                    }}
                  >
                    Provider Type
                  </p>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {PROVIDER_OPTIONS.map((option) => {
                      const Icon = option.icon;
                      const selected = draft.provider === option.value;

                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() =>
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    provider: option.value,
                                    endpoint:
                                      option.value === "awsS3"
                                        ? ""
                                        : current.endpoint,
                                  }
                                : current,
                            )
                          }
                          style={{
                            textAlign: "left",
                            padding: 14,
                            borderRadius: 14,
                            border: selected
                              ? `1px solid ${option.color}`
                              : "1px solid var(--border)",
                            background: selected
                              ? `${option.color}12`
                              : "var(--bg-card)",
                            display: "flex",
                            gap: 12,
                            alignItems: "flex-start",
                            cursor: "pointer",
                          }}
                        >
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 10,
                              background: `${option.color}18`,
                              border: `1px solid ${option.color}33`,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            <Icon size={15} style={{ color: option.color }} />
                          </div>
                          <div>
                            <p
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                              }}
                            >
                              {option.label}
                            </p>
                            <p
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                                marginTop: 4,
                              }}
                            >
                              {option.description}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      marginBottom: 12,
                    }}
                  >
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: "var(--text-primary)",
                      }}
                    >
                      Lifecycle & Retention
                    </p>
                    <p
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                      }}
                    >
                      Automatically remove old objects from this destination.
                      Retention is disabled when both limits are empty.
                    </p>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
                      gap: 14,
                    }}
                  >
                    <div>
                      <FieldLabel>Retention days</FieldLabel>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={3650}
                        value={draft.retentionDays ?? ""}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  retentionDays: event.target.value
                                    ? Number(event.target.value)
                                    : null,
                                }
                              : current,
                          )
                        }
                        placeholder="30"
                      />
                    </div>
                    <div>
                      <FieldLabel>Maximum backup count</FieldLabel>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={10000}
                        value={draft.maxBackupCount ?? ""}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  maxBackupCount: event.target.value
                                    ? Number(event.target.value)
                                    : null,
                                }
                              : current,
                          )
                        }
                        placeholder="10"
                      />
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <FieldLabel>Object prefix / folder</FieldLabel>
                      <input
                        className="input"
                        value={draft.objectPrefix ?? ""}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? { ...current, objectPrefix: event.target.value }
                              : current,
                          )
                        }
                        placeholder="doktainer/backups/production"
                      />
                      <p
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          marginTop: 5,
                        }}
                      >
                        Required when retention or maximum count is enabled.
                      </p>
                    </div>
                  </div>
                </section>

                <section>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <p
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--text-primary)",
                        }}
                      >
                        Basic Information
                      </p>
                      <p
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          marginTop: 4,
                        }}
                      >
                        Set the destination name, bucket, and target server that
                        will use it.
                      </p>
                    </div>
                    <StatusButton
                      active={draft.enabled}
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? { ...current, enabled: !current.enabled }
                            : current,
                        )
                      }
                    />
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 14,
                    }}
                  >
                    <div>
                      <FieldLabel>Destination name</FieldLabel>
                      <input
                        className="input"
                        value={draft.name}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? { ...current, name: event.target.value }
                              : current,
                          )
                        }
                        placeholder="Example: Backup Singapore, R2 Europe, Archive Internal"
                      />
                    </div>

                    <div>
                      <FieldLabel>Target server</FieldLabel>
                      <select
                        className="input"
                        value={draft.serverId ?? ""}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  serverId: event.target.value || null,
                                }
                              : current,
                          )
                        }
                      >
                        <option value="">All accessible servers</option>
                        {servers.map((server) => (
                          <option key={server.id} value={server.id}>
                            {server.name} ({server.ip})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </section>

                <section>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      marginBottom: 12,
                    }}
                  >
                    Connection Settings
                  </p>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 14,
                    }}
                  >
                    <div>
                      <FieldLabel>Access Key ID</FieldLabel>
                      <div style={{ position: "relative" }}>
                        <input
                          className="input"
                          autoComplete="off"
                          value={draft.accessKeyId}
                          onChange={(event) =>
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    accessKeyId: event.target.value,
                                  }
                                : current,
                            )
                          }
                          placeholder="AKIA... or provider interoperability key"
                        />
                        <Key
                          size={14}
                          style={{
                            position: "absolute",
                            right: 12,
                            top: 12,
                            color: "var(--text-muted)",
                          }}
                        />
                      </div>
                    </div>

                    <div>
                      <FieldLabel>
                        Secret Access Key
                        {draft.hasSecretAccessKey
                          ? " (leave blank to keep existing key)"
                          : ""}
                      </FieldLabel>
                      <input
                        className="input"
                        type="password"
                        autoComplete="new-password"
                        value={draft.secretAccessKey ?? ""}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  secretAccessKey: event.target.value,
                                  hasSecretAccessKey:
                                    current.hasSecretAccessKey ||
                                    Boolean(event.target.value.trim()),
                                }
                              : current,
                          )
                        }
                      />
                    </div>

                    <div>
                      <FieldLabel>Bucket</FieldLabel>
                      <input
                        className="input"
                        value={draft.bucket}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? { ...current, bucket: event.target.value }
                              : current,
                          )
                        }
                        placeholder="doktainer-backups"
                      />
                    </div>

                    <div>
                      <FieldLabel>Region</FieldLabel>
                      <input
                        className="input"
                        value={draft.region}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? { ...current, region: event.target.value }
                              : current,
                          )
                        }
                        placeholder="ap-southeast-1"
                      />
                    </div>

                    <div>
                      <FieldLabel>
                        Endpoint
                        {draft.provider === "awsS3"
                          ? " (optional for AWS S3)"
                          : " (required for S3-compatible providers)"}
                      </FieldLabel>
                      <input
                        className="input"
                        value={draft.endpoint ?? ""}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? { ...current, endpoint: event.target.value }
                              : current,
                          )
                        }
                        placeholder="https://<account>.r2.cloudflarestorage.com"
                      />
                    </div>
                  </div>
                </section>

                <section>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <p
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: "var(--text-primary)",
                        }}
                      >
                        Additional Flags
                      </p>
                      <p
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          marginTop: 4,
                        }}
                      >
                        Save additional flags for runtime backup needs or
                        provider compatibility.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                additionalFlags: [
                                  ...current.additionalFlags,
                                  "",
                                ],
                              }
                            : current,
                        )
                      }
                      style={{ padding: "7px 12px", fontSize: 12 }}
                    >
                      <Plus size={13} /> Add Flag
                    </button>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    {draft.additionalFlags.length === 0 ? (
                      <div
                        style={{
                          padding: 14,
                          borderRadius: 12,
                          border: "1px dashed var(--border)",
                          background: "var(--bg-input)",
                          fontSize: 12,
                          color: "var(--text-muted)",
                        }}
                      >
                        No additional flags.
                      </div>
                    ) : null}

                    {draft.additionalFlags.map((flag, index) => (
                      <div
                        key={`flag-${index}`}
                        style={{
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        <input
                          className="input"
                          value={flag}
                          onChange={(event) =>
                            setDraft((current) => {
                              if (!current) return current;

                              const nextFlags = [...current.additionalFlags];
                              nextFlags[index] = event.target.value;
                              return { ...current, additionalFlags: nextFlags };
                            })
                          }
                          placeholder="Contoh: forcePathStyle=true"
                        />
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() =>
                            setDraft((current) => {
                              if (!current) return current;
                              return {
                                ...current,
                                additionalFlags: current.additionalFlags.filter(
                                  (_, flagIndex) => flagIndex !== index,
                                ),
                              };
                            })
                          }
                          style={{
                            padding: "7px 12px",
                            fontSize: 12,
                            color: "#ef4444",
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                    paddingTop: 6,
                  }}
                >
                  <div>
                    <p
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                      }}
                    >
                      {getProviderMeta(draft.provider).label}
                    </p>
                    <p
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        marginTop: 4,
                      }}
                    >
                      {getDestinationSummary(draft)}
                    </p>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void onVerifyDestination(draft)}
                      disabled={
                        actionLoading === `verify-${draft.id ?? "draft"}`
                      }
                      style={{ padding: "8px 14px", fontSize: 12 }}
                    >
                      {actionLoading === `verify-${draft.id ?? "draft"}` ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <TestTube2 size={13} />
                      )}
                      Verify Connection
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void saveDraft()}
                      disabled={
                        savingDestinationId === (draft.id ?? "new-destination")
                      }
                      style={{ padding: "8px 14px", fontSize: 12 }}
                    >
                      {savingDestinationId ===
                      (draft.id ?? "new-destination") ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : null}
                      {editingId ? "Update Destination" : "Create Destination"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

