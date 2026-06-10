"use client";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import GuardedPage from "@/components/GuardedPage";
import IssueDetailsSummary from "@/components/IssueDetailsSummary";
import ToastViewport from "@/components/ToastViewport";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CreateUserInvitationBody,
  Server as ServerRecord,
  UserInvitationRecord,
  UserRecord,
  UserRole,
  users as usersApi,
  servers as serversApi,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-state";
import { useTablePagination } from "@/lib/use-table-pagination";
import { useToastManager } from "@/lib/use-toast-manager";
import ActiveUsersPanel from "@/app/users/components/ActiveUsersPanel";
import ArchivedUsersPanel from "@/app/users/components/ArchivedUsersPanel";
import EditRoleModal from "@/app/users/components/EditRoleModal";
import InviteUserModal from "@/app/users/components/InviteUserModal";
import PendingInvitesPanel from "@/app/users/components/PendingInvitesPanel";
import ServerAccessModal from "@/app/users/components/ServerAccessModal";
import UsersRoleSummary from "@/app/users/components/UsersRoleSummary";
import UsersToolbar, {
  type UsersTabKey,
} from "@/app/users/components/UsersToolbar";
import { roles } from "@/app/users/components/user-role-config";
import { copyText } from "@/app/users/components/user-utils";

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

