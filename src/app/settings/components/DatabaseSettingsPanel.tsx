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
      <section className="card" style={{ padding: 24 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Database size={20} style={{ color: "#2563eb", marginTop: 2 }} />
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>Database backup & restore</h2>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.6 }}>
            Export the internal Doktainer database as a PostgreSQL dump or restore it from a previous dump file.
          </p>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 24 }}>
        <button className="btn btn-primary" type="button" onClick={() => void download()} disabled={loading !== null}>
          {loading === "backup" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Download backup
        </button>
        <input ref={fileInput} type="file" accept=".dump,.backup,application/octet-stream" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) setRestoreFile(file); }} />
        <button className="btn btn-ghost" type="button" onClick={() => fileInput.current?.click()} disabled={loading !== null}>
          {loading === "restore" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Restore from dump
        </button>
      </div>
      <p style={{ fontSize: 12, color: "#b45309", marginTop: 18 }}>Restoring will overwrite the current database data. Ensure you have downloaded the latest backup.</p>
      </section>
    </>
  );
}
