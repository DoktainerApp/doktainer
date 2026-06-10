"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Globe2,
  Loader2,
  RefreshCw,
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
    settings.general.panelUrl.startsWith("https://") || !initialDomain,
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
  const panelRoutePreview = panelDomain.trim()
    ? `${panelDomain.trim()} -> ${panelProxy}`
    : "No custom panel domain configured";
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
        autoSsl: panelAutoSsl,
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

  return (
    <div
      className="card"
      style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
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
            Panel Access
          </h2>
          <div
            style={{
              marginTop: 5,
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            Custom domain provisioning for the Doktainer panel
          </div>
        </div>
        <span className="ui-badge badge-info">
          {loadingCapabilities
            ? "Inspecting"
            : (capabilities?.target.label ?? "Panel host")}
        </span>
      </div>

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

      {message ? (
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
      ) : null}

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
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 16,
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
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        <div>
          <FieldLabel>Reverse Proxy</FieldLabel>
          <div
            className="ui-pill-switch"
            style={{
              border: "1px solid var(--border)",
              background: "var(--bg-input)",
            }}
          >
            {proxyOptions.map((option) => {
              const active = panelProxy === option.value;
              const capability = capabilities?.proxies.find(
                (proxy) => proxy.type === option.value,
              );
              const disabled =
                loadingCapabilities ||
                !capability?.available ||
                !capability.supportsProvisioning;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    if (!disabled) setPanelProxy(option.value);
                  }}
                  disabled={disabled}
                  title={capability?.reason ?? undefined}
                  style={{
                    minHeight: 34,
                    flex: "1 1 120px",
                    border: "none",
                    borderRadius: 6,
                    background: active ? "#1d4ed8" : "transparent",
                    color: disabled
                      ? "var(--text-muted)"
                      : active
                        ? "white"
                        : "var(--text-secondary)",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.55 : 1,
                  }}
                >
                  {option.label}
                </button>
              );
            })}
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
        <div
          style={{
            minHeight: 62,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "11px 12px",
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
              Auto SSL
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              Certbot or proxy-managed TLS
            </div>
          </div>
          <Toggle
            checked={panelAutoSsl}
            onChange={() => setPanelAutoSsl((current) => !current)}
          />
        </div>
      </div>
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
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 14px",
          border: "1px solid rgba(59,130,246,0.24)",
          borderRadius: 8,
          background: "rgba(59,130,246,0.07)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            color: "var(--text-secondary)",
            fontSize: 12,
          }}
        >
          <RefreshCw size={14} color="var(--accent-blue)" />
          <span>{panelRoutePreview}</span>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canProvision}
          onClick={() => void provisionPanelDomain()}
          style={{
            minWidth: 168,
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
            "Provision Panel Domain"
          )}
        </button>
      </div>
    </div>
  );
}
