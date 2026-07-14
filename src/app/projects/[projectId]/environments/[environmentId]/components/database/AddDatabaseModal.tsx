"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  RocketIcon,
  X,
} from "lucide-react";
import {
  apps as appsApi,
  containers as containersApi,
  networks as networksApi,
  projectsApi,
  type Container,
  type NetworkRecord,
  type ProjectEnvironmentRecord,
} from "@/lib/api";
import { DB_APPS, DB_META, DbType } from "./database-constants";
import type { AddDatabaseModalProps } from "./database-types";

type DeployChoice = "MANUAL" | null;
type EnvironmentOption = ProjectEnvironmentRecord & { projectName: string };

const choiceCardStyle = {
  textAlign: "left" as const,
  padding: 16,
  borderRadius: 12,
  border: "1px solid rgba(59,130,246,0.24)",
  background: "rgba(59,130,246,0.08)",
  color: "var(--text-primary)",
  cursor: "pointer",
  minHeight: 142,
};

const defaultDbNames: Record<DbType, string> = {
  postgres: "mydb",
  mysql: "mydb",
  mongodb: "admin",
  redis: "",
};

const defaultDbUsers: Record<DbType, string> = {
  postgres: "admin",
  mysql: "username",
  mongodb: "admin",
  redis: "",
};

function defaultAppName(dbType: DbType) {
  return DB_META[dbType].label;
}

function defaultContainerName(dbType: DbType) {
  return `${dbType}-app`;
}

function safePathSegment(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "database"
  );
}

function buildDatabaseVolumes(dbType: DbType, nameSeed: string) {
  const hostPath = `/srv/doktainer/databases/${safePathSegment(nameSeed)}`;

  if (dbType === "postgres") {
    return `${hostPath}:/var/lib/postgresql/data`;
  }

  if (dbType === "mysql") {
    return `${hostPath}:/var/lib/mysql`;
  }

  if (dbType === "mongodb") {
    return `${hostPath}:/data/db`;
  }

  return `${hostPath}:/data`;
}

function buildPortMapping(hostPort: string, containerPort: string) {
  const value = hostPort.trim();
  if (!value) return "";
  if (value.includes(":")) return value;
  return `${value}:${containerPort}`;
}

function getRequestedHostPort(portValue: string) {
  const value = portValue.trim();
  if (!value) return "";

  const mapping = value.split("/")[0] ?? value;
  const parts = mapping.split(":").filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0];
  return parts[parts.length - 2] ?? "";
}

function extractHostPorts(ports: string[]) {
  return ports
    .map((port) => {
      const dockerPsMatch = port.match(/(?:^|:)(\d+)->/);
      if (dockerPsMatch?.[1]) return dockerPsMatch[1];

      const mapping = port.trim().split("/")[0] ?? port.trim();
      const parts = mapping.split(":").filter(Boolean);
      if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 2] ?? "")) {
        return parts[parts.length - 2];
      }

      return "";
    })
    .filter(Boolean);
}

function findContainerNameConflict(containers: Container[], name: string) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;

  return (
    containers.find((container) => {
      const containerName = container.name.trim().toLowerCase();
      return (
        containerName === normalized ||
        containerName.replace(/^\//, "") === normalized
      );
    }) ?? null
  );
}

function findPortConflict(containers: Container[], hostPort: string) {
  const normalized = hostPort.trim();
  if (!normalized) return null;

  return (
    containers.find((container) =>
      extractHostPorts(container.ports ?? []).includes(normalized),
    ) ?? null
  );
}

function appendEnv(lines: string[], key: string, value: string) {
  const nextValue = value.trim();
  if (nextValue) {
    lines.push(`${key}=${nextValue}`);
  }
}

