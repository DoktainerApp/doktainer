import type { UserRole } from "@/lib/api";
import {
  Activity,
  Bell,
  Boxes,
  CloudBackup,
  FileText,
  FolderArchive,
  GitBranch,
  Globe,
  HardDrive,
  Key,
  LayoutDashboard,
  Lock,
  Network,
  Package,
  RotateCcw,
  Server,
  Settings,
  Shield,
  Terminal,
  Users,
} from "lucide-react";

export interface NavSection {
  label: string;
  items: NavItem[];
}

export interface NavItem {
  href: string;
  icon: React.ElementType;
  label: string;
  badge?: string | number;
  minRole?: UserRole;
  keywords?: string[];
}

export const navigation: NavSection[] = [
  {
    label: "OVERVIEW",
    items: [
      {
        href: "/",
        icon: LayoutDashboard,
        label: "Dashboard",
        keywords: ["home", "overview", "metrics", "monitoring"],
      },
      {
        href: "/projects",
        icon: FolderArchive,
        label: "Projects",
        keywords: ["projects", "organization", "teams"],
      },
      {
        href: "/activity",
        icon: Activity,
        label: "Activity Log",
        keywords: ["audit", "events", "history"],
      },
    ],
  },
  {
    label: "INFRASTRUCTURE",
    items: [
      {
        href: "/servers",
        icon: Server,
        label: "Servers",
        keywords: ["hosts", "vps", "instances", "ssh"],
      },
      {
        href: "/networks",
        icon: Network,
        label: "Networks",
        keywords: ["ports", "routing", "bridge"],
      },
    ],
  },
  {
    label: "DOMAIN & SSL",
    items: [
      {
        href: "/domains",
        icon: Globe,
        label: "Domains",
        keywords: ["dns", "nginx", "traefik", "caddy"],
      },
      {
        href: "/ssl",
        icon: Lock,
        label: "SSL Certificates",
        keywords: ["tls", "letsencrypt", "https", "certbot"],
      },
    ],
  },
  {
    label: "SECURITY",
    items: [
      {
        href: "/security",
        icon: Shield,
        label: "Security",
        keywords: ["hardening", "policy", "alerts"],
      },
      {
        href: "/firewall",
        icon: HardDrive,
        label: "Firewall (UFW)",
        keywords: ["ufw", "ports", "rules"],
      },
    ],
  },
  {
    label: "APPS STORE",
    items: [
      {
        href: "/apps",
        icon: Package,
        label: "App Installer",
        keywords: ["catalog", "templates", "deploy"],
      },
      {
        href: "/apps/installed",
        icon: Boxes,
        label: "Installed Apps",
        keywords: ["deployments", "services"],
      },
    ],
  },
  {
    label: "TOOLS",
    items: [
      {
        href: "/terminal",
        icon: Terminal,
        label: "Web Terminal",
        keywords: ["shell", "console", "ssh"],
      },
      {
        href: "/logs",
        icon: FileText,
        label: "Logs",
        keywords: ["audit", "events", "tail"],
      },
      {
        href: "/backups",
        icon: RotateCcw,
        label: "Backups",
        keywords: ["restore", "snapshots"],
      },
    ],
  },
  {
    label: "INTEGRATIONS",
    items: [
      {
        href: "/git",
        icon: GitBranch,
        label: "Git",
        keywords: ["git", "repository", "version control"],
      },
      {
        href: "/s3-storage",
        icon: CloudBackup,
        label: "S3 Storage",
        keywords: ["s3", "storage", "backups"],
      },
      {
        href: "/notifications",
        icon: Bell,
        label: "Notifications",
        keywords: ["notifications", "alerts", "integrations"],
      },
    ],
  },
  {
    label: "MANAGEMENT",
    items: [
      {
        href: "/users",
        icon: Users,
        label: "Users & RBAC",
        minRole: "OPERATOR",
        keywords: ["roles", "permissions", "team"],
      },
      {
        href: "/api-keys",
        icon: Key,
        label: "API Keys",
        minRole: "DEVELOPER",
        keywords: ["tokens", "access", "automation"],
      },
      {
        href: "/settings",
        icon: Settings,
        label: "Settings",
        minRole: "OPERATOR",
        keywords: ["preferences", "theme", "panel"],
      },
    ],
  },
];
