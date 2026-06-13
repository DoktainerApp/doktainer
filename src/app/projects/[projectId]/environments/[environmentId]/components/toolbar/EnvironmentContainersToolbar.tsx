import SearchField from "@/components/SearchField";
import {
  Box,
  ChevronDown,
  CloudSyncIcon,
  Database,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface EnvironmentContainersToolbarProps {
  search: string;
  statusFilter: string;
  syncing: boolean;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onSync: () => void | Promise<void>;
  onDeployContainer: () => void;
  onDeployDatabase: () => void;
  onImportFromSync: () => void;
}

export default function EnvironmentContainersToolbar({
  search,
  statusFilter,
  syncing,
  onSearchChange,
  onStatusFilterChange,
  onSync,
  onDeployContainer,
  onDeployDatabase,
  onImportFromSync,
}: EnvironmentContainersToolbarProps) {
  const [deployMenuOpen, setDeployMenuOpen] = useState(false);
  const deployMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!deployMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        deployMenuRef.current &&
        !deployMenuRef.current.contains(event.target as Node)
      ) {
        setDeployMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [deployMenuOpen]);

  const handleDeployContainer = () => {
    setDeployMenuOpen(false);
    onDeployContainer();
  };

  const handleDeployDatabase = () => {
    setDeployMenuOpen(false);
    onDeployDatabase();
  };

  const handleImportFromSync = () => {
    setDeployMenuOpen(false);
    onImportFromSync();
  };

  return (
    <section
      className="card ui-responsive-toolbar"
      style={{ padding: "12px 16px" }}
    >
      <SearchField
        placeholder="Search apps or images..."
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        containerStyle={{ flex: "1 1 320px", minWidth: 220 }}
      />
      <select
        className="input"
        value={statusFilter}
        onChange={(event) => onStatusFilterChange(event.target.value)}
        style={{
          cursor: "pointer",
          width: 134,
          maxWidth: "100%",
          flex: "0 0 auto",
        }}
      >
        <option value="ALL">All Status</option>
        <option value="RUNNING">Running</option>
        <option value="STOPPED">Stopped</option>
        <option value="STARTING">Starting</option>
        <option value="ERROR">Error</option>
      </select>
      <div className="ui-toolbar-actions">
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 12 }}
          onClick={() => void onSync()}
          disabled={syncing}
        >
          {syncing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          Sync
        </button>
        <div
          ref={deployMenuRef}
          style={{ position: "relative", display: "inline-flex" }}
        >
          <button
            type="button"
            className="btn btn-primary"
            style={{ fontSize: 12 }}
            onClick={() => setDeployMenuOpen((open) => !open)}
            aria-expanded={deployMenuOpen}
            aria-haspopup="menu"
          >
            <Plus size={12} />
            Deploy App
            <ChevronDown size={13} />
          </button>
          {deployMenuOpen ? (
            <div
              role="menu"
              className="card"
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 8px)",
                zIndex: 2300,
                width: 180,
                padding: 6,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                boxShadow: "0 18px 40px rgba(2, 6, 23, 0.22)",
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="btn btn-ghost"
                onClick={handleDeployContainer}
                style={{
                  justifyContent: "flex-start",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <Box size={14} style={{ color: "var(--accent-blue)" }} />
                Deploy Container
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn btn-ghost"
                onClick={handleDeployDatabase}
                style={{
                  justifyContent: "flex-start",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <Database size={14} style={{ color: "var(--accent-green)" }} />
                Deploy Database
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn btn-ghost"
                onClick={handleImportFromSync}
                style={{
                  justifyContent: "flex-start",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <CloudSyncIcon
                  size={14}
                  style={{ color: "var(--accent-red)" }}
                />
                Import from Sync
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
