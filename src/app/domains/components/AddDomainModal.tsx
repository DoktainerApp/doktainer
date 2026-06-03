"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  containers as containersApi,
  Container,
  DomainConfigMode as ApiDomainConfigMode,
  Domain,
  DomainProxy,
  domains as domainsApi,
  Server,
  servers as serversApi,
} from "@/lib/api";
import { Loader2, Shield, X } from "lucide-react";
import AddDomainDnsFields from "./AddDomainDnsFields";
import AddDomainModeSelector from "./AddDomainModeSelector";
import AddDomainSslSection from "./AddDomainSslSection";
import AddDomainTargetingSection from "./AddDomainTargetingSection";
import {
  AddDomainFormState,
  DomainConfigMode,
  PortOption,
} from "./domain-types";
import {
  detectAvailableProxies,
  isIpv4WithPort,
  parseInspectPortOptions,
} from "./domain-utils";

interface AddDomainModalProps {
  serverList: Server[];
  existingDomains: Domain[];
  domainToEdit?: Domain | null;
  onClose: () => void;
  onSaved: (
    domainName: string,
    operation: "created" | "updated",
  ) => void | Promise<void>;
}

const PROXY_OPTIONS: DomainProxy[] = ["NONE", "TRAEFIK", "NGINX", "CADDY"];

