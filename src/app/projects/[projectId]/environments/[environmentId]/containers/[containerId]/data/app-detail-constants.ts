import {
  ExternalLink,
  FolderOpen,
  History,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Terminal,
  Trash,
} from "lucide-react";
import type { AppAction, AppDetailTab } from "../types/app-detail-types";

export const appTabs: Array<{ id: AppDetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "deployments", label: "Deployments" },
  { id: "runtime", label: "Runtime" },
  { id: "logs", label: "Logs" },
  { id: "terminal", label: "Terminal" },
  { id: "environment", label: "Environment" },
  { id: "domains", label: "Domains" },
  { id: "storage", label: "Storage" },
  { id: "advanced", label: "Advanced" },
];

export const primaryActions: AppAction[] = [
  // { id: "deploy", label: "Deploy", icon: Rocket, tone: "primary" },
  { id: "start", label: "Start", icon: Play, tone: "ghost" },
  { id: "restart", label: "Restart", icon: RotateCcw, tone: "ghost" },
  { id: "stop", label: "Stop", icon: Square, tone: "danger" },
  {
    id: "edit",
    label: "Edit configuration",
    icon: Settings2,
    tone: "ghost",
  },
  {
    id: "redeploy",
    label: "Redeploy current revision",
    icon: RefreshCw,
    tone: "ghost",
  },
  {
    id: "rebuild",
    label: "Rebuild from source",
    icon: History,
    tone: "ghost",
  },
  { id: "files", label: "File Manager", icon: FolderOpen, tone: "ghost" },
  { id: "terminal", label: "Terminal", icon: Terminal, tone: "ghost" },
  { id: "open", label: "Open App", icon: ExternalLink, tone: "ghost" },
  { id: "remove", label: "Remove", icon: Trash, tone: "danger" },
];

export const headerActions: AppAction[] = [
  { id: "open", label: "Open", icon: ExternalLink, tone: "ghost" },
  // { id: "deploy", label: "Deploy", icon: Rocket, tone: "primary" },
  { id: "restart", label: "Restart", icon: RotateCcw, tone: "ghost" },
  { id: "stop", label: "Stop", icon: Square, tone: "danger" },
];