function buildDatabaseEnv({
  dbType,
  databaseName,
  databaseUser,
  databasePassword,
  rootPassword,
}: {
  dbType: DbType;
  databaseName: string;
  databaseUser: string;
  databasePassword: string;
  rootPassword: string;
}) {
  const lines: string[] = [];

  if (dbType === "postgres") {
    appendEnv(lines, "POSTGRES_DB", databaseName);
    appendEnv(lines, "POSTGRES_USER", databaseUser);
    appendEnv(lines, "POSTGRES_PASSWORD", databasePassword);
  }

  if (dbType === "mysql") {
    appendEnv(lines, "MYSQL_DATABASE", databaseName);
    appendEnv(lines, "MYSQL_USER", databaseUser);
    appendEnv(lines, "MYSQL_PASSWORD", databasePassword);
    appendEnv(lines, "MYSQL_ROOT_PASSWORD", rootPassword || databasePassword);
  }

  if (dbType === "mongodb") {
    appendEnv(lines, "MONGO_INITDB_DATABASE", databaseName);
    appendEnv(lines, "MONGO_INITDB_ROOT_USERNAME", databaseUser);
    appendEnv(
      lines,
      "MONGO_INITDB_ROOT_PASSWORD",
      rootPassword || databasePassword,
    );
  }

  if (dbType === "redis") {
    appendEnv(lines, "REDIS_PASSWORD", databasePassword);
  }

  return lines.join("\n");
}

