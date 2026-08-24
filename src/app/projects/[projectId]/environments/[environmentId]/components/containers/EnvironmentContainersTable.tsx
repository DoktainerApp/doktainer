import Link from "next/link";
import TablePagination from "@/components/TablePagination";
import { Container as ContainerIcon } from "lucide-react";
import type { EnvironmentContainer } from "../../types/environment-container-types";
import EnvironmentStatusBadge from "./EnvironmentStatusBadge";

interface EnvironmentContainersTableProps {
  projectId: string;
  environmentId: string;
  loading: boolean;
  containers: EnvironmentContainer[];
  paginatedContainers: EnvironmentContainer[];
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startItem: number;
  endItem: number;
  onPageChange: (page: number) => void;
}

export default function EnvironmentContainersTable({
  projectId,
  environmentId,
  loading,
  containers,
  paginatedContainers,
  currentPage,
  totalPages,
  totalItems,
  startItem,
  endItem,
  onPageChange,
}: EnvironmentContainersTableProps) {
  if (loading) {
    return (
      <section
        className="card"
        style={{
          padding: 48,
          textAlign: "center",
          color: "var(--text-muted)",
        }}
      >
        <p>Loading environment containers...</p>
      </section>
    );
  }

  if (containers.length === 0) {
    return (
      <section
        className="card"
        style={{
          padding: 40,
          textAlign: "center",
          color: "var(--text-muted)",
        }}
      >
        <ContainerIcon
          size={34}
          style={{ margin: "0 auto 12px", opacity: 0.5 }}
        />
        <p>No apps or containers match this filter.</p>
      </section>
    );
  }

  return (
    <section className="card" style={{ overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ minWidth: 920 }}>
          <thead>
            <tr>
              <th>App / Container</th>
              <th>Source</th>
              <th>Status</th>
              <th>Endpoint</th>
              {/* <th>Runtime</th> */}
              <th>Last Deploy</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedContainers.map((container) => (
              <tr key={container.id}>
                <td>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 8,
                        background: "var(--bg-input)",
                        border: "1px solid var(--border)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <ContainerIcon
                        size={14}
                        style={{ color: "var(--accent-blue)" }}
                      />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <Link
                        href={`/projects/${projectId}/environments/${environmentId}/containers/${container.id}`}
                        style={{
                          color: "var(--text-primary)",
                          fontWeight: 700,
                          fontSize: 13,
                          textDecoration: "none",
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {container.name}
                      </Link>
                      <p
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 11,
                          fontFamily: "var(--font--code)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 260,
                        }}
                      >
                        {container.image}
                      </p>
                    </div>
                  </div>
                </td>
                <td>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 5,
                    }}
                  >
                    <span style={{ fontSize: 12 }}>{container.source}</span>
                    <span
                      className={`ui-badge ${
                        container.managed ? "badge-online" : ""
                      }`}
                      title={
                        container.managed
                          ? "Deployment lifecycle is tracked by Doktainer."
                          : "Discovered from Docker; no Doktainer deployment history is available yet."
                      }
                    >
                      {container.managementLabel}
                    </span>
                  </div>
                </td>
                <td>
                  <EnvironmentStatusBadge status={container.status} />
                </td>
                <td>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 12,
                        fontFamily: "var(--font--code)",
                      }}
                    >
                      {container.domain}
                    </span>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {container.ports.length > 0 ? (
                        container.ports.map((port) => (
                          <span
                            key={`${container.id}-${port}`}
                            style={{
                              color: "var(--accent-blue)",
                              background: "var(--accent-blue-glow)",
                              borderRadius: 4,
                              padding: "1px 6px",
                              fontSize: 10,
                              fontFamily: "var(--font--code)",
                            }}
                          >
                            {port}
                          </span>
                        ))
                      ) : (
                        <span
                          style={{ color: "var(--text-muted)", fontSize: 11 }}
                        >
                          internal only
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                {/* <td>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <span style={{ fontSize: 12 }}>CPU {container.cpu}</span>
                    <span style={{ fontSize: 12 }}>RAM {container.memory}</span>
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                      Uptime {container.uptime}
                    </span>
                  </div>
                </td> */}
                <td style={{ fontSize: 12 }}>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 3 }}
                  >
                    <span>{container.lastDeployed}</span>
                    <span
                      style={{
                        color: container.deploymentInProgress
                          ? "var(--accent-blue)"
                          : "var(--text-muted)",
                        fontFamily: "var(--font--code)",
                        fontSize: 10,
                      }}
                    >
                      {container.deploymentInProgress
                        ? "Deployment in progress"
                        : container.revision}
                    </span>
                    {container.rollbackAvailable ? (
                      <span
                        style={{ color: "var(--accent-green)", fontSize: 10 }}
                      >
                        Rollback available
                      </span>
                    ) : null}
                    {container.lastDeploymentError ? (
                      <span
                        title={container.lastDeploymentError}
                        style={{
                          color: "var(--accent-red)",
                          fontSize: 10,
                          maxWidth: 220,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Last deployment failed
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      alignItems: "center",
                    }}
                  >
                    <Link
                      href={`/projects/${projectId}/environments/${environmentId}/containers/${container.id}`}
                      className="btn btn-primary"
                      style={{
                        padding: "5px 9px",
                        fontSize: 11,
                        textDecoration: "none",
                      }}
                    >
                      <ContainerIcon size={12} />
                      Manage
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={totalItems}
        startItem={startItem}
        endItem={endItem}
        itemLabel="containers"
        onPageChange={onPageChange}
      />
    </section>
  );
}
