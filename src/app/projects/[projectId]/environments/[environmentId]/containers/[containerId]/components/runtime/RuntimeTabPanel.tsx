"use client";

import TablePagination from "@/components/TablePagination";
import { useTablePagination } from "@/lib/use-table-pagination";
import {
  Activity,
  Network,
} from "lucide-react";
import type { RuntimeTabData } from "../../types/app-detail-types";
import PanelShell from "../overview/PanelShell";
import RuntimeKeyValuePanel from "./RuntimeKeyValuePanel";

interface RuntimeTabPanelProps {
  runtime: RuntimeTabData;
}

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
            "repeat(auto-fit, minmax(min(360px, 100%), 1fr))",
          gap: 12,
          alignItems: "start",
        }}
      >
        <RuntimeKeyValuePanel
          title="Runtime Configuration"
          rows={[...runtime.configuration, { label: "Docker Health", value: runtime.healthStatus }]}
        />

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
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(0, 1fr)",
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
          {runtime.processes.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>No process data available. The container may be stopped or the process request may have failed.</p>
          ) : null}
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
      </div>
    </section>
  );
}