export default function AddDomainModal({
  serverList,
  existingDomains,
  domainToEdit,
  onClose,
  onSaved,
}: AddDomainModalProps) {
  const buildInitialForm = (domain?: Domain | null): AddDomainFormState => ({
    name: domain?.name ?? "",
    type: domain?.type ?? "A",
    value: domain?.value ?? "",
    serverId: domain?.serverId ?? "",
    targetContainerId: domain?.targetContainerId ?? "",
    targetPort: domain?.targetPort ?? "",
    proxy: domain?.proxy ?? "NONE",
    proxyConfigMode: domain?.configMode ?? "ISOLATED",
    isPrimary: domain?.isPrimary ?? false,
    sslEnabled: domain?.sslEnabled ?? false,
    autoRenew: domain?.autoRenew ?? true,
  });

  const detectInitialConfigMode = (
    domain?: Domain | null,
  ): DomainConfigMode => {
    if (
      domain &&
      (domain.targetContainerId != null || domain.targetPort != null)
    ) {
      return "CONTAINER";
    }

    return "MANUAL";
  };

  const isEditMode = Boolean(domainToEdit);
  const [form, setForm] = useState<AddDomainFormState>({
    ...buildInitialForm(domainToEdit),
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [proxyCapabilityError, setProxyCapabilityError] = useState("");
  const [certbotInstalled, setCertbotInstalled] = useState(false);
  const [serverContainers, setServerContainers] = useState<Container[]>([]);
  const [portOptions, setPortOptions] = useState<PortOption[]>([]);
  const [containerInspectLoading, setContainerInspectLoading] = useState(false);
  const [availableProxies, setAvailableProxies] = useState<
    DomainProxy[] | null
  >(null);
  const [configMode, setConfigMode] = useState<DomainConfigMode>(
    detectInitialConfigMode(domainToEdit),
  );

  const selectedServer = useMemo(
    () => serverList.find((server) => server.id === form.serverId) ?? null,
    [serverList, form.serverId],
  );
  const isContainerMode = configMode === "CONTAINER";
  const selectableProxies = availableProxies ?? PROXY_OPTIONS;
  const targetingEnabled = Boolean(form.serverId);

  const linkedContainerDomains = useMemo(() => {
    const usage = new Map<string, string[]>();

    for (const domain of existingDomains) {
      if (
        domain.id === domainToEdit?.id ||
        domain.serverId !== form.serverId ||
        !domain.targetContainerId ||
        !domain.name
      ) {
        continue;
      }

      const names = usage.get(domain.targetContainerId) ?? [];
      names.push(domain.name);
      usage.set(domain.targetContainerId, names);
    }

    return usage;
  }, [domainToEdit?.id, existingDomains, form.serverId]);

  const linkedPortDomains = useMemo(() => {
    const usage = new Map<number, string[]>();

    if (!form.targetContainerId) {
      return usage;
    }

    for (const domain of existingDomains) {
      if (
        domain.id === domainToEdit?.id ||
        domain.serverId !== form.serverId ||
        domain.targetContainerId !== form.targetContainerId ||
        domain.targetPort == null ||
        !domain.name
      ) {
        continue;
      }

      const names = usage.get(domain.targetPort) ?? [];
      names.push(domain.name);
      usage.set(domain.targetPort, names);
    }

    return usage;
  }, [
    domainToEdit?.id,
    existingDomains,
    form.serverId,
    form.targetContainerId,
  ]);

  useEffect(() => {
    setForm(buildInitialForm(domainToEdit));
    setConfigMode(detectInitialConfigMode(domainToEdit));
    setError("");
    setLoading(false);
  }, [domainToEdit]);

  const updateForm = (updates: Partial<AddDomainFormState>) => {
    setForm((current) => ({
      ...current,
      ...updates,
    }));
  };

  useEffect(() => {
    let cancelled = false;

    if (!form.serverId) {
      setCapabilityLoading(false);
      setProxyCapabilityError("");
      setAvailableProxies(null);
      setServerContainers([]);
      setPortOptions([]);
      setCertbotInstalled(false);
      setForm((current) => {
        if (
          current.proxy === "NONE" &&
          !current.sslEnabled &&
          !current.targetContainerId &&
          current.targetPort === ""
        ) {
          return current;
        }

        return {
          ...current,
          targetContainerId: "",
          targetPort: "",
          proxy: "NONE",
          sslEnabled: false,
          autoRenew: false,
        };
      });

      return () => {
        cancelled = true;
      };
    }

    setCapabilityLoading(true);
    setProxyCapabilityError("");

    void Promise.all([
      serversApi.getConfig(form.serverId),
      containersApi.list({ serverId: form.serverId }),
    ])
      .then(([configRes, containersRes]) => {
        if (cancelled) {
          return;
        }

        const proxies = detectAvailableProxies(
          configRes.data,
          containersRes.data,
        );
        const hasCertbot = configRes.data.webServer.components.some(
          (component) => component.key === "certbot" && component.installed,
        );

        setCertbotInstalled(hasCertbot);
        setAvailableProxies(proxies);
        setServerContainers(
          containersRes.data.filter(
            (container) => container.status === "RUNNING",
          ),
        );
        setForm((current) => ({
          ...current,
          sslEnabled: hasCertbot ? current.sslEnabled : false,
          autoRenew:
            hasCertbot && current.sslEnabled ? current.autoRenew : false,
          proxy: proxies.includes(current.proxy) ? current.proxy : "NONE",
        }));
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }

        setAvailableProxies(["NONE"]);
        setCertbotInstalled(false);
        setServerContainers([]);
        setPortOptions([]);
        setForm((current) => ({ ...current, proxy: "NONE" }));
        setProxyCapabilityError(
          err instanceof Error
            ? err.message
            : "Failed to inspect server reverse proxy availability",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setCapabilityLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [form.serverId]);

  useEffect(() => {
    let cancelled = false;

    if (!form.targetContainerId) {
      setPortOptions([]);
      setContainerInspectLoading(false);
      setForm((current) =>
        current.targetPort === "" ? current : { ...current, targetPort: "" },
      );

      return () => {
        cancelled = true;
      };
    }

    setContainerInspectLoading(true);

    void containersApi
      .inspect(form.targetContainerId)
      .then((response) => {
        if (cancelled) {
          return;
        }

        const nextPortOptions = parseInspectPortOptions(response.data);
        setPortOptions(nextPortOptions);
        setForm((current) => ({
          ...current,
          targetPort: nextPortOptions.some(
            (option) => option.value === current.targetPort,
          )
            ? current.targetPort
            : (nextPortOptions[0]?.value ?? ""),
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setPortOptions([]);
        setForm((current) => ({ ...current, targetPort: "" }));
      })
      .finally(() => {
        if (!cancelled) {
          setContainerInspectLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [form.targetContainerId]);

  const toggle = (key: "sslEnabled" | "autoRenew") => {
    setForm((current) => {
      if (key === "sslEnabled") {
        if (!current.serverId) {
          return current;
        }

        const nextSslEnabled = !current.sslEnabled;

        return {
          ...current,
          sslEnabled: nextSslEnabled,
          autoRenew:
            nextSslEnabled && certbotInstalled
              ? current.autoRenew || true
              : false,
        };
      }

      if (!current.sslEnabled) {
        return current;
      }

      return { ...current, autoRenew: !current.autoRenew };
    });
  };

  const switchConfigMode = (nextMode: DomainConfigMode) => {
    setConfigMode(nextMode);
    setError("");
    setForm((current) => {
      if (nextMode === "MANUAL") {
        return {
          ...current,
          proxy: "NONE",
          targetContainerId: "",
          targetPort: "",
        };
      }

      return {
        ...current,
        type: "A",
        proxyConfigMode:
          current.proxy === "NGINX" ? current.proxyConfigMode : "ISOLATED",
      };
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const effectiveType = isContainerMode ? "A" : form.type;
    const effectiveValue = isContainerMode
      ? (selectedServer?.ip?.trim() ?? "")
      : form.value.trim();

    if (!effectiveValue) {
      setError(
        isContainerMode
          ? "Select a target server so the DNS target IP can be derived automatically."
          : "DNS target value is required.",
      );
      return;
    }

    if (effectiveType === "A" && isIpv4WithPort(effectiveValue)) {
      setError(
        "A record only accepts an IP address. Ports are not valid in DNS records.",
      );
      return;
    }

    if (isContainerMode && form.proxy === "NONE") {
      setError("Select a reverse proxy for Container Config mode.");
      return;
    }

    if (form.proxy !== "NONE" && !form.serverId) {
      setError("Select a target server before choosing a reverse proxy.");
      return;
    }

    if (form.proxy !== "NONE" && !form.targetContainerId) {
      setError(
        "Select a target container before provisioning a reverse proxy.",
      );
      return;
    }

    if (form.proxy !== "NONE" && form.targetPort === "") {
      setError("Select a target port before provisioning a reverse proxy.");
      return;
    }

    if (form.sslEnabled && !form.serverId) {
      setError("Select a target server before enabling Auto SSL.");
      return;
    }

    if (form.sslEnabled && !certbotInstalled) {
      setError(
        "Auto SSL is disabled because Certbot is not installed on the selected server.",
      );
      return;
    }

    setLoading(true);

    try {
      const normalizedDomainName = form.name.trim().toLowerCase();
      const payload = {
        name: normalizedDomainName,
        type: effectiveType,
        value: effectiveValue,
        serverId: form.serverId || undefined,
        targetContainerId:
          form.proxy !== "NONE" ? form.targetContainerId : undefined,
        targetPort:
          form.proxy !== "NONE" && form.targetPort !== ""
            ? form.targetPort
            : undefined,
        proxy: form.proxy,
        configMode:
          form.proxy === "NGINX"
            ? form.proxyConfigMode
            : ("ISOLATED" as ApiDomainConfigMode),
        isPrimary: form.proxy === "NGINX" ? form.isPrimary : false,
        reviewStatus:
          domainToEdit?.reviewStatus === "NEEDS_REVIEW"
            ? "CONFIRMED"
            : undefined,
        sslEnabled: form.sslEnabled,
        autoRenew: form.autoRenew,
      };

      if (domainToEdit) {
        await domainsApi.update(domainToEdit.id, payload);
      } else {
        await domainsApi.create(payload);
      }

      await onSaved(normalizedDomainName, domainToEdit ? "updated" : "created");
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : domainToEdit
            ? "Failed to update domain"
            : "Failed to add domain",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal animate-slide-in"
        style={{
          width: "100%",
          maxWidth: 580,
          padding: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 20,
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
              {isEditMode ? "Edit Domain" : "Add Domain"}
            </h3>
            <p
              style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}
            >
              {isEditMode
                ? "Update domain target, reverse proxy, and SSL settings"
                : "Configure domain with optional auto-SSL"}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
            }}
          >
            <X size={18} />
          </button>
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
          <AddDomainModeSelector
            configMode={configMode}
            onChange={switchConfigMode}
          />

          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background:
                configMode === "MANUAL"
                  ? "rgba(148,163,184,0.08)"
                  : "rgba(59,130,246,0.08)",
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            {configMode === "MANUAL"
              ? "Manual Config is used if you only want to store DNS records such as A, AAAA, CNAME, MX, or TXT. This mode doesn't route traffic to the container. You can still select a Target Server if you want to associate the domain with a specific server or use it for Auto SSL."
              : "Container Config is used when a domain needs to be directed to a specific container and port through a reverse proxy like Traefik, Nginx, or Caddy. The target DNS IP will follow the selected server IP."}
          </div>

          <AddDomainDnsFields
            form={form}
            isContainerMode={isContainerMode}
            selectedServerIp={selectedServer?.ip ?? ""}
            onChange={updateForm}
          />

          <div>
            <label
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                display: "block",
                marginBottom: 5,
              }}
            >
              Server Target{" "}
              {isContainerMode || form.proxy !== "NONE" || form.sslEnabled
                ? "*"
                : "(optional)"}
            </label>
            <select
              className="input"
              value={form.serverId}
              onChange={(event) =>
                updateForm({
                  serverId: event.target.value,
                  targetContainerId: "",
                  targetPort: "",
                })
              }
              style={{ width: "100%" }}
            >
              <option value="">— None —</option>
              {serverList.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} ({server.ip})
                </option>
              ))}
            </select>
            {!isContainerMode && (
              <p
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 6,
                  lineHeight: 1.5,
                }}
              >
                In Manual Config, this field is optional. Select a server only
                if you want to associate the domain with a specific server or
                enable Auto SSL for that server.
              </p>
            )}
          </div>

          {isContainerMode && (
            <AddDomainTargetingSection
              form={form}
              capabilityLoading={capabilityLoading}
              proxyCapabilityError={proxyCapabilityError}
              serverContainers={serverContainers}
              portOptions={portOptions}
              containerInspectLoading={containerInspectLoading}
              selectableProxies={selectableProxies}
              targetingEnabled={targetingEnabled}
              allowSharedTargetReuse={
                isContainerMode &&
                form.proxy === "NGINX" &&
                form.proxyConfigMode === "SHARED"
              }
              linkedContainerDomains={linkedContainerDomains}
              linkedPortDomains={linkedPortDomains}
              onChange={updateForm}
            />
          )}

          {isContainerMode && form.proxy === "NGINX" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                padding: 14,
                background: "var(--bg-input)",
                borderRadius: 8,
                border: "1px solid var(--border)",
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
                  Nginx Config Mode
                </label>
                <select
                  className="input"
                  value={form.proxyConfigMode}
                  onChange={(event) =>
                    updateForm({
                      proxyConfigMode: event.target
                        .value as ApiDomainConfigMode,
                      isPrimary:
                        event.target.value === "ISOLATED"
                          ? false
                          : form.isPrimary,
                    })
                  }
                  style={{ width: "100%" }}
                >
                  <option value="ISOLATED">Isolated Domain Config</option>
                  <option value="SHARED">Shared Service Config</option>
                </select>
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    marginTop: 6,
                  }}
                >
                  {form.proxyConfigMode === "SHARED"
                    ? "Shared mode groups the root domain and its subdomains into one root-domain Nginx file, for example /etc/nginx/sites-available/example.com.conf. Each hostname can still point to a different container and port."
                    : "Isolated mode means exactly one domain per Nginx file, for example /etc/nginx/sites-available/app.example.com.conf. Domain lain seperti api.example.com atau admin.example.com tidak otomatis ikut masuk ke file ini dan harus dibuat sendiri, atau dipindah ke Shared mode jika memang ingin satu config bersama."}
                </p>
              </div>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <input
                  type="checkbox"
                  checked={form.isPrimary}
                  disabled={form.proxyConfigMode !== "SHARED"}
                  onChange={(event) =>
                    updateForm({ isPrimary: event.target.checked })
                  }
                />
                Mark this domain as primary within the shared service group
              </label>

              {form.proxyConfigMode === "SHARED" && (
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    lineHeight: 1.5,
                  }}
                >
                  Shared create allows selecting a container and port that are
                  already used by other Shared Nginx domains on the same server.
                  Mixed reuse with isolated or non-Nginx bindings remains
                  blocked.
                </label>
              )}

              {form.proxyConfigMode === "ISOLATED" && (
                <label
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    lineHeight: 1.5,
                  }}
                >
                  Isolated config means the Nginx config for this domain will be
                  created separately and won't be shared with any other domain.
                  This allows you to reuse target containers and ports that are
                  already in use by other domains, as long as those domains are
                  not using Shared mode on the same server.
                </label>
              )}

              {domainToEdit?.reviewStatus === "NEEDS_REVIEW" && (
                <div
                  style={{
                    borderRadius: 8,
                    padding: "10px 12px",
                    border: "1px solid rgba(245,158,11,0.35)",
                    background: "rgba(245,158,11,0.12)",
                    fontSize: 12,
                    color: "#f59e0b",
                    lineHeight: 1.5,
                  }}
                >
                  This domain was inferred during sync and still needs review.
                  Saving your changes will mark the review as confirmed.
                </div>
              )}
            </div>
          )}

          <AddDomainSslSection
            form={form}
            certbotInstalled={certbotInstalled}
            onToggle={toggle}
          />

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
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              <Shield size={13} /> {isEditMode ? "Save Changes" : "Add Domain"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
