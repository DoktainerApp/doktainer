"use client";

import TablePagination from "@/components/TablePagination";
import { useTablePagination } from "@/lib/use-table-pagination";
import {
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  GitBranch,
  GitCommit,
  Rocket,
  XCircle,
} from "lucide-react";
import type {
  DeploymentHistoryItem,
  DeploymentPipelineStep,
  DeploymentTabData,
} from "../../types/app-detail-types";
import PanelShell from "../overview/PanelShell";
import DeploymentSummaryCard from "./DeploymentSummaryCard";

interface DeploymentsTabPanelProps {
  deployments: DeploymentTabData;
}

const statusClass: Record<DeploymentHistoryItem["status"], string> = {
  Success: "badge-online",
  Failed: "badge-danger",
  Running: "badge-warning",
  "Rolled Back": "badge-warning",
};

function getStepIcon(status: DeploymentPipelineStep["status"]) {
  if (status === "success") return <CheckCircle2 size={15} />;
  if (status === "failed") return <XCircle size={15} />;
  if (status === "running") return <Clock3 size={15} />;
  return <Circle size={15} />;
}

function getStepColor(status: DeploymentPipelineStep["status"]) {
  if (status === "success") return "var(--accent-green)";
  if (status === "failed") return "var(--text-danger)";
  if (status === "running") return "var(--accent-blue)";
  return "var(--text-muted)";
}

export default function DeploymentsTabPanel({
  deployments,
}: DeploymentsTabPanelProps) {
  const pagination = useTablePagination({
    items: deployments.history,
    pageSize: 5,
    resetKey: deployments.history.map((item) => item.id).join("|"),
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

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(min(620px, 100%), 1fr) minmax(min(360px, 100%), 0.8fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell title="Latest Deployment">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr)",
              minHeight: "160px",
              maxHeight: "160px",
              gap: 12,
              alignItems: "start",
              padding: 12,
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-input)",
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
              <Rocket size={21} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    color: "var(--text-primary)",
                    fontSize: 16,
                  }}
                >
                  {deployments.latest.version}
                </h3>
                <span
                  className={`ui-badge ${statusClass[deployments.latest.status]}`}
                >
                  {deployments.latest.status}
                </span>
              </div>
              <p
                style={{
                  marginTop: 6,
                  color: "var(--text-muted)",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                Deployed by {deployments.latest.deployedBy} from{" "}
                {deployments.latest.source}. This panel reflects the current
                container deployment record and runtime inspection state.
              </p>
              <p
                style={{
                  marginTop: 8,
                  color: "var(--text-secondary)",
                  fontFamily: "var(--font--code)",
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {deployments.latest.image}
              </p>
            </div>
          </div>
        </PanelShell>

        <PanelShell title="Deployment Artifacts">
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
              gap: 8,
            }}
          >
            {deployments.artifacts.map((artifact) => (
              <div
                key={artifact.label}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-input)",
                  padding: "9px 10px",
                  minWidth: 0,
                }}
              >
                <p
                  style={{
                    margin: 0,
                    color: "var(--text-muted)",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {artifact.label}
                </p>
                <p
                  style={{
                    marginTop: 5,
                    color: "var(--text-primary)",
                    fontSize: 12,
                    fontFamily: "var(--font--code)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {artifact.value}
                </p>
                <p
                  style={{
                    marginTop: 3,
                    color: "var(--text-muted)",
                    fontSize: 10,
                  }}
                >
                  {artifact.meta}
                </p>
              </div>
            ))}
          </div>
        </PanelShell>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(min(620px, 100%), 1fr) minmax(min(360px, 100%), 0.8fr)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <PanelShell
          title={`Deployment History (${deployments.history.length})`}
        >
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Trigger</th>
                  <th>Commit</th>
                  <th>Branch</th>
                  <th>Duration</th>
                  <th>Deployed At</th>
                </tr>
              </thead>
              <tbody>
                {pagination.paginatedItems.map((deployment) => (
                  <tr key={deployment.id}>
                    <td style={{ fontFamily: "var(--font--code)" }}>
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
                  </tr>
                ))}
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

        <PanelShell title="Pipeline Timeline">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {deployments.pipeline.map((step) => (
              <div
                key={step.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "start",
                  padding: "9px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-input)",
                }}
              >
                <span
                  style={{
                    color: getStepColor(step.status),
                    display: "inline-flex",
                    marginTop: 1,
                  }}
                >
                  {getStepIcon(step.status)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <p
                    style={{
                      margin: 0,
                      color: "var(--text-primary)",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {step.label}
                  </p>
                  <p
                    style={{
                      marginTop: 3,
                      color: "var(--text-muted)",
                      fontSize: 11,
                      lineHeight: 1.45,
                    }}
                  >
                    {step.description}
                  </p>
                </div>
                <span
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 11,
                    fontFamily: "var(--font--code)",
                  }}
                >
                  {step.duration}
                </span>
              </div>
            ))}
          </div>
        </PanelShell>
      </div>
    </section>
  );
}