export default function UsersPage() {
  const currentUser = useCurrentUser();
  const { toasts, pushToast, dismissToast } = useToastManager();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [invitations, setInvitations] = useState<UserInvitationRecord[]>([]);
  const [availableServers, setAvailableServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<UsersTabKey>("active-users");
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteResult, setInviteResult] = useState<{
    inviteUrl: string;
    email: string;
    expiresAt: string;
  } | null>(null);
  const [editingRoleUser, setEditingRoleUser] = useState<UserRecord | null>(
    null,
  );
  const [editingAccessUser, setEditingAccessUser] = useState<UserRecord | null>(
    null,
  );
  const [modalError, setModalError] = useState("");
  const [mutatingKey, setMutatingKey] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);

  const canInvite =
    currentUser?.role === "SUPER_ADMIN" || currentUser?.role === "OPERATOR";
  const canViewUsers = canInvite;
  const canManageAccess = canInvite;
  const canManageRoles = currentUser?.role === "SUPER_ADMIN";
  const activeUsers = useMemo(
    () => users.filter((user) => user.isActive),
    [users],
  );
  const archivedUsers = useMemo(
    () => users.filter((user) => !user.isActive),
    [users],
  );
  const usersPagination = useTablePagination({
    items: activeUsers,
    resetKey: `${activeUsers.length}|${activeTab}`,
  });
  const invitationsPagination = useTablePagination({
    items: invitations,
    resetKey: `${invitations.length}|${activeTab}`,
  });
  const archivedUsersPagination = useTablePagination({
    items: archivedUsers,
    resetKey: `${archivedUsers.length}|${activeTab}`,
  });

  const loadData = useCallback(
    async (showLoader = true) => {
      if (!canViewUsers) {
        setLoading(false);
        setRefreshing(false);
        return false;
      }

      if (showLoader) setLoading(true);
      else setRefreshing(true);

      try {
        setError("");
        const [usersResponse, invitationsResponse, serversResponse] =
          await Promise.all([
            usersApi.list(),
            usersApi.listInvitations(),
            serversApi.list(),
          ]);
        setUsers(usersResponse.data ?? []);
        setInvitations(invitationsResponse.data ?? []);
        setAvailableServers(serversResponse.data ?? []);
        return true;
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : "Failed to load user data",
        );
        return false;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [canViewUsers],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const roleCounts = useMemo(
    () =>
      roles.reduce<Record<UserRole, number>>(
        (accumulator, role) => {
          accumulator[role.id] = activeUsers.filter(
            (user) => user.role === role.id,
          ).length;
          return accumulator;
        },
        { SUPER_ADMIN: 0, OPERATOR: 0, DEVELOPER: 0, VIEWER: 0 },
      ),
    [activeUsers],
  );

  const handleRefresh = async () => {
    const ok = await loadData(false);
    pushToast({
      tone: ok ? "success" : "error",
      title: ok ? "Users Refreshed" : "Refresh Failed",
      message: ok
        ? "User and invitation data has been refreshed"
        : "Failed to refresh user data",
    });
  };

  const handleInvite = async (payload: CreateUserInvitationBody) => {
    setInviteError("");
    setMutatingKey("invite");
    try {
      const response = await usersApi.invite(payload);
      setInviteResult({
        inviteUrl: response.data.inviteUrl,
        email: response.data.email,
        expiresAt: response.data.expiresAt,
      });
      await loadData(false);
      pushToast({
        tone: "success",
        title: "Invitation Created",
        message: `Invite link generated for ${response.data.email}`,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to create invite";
      setInviteError(message);
      pushToast({
        tone: "error",
        title: "Invitation Failed",
        message,
      });
    } finally {
      setMutatingKey(null);
    }
  };

  const handleRoleUpdate = async (role: Exclude<UserRole, "SUPER_ADMIN">) => {
    if (!editingRoleUser) return;
    setModalError("");
    setMutatingKey(`role:${editingRoleUser.id}`);
    try {
      await usersApi.updateRole(editingRoleUser.id, role);
      const userName = editingRoleUser.name;
      setEditingRoleUser(null);
      await loadData(false);
      pushToast({
        tone: "success",
        title: "Role Updated",
        message: `${userName} role updated successfully`,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to update role";
      setModalError(message);
      pushToast({
        tone: "error",
        title: "Role Update Failed",
        message,
      });
    } finally {
      setMutatingKey(null);
    }
  };

  const handleAccessUpdate = async (payload: {
    allServersAccess: boolean;
    serverIds: string[];
  }) => {
    if (!editingAccessUser) return;
    setModalError("");
    setMutatingKey(`access:${editingAccessUser.id}`);
    try {
      await usersApi.updateServerAccess(editingAccessUser.id, payload);
      const userName = editingAccessUser.name;
      setEditingAccessUser(null);
      await loadData(false);
      pushToast({
        tone: "success",
        title: "Access Updated",
        message: `Server access updated for ${userName}`,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to update server access";
      setModalError(message);
      pushToast({
        tone: "error",
        title: "Access Update Failed",
        message,
      });
    } finally {
      setMutatingKey(null);
    }
  };

  const deleteUser = async (user: UserRecord) => {
    setError("");
    setMutatingKey(`delete:${user.id}`);
    try {
      await usersApi.remove(user.id);
      await loadData(false);
      pushToast({
        tone: "success",
        title: "User Deleted",
        message: `${user.email} has been deleted permanently`,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to delete user";
      setError(message);
      pushToast({
        tone: "error",
        title: "Delete Failed",
        message,
      });
    } finally {
      setMutatingKey(null);
    }
  };

  const handleDeleteUser = async (user: UserRecord) => {
    setConfirmDialog({
      title: "Delete User",
      description: `Delete user "${user.email}" permanently?`,
      confirmLabel: "Delete User",
      tone: "danger",
      note: "This permanently removes the user record and associated access assignments.",
      onConfirm: () => {
        void deleteUser(user);
      },
    });
  };

  const handleCopyFreshInviteLink = async (invitationId: string) => {
    setError("");
    setMutatingKey(`invite-link:${invitationId}`);
    try {
      const response = await usersApi.regenerateInvitation(invitationId);
      await copyText(response.data.inviteUrl);
      setCopiedInviteId(invitationId);
      window.setTimeout(() => setCopiedInviteId(null), 2000);
      await loadData(false);
      pushToast({
        tone: "success",
        title: "Invite Link Copied",
        message: "Fresh invitation link copied to clipboard",
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to refresh invite link";
      setError(message);
      pushToast({
        tone: "error",
        title: "Invite Link Failed",
        message,
      });
    } finally {
      setMutatingKey(null);
    }
  };

  const revokeInvitation = async (invitationId: string) => {
    setError("");
    setMutatingKey(`revoke-invite:${invitationId}`);
    try {
      await usersApi.revokeInvitation(invitationId);
      await loadData(false);
      pushToast({
        tone: "success",
        title: "Invitation Revoked",
        message: "Pending invitation removed successfully",
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to revoke invitation";
      setError(message);
      pushToast({
        tone: "error",
        title: "Revoke Failed",
        message,
      });
    } finally {
      setMutatingKey(null);
    }
  };

  const handleRevokeInvitation = async (invitationId: string) => {
    const invitation = invitations.find((item) => item.id === invitationId);
    setConfirmDialog({
      title: "Revoke Invitation",
      description: invitation
        ? `Revoke the pending invitation for "${invitation.email}"?`
        : "Revoke this pending invitation?",
      confirmLabel: "Revoke Invitation",
      tone: "warning",
      note: "The current invite link will stop working immediately.",
      onConfirm: () => {
        void revokeInvitation(invitationId);
      },
    });
  };

  return (
    <GuardedPage
      route="/users"
      title="Users & RBAC"
      subtitle="Manage team members, onboarding, and server access control"
      redirectSubtitle="Redirecting to a page you can access"
      currentUser={currentUser}
    >
      <ConfirmActionDialog
        open={confirmDialog !== null}
        title={confirmDialog?.title ?? ""}
        description={confirmDialog?.description ?? ""}
        confirmLabel={confirmDialog?.confirmLabel ?? "Confirm"}
        tone={confirmDialog?.tone ?? "danger"}
        note={confirmDialog?.note}
        onClose={() => setConfirmDialog(null)}
        onConfirm={() => {
          const current = confirmDialog;
          setConfirmDialog(null);
          current?.onConfirm();
        }}
      />
      <ToastViewport toasts={toasts} onClose={dismissToast} />
      <div
        className="animate-slide-in"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {error && (
          <IssueDetailsSummary
            label="Users"
            message={error}
            description="User data could not be loaded or updated."
          />
        )}

        <UsersRoleSummary roleCounts={roleCounts} />

        <UsersToolbar
          activeTab={activeTab}
          activeUsersCount={activeUsers.length}
          invitationsCount={invitations.length}
          archivedUsersCount={archivedUsers.length}
          loading={loading}
          refreshing={refreshing}
          canInvite={canInvite}
          onTabChange={setActiveTab}
          onRefresh={handleRefresh}
          onInvite={() => {
            setInviteError("");
            setInviteResult(null);
            setShowInviteModal(true);
          }}
        />

        {activeTab === "active-users" ? (
          <ActiveUsersPanel
            loading={loading}
            items={usersPagination.paginatedItems}
            currentUserId={currentUser?.id}
            canManageAccess={canManageAccess}
            canManageRoles={canManageRoles}
            mutatingKey={mutatingKey}
            currentPage={usersPagination.currentPage}
            totalPages={usersPagination.totalPages}
            totalItems={usersPagination.totalItems}
            startItem={usersPagination.startItem}
            endItem={usersPagination.endItem}
            onPageChange={usersPagination.setCurrentPage}
            onEditAccess={(user) => {
              setModalError("");
              setEditingAccessUser(user);
            }}
            onEditRole={(user) => {
              setModalError("");
              setEditingRoleUser(user);
            }}
            onDelete={handleDeleteUser}
          />
        ) : null}

        {activeTab === "pending-invites" ? (
          <PendingInvitesPanel
            loading={loading}
            items={invitationsPagination.paginatedItems}
            copiedInviteId={copiedInviteId}
            mutatingKey={mutatingKey}
            currentPage={invitationsPagination.currentPage}
            totalPages={invitationsPagination.totalPages}
            totalItems={invitationsPagination.totalItems}
            startItem={invitationsPagination.startItem}
            endItem={invitationsPagination.endItem}
            onPageChange={invitationsPagination.setCurrentPage}
            onCopyFreshInviteLink={handleCopyFreshInviteLink}
            onRevokeInvitation={handleRevokeInvitation}
          />
        ) : null}

        {activeTab === "archived-users" ? (
          <ArchivedUsersPanel
            loading={loading}
            items={archivedUsersPagination.paginatedItems}
            currentPage={archivedUsersPagination.currentPage}
            totalPages={archivedUsersPagination.totalPages}
            totalItems={archivedUsersPagination.totalItems}
            startItem={archivedUsersPagination.startItem}
            endItem={archivedUsersPagination.endItem}
            onPageChange={archivedUsersPagination.setCurrentPage}
          />
        ) : null}
      </div>

      {showInviteModal && (
        <InviteUserModal
          availableServers={availableServers}
          onClose={() => {
            setShowInviteModal(false);
            setInviteError("");
            setInviteResult(null);
          }}
          onSubmit={handleInvite}
          onCopySuccess={() =>
            pushToast({
              tone: "success",
              title: "Invite Link Copied",
              message: "Invitation link copied to clipboard",
            })
          }
          submitting={mutatingKey === "invite"}
          error={inviteError}
          result={inviteResult}
        />
      )}
      {editingRoleUser && (
        <EditRoleModal
          key={editingRoleUser.id}
          user={editingRoleUser}
          onClose={() => {
            setEditingRoleUser(null);
            setModalError("");
          }}
          onSubmit={handleRoleUpdate}
          submitting={mutatingKey === `role:${editingRoleUser.id}`}
          error={modalError}
        />
      )}
      {editingAccessUser && (
        <ServerAccessModal
          key={editingAccessUser.id}
          user={editingAccessUser}
          availableServers={availableServers}
          onClose={() => {
            setEditingAccessUser(null);
            setModalError("");
          }}
          onSubmit={handleAccessUpdate}
          submitting={mutatingKey === `access:${editingAccessUser.id}`}
          error={modalError}
        />
      )}
    </GuardedPage>
  );
}
