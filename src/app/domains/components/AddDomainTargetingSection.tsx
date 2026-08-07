import { Container, DomainProxy } from "@/lib/api";
import SearchableSelect, { type SearchableSelectOption } from "@/components/SearchableSelect";
import { Loader2 } from "lucide-react";
import { AddDomainFormState, PortOption } from "./domain-types";

interface AddDomainTargetingSectionProps {
  form: AddDomainFormState;
  capabilityLoading: boolean;
  proxyCapabilityError: string;
  serverContainers: Container[];
  serverContainersLoading: boolean;
  portOptions: PortOption[];
  containerInspectLoading: boolean;
  selectableProxies: DomainProxy[];
  targetingEnabled: boolean;
  allowSharedTargetReuse: boolean;
  linkedContainerDomains: Map<string, string[]>;
  linkedPortDomains: Map<number, string[]>;
  onChange: (updates: Partial<AddDomainFormState>) => void;
}

const PROXY_OPTIONS: DomainProxy[] = ["NONE", "TRAEFIK", "NGINX", "CADDY"];

export default function AddDomainTargetingSection({
  form,
  capabilityLoading,
  proxyCapabilityError,
  serverContainers,
  serverContainersLoading,
  portOptions,
  containerInspectLoading,
  selectableProxies,
  targetingEnabled,
  allowSharedTargetReuse,
  linkedContainerDomains,
  linkedPortDomains,
  onChange,
}: AddDomainTargetingSectionProps) {
  const containerOptions: SearchableSelectOption[] = serverContainers.map((container) => {
    const linkedDomains = linkedContainerDomains.get(container.id) ?? [];
    const disabled = linkedDomains.length > 0 && !allowSharedTargetReuse;
    return { value: container.id, label: `${container.name} (${container.image})`, keywords: `${container.name} ${container.image} ${container.dockerId ?? ""}`, description: disabled ? linkedDomains.length > 1 ? "Used by 1+ domains" : `Used by ${linkedDomains.join(", ")}` : undefined, disabled };
  });

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <label
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              display: "block",
              marginBottom: 5,
            }}
          >
            Target Container *
          </label>
          <SearchableSelect
            value={form.targetContainerId}
            options={containerOptions}
            onChange={(targetContainerId) =>
              onChange({
                targetContainerId,
                targetPort: "",
              })
            }
            placeholder="Select container..."
            searchPlaceholder="Search containers..."
            emptyText="No matching containers found"
            disabled={!form.serverId || serverContainersLoading || !targetingEnabled}
            style={{ width: "100%" }}
          />
          {/*
            <option value="">— Select container —</option>
            {serverContainers.map((container) => {
              const linkedDomains =
                linkedContainerDomains.get(container.id) ?? [];
              const disabled =
                linkedDomains.length > 0 && !allowSharedTargetReuse;

              return (
                <option
                  key={container.id}
                  value={container.id}
                  disabled={disabled}
                >
                  {disabled
                    ? `${container.name} (${container.image}) - used by ${linkedDomains.length > 1 ? "1+ domains" : linkedDomains.join(", ")}`
                    : `${container.name} (${container.image})`}
                </option>
              );
            })}
          */}
        </div>
        <div style={{ minWidth: 0 }}>
          <label
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              display: "block",
              marginBottom: 5,
            }}
          >
            Target Port *
          </label>
          <select
            className="input"
            value={form.targetPort}
            onChange={(event) =>
              onChange({
                targetPort: event.target.value
                  ? Number(event.target.value)
                  : "",
              })
            }
            disabled={
              !targetingEnabled ||
              !form.targetContainerId ||
              containerInspectLoading ||
              portOptions.length === 0
            }
            style={{ width: "100%" }}
          >
            <option value="">— Select port —</option>
            {portOptions.map((option) => {
              const linkedDomains = linkedPortDomains.get(option.value) ?? [];
              const disabled =
                linkedDomains.length > 0 && !allowSharedTargetReuse;

              return (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={disabled}
                >
                  {disabled
                    ? `${option.label} - used by ${linkedDomains.join(", ")}`
                    : option.label}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {form.serverId && serverContainersLoading && (
        <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8, padding: "8px 10px", border: "1px solid rgba(59,130,246,0.28)", borderRadius: 7, background: "rgba(59,130,246,0.08)", color: "var(--text-muted)", fontSize: 12 }}>
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading running containers from the selected server…
        </div>
      )}

      {form.serverId && !serverContainersLoading && serverContainers.length === 0 && (
        <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
          No running containers were found on the selected server.
        </p>
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
          Reverse Proxy
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          {PROXY_OPTIONS.map((proxy) => {
            const disabled =
              proxy !== "NONE" &&
              (!form.serverId ||
                capabilityLoading ||
                !selectableProxies.includes(proxy));

            return (
              <button
                type="button"
                key={proxy}
                onClick={() => onChange({ proxy })}
                disabled={disabled}
                style={{
                  flex: 1,
                  padding: "8px 0",
                  borderRadius: 8,
                  border: `1px solid ${form.proxy === proxy ? "var(--accent-green)" : "var(--border)"}`,
                  background: disabled
                    ? "rgba(148,163,184,0.12)"
                    : form.proxy === proxy
                      ? "rgba(59,130,246,0.1)"
                      : "var(--bg-primary)",
                  color: disabled
                    ? "rgba(100,116,139,0.8)"
                    : form.proxy === proxy
                      ? "var(--accent-green)"
                      : "var(--accent-green)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.65 : 1,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {proxy === "NONE"
                  ? "None"
                  : proxy === "CADDY"
                    ? "Caddy"
                    : proxy.charAt(0) + proxy.slice(1).toLowerCase()}
              </button>
            );
          })}
        </div>
        <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
          {form.serverId && capabilityLoading && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          {form.serverId
            ? capabilityLoading
              ? "Checking reverse proxy availability on the selected server…"
              : "Choose container and port first, then pick one of the proxies detected on the selected server."
            : "Select Server Target first to enable proxy-aware validation."}
        </p>
        {proxyCapabilityError && (
          <p style={{ fontSize: 11, color: "#f59e0b", marginTop: 4 }}>
            {proxyCapabilityError}
          </p>
        )}
      </div>
    </>

    // <>
    //   <div>
    //     <label
    //       style={{
    //         fontSize: 12,
    //         color: "var(--text-muted)",
    //         display: "block",
    //         marginBottom: 5,
    //       }}
    //     >
    //       Reverse Proxy
    //     </label>
    //     <div style={{ display: "flex", gap: 8 }}>
    //       {PROXY_OPTIONS.map((proxy) => {
    //         const disabled =
    //           proxy !== "NONE" &&
    //           (!form.serverId ||
    //             capabilityLoading ||
    //             !selectableProxies.includes(proxy));

    //         return (
    //           <button
    //             type="button"
    //             key={proxy}
    //             onClick={() => onChange({ proxy })}
    //             disabled={disabled}
    //             style={{
    //               flex: 1,
    //               padding: "8px 0",
    //               borderRadius: 8,
    //               border: `1px solid ${form.proxy === proxy ? "var(--accent)" : "var(--border)"}`,
    //               background: disabled
    //                 ? "rgba(148,163,184,0.12)"
    //                 : form.proxy === proxy
    //                   ? "rgba(59,130,246,0.1)"
    //                   : "var(--bg-input)",
    //               color: disabled
    //                 ? "rgba(100,116,139,0.8)"
    //                 : form.proxy === proxy
    //                   ? "var(--accent)"
    //                   : "var(--text-muted)",
    //               cursor: disabled ? "not-allowed" : "pointer",
    //               opacity: disabled ? 0.65 : 1,
    //               fontSize: 12,
    //               fontWeight: 600,
    //             }}
    //           >
    //             {proxy === "NONE"
    //               ? "None"
    //               : proxy === "CADDY"
    //                 ? "Caddy"
    //                 : proxy.charAt(0) + proxy.slice(1).toLowerCase()}
    //           </button>
    //         );
    //       })}
    //     </div>
    //     <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
    //       {form.serverId
    //         ? capabilityLoading
    //           ? "Inspecting selected server for available reverse proxies..."
    //           : "Choose container and port first, then pick one of the proxies detected on the selected server."
    //         : "Select Server Target first to enable proxy-aware validation."}
    //     </p>
    //     {proxyCapabilityError && (
    //       <p style={{ fontSize: 11, color: "#f59e0b", marginTop: 4 }}>
    //         {proxyCapabilityError}
    //       </p>
    //     )}
    //   </div>

    //   <div
    //     style={{
    //       display: "grid",
    //       gridTemplateColumns: "1fr 1fr",
    //       gap: 12,
    //     }}
    //   >
    //     <div>
    //       <label
    //         style={{
    //           fontSize: 12,
    //           color: "var(--text-muted)",
    //           display: "block",
    //           marginBottom: 5,
    //         }}
    //       >
    //         Target Container *
    //       </label>
    //       <select
    //         className="input"
    //         value={form.targetContainerId}
    //         onChange={(event) =>
    //           onChange({
    //             targetContainerId: event.target.value,
    //             targetPort: "",
    //           })
    //         }
    //         disabled={!form.serverId || capabilityLoading || !targetingEnabled}
    //         style={{ width: "100%" }}
    //       >
    //         <option value="">— Select container —</option>
    //         {serverContainers.map((container) => (
    //           <option key={container.id} value={container.id}>
    //             {container.name} ({container.image})
    //           </option>
    //         ))}
    //       </select>
    //     </div>
    //     <div>
    //       <label
    //         style={{
    //           fontSize: 12,
    //           color: "var(--text-muted)",
    //           display: "block",
    //           marginBottom: 5,
    //         }}
    //       >
    //         Target Port *
    //       </label>
    //       <select
    //         className="input"
    //         value={form.targetPort}
    //         onChange={(event) =>
    //           onChange({
    //             targetPort: event.target.value
    //               ? Number(event.target.value)
    //               : "",
    //           })
    //         }
    //         disabled={
    //           !targetingEnabled ||
    //           !form.targetContainerId ||
    //           containerInspectLoading ||
    //           portOptions.length === 0
    //         }
    //         style={{ width: "100%" }}
    //       >
    //         <option value="">— Select port —</option>
    //         {portOptions.map((option) => (
    //           <option key={option.value} value={option.value}>
    //             {option.label}
    //           </option>
    //         ))}
    //       </select>
    //     </div>
    //   </div>

    //   {form.serverId && serverContainers.length === 0 && (
    //     <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
    //       No running containers were found on the selected server.
    //     </p>
    //   )}
    // </>
  );
}
