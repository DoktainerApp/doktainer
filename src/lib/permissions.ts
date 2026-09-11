import type { UserRole } from "@/lib/api";

export const roleRank: Record<UserRole, number> = {
  VIEWER: 0,
  DEVELOPER: 1,
  OPERATOR: 2,
  SUPER_ADMIN: 3,
};

export function hasMinimumRole(role: string | undefined, minRole?: UserRole) {
  if (!minRole) return true;
  if (!role) return false;
  return roleRank[role as UserRole] >= roleRank[minRole];
}

export function formatRoleLabel(role: string | undefined) {
  if (!role) return "Authenticated User";
  return role
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

export const managementRouteAccess = {
  "/sessions": "OPERATOR",
  "/users": "OPERATOR",
  "/api-keys": "DEVELOPER",
  "/settings": "OPERATOR",
} as const satisfies Record<string, UserRole>;

type ManagementRoute = keyof typeof managementRouteAccess;

export function canAccessRoute(pathname: string, role: string | undefined) {
  const minRole = managementRouteAccess[pathname as ManagementRoute];
  return hasMinimumRole(role, minRole);
}
