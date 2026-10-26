"use client";

import { Database, Download, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { settingsApi } from "@/lib/api";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";

export default function DatabaseSettingsPanel({
  onError,
  onSuccess,
}: {
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState<"backup" | "restore" | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);

  const download = async () => {
    setLoading("backup");
    try {
      const result = await settingsApi.downloadDatabaseBackup();
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      onSuccess("Database backup downloaded");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Database backup failed");
    } finally {
      setLoading(null);
    }
  };

  const restore = async (file: File) => {
    setLoading("restore");
    try {
      await settingsApi.restoreDatabaseBackup(file);
      onSuccess("Database restore completed. Refresh the page to load restored data.");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Database restore failed");
    } finally {
      setLoading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const clearRestoreFile = () => {
    setRestoreFile(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <>
      <ConfirmActionDialog
        open={restoreFile !== null}
        title="Restore database?"
        description="The current database will be overwritten by the contents of the selected backup. This action cannot be undone."
        confirmLabel="Restore database"
        cancelLabel="Cancel"
        tone="danger"
        note="Ensure you have saved the latest backup before proceeding."
        icon={<Upload size={14} />}
        onClose={clearRestoreFile}
        onConfirm={() => {
          const file = restoreFile;
          setRestoreFile(null);
          if (file) void restore(file);
        }}
      />
      <section className="card" style={{ overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
        <Database size={18} style={{ color: "var(--accent-blue)", marginTop: 1 }} />
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Database backup and restore</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 5, lineHeight: 1.5 }}>
            Download a PostgreSQL backup, or restore the panel from a previous backup file.
          </p>
        </div>
      </div>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16, padding: 16, border: "1px solid var(--border)", borderRadius: 8 }}>
          <div><h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Create backup</h3><p style={{ marginTop: 3, fontSize: 12, color: "var(--text-muted)" }}>Save the current Doktainer database as a dump file.</p></div>
          <button className="btn btn-primary" type="button" onClick={() => void download()} disabled={loading !== null}>
          {loading === "backup" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Download backup
        </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16, padding: 16, border: "1px solid rgba(245,158,11,0.28)", borderRadius: 8, background: "rgba(245,158,11,0.06)" }}>
          <div><h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>Restore backup</h3><p style={{ marginTop: 3, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>This replaces the current database. Download a fresh backup first.</p></div>
          <input ref={fileInput} type="file" accept=".dump,.backup,application/octet-stream" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) setRestoreFile(file); }} />
          <button className="btn btn-ghost" type="button" onClick={() => fileInput.current?.click()} disabled={loading !== null}>
          {loading === "restore" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Restore from dump
        </button>
      </div>
      </div>
      </section>
    </>
  );
}
