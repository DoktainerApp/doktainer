"use client";

import type { ServerConfigSnapshot } from "@/lib/api";
import {
  ServerUserCard,
  UserBadge,
} from "@/app/servers/components/server-config/ServerConfigPrimitives";

interface ServerConfigUsersPanelProps {
  snapshot: ServerConfigSnapshot;
  snapshotLoadError?: string | null;
}

export default function ServerConfigUsersPanel({
  snapshot,
  snapshotLoadError,
}: ServerConfigUsersPanelProps) {
  const users = [
    ...(snapshot.rootUser ? [snapshot.rootUser] : []),
    ...snapshot.nonRootUsers,
  ];

  return (
    <div
      style={{ display: "grid", gap: 16 }}
      hidden={snapshotLoadError != null}
    >
      <div className="card" style={{ padding: 18 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
              User Inventory
            </strong>
            <p
              style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 13 }}
            >
              Showing root and non-root accounts together with their detected
              groups.
            </p>
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <UserBadge
              label={`${snapshot.hasRootUser ? 1 : 0} root`}
              tone="danger"
            />
            <UserBadge
              label={`${snapshot.nonRootUsers.length} non-root`}
              tone="info"
            />
          </div>
        </div>
      </div>
      {users.length > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fill, minmax(min(380px, 100%), 1fr))",
            gap: 16,
          }}
        >
          {users.map((user) => (
            <ServerUserCard key={user.username} user={user} />
          ))}
        </div>
      ) : (
        <div
          className="card"
          style={{ padding: 20, color: "var(--text-muted)", fontSize: 13 }}
        >
          {snapshotLoadError
            ? "User inventory could not be fetched because the live server snapshot is unavailable."
            : "No users were included in the current snapshot."}
        </div>
      )}
    </div>
  );
}
