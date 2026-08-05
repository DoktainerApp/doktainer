import SearchField from "@/components/SearchField";
import { Loader2, Plus, RefreshCw } from "lucide-react";

export type UsersTabKey = "active-users" | "pending-invites" | "archived-users";

interface UsersToolbarProps {
  activeTab: UsersTabKey;
  search: string;
  activeUsersCount: number;
  invitationsCount: number;
  archivedUsersCount: number;
  loading: boolean;
  refreshing: boolean;
  canInvite: boolean;
  onTabChange: (tab: UsersTabKey) => void;
  onSearchChange: (value: string) => void;
  onRefresh: () => void | Promise<void>;
  onInvite: () => void;
}

export default function UsersToolbar({
  activeTab,
  search,
  activeUsersCount,
  invitationsCount,
  archivedUsersCount,
  loading,
  refreshing,
  canInvite,
  onTabChange,
  onSearchChange,
  onRefresh,
  onInvite,
}: UsersToolbarProps) {
  const tabs: Array<{ key: UsersTabKey; label: string }> = [
    {
      key: "active-users",
      label: `Active Users (${activeUsersCount})`,
    },
    {
      key: "pending-invites",
      label: `Pending Invites (${invitationsCount})`,
    },
    {
      key: "archived-users",
      label: `Archived Users (${archivedUsersCount})`,
    },
  ];

  return (
    <div
      className="card ui-responsive-toolbar users-toolbar"
      style={{ padding: "12px 16px" }}
    >
      <SearchField
        placeholder="Search users, roles, emails, or servers..."
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        containerStyle={{ flex: "1 1 360px", minWidth: 240 }}
      />
      <select
        className="input users-toolbar-filter"
        aria-label="Filter user records"
        value={activeTab}
        onChange={(event) => onTabChange(event.target.value as UsersTabKey)}
        style={{ fontSize: 12 }}
      >
        {tabs.map((tab) => (
          <option key={tab.key} value={tab.key}>
            {tab.label}
          </option>
        ))}
      </select>
      <div className="ui-toolbar-actions">
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12 }}
          onClick={() => void onRefresh()}
          disabled={loading || refreshing}
        >
          {refreshing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          Refresh
        </button>
        {canInvite ? (
          <button
            className="btn btn-primary"
            style={{ fontSize: 12 }}
            onClick={onInvite}
          >
            <Plus size={12} /> Invite User
          </button>
        ) : null}
      </div>
    </div>
  );
}
