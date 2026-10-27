"use client";

import { HardDrive } from "lucide-react";
import Link from "next/link";
import type { StorageTabData } from "../../types/app-detail-types";
import PanelShell from "../overview/PanelShell";

interface StorageTabPanelProps {
  storage: StorageTabData;
}

const summaryToneColor: Record<
  StorageTabData["summaries"][number]["tone"],
  string
> = {
  blue: "var(--accent-blue)",
  green: "var(--accent-green)",
  purple: "var(--accent-purple)",
  amber: "var(--accent-yellow)",
  cyan: "var(--accent-cyan)",
};

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        minHeight: 172,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        textAlign: "center",
        color: "var(--text-muted)",
        border: "1px dashed var(--border)",
        borderRadius: 7,
        background: "var(--bg-input)",
        padding: 18,
      }}
    >
      <span
        style={{
          width: 42,
          height: 42,
          borderRadius: 10,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--accent-blue)",
          background: "rgba(59,130,246,0.1)",
        }}
      >
        {icon}
      </span>
      <div>
        <p
          style={{
            margin: 0,
            color: "var(--text-primary)",
            fontSize: 13,
            fontWeight: 800,
          }}
        >
          {title}
        </p>
        <p
          style={{
            marginTop: 5,
            maxWidth: 420,
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          {description}
        </p>
      </div>
    </div>
  );
}

export default function StorageTabPanel({ storage }: StorageTabPanelProps) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(190px, 100%), 1fr))",
          gap: 12,
        }}
      >
        {storage.summaries.map((summary) => (
          <div
            key={summary.label}
            className="card"
            style={{
              padding: 14,
              background: "var(--bg-card)",
              minHeight: 112,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {summary.label}
              </p>
              <HardDrive
                size={16}
                style={{ color: summaryToneColor[summary.tone] }}
              />
            </div>
            <div>
              <p
                style={{
                  margin: 0,
                  color: "var(--text-primary)",
                  fontSize: 22,
                  fontWeight: 800,
                }}
              >
                {summary.value}
              </p>
              <p
                style={{
                  marginTop: 5,
                  color: "var(--text-muted)",
                  fontSize: 11,
                }}
              >
                {summary.subvalue}
              </p>
            </div>
          </div>
        ))}
      </div>

      <PanelShell title="Volume Mounts">
        {storage.mounts.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Target</th>
                  <th>Type</th>
                  <th>Access</th>
                  <th>Driver</th>
                  <th>Mode</th>
                  <th>Propagation</th>
                </tr>
              </thead>
              <tbody>
                {storage.mounts.map((mount) => (
                  <tr key={mount.id}>
                    <td>
                      {mount.name}
                    </td>
                    <td style={{ fontFamily: "var(--font--code)" }}>
                      {mount.source}
                    </td>
                    <td style={{ fontFamily: "var(--font--code)" }}>
                      {mount.target}
                    </td>
                    <td>{mount.type}</td>
                    <td>{mount.access}</td>
                    <td>{mount.driver}</td>
                    <td>{mount.mode}</td>
                    <td>{mount.propagation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<HardDrive size={21} />}
            title={storage.inspectAvailable ? "No volume mounts detected" : "Mount data unavailable"}
            description={storage.inspectAvailable ? "Docker inspect reported no mounts for this container." : "Docker inspect has not returned mount data."}
          />
        )}
      </PanelShell>

      <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
        Backup records are not shown here. Manage them on the{" "}
        <Link href="/backups">Backups page</Link>.
      </p>
    </section>
  );
}
