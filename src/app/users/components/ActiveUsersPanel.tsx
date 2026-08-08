import TablePagination from "@/components/TablePagination";
import { Clock, Edit3, Loader2, Lock, Trash2 } from "lucide-react";
import type { UserRecord } from "@/lib/api";
import { getRoleMeta } from "@/app/users/components/user-role-config";
import {
  formatRelativeDate,
  getInitials,
  getServerAccessSummary,
} from "@/app/users/components/user-utils";

interface ActiveUsersPanelProps {
  loading: boolean;
  items: UserRecord[];
  currentUserId: string | undefined;
  canManageUsers: boolean;
  mutatingKey: string | null;
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startItem: number;
  endItem: number;
  emptyMessage: string;
  onPageChange: (page: number) => void;
  onEdit: (user: UserRecord) => void;
  onDelete: (user: UserRecord) => void | Promise<void>;
}

export default function ActiveUsersPanel({
  loading,
  items,
  currentUserId,
  canManageUsers,
  mutatingKey,
  currentPage,
  totalPages,
  totalItems,
  startItem,
  endItem,
  emptyMessage,
  onPageChange,
  onEdit,
  onDelete,
}: ActiveUsersPanelProps) {
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      {loading ? (
        <div
          style={{
            padding: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            color: "var(--text-muted)",
            fontSize: 13,
          }}
        >
          <Loader2 size={16} className="animate-spin" />
          Loading users...
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            padding: 32,
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
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const role = getRoleMeta(item.role);
                const RoleIcon = role.icon;
                const isSelf = currentUserId === item.id;
                const access = getServerAccessSummary({
                  role: item.role,
                  allServersAccess: item.allServersAccess,
                  names: item.serverAssignments.map(
                    (assignment) => assignment.server.name,
                  ),
                });
                const canEdit = canManageUsers && item.role !== "SUPER_ADMIN";
                const canDeactivate =
                  canManageUsers && item.role !== "SUPER_ADMIN" && !isSelf;

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
                              "linear-gradient(135deg, #3b82f6, #8b5cf6)",
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
                          background: item.isActive
                            ? "rgba(16,185,129,0.1)"
                            : "rgba(100,116,139,0.1)",
                          color: item.isActive ? "#10b981" : "#64748b",
                          border: `1px solid ${item.isActive ? "rgba(16,185,129,0.3)" : "rgba(100,116,139,0.3)"}`,
                          padding: "2px 9px",
                          borderRadius: 6,
                          fontSize: 11,
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        {item.isActive ? (
                          <span
                            className="animate-pulse-dot"
                            style={{
                              display: "inline-block",
                              width: 5,
                              height: 5,
                              borderRadius: "50%",
                              background: "currentColor",
                            }}
                          />
                        ) : null}
                        {item.isActive ? "active" : "inactive"}
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
                    <td>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          gap: 5,
                        }}
                      >
                        <button
                          className="btn btn-ghost"
                          style={{ padding: "5px 8px" }}
                          title={canEdit ? "Edit user" : "Protected Super Admin account"}
                          onClick={() => onEdit(item)}
                          disabled={
                            !canEdit || mutatingKey === `edit:${item.id}`
                          }
                        >
                          {mutatingKey === `edit:${item.id}` ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Edit3 size={11} />
                          )}
                        </button>
                        {canDeactivate ? (
                          <button
                            className="btn btn-danger"
                            style={{ padding: "5px 8px" }}
                            title="Delete user"
                            onClick={() => void onDelete(item)}
                            disabled={mutatingKey === `delete:${item.id}`}
                          >
                            {mutatingKey === `delete:${item.id}` ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <Trash2 size={11} />
                            )}
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost"
                            style={{
                              padding: "5px 8px",
                              opacity: 0.7,
                              cursor: "default",
                            }}
                            title={
                              item.role === "SUPER_ADMIN"
                                ? "Protected Super Admin account"
                                : isSelf
                                  ? "Current user"
                                  : "Locked action"
                            }
                            disabled
                          >
                            <Lock size={11} />
                          </button>
                        )}
                      </div>
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
            itemLabel="users"
            onPageChange={onPageChange}
          />
        </>
      )}
    </div>
  );
}
