import { AlertTriangle } from "lucide-react";
import type { SecurityOperationalNoteData } from "./security-types";

interface SecurityOperationalNoteProps {
  operationalNote: SecurityOperationalNoteData | null;
}

export default function SecurityOperationalNote({
  operationalNote,
}: SecurityOperationalNoteProps) {
  return (
    <div
      className="card"
      style={{
        padding: 16,
        border: operationalNote?.supported
          ? "1px solid rgba(16,185,129,0.25)"
          : "1px solid rgba(245,158,11,0.25)",
        background: operationalNote?.supported
          ? "rgba(16,185,129,0.05)"
          : "rgba(245,158,11,0.06)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <AlertTriangle
          size={15}
          style={{
            color: operationalNote?.supported ? "#10b981" : "#f59e0b",
          }}
        />
        <h2
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          Fail2ban Operational Note
        </h2>
      </div>
      <p
        style={{
          fontSize: 12,
          color: "var(--text-secondary)",
          marginBottom: 12,
        }}
      >
        The Install & Activate button will succeed if the SSH user has
        non-interactive sudo privileges and the server has a supported package
        manager.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        {[
          {
            label: "Distro",
            value: operationalNote?.distroLabel ?? "Unknown distro",
          },
          {
            label: "Package Manager",
            value: operationalNote?.packageManagerLabel ?? "Not detected",
          },
          {
            label: "Sudo Non-Interactive",
            value: operationalNote?.sudoLabel ?? "Unavailable",
          },
        ].map((item) => (
          <div
            key={item.label}
            className="card"
            style={{ padding: 12, background: "var(--bg-input)" }}
          >
            <p
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                marginBottom: 4,
              }}
            >
              {item.label}
            </p>
            <p
              style={{
                fontSize: 12,
                color: "var(--text-primary)",
                fontWeight: 600,
              }}
            >
              {item.value}
            </p>
          </div>
        ))}
        <div
          className="card"
          style={{ padding: 12, background: "var(--bg-input)" }}
        >
          <p
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              marginBottom: 4,
            }}
          >
            Install Compatibility
          </p>
          <p
            style={{
              fontSize: 12,
              color: operationalNote?.supported ? "#10b981" : "#f59e0b",
              fontWeight: 700,
            }}
          >
            {operationalNote?.supported ? "Supported" : "Needs attention"}
          </p>
        </div>
      </div>
    </div>
  );
}
