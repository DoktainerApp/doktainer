import TablePagination from "@/components/TablePagination";
import { CheckCircle, Key, Loader2, Trash2, Users } from "lucide-react";
import type { UserInvitationRecord } from "@/lib/api";
import { getRoleMeta } from "@/app/users/components/user-role-config";
import {
  formatRelativeDate,
  getServerAccessSummary,
} from "@/app/users/components/user-utils";

interface PendingInvitesPanelProps {
  loading: boolean;
  items: UserInvitationRecord[];
  copiedInviteId: string | null;
  mutatingKey: string | null;
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startItem: number;
  endItem: number;
  emptyMessage: string;
  onPageChange: (page: number) => void;
  onCopyFreshInviteLink: (invitationId: string) => void | Promise<void>;
  onRevokeInvitation: (invitationId: string) => void | Promise<void>;
}

export default function PendingInvitesPanel({
  loading,
  items,
  copiedInviteId,
  mutatingKey,
  currentPage,
  totalPages,
  totalItems,
  startItem,
  endItem,
  emptyMessage,
  onPageChange,
  onCopyFreshInviteLink,
  onRevokeInvitation,
}: PendingInvitesPanelProps) {
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
        <Users size={14} style={{ color: "var(--text-secondary)" }} />
        <div>
          <p
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            Pending Invitations
          </p>
          <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Copy a fresh invite link or revoke an unused invitation.
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
          Loading invitations...
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
                <th>Invitee</th>
                <th>Role</th>
                <th>Server Access</th>
                <th>Expires</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((invitation) => {
                const role = getRoleMeta(invitation.role);
                const InvitationIcon = role.icon;
                const access = getServerAccessSummary({
                  role: invitation.role,
                  allServersAccess: invitation.allServersAccess,
                  names: invitation.servers.map((server) => server.name),
                });

                return (
                  <tr key={invitation.id}>
                    <td>
                      <div>
                        <p
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          {invitation.name}
                        </p>
                        <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {invitation.email}
                        </p>
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
                        <InvitationIcon size={10} /> {role.label}
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
                    <td
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        fontFamily: "JetBrains Mono, monospace",
                      }}
                    >
                      {formatRelativeDate(invitation.expiresAt)}
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
                          title="Copy fresh invite link"
                          onClick={() =>
                            void onCopyFreshInviteLink(invitation.id)
                          }
                          disabled={
                            mutatingKey === `invite-link:${invitation.id}`
                          }
                        >
                          {mutatingKey === `invite-link:${invitation.id}` ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : copiedInviteId === invitation.id ? (
                            <CheckCircle size={11} />
                          ) : (
                            <Key size={11} />
                          )}
                        </button>
                        <button
                          className="btn btn-danger"
                          style={{ padding: "5px 8px" }}
                          title="Revoke invitation"
                          onClick={() => void onRevokeInvitation(invitation.id)}
                          disabled={
                            mutatingKey === `revoke-invite:${invitation.id}`
                          }
                        >
                          {mutatingKey === `revoke-invite:${invitation.id}` ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Trash2 size={11} />
                          )}
                        </button>
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
            itemLabel="invitations"
            onPageChange={onPageChange}
          />
        </>
      )}
    </div>
  );
}