export default function AddDatabaseModal({
  serverList,
  initialServerId,
  initialEnvironmentId,
  lockServerSelection = false,
  onClose,
  onAdded,
}: AddDatabaseModalProps) {
  const router = useRouter();
  const [choice, setChoice] = useState<DeployChoice>(null);
  const [dbType, setDbType] = useState<DbType>("postgres");
  const [serverId, setServerId] = useState(
    initialServerId ?? serverList[0]?.id ?? "",
  );
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId ?? "");
  const [environmentOptions, setEnvironmentOptions] = useState<
    EnvironmentOption[]
  >([]);
  const [environmentsLoading, setEnvironmentsLoading] = useState(false);
  const [environmentsError, setEnvironmentsError] = useState("");
  const [appName, setAppName] = useState(defaultAppName("postgres"));
  const [containerName, setContainerName] = useState(
    defaultContainerName("postgres"),
  );
  const [network, setNetwork] = useState("bridge");
  const [networkOptions, setNetworkOptions] = useState<NetworkRecord[]>([]);
  const [networksLoading, setNetworksLoading] = useState(false);
  const [networksError, setNetworksError] = useState("");
  const [port, setPort] = useState(DB_META.postgres.port);
  const [databaseName, setDatabaseName] = useState(defaultDbNames.postgres);
  const [databaseUser, setDatabaseUser] = useState(defaultDbUsers.postgres);
  const [databasePassword, setDatabasePassword] = useState("");
  const [rootPassword, setRootPassword] = useState("");
  const [showDatabasePassword, setShowDatabasePassword] = useState(false);
  const [showRootPassword, setShowRootPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleTypeChange = (t: DbType) => {
    setDbType(t);
    setAppName(defaultAppName(t));
    setContainerName(defaultContainerName(t));
    setPort(DB_META[t].port);
    setDatabaseName(defaultDbNames[t]);
    setDatabaseUser(defaultDbUsers[t]);
    setDatabasePassword("");
    setRootPassword("");
    setShowDatabasePassword(false);
    setShowRootPassword(false);
    setError("");
  };

  useEffect(() => {
    if (!serverId || choice === null) {
      return;
    }

    let mounted = true;

    const loadNetworks = async () => {
      setNetworksLoading(true);
      setNetworksError("");
      try {
        const response = await networksApi.list(serverId);
        if (!mounted) return;

        const nextNetworks = response.data ?? [];
        setNetworkOptions(nextNetworks);
        setNetwork((current) => {
          if (current === "bridge") return current;
          return nextNetworks.some((item) => item.name === current)
            ? current
            : "bridge";
        });
      } catch (err) {
        if (!mounted) return;
        setNetworkOptions([]);
        setNetworksError(
          err instanceof Error ? err.message : "Failed to load networks",
        );
      } finally {
        if (mounted) setNetworksLoading(false);
      }
    };

    void loadNetworks();

    return () => {
      mounted = false;
    };
  }, [choice, serverId]);

  useEffect(() => {
    if (choice === null) {
      return;
    }

    let mounted = true;

    const loadEnvironments = async () => {
      setEnvironmentsLoading(true);
      setEnvironmentsError("");

      try {
        const response = await projectsApi.list();
        if (!mounted) return;

        const options = (response.data ?? []).flatMap((project) =>
          project.environments.map((environment) => ({
            ...environment,
            projectName: project.name,
          })),
        );

        setEnvironmentOptions(options);
      } catch (err) {
        if (!mounted) return;
        setEnvironmentOptions([]);
        setEnvironmentsError(
          err instanceof Error
            ? err.message
            : "Failed to load project environments",
        );
      } finally {
        if (mounted) setEnvironmentsLoading(false);
      }
    };

    void loadEnvironments();

    return () => {
      mounted = false;
    };
  }, [choice]);

  const openAppInstaller = () => {
    router.push("/apps");
    onClose();
  };

  const availableEnvironments = environmentOptions.filter(
    (environment) => environment.serverId === serverId,
  );
  const selectedEnvironment = environmentOptions.find(
    (environment) => environment.id === environmentId,
  );

  const validateTargetAvailability = async ({
    requestedContainerName,
    requestedHostPort,
  }: {
    requestedContainerName: string;
    requestedHostPort: string;
  }) => {
    const dbContainersResponse = await containersApi.list({ serverId });
    const dbContainers = dbContainersResponse.data ?? [];

    const dbNameConflict = findContainerNameConflict(
      dbContainers,
      requestedContainerName,
    );
    if (dbNameConflict) {
      throw new Error(
        `Container name "${requestedContainerName}" is already used in database records on the selected server.`,
      );
    }

    const dbPortConflict = findPortConflict(dbContainers, requestedHostPort);
    if (dbPortConflict) {
      throw new Error(
        `Exposed port ${requestedHostPort} is already used by "${dbPortConflict.name}" in database records on the selected server.`,
      );
    }

    const serverContainersResponse = await containersApi.sync({ serverId });
    const serverContainers = serverContainersResponse.data ?? [];

    const serverNameConflict = findContainerNameConflict(
      serverContainers,
      requestedContainerName,
    );
    if (serverNameConflict) {
      throw new Error(
        `Container name "${requestedContainerName}" is already used on the target server.`,
      );
    }

    const serverPortConflict = findPortConflict(
      serverContainers,
      requestedHostPort,
    );
    if (serverPortConflict) {
      throw new Error(
        `Exposed port ${requestedHostPort} is already used by "${serverPortConflict.name}" on the target server.`,
      );
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!serverId) {
      setError("Please select a server");
      return;
    }

    if (!appName.trim()) {
      setError("Please enter an app name");
      return;
    }

    if (dbType === "redis" && /\s/.test(databasePassword.trim())) {
      setError("Redis password cannot contain whitespace");
      return;
    }

    const meta = DB_META[dbType];
    const requestedContainerName = containerName.trim();
    const volumeNameSeed = requestedContainerName || appName.trim() || dbType;
    const requestedHostPort = getRequestedHostPort(port);
    const env = buildDatabaseEnv({
      dbType,
      databaseName,
      databaseUser,
      databasePassword,
      rootPassword,
    });
    const ports = buildPortMapping(port, meta.port);
    const volumes = buildDatabaseVolumes(dbType, volumeNameSeed);
    const command =
      dbType === "redis" && databasePassword.trim()
        ? `redis-server --appendonly yes --requirepass ${databasePassword.trim()}`
        : undefined;

    setLoading(true);

    try {
      await validateTargetAvailability({
        requestedContainerName,
        requestedHostPort,
      });

      await appsApi.install({
        appId: dbType,
        serverId,
        environmentId: environmentId || undefined,
        appName: appName.trim(),
        containerName: requestedContainerName || undefined,
        network: network.trim() || undefined,
        ports,
        env: env || undefined,
        volumes,
        command,
      });
      await onAdded();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-shell" style={{ maxWidth: 540 }}>
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label="Close deploy database modal"
        >
          <X size={22} />
        </button>
        <div
          className="modal animate-slide-in"
          style={{ width: "100%", maxWidth: 540, padding: 28 }}
        >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 20,
            paddingRight: 36,
          }}
        >
          <div>
            <h3
              style={{
                display: "flex",
                // justifyContent: "space-between",
                gap: 10,
                color: "var(--text-primary)",
                fontWeight: 700,
                fontSize: 16,
              }}
            >
              {choice !== null ? (
                <>
                  <ArrowLeft
                    size={24}
                    cursor="pointer"
                    onClick={() => {
                      setChoice(null);
                      setError("");
                    }}
                  />
                  Deploy Database
                </>
              ) : (
                "Deploy Database"
              )}
            </h3>
            <p
              style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}
            >
              {choice === null
                ? "Select a source to deploy from"
              : "Deploy a new database container on your server"}
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

        {choice === null ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 12,
            }}
          >
            <button
              type="button"
              onClick={openAppInstaller}
              style={choiceCardStyle}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 14 }}>App Installer</strong>
                <ExternalLink size={14} />
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                Use pre-built database templates from the app catalog with
                optimized defaults.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setChoice("MANUAL")}
              style={choiceCardStyle}
            >
              <div style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 14 }}>Manual</strong>
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                Choose the database engine, server, exposed port, and initial
                credentials directly.
              </p>
            </button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
          >
            {/* <button
              type="button"
              className="btn"
              onClick={() => {
                setChoice(null);
                setError("");
              }}
              style={{
                alignSelf: "flex-start",
                display: "flex",
                alignItems: "center",
                gap: 8,
                backgroundColor: "var(--bg-secondary)",
              }}
            >
              <ArrowLeft size={14} /> Back
            </button> */}

            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 8,
                }}
              >
                Database Type
              </label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                }}
              >
                {DB_APPS.map((id) => {
                  const meta = DB_META[id];
                  return (
                    <button
                      type="button"
                      key={id}
                      onClick={() => handleTypeChange(id)}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        border: `1px solid ${
                          dbType === id ? meta.color : "var(--border)"
                        }`,
                        background:
                          dbType === id ? `${meta.color}15` : "var(--bg-input)",
                        color: dbType === id ? meta.color : "var(--text-muted)",
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                      }}
                    >
                      <Database size={13} />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Server *
              </label>
              <select
                className="input"
                value={serverId}
                onChange={(e) => {
                  setServerId(e.target.value);
                  if (!initialEnvironmentId) {
                    setEnvironmentId("");
                  }
                }}
                disabled={lockServerSelection}
                required
                style={{ width: "100%" }}
              >
                <option value="">-- Select server --</option>
                {serverList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.ip})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Project Environment
              </label>
              <select
                className="input"
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                disabled={
                  !serverId ||
                  environmentsLoading ||
                  Boolean(initialEnvironmentId)
                }
                style={{ width: "100%" }}
              >
                <option value="">
                  {environmentsLoading
                    ? "Loading environments..."
                    : availableEnvironments.length > 0
                      ? "No environment selected"
                      : "No environment mapped to this server"}
                </option>
                {selectedEnvironment &&
                !availableEnvironments.some(
                  (environment) => environment.id === selectedEnvironment.id,
                ) ? (
                  <option value={selectedEnvironment.id}>
                    {selectedEnvironment.projectName} /{" "}
                    {selectedEnvironment.name}
                  </option>
                ) : null}
                {availableEnvironments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.projectName} / {environment.name}
                  </option>
                ))}
              </select>
              <p
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: environmentsError
                    ? "#fca5a5"
                    : "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                {environmentsError ||
                  (initialEnvironmentId
                    ? "Locked to the current environment. New databases from this page will be attached here."
                    : availableEnvironments.length > 0
                      ? "Optional. When selected, this database container will be attached to that project environment."
                      : "Create a project environment first if you want this database attached beyond server scope.")}
              </p>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 12,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    display: "block",
                    marginBottom: 5,
                  }}
                >
                  App Name *
                </label>
                <input
                  className="input"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  placeholder={DB_META[dbType].label}
                  required
                  style={{ width: "100%" }}
                />
              </div>

              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    display: "block",
                    marginBottom: 5,
                  }}
                >
                  Container Name
                </label>
                <input
                  className="input"
                  value={containerName}
                  onChange={(e) => setContainerName(e.target.value)}
                  placeholder={defaultContainerName(dbType)}
                  style={{ width: "100%" }}
                />
              </div>

              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    display: "block",
                    marginBottom: 5,
                  }}
                >
                  Network
                </label>
                <select
                  className="input"
                  value={network}
                  onChange={(e) => setNetwork(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="bridge">bridge</option>
                  {networkOptions
                    .filter((item) => item.name !== "bridge")
                    .map((item) => (
                      <option key={item.id} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                </select>
                {networksLoading && (
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 4,
                    }}
                  >
                    Loading networks...
                  </p>
                )}
                {networksError && (
                  <p
                    style={{
                      fontSize: 11,
                      color: "#f59e0b",
                      marginTop: 4,
                    }}
                  >
                    {networksError}
                  </p>
                )}
              </div>
            </div>

            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Exposed Port
              </label>
              <input
                className="input"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={DB_META[dbType].port}
                style={{ width: "100%" }}
              />
            </div>

            {dbType !== "redis" && (
              <>
                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      display: "block",
                      marginBottom: 5,
                    }}
                  >
                    Database Name
                  </label>
                  <input
                    className="input"
                    value={databaseName}
                    onChange={(e) => setDatabaseName(e.target.value)}
                    placeholder="mydb"
                    style={{ width: "100%" }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      display: "block",
                      marginBottom: 5,
                    }}
                  >
                    Database User
                  </label>
                  <input
                    className="input"
                    value={databaseUser}
                    onChange={(e) => setDatabaseUser(e.target.value)}
                    placeholder="admin"
                    style={{ width: "100%" }}
                  />
                </div>
              </>
            )}

            <div>
              <label
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "block",
                  marginBottom: 5,
                }}
              >
                Database Password
              </label>
              <div style={{ position: "relative" }}>
                <input
                  className="input"
                  type={showDatabasePassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={databasePassword}
                  onChange={(e) => setDatabasePassword(e.target.value)}
                  placeholder="********"
                  style={{ width: "100%", paddingRight: 36 }}
                />
                <button
                  type="button"
                  onClick={() =>
                    setShowDatabasePassword(!showDatabasePassword)
                  }
                  style={{
                    position: "absolute",
                    right: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--text-muted)",
                  }}
                >
                  {showDatabasePassword ? (
                    <EyeOff size={14} />
                  ) : (
                    <Eye size={14} />
                  )}
                </button>
              </div>
            </div>

            {(dbType === "mysql" || dbType === "mongodb") && (
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    display: "block",
                    marginBottom: 5,
                  }}
                >
                  Root Password
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    className="input"
                    type={showRootPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={rootPassword}
                    onChange={(e) => setRootPassword(e.target.value)}
                    placeholder="Use database password if blank"
                    style={{ width: "100%", paddingRight: 36 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowRootPassword(!showRootPassword)}
                    style={{
                      position: "absolute",
                      right: 10,
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                    }}
                  >
                    {showRootPassword ? (
                      <EyeOff size={14} />
                    ) : (
                      <Eye size={14} />
                    )}
                  </button>
                </div>
              </div>
            )}

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
                className="btn-primary"
                disabled={loading}
                style={{
                  flex: 2,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                <RocketIcon size={14} /> Deploy
              </button>
            </div>
          </form>
        )}
        </div>
      </div>
    </div>
  );
}
