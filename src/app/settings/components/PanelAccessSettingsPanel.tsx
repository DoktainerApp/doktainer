"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Globe2,
  Loader2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import {
  settingsApi,
  type PanelAccessCapabilities,
  type PanelAccessProxy,
  type SettingsRecord,
} from "@/lib/api";
import {
  FieldLabel,
  Toggle,
} from "@/app/settings/components/SettingsPrimitives";
import type { EditableSettings } from "@/app/settings/components/settings-types";

interface PanelAccessSettingsPanelProps {
  settings: EditableSettings;
  onProvisioned?: (settings: SettingsRecord, message?: string) => void;
}

const proxyOptions = [
  { value: "NGINX", label: "Nginx" },
  { value: "CADDY", label: "Caddy" },
  { value: "TRAEFIK", label: "Traefik" },
] as const satisfies Array<{ value: PanelAccessProxy; label: string }>;

function resolveInitialDomain(panelUrl: string) {
  try {
    const parsed = new URL(panelUrl);
    const host = parsed.hostname.toLowerCase();
    const isLocalOrIp =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      host.endsWith(".local");

    return isLocalOrIp ? "" : parsed.hostname;
  } catch {
    return "";
  }
}

export default function PanelAccessSettingsPanel({
  settings,
  onProvisioned,
}: PanelAccessSettingsPanelProps) {
  const initialDomain = useMemo(
    () => resolveInitialDomain(settings.general.panelUrl),
    [settings.general.panelUrl],
  );
  const [panelDomain, setPanelDomain] = useState(initialDomain);
  const [panelProxy, setPanelProxy] = useState<PanelAccessProxy>("NGINX");
  const [panelAutoSsl, setPanelAutoSsl] = useState(
    Boolean(initialDomain) && settings.general.panelUrl.startsWith("https://"),
  );
  const [capabilities, setCapabilities] =
    useState<PanelAccessCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedCapability = capabilities?.proxies.find(
    (proxy) => proxy.type === panelProxy,
  );
  const hasProvisionableProxy = Boolean(
    capabilities?.proxies.some(
      (proxy) => proxy.available && proxy.supportsProvisioning,
    ),
  );
  const sslDisabled = !panelDomain.trim() || !hasProvisionableProxy;
  const hasCustomDomain = Boolean(initialDomain);
  const canProvision = Boolean(
    panelDomain.trim() &&
    selectedCapability?.available &&
    selectedCapability.supportsProvisioning &&
    !provisioning,
  );

  useEffect(() => {
    let mounted = true;

    const loadCapabilities = async () => {
      setLoadingCapabilities(true);
      setError(null);

      try {
        const response = await settingsApi.getPanelAccessCapabilities();
        if (!mounted) return;

        setCapabilities(response.data);
        if (response.data.defaultProxy) {
          setPanelProxy(response.data.defaultProxy);
        }
      } catch (err) {
        if (!mounted) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to inspect panel host reverse proxy",
        );
      } finally {
        if (mounted) setLoadingCapabilities(false);
      }
    };

    void loadCapabilities();
    return () => {
      mounted = false;
    };
  }, []);

  const provisionPanelDomain = async () => {
    setProvisioning(true);
    setError(null);
    setMessage(null);

    try {
      const response = await settingsApi.provisionPanelDomain({
        domain: panelDomain.trim(),
        proxy: panelProxy,
        autoSsl: panelAutoSsl && !sslDisabled,
      });
      setMessage(response.message || response.data.provision.message);
      onProvisioned?.(response.data.settings, response.message);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Panel domain provisioning failed",
      );
    } finally {
      setProvisioning(false);
    }
  };

  const resetPanelDomain = async () => {
    if (
      !window.confirm(
        "Reset the custom panel domain? This only removes it from Doktainer settings; reverse-proxy and SSL configuration on the server will remain unchanged.",
      )
    ) {
      return;
    }

    setProvisioning(true);
    setError(null);
    setMessage(null);

    try {
      const response = await settingsApi.resetPanelDomain();
      setPanelDomain("");
      setPanelAutoSsl(false);
      setMessage(response.message || "Custom panel domain reset");
      onProvisioned?.(response.data, response.message);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to reset panel domain",
      );
    } finally {
      setProvisioning(false);
    }
  };

  return (
    <div
      className="card"
      style={{
        padding: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          padding: "18px 22px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 11,
            minWidth: 0,
          }}
        >
          {/* <span
            style={{
              width: 22,
              height: 22,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "50%",
              background: "var(--accent-blue)",
              color: "white",
              fontSize: 11,
              fontWeight: 800,
            }}
          >
            1
          </span> */}
          <div>
            <h2
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 15,
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              <Globe2 size={16} color="var(--accent-green)" />
              Configure Panel Domain
            </h2>
            <div
              style={{
                marginTop: 5,
                fontSize: 12,
                color: "var(--text-muted)",
                lineHeight: 1.5,
              }}
            >
              Set your panel domain and reverse proxy. Doktainer will handle the
              rest.
            </div>
          </div>
        </div>
        <span className="ui-badge badge-info">
          {loadingCapabilities
            ? "Inspecting"
            : (capabilities?.target.label ?? "Panel host")}
        </span>
      </div>

      <div
        style={{
          padding: 22,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {error ? (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "10px 12px",
              border: "1px solid rgba(239,68,68,0.28)",
              borderRadius: 8,
              background: "rgba(239,68,68,0.1)",
              color: "#ef4444",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{error}</span>
          </div>
        ) : null}

        {/* {message ? (
          <div
            style={{
              padding: "10px 12px",
              border: "1px solid rgba(16,185,129,0.28)",
              borderRadius: 8,
              background: "rgba(16,185,129,0.1)",
              color: "#10b981",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {message}
          </div>
        ) : null} */}

        {capabilities?.target.diagnostic ? (
          <div
            style={{
              padding: "10px 12px",
              border: "1px solid rgba(59,130,246,0.24)",
              borderRadius: 8,
              background: "rgba(59,130,246,0.07)",
              color: "var(--text-secondary)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {capabilities.target.diagnostic}
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 14,
            alignItems: "start",
          }}
        >
          <div>
            <FieldLabel>Domain</FieldLabel>
            <input
              className="input"
              placeholder="panel.example.com"
              value={panelDomain}
              onChange={(event) => setPanelDomain(event.target.value)}
            />
            <div
              style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}
            >
              Enter the domain used to open the Doktainer panel.
            </div>
          </div>
          <div>
            <FieldLabel>
              Reverse Proxy{" "}
              <span style={{ fontWeight: 500, color: "var(--text-muted)" }}>
                (Auto Detect)
              </span>
            </FieldLabel>
            <div style={{ position: "relative" }}>
              <select
                className="input"
                value={panelProxy}
                disabled={loadingCapabilities}
                onChange={(event) =>
                  setPanelProxy(event.target.value as PanelAccessProxy)
                }
                style={{ width: "100%", appearance: "none", paddingRight: 34 }}
              >
                {proxyOptions.map((option) => {
                  const capability = capabilities?.proxies.find(
                    (proxy) => proxy.type === option.value,
                  );
                  const available =
                    capability?.available && capability.supportsProvisioning;
                  return (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={!available}
                    >
                      {option.label}
                      {available ? " (Detected)" : " (Unavailable)"}
                    </option>
                  );
                })}
              </select>
              <ChevronDown
                size={15}
                style={{
                  position: "absolute",
                  right: 11,
                  top: "50%",
                  transform: "translateY(-50%)",
                  pointerEvents: "none",
                  color: "var(--text-muted)",
                }}
              />
            </div>
            {selectedCapability?.reason ? (
              <div
                style={{
                  marginTop: 7,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                {selectedCapability.reason}
              </div>
            ) : null}
          </div>
        </div>

        <div
          style={{
            minHeight: 74,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "13px 14px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-input)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12,
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              <ShieldCheck size={14} color="var(--accent-green)" />
              HTTPS / SSL
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              Automatically provision SSL certificate
            </div>
          </div>
          <Toggle
            checked={panelAutoSsl && !sslDisabled}
            onChange={() => setPanelAutoSsl((current) => !current)}
            disabled={sslDisabled}
          />
        </div>
        {sslDisabled ? (
          <div
            style={{
              marginTop: -8,
              fontSize: 11,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            {!panelDomain.trim()
              ? "Enter a domain to enable HTTPS / SSL."
              : "HTTPS / SSL is unavailable because no reverse proxy can be provisioned."}
          </div>
        ) : null}
        {capabilities?.autoSsl.reason ? (
          <div
            style={{
              marginTop: -8,
              fontSize: 11,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            {capabilities.autoSsl.reason}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            paddingTop: 2,
          }}
        >
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!hasCustomDomain || provisioning}
            onClick={() => void resetPanelDomain()}
            style={{
              minWidth: 88,
              opacity: hasCustomDomain && !provisioning ? 1 : 0.55,
              cursor:
                hasCustomDomain && !provisioning ? "pointer" : "not-allowed",
            }}
          >
            <RotateCcw size={14} />
            Reset
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canProvision}
            onClick={() => void provisionPanelDomain()}
            style={{
              minWidth: 164,
              opacity: canProvision ? 1 : 0.55,
              cursor: canProvision ? "pointer" : "not-allowed",
            }}
          >
            {provisioning ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Provisioning
              </>
            ) : (
              "Configure Domain"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
