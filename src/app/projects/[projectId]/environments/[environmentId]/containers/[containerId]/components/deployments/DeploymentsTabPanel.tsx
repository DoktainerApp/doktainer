"use client";

import TablePagination from "@/components/TablePagination";
import { useTablePagination } from "@/lib/use-table-pagination";
import { useMemo, useState } from "react";
import { Eye, GitBranch, GitCommit, Loader2, RotateCcw } from "lucide-react";
import type {
  DeploymentHistoryItem,
  DeploymentTabData,
} from "../../types/app-detail-types";
import PanelShell from "../overview/PanelShell";
import DeploymentSummaryCard from "./DeploymentSummaryCard";

interface DeploymentsTabPanelProps {
  deployments: DeploymentTabData;
  onRollback: (deploymentId: string) => void;
  onViewDetails: (deploymentId: string) => void;
  rollingBackId?: string | null;
}

const statusClass: Record<DeploymentHistoryItem["status"], string> = {
  Success: "badge-online",
  Failed: "badge-danger",
  Running: "badge-warning",
  "Rolled Back": "badge-warning",
};

export default function DeploymentsTabPanel({
  deployments,
  onRollback,
  onViewDetails,
  rollingBackId = null,
}: DeploymentsTabPanelProps) {
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | DeploymentHistoryItem["status"]
  >("ALL");
  const [triggerFilter, setTriggerFilter] = useState("ALL");
  const filteredHistory = useMemo(
    () =>
      deployments.history.filter(
        (item) =>
          (statusFilter === "ALL" || item.status === statusFilter) &&
          (triggerFilter === "ALL" || item.trigger === triggerFilter),
      ),
    [deployments.history, statusFilter, triggerFilter],
  );
  const pagination = useTablePagination({
    items: filteredHistory,
    pageSize: 5,
    resetKey: `${statusFilter}:${triggerFilter}:${filteredHistory.map((item) => item.id).join("|")}`,
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
        {deployments.summaries.map((summary) => (
          <DeploymentSummaryCard key={summary.label} item={summary} />
        ))}
      </div>

      <PanelShell title={`Deployment History (${filteredHistory.length})`}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "flex-start",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <label
            style={{
              display: "grid",
              gap: 4,
              minWidth: 160,
              flex: "0 1 190px",
              color: "var(--text-muted)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            <select
              className="input"
              style={{ width: "100%", minHeight: 36, fontSize: 12 }}
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as typeof statusFilter)
              }
              aria-label="Filter deployments by status"
            >
              <option value="ALL">All statuses</option>
              <option value="Success">Success</option>
              <option value="Failed">Failed</option>
              <option value="Running">Running</option>
              <option value="Rolled Back">Rolled Back</option>
            </select>
          </label>

          <label
            style={{
              display: "grid",
              gap: 4,
              minWidth: 160,
              flex: "0 1 190px",
              color: "var(--text-muted)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            <select
              className="input"
              style={{ width: "100%", minHeight: 36, fontSize: 12 }}
              value={triggerFilter}
              onChange={(event) => setTriggerFilter(event.target.value)}
              aria-label="Filter deployments by trigger"
            >
              <option value="ALL">All triggers</option>
              {[
                ...new Set(deployments.history.map((item) => item.trigger)),
              ].map((trigger) => (
                <option key={trigger} value={trigger}>
                  {trigger}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Commit</th>
                <th>Branch</th>
                <th>Duration</th>
                <th>Deployed At</th>
                <th style={{ textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {pagination.paginatedItems.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      padding: 24,
                      textAlign: "center",
                      color: "var(--text-muted)",
                    }}
                  >
                    {deployments.history.length === 0
                      ? "No deployment history yet."
                      : "No deployments match the selected filters."}
                  </td>
                </tr>
              ) : (
                pagination.paginatedItems.map((deployment) => (
                  <tr key={deployment.id}>
                    <td
                      style={{
                        maxWidth: 220,
                        fontFamily: "var(--font--code)",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                      }}
                      title={deployment.version}
                    >
                      {deployment.version}
                    </td>
                    <td>
                      <span
                        className={`ui-badge ${statusClass[deployment.status]}`}
                      >
                        {deployment.status}
                      </span>
                    </td>
                    <td>{deployment.trigger}</td>
                    <td style={{ fontFamily: "var(--font--code)" }}>
                      <GitCommit size={13} />
                      {deployment.commit}
                    </td>
                    <td>
                      <GitBranch size={13} />
                      {deployment.branch}
                    </td>
                    <td>{deployment.duration}</td>
                    <td>{deployment.deployedAt}</td>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <button
                          type="button"
                          className="btn btn-ghost btn-small"
                          onClick={() => onViewDetails(deployment.id)}
                          title="View deployment details"
                          aria-label={`View details for deployment ${deployment.version}`}
                          style={{ padding: "6px 8px", minWidth: 30 }}
                        >
                          <Eye size={13} />
                        </button>
                        {deployment.canRollback ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-small"
                            onClick={() => onRollback(deployment.id)}
                            disabled={rollingBackId !== null}
                            title="Rollback to this deployment"
                            aria-label={`Rollback to deployment ${deployment.version}`}
                            style={{ padding: "6px 8px", minWidth: 30 }}
                          >
                            {rollingBackId === deployment.id ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <RotateCcw size={13} />
                            )}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          totalItems={pagination.totalItems}
          startItem={pagination.startItem}
          endItem={pagination.endItem}
          itemLabel="deployments"
          onPageChange={pagination.setCurrentPage}
        />
      </PanelShell>
    </section>
  );
}
