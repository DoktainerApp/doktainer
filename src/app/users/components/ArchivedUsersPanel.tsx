import TablePagination from "@/components/TablePagination";
import { Clock, Lock } from "lucide-react";
import type { UserRecord } from "@/lib/api";
import { getRoleMeta } from "@/app/users/components/user-role-config";
import {
  formatRelativeDate,
  getInitials,
  getServerAccessSummary,
} from "@/app/users/components/user-utils";

interface ArchivedUsersPanelProps {
  loading: boolean;
  items: UserRecord[];
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startItem: number;
  endItem: number;
  emptyMessage: string;
  onPageChange: (page: number) => void;
}

export default function ArchivedUsersPanel({
  loading,
  items,
  currentPage,
  totalPages,
  totalItems,
  startItem,
  endItem,
  emptyMessage,
  onPageChange,
}: ArchivedUsersPanelProps) {
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Lock size={14} style={{ color: "var(--text-secondary)" }} />
        <div>
          <p
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            Archived / Inactive Users
          </p>
          <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Legacy accounts that were previously deactivated remain visible here
            for reference.
          </p>
        </div>
      </div>
      {loading ? (
        <div
          style={{
            padding: 28,
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 13,
          }}
        >
          Loading archived users...
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            padding: 28,
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 13,
          }}
        >
          {emptyMessage}
        </div>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Server Access</th>
                <th>Status</th>
                <th>Last Login</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const role = getRoleMeta(item.role);
                const RoleIcon = role.icon;
                const access = getServerAccessSummary({
                  role: item.role,
                  allServersAccess: item.allServersAccess,
                  names: item.serverAssignments.map(
                    (assignment) => assignment.server.name,
                  ),
                });

                return (
                  <tr key={item.id}>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 8,
                            background:
                              "linear-gradient(135deg, rgba(100,116,139,0.9), rgba(71,85,105,0.9))",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 13,
                            fontWeight: 700,
                            color: "white",
                          }}
                        >
                          {getInitials(item.name)}
                        </div>
                        <div>
                          <p
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "var(--text-primary)",
                            }}
                          >
                            {item.name}
                          </p>
                          <p
                            style={{ fontSize: 11, color: "var(--text-muted)" }}
                          >
                            {item.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          background: `${role.color}15`,
                          color: role.color,
                          border: `1px solid ${role.color}25`,
                          padding: "3px 10px",
                          borderRadius: 6,
                          fontSize: 11,
                          fontWeight: 600,
                        }}
                      >
                        <RoleIcon size={10} /> {role.label}
                      </span>
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: 10,
                          background: access.tone,
                          color: access.color,
                          border: `1px solid ${access.border}`,
                          padding: "2px 7px",
                          borderRadius: 4,
                        }}
                      >
                        {access.label}
                      </span>
                    </td>
                    <td>
                      <span
                        style={{
                          background: "rgba(100,116,139,0.1)",
                          color: "#64748b",
                          border: "1px solid rgba(100,116,139,0.3)",
                          padding: "2px 9px",
                          borderRadius: 6,
                          fontSize: 11,
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        inactive
                      </span>
                    </td>
                    <td
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        fontFamily: "JetBrains Mono, monospace",
                      }}
                    >
                      <Clock
                        size={10}
                        style={{
                          display: "inline",
                          marginRight: 4,
                          verticalAlign: "middle",
                        }}
                      />
                      {formatRelativeDate(item.lastLogin)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <TablePagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            startItem={startItem}
            endItem={endItem}
            itemLabel="archived users"
            onPageChange={onPageChange}
          />
        </>
      )}
    </div>
  );
}
