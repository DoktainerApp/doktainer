"use client";

import TablePagination from "@/components/TablePagination";
import { useTablePagination } from "@/lib/use-table-pagination";
import {
  Activity,
  CheckCircle2,
  Clock3,
  HardDrive,
  Network,
} from "lucide-react";
import type { RuntimeTabData } from "../../types/app-detail-types";
import PanelShell from "../overview/PanelShell";
import RuntimeKeyValuePanel from "./RuntimeKeyValuePanel";
import RuntimeSummaryCard from "./RuntimeSummaryCard";

interface RuntimeTabPanelProps {
  runtime: RuntimeTabData;
}

const eventToneColor: Record<RuntimeTabData["events"][number]["tone"], string> =
  {
    info: "var(--accent-blue)",
    success: "var(--accent-green)",
    warning: "var(--accent-yellow)",
  };

export default function RuntimeTabPanel({ runtime }: RuntimeTabPanelProps) {
  const processPagination = useTablePagination({
    items: runtime.processes,
    pageSize: 5,
    resetKey: runtime.processes.map((process) => process.pid).join("|"),
  });

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
        {runtime.summaries.map((summary) => (
          <RuntimeSummaryCard key={summary.label} item={summary} />
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(360px, 100%), 1fr))",
          gap: 12,
          alignItems: "start",
        }}
      >
        <RuntimeKeyValuePanel
          title="Runtime Configuration"
          rows={runtime.configuration}
        />

        <PanelShell title="Health Checks">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {runtime.healthChecks.map((check) => (
              <div
                key={check.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "9px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-input)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p
                    style={{
                      margin: 0,
                      color: "var(--text-primary)",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {check.name}
                  </p>
                  <p
                    style={{
                      marginTop: 3,
                      color: "var(--text-muted)",
                      fontSize: 11,
                    }}
                  >
                    Every {check.interval} - Last run {check.lastRun}
                  </p>
                </div>
                <span className="ui-badge badge-online">
                  <CheckCircle2 size={12} />
                  {check.status}
                </span>
              </div>
            ))}
          </div>
        </PanelShell>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(360px, 100%), 1fr))",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title="Port Bindings">
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th>Container Port</th>
                  <th>Public Endpoint</th>
                  <th>Protocol</th>
                  <th>Mode</th>
                </tr>
              </thead>
              <tbody>
                {runtime.ports.map((port, index) => (
                  <tr
                    key={`${port.containerPort}-${port.publicEndpoint}-${index}`}
                  >
                    <td style={{ fontFamily: "var(--font--code)" }}>
                      {port.containerPort}
                    </td>
                    <td style={{ fontFamily: "var(--font--code)" }}>
                      <Network size={13} />
                      {port.publicEndpoint}
                    </td>
                    <td>{port.protocol}</td>
                    <td>{port.mode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelShell>

        <PanelShell title="Volume Mounts">
          {runtime.mounts.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Target</th>
                    <th>Type</th>
                    <th>Access</th>
                  </tr>
                </thead>
                <tbody>
                  {runtime.mounts.map((mount, index) => (
                    <tr key={`${mount.source}-${mount.target}-${index}`}>
                      <td style={{ fontFamily: "var(--font--code)" }}>
                        <HardDrive size={13} />
                        {mount.source}
                      </td>
                      <td style={{ fontFamily: "var(--font--code)" }}>
                        {mount.target}
                      </td>
                      <td>{mount.type}</td>
                      <td>{mount.access}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div
              style={{
                minHeight: 210,
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
                <HardDrive size={21} />
              </span>
              <div>
                <p
                  style={{
                    margin: 0,
                    color: "var(--text-primary)",
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  No volume mounts detected
                </p>
                <p style={{ marginTop: 4, fontSize: 12 }}>
                  This container is not using persistent volumes or bind mounts.
                </p>
              </div>
            </div>
          )}
        </PanelShell>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(min(620px, 100%), 1.35fr) minmax(min(320px, 100%), 0.65fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title={`Processes (${runtime.processes.length})`}>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 620 }}>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>User</th>
                  <th>Command</th>
                  <th>CPU</th>
                  <th>Memory</th>
                </tr>
              </thead>
              <tbody>
                {processPagination.paginatedItems.map((process, index) => (
                  <tr key={`${process.pid}-${process.command}-${index}`}>
                    <td style={{ fontFamily: "var(--font--code)" }}>
                      {process.pid}
                    </td>
                    <td>{process.user}</td>
                    <td style={{ fontFamily: "var(--font--code)" }}>
                      <Activity size={13} />
                      {process.command}
                    </td>
                    <td>{process.cpu}</td>
                    <td>{process.memory}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination
            currentPage={processPagination.currentPage}
            totalPages={processPagination.totalPages}
            totalItems={processPagination.totalItems}
            startItem={processPagination.startItem}
            endItem={processPagination.endItem}
            itemLabel="processes"
            onPageChange={processPagination.setCurrentPage}
          />
        </PanelShell>

        <PanelShell title="Runtime Events">
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {runtime.events.map((event) => (
              <div
                key={`${event.time}-${event.message}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0, 1fr)",
                  gap: 8,
                  alignItems: "start",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    color: eventToneColor[event.tone],
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontFamily: "var(--font--code)",
                  }}
                >
                  <Clock3 size={12} />
                  {event.time}
                </span>
                <span style={{ color: "var(--text-secondary)" }}>
                  {event.message}
                </span>
              </div>
            ))}
          </div>
        </PanelShell>
      </div>
    </section>
  );
}
