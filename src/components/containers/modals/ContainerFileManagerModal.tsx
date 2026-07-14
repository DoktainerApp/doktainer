"use client";

import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  Home,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  Container,
  ContainerDirectoryListing,
  ContainerFileContent,
  ContainerFileEntry,
  containers as containersApi,
} from "@/lib/api";
import StatusBadge from "../StatusBadge";
import {
  decodeBase64ToBlob,
  decodeBase64ToText,
  formatBytes,
  formatTimestamp,
  joinContainerPath,
} from "../utils/container-utils";

interface ContainerFileManagerModalProps {
  container: Container;
  onClose: () => void;
}

const FILE_MANAGER_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
  onCancel?: () => void;
};

export default function ContainerFileManagerModal({
  container,
  onClose,
}: ContainerFileManagerModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [listing, setListing] = useState<ContainerDirectoryListing | null>(
    null,
  );
  const [currentPath, setCurrentPath] = useState("/");
  const [listingLoading, setListingLoading] = useState(true);
  const [listingError, setListingError] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<ContainerFileContent | null>(
    null,
  );
  const [editorValue, setEditorValue] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"file" | "folder" | null>(null);
  const [createName, setCreateName] = useState("");
  const [renamePath, setRenamePath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);

  const dirty =
    !!selectedFile &&
    !selectedFile.isBinary &&
    !selectedFile.tooLarge &&
    editorValue !== selectedFile.content;

  const loadDirectory = useCallback(
    async (path: string) => {
      setListingLoading(true);
      setListingError("");
      try {
        const response = await containersApi.listFiles(container.id, path);
        setListing(response.data ?? null);
        setCurrentPath(response.data?.path ?? path);
      } catch (err: unknown) {
        setListingError(
          err instanceof Error ? err.message : "Failed to load files",
        );
      } finally {
        setListingLoading(false);
      }
    },
    [container.id],
  );

  useEffect(() => {
    void loadDirectory("/");
  }, [loadDirectory]);

  const resetEditor = () => {
    setSelectedFile(null);
    setEditorValue("");
    setFileError("");
  };

  const closeInlineForms = () => {
    setCreateMode(null);
    setCreateName("");
    setRenamePath(null);
    setRenameValue("");
  };

  const requestConfirmation = useCallback(
    (options: Omit<PendingConfirmAction, "onConfirm" | "onCancel">) =>
      new Promise<boolean>((resolve) => {
        setConfirmDialog({
          ...options,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
    [],
  );

  const confirmLoseChanges = useCallback(async () => {
    if (!dirty) return true;

    return requestConfirmation({
      title: "Discard Unsaved Changes",
      description: "Unsaved changes will be lost. Continue?",
      confirmLabel: "Discard Changes",
      tone: "warning",
      note: "Any edits in the current file editor will be discarded.",
    });
  }, [dirty, requestConfirmation]);

  const handleNavigate = async (path: string) => {
    if (!(await confirmLoseChanges())) return;
    resetEditor();
    await loadDirectory(path);
  };

  const handleOpenFile = async (path: string) => {
    if (!(await confirmLoseChanges())) return;
    setFileLoading(true);
    setFileError("");
    setNotice(null);
    try {
      const response = await containersApi.readFile(container.id, path);
      const nextFile = response.data ?? null;
      setSelectedFile(nextFile);
      setEditorValue(nextFile?.content ?? "");
    } catch (err: unknown) {
      setFileError(err instanceof Error ? err.message : "Failed to open file");
    } finally {
      setFileLoading(false);
    }
  };

  const handleCloseFile = async () => {
    if (!(await confirmLoseChanges())) return;
    setNotice(null);
    resetEditor();
  };

  const handleSave = async () => {
    if (!selectedFile || selectedFile.isBinary || selectedFile.tooLarge) return;
    setSaving(true);
    setNotice(null);
    try {
      await containersApi.writeFile(container.id, {
        path: selectedFile.path,
        content: editorValue,
      });
      const nextSize = new TextEncoder().encode(editorValue).length;
      setSelectedFile({
        ...selectedFile,
        content: editorValue,
        size: nextSize,
      });
      setNotice({ tone: "success", message: `Saved ${selectedFile.path}` });
      await loadDirectory(currentPath);
    } catch (err: unknown) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to save file",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateFile = async () => {
    if (!(await confirmLoseChanges())) return;
    const name = createName.trim();
    if (!name) return;

    const path = joinContainerPath(currentPath, name);
    setBusyPath(path);
    setNotice(null);
    try {
      await containersApi.createFile(container.id, { path, content: "" });
      await loadDirectory(currentPath);
      await handleOpenFile(path);
      closeInlineForms();
      setNotice({ tone: "success", message: `Created ${path}` });
    } catch (err: unknown) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to create file",
      });
    } finally {
      setBusyPath(null);
    }
  };

  const handleCreateFolder = async () => {
    const name = createName.trim();
    if (!name) return;

    const path = joinContainerPath(currentPath, name);
    setBusyPath(path);
    setNotice(null);
    try {
      await containersApi.createFolder(container.id, { path });
      await loadDirectory(currentPath);
      closeInlineForms();
      setNotice({ tone: "success", message: `Created folder ${path}` });
    } catch (err: unknown) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to create folder",
      });
    } finally {
      setBusyPath(null);
    }
  };

  const handleRename = async (entry: ContainerFileEntry) => {
    const nextName = renameValue.trim();
    if (!nextName || nextName === entry.name) return;
    if (
      dirty &&
      selectedFile?.path === entry.path &&
      !(await confirmLoseChanges())
    ) {
      return;
    }

    const newPath = joinContainerPath(currentPath, nextName);
    setBusyPath(entry.path);
    setNotice(null);
    try {
      await containersApi.renamePath(container.id, {
        path: entry.path,
        newPath,
      });
      if (selectedFile?.path === entry.path) {
        resetEditor();
      }
      await loadDirectory(currentPath);
      closeInlineForms();
      setNotice({ tone: "success", message: `Renamed to ${newPath}` });
    } catch (err: unknown) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to rename item",
      });
    } finally {
      setBusyPath(null);
    }
  };

  const uploadFileObject = useCallback(
    async (file: File) => {
      if (file.size > FILE_MANAGER_UPLOAD_MAX_BYTES) {
        setNotice({
          tone: "error",
          message: `File is too large. Maximum upload size is ${formatBytes(
            FILE_MANAGER_UPLOAD_MAX_BYTES,
          )}.`,
        });
        return;
      }

      setUploading(true);
      setNotice(null);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ""));
          reader.onerror = () =>
            reject(new Error("Failed to read selected file"));
          reader.readAsDataURL(file);
        });
        const contentBase64 = dataUrl.split(",")[1] ?? "";
        if (!contentBase64) {
          throw new Error("Selected file is empty or could not be encoded");
        }

        await containersApi.uploadFile(container.id, {
          directoryPath: currentPath,
          fileName: file.name,
          contentBase64,
        });
        await loadDirectory(currentPath);
        setNotice({ tone: "success", message: `Uploaded ${file.name}` });
      } catch (err: unknown) {
        setNotice({
          tone: "error",
          message: err instanceof Error ? err.message : "Failed to upload file",
        });
      } finally {
        setUploading(false);
      }
    },
    [container.id, currentPath, loadDirectory],
  );

  const handleDelete = async (entry: ContainerFileEntry) => {
    const confirmed = await requestConfirmation({
      title: `Delete ${entry.type === "directory" ? "Folder" : "File"}`,
      description: `Delete ${entry.type} "${entry.name}"?`,
      confirmLabel: `Delete ${entry.type === "directory" ? "Folder" : "File"}`,
      tone: "danger",
      note: "This removes the selected path from the container filesystem.",
    });
    if (!confirmed) return;
    if (
      dirty &&
      selectedFile?.path === entry.path &&
      !(await confirmLoseChanges())
    ) {
      return;
    }

    setBusyPath(entry.path);
    setNotice(null);
    try {
      await containersApi.deletePath(container.id, entry.path);
      if (
        selectedFile?.path === entry.path ||
        (entry.type === "directory" &&
          selectedFile?.path.startsWith(`${entry.path}/`))
      ) {
        resetEditor();
      }
      await loadDirectory(currentPath);
      setNotice({ tone: "success", message: `Deleted ${entry.path}` });
    } catch (err: unknown) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to delete item",
      });
    } finally {
      setBusyPath(null);
    }
  };

  const handleDownload = async (path: string) => {
    setBusyPath(path);
    setNotice(null);
    try {
      const response = await containersApi.downloadFile(container.id, path);
      const data = response.data;
      if (!data) {
        throw new Error("No file content returned");
      }
      const blob = decodeBase64ToBlob(data.contentBase64);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = data.name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice({ tone: "success", message: `Downloaded ${data.name}` });
    } catch (err: unknown) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to download file",
      });
    } finally {
      setBusyPath(null);
    }
  };

  const handleUploadRequest = () => {
    setNewMenuOpen(false);
    fileInputRef.current?.click();
  };

  const handleUploadSelected = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    await uploadFileObject(file);
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragOver(false);

    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }

    await uploadFileObject(file);
  };

  const imagePreviewUrl =
    selectedFile?.previewBase64 && selectedFile.mimeType?.startsWith("image/")
      ? `data:${selectedFile.mimeType};base64,${selectedFile.previewBase64}`
      : null;
  const binaryPreviewText =
    selectedFile?.previewBase64 && !selectedFile.mimeType?.startsWith("image/")
      ? decodeBase64ToText(selectedFile.previewBase64)
      : null;

  const pathSegments = currentPath.split("/").filter(Boolean);
  const breadcrumbItems =
    pathSegments.length > 5
      ? [
          ...pathSegments.slice(0, 2).map((segment, index) => ({
            segment,
            index,
            type: "segment" as const,
          })),
          {
            segment: "...",
            index: -1,
            type: "ellipsis" as const,
            title: pathSegments.slice(2, -2).join("/"),
          },
          ...pathSegments.slice(-2).map((segment, offset) => ({
            segment,
            index: pathSegments.length - 2 + offset,
            type: "segment" as const,
          })),
        ]
      : pathSegments.map((segment, index) => ({
          segment,
          index,
          type: "segment" as const,
        }));

  return (
    <div className="modal-overlay">
      <ConfirmActionDialog
        open={confirmDialog !== null}
        title={confirmDialog?.title ?? ""}
        description={confirmDialog?.description ?? ""}
        confirmLabel={confirmDialog?.confirmLabel ?? "Confirm"}
        tone={confirmDialog?.tone ?? "danger"}
        note={confirmDialog?.note}
        onClose={() => {
          const current = confirmDialog;
          setConfirmDialog(null);
          current?.onCancel?.();
        }}
        onConfirm={() => {
          const current = confirmDialog;
          setConfirmDialog(null);
          current?.onConfirm();
        }}
      />
      <div className="modal-shell" style={{ maxWidth: 1240 }}>
        <button
          type="button"
          onClick={async () => {
            if (!(await confirmLoseChanges())) return;
            onClose();
          }}
          className="modal-close"
          aria-label="Close file manager modal"
        >
          <X size={22} />
        </button>
      <div
        className="modal animate-slide-in"
        style={{
          width: "100%",
          maxWidth: 1240,
          maxHeight: "92vh",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "18px 22px",
            paddingRight: 56,
            borderBottom: "1px solid var(--border)",
            gap: 16,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h3
                style={{
                  color: "var(--text-primary)",
                  fontWeight: 700,
                  fontSize: 16,
                }}
              >
                File Manager
              </h3>
              <StatusBadge status={container.status} />
            </div>
            <p
              style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}
            >
              {container.name} • {container.image}
              {container.server
                ? ` • ${container.server.name} (${container.server.ip})`
                : ""}
            </p>
          </div>
        </div>

        <div
          style={{
            padding: "14px 22px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void handleNavigate("/")}
            >
              <Home size={12} />
              Root
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() =>
                listing?.parentPath
                  ? void handleNavigate(listing.parentPath)
                  : null
              }
              disabled={!listing?.parentPath}
            >
              <ArrowUp size={12} />
              Up
            </button>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
                padding: "6px 10px",
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: 10,
              }}
            >
              <button
                type="button"
                onClick={() => void handleNavigate("/")}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                /
              </button>
              {breadcrumbItems.map((item) => {
                return (
                  <div
                    key={
                      item.type === "segment"
                        ? `path-${item.index}`
                        : "path-ellipsis"
                    }
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <ChevronRight
                      size={12}
                      style={{ color: "var(--text-muted)" }}
                    />
                    {item.type === "ellipsis" ? (
                      <span
                        title={item.title}
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 12,
                          cursor: item.title ? "help" : "default",
                        }}
                      >
                        {item.segment}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          void handleNavigate(
                            `/${pathSegments
                              .slice(0, item.index + 1)
                              .join("/")}`,
                          )
                        }
                        title={`/${pathSegments
                          .slice(0, item.index + 1)
                          .join("/")}`}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                          fontSize: 12,
                        }}
                      >
                        {item.segment}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div
              style={{ position: "relative" }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setNewMenuOpen(false);
                }
              }}
            >
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => setNewMenuOpen((open) => !open)}
                disabled={listingLoading || uploading}
                aria-expanded={newMenuOpen}
                aria-haspopup="menu"
              >
                {uploading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <FilePlus2 size={12} />
                )}
                New
                <ChevronDown size={12} />
              </button>
              {newMenuOpen ? (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    left: 0,
                    zIndex: 20,
                    minWidth: 160,
                    padding: 6,
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "var(--shadow-lg)",
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false);
                      setCreateMode("file");
                      setCreateName("new-file.txt");
                      setRenamePath(null);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      background: "none",
                      border: "none",
                      borderRadius: 6,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontSize: 12,
                      textAlign: "left",
                    }}
                  >
                    <FilePlus2 size={12} />
                    New File
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false);
                      setCreateMode("folder");
                      setCreateName("new-folder");
                      setRenamePath(null);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      background: "none",
                      border: "none",
                      borderRadius: 6,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontSize: 12,
                      textAlign: "left",
                    }}
                  >
                    <FolderPlus size={12} />
                    New Folder
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleUploadRequest}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      background: "none",
                      border: "none",
                      borderRadius: 6,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontSize: 12,
                      textAlign: "left",
                    }}
                  >
                    <Upload size={12} />
                    Upload
                  </button>
                </div>
              ) : null}
            </div>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() =>
                selectedFile ? void handleDownload(selectedFile.path) : null
              }
              disabled={!selectedFile || busyPath === selectedFile.path}
            >
              <Download size={12} />
              Download
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => void loadDirectory(currentPath)}
              disabled={listingLoading}
            >
              {listingLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Refresh
            </button>
            <button
              className="btn btn-primary"
              style={{ fontSize: 12 }}
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
            >
              {saving ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save File
            </button>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={handleUploadSelected}
            />
          </div>
        </div>

        {createMode || renamePath ? (
          <div
            style={{
              padding: "12px 22px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
              background: "rgba(59,130,246,0.06)",
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              {renamePath
                ? "Rename item"
                : createMode === "file"
                  ? "Create new file"
                  : "Create new folder"}
            </span>
            <input
              className="input"
              value={renamePath ? renameValue : createName}
              onChange={(event) =>
                renamePath
                  ? setRenameValue(event.target.value)
                  : setCreateName(event.target.value)
              }
              placeholder={
                createMode === "file" ? "new-file.txt" : "new-folder"
              }
              style={{ minWidth: 280, flex: "1 1 280px" }}
            />
            <button
              className="btn btn-primary"
              style={{ fontSize: 12 }}
              onClick={() => {
                if (renamePath && listing) {
                  const entry = listing.entries.find(
                    (item) => item.path === renamePath,
                  );
                  if (entry) {
                    void handleRename(entry);
                  }
                  return;
                }

                if (createMode === "file") {
                  void handleCreateFile();
                  return;
                }

                if (createMode === "folder") {
                  void handleCreateFolder();
                }
              }}
            >
              Apply
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={closeInlineForms}
            >
              Cancel
            </button>
          </div>
        ) : null}

        <div
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setIsDragOver(true);
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={(event) => {
            if (
              event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              return;
            }
            setIsDragOver(false);
          }}
          onDrop={(event) => void handleDrop(event)}
          style={{
            flex: 1,
            overflow: "hidden",
            padding: 22,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
            gap: 18,
            border: isDragOver
              ? "2px dashed rgba(59,130,246,0.55)"
              : "2px solid transparent",
            borderRadius: 18,
            background: isDragOver ? "rgba(59,130,246,0.06)" : undefined,
          }}
        >
          <div
            className="card"
            style={{
              padding: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "14px 16px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <h4
                  style={{
                    color: "var(--text-primary)",
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  Directory Browser
                </h4>
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 12,
                    marginTop: 4,
                  }}
                >
                  {currentPath}
                </p>
              </div>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {listing?.entries.length ?? 0} items
              </span>
            </div>

            <div style={{ flex: 1, overflow: "auto" }}>
              {listingLoading ? (
                <div style={{ padding: 40, textAlign: "center" }}>
                  <Loader2
                    size={24}
                    className="animate-spin"
                    style={{ color: "var(--accent)", margin: "0 auto 12px" }}
                  />
                  <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                    Loading directory contents...
                  </p>
                </div>
              ) : listingError ? (
                <div
                  style={{
                    margin: 16,
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    borderRadius: 10,
                    padding: 14,
                    color: "#ef4444",
                    fontSize: 13,
                  }}
                >
                  {listingError}
                </div>
              ) : !listing || listing.entries.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center" }}>
                  <FolderOpen
                    size={28}
                    style={{
                      color: "var(--text-muted)",
                      opacity: 0.45,
                      margin: "0 auto 10px",
                    }}
                  />
                  <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                    Directory is empty.
                  </p>
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Size</th>
                      <th>Modified</th>
                      <th style={{ textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listing.entries.map((entry) => {
                      const isDirectory = entry.type === "directory";
                      const isSpecial = entry.type === "special";
                      const canOpen = !isSpecial;
                      const rowBusy = busyPath === entry.path;
                      return (
                        <tr key={entry.path}>
                          <td>
                            <button
                              type="button"
                              onClick={() =>
                                isDirectory
                                  ? void handleNavigate(entry.path)
                                  : canOpen
                                    ? void handleOpenFile(entry.path)
                                    : undefined
                              }
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                cursor: canOpen ? "pointer" : "default",
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                color: isDirectory
                                  ? "#60a5fa"
                                  : isSpecial
                                    ? "var(--text-muted)"
                                    : "var(--text-primary)",
                                fontWeight: isDirectory ? 600 : 500,
                                opacity: rowBusy ? 0.7 : 1,
                              }}
                              disabled={rowBusy || !canOpen}
                            >
                              {isDirectory ? (
                                <FolderOpen size={15} />
                              ) : (
                                <FileText size={15} />
                              )}
                              <span>{entry.name}</span>
                            </button>
                          </td>
                          <td
                            style={{
                              color: "var(--text-secondary)",
                              fontSize: 12,
                            }}
                          >
                            {isDirectory || entry.size == null
                              ? "-"
                              : formatBytes(entry.size)}
                          </td>
                          <td
                            style={{
                              color: "var(--text-secondary)",
                              fontSize: 12,
                            }}
                          >
                            {formatTimestamp(entry.modified)}
                          </td>
                          <td>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "flex-end",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: "4px 8px" }}
                                onClick={() =>
                                  isDirectory
                                    ? void handleNavigate(entry.path)
                                    : canOpen
                                      ? void handleOpenFile(entry.path)
                                      : undefined
                                }
                                disabled={rowBusy || !canOpen}
                              >
                                {isDirectory
                                  ? "Open"
                                  : isSpecial
                                    ? "Unsupported"
                                    : "Edit"}
                              </button>
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: "4px 8px" }}
                                onClick={() => {
                                  setCreateMode(null);
                                  setRenamePath(entry.path);
                                  setRenameValue(entry.name);
                                }}
                                disabled={rowBusy}
                              >
                                <Pencil size={11} />
                              </button>
                              {!isDirectory ? (
                                <button
                                  className="btn btn-ghost"
                                  style={{ fontSize: 11, padding: "4px 8px" }}
                                  onClick={() =>
                                    void handleDownload(entry.path)
                                  }
                                  disabled={rowBusy}
                                >
                                  <Download size={11} />
                                </button>
                              ) : null}
                              <button
                                className="btn btn-ghost"
                                style={{
                                  fontSize: 11,
                                  padding: "4px 8px",
                                  color: "#ef4444",
                                }}
                                onClick={() => void handleDelete(entry)}
                                disabled={rowBusy}
                              >
                                {rowBusy ? (
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
              )}
            </div>
          </div>

          <div
            className="card"
            style={{
              padding: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "14px 16px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <h4
                  style={{
                    color: "var(--text-primary)",
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {selectedFile ? selectedFile.name : "Editor"}
                </h4>
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 12,
                    marginTop: 4,
                  }}
                >
                  {selectedFile
                    ? selectedFile.path
                    : "Choose a file from the left panel"}
                </p>
              </div>
              {selectedFile ? (
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {formatBytes(selectedFile.size)}
                </span>
              ) : null}
            </div>

            <div
              style={{
                flex: 1,
                overflow: "auto",
                padding: 16,
                position: "relative",
              }}
            >
              {selectedFile ? (
                <button
                  type="button"
                  onClick={() => void handleCloseFile()}
                  aria-label="Close current file"
                  title="Close file"
                  style={{
                    position: "absolute",
                    top: 50,
                    right: 25,
                    width: 22,
                    height: 22,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 999,
                    border: "1px solid rgb(173, 173, 173)",
                    background: "transparent",
                    color: "rgb(173, 173, 173)",
                    boxShadow: "0 12px 24px rgba(2,6,23,0.28)",
                    cursor: "pointer",
                    zIndex: 2,
                  }}
                >
                  <X size={16} />
                </button>
              ) : null}

              {notice ? (
                <div
                  style={{
                    background:
                      notice.tone === "success"
                        ? "rgba(16,185,129,0.12)"
                        : notice.tone === "error"
                          ? "rgba(239,68,68,0.1)"
                          : "rgba(59,130,246,0.12)",
                    border:
                      notice.tone === "success"
                        ? "1px solid rgba(16,185,129,0.24)"
                        : notice.tone === "error"
                          ? "1px solid rgba(239,68,68,0.3)"
                          : "1px solid rgba(59,130,246,0.24)",
                    color:
                      notice.tone === "success"
                        ? "#10b981"
                        : notice.tone === "error"
                          ? "#ef4444"
                          : "#60a5fa",
                    borderRadius: 10,
                    padding: 12,
                    fontSize: 13,
                    marginBottom: 12,
                  }}
                >
                  {notice.message}
                </div>
              ) : null}

              {fileError ? (
                <div
                  style={{
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    borderRadius: 10,
                    padding: 14,
                    color: "#ef4444",
                    fontSize: 13,
                    marginBottom: 12,
                  }}
                >
                  {fileError}
                </div>
              ) : null}

              {fileLoading ? (
                <div style={{ padding: 36, textAlign: "center" }}>
                  <Loader2
                    size={24}
                    className="animate-spin"
                    style={{ color: "var(--accent)", margin: "0 auto 12px" }}
                  />
                  <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                    Opening file...
                  </p>
                </div>
              ) : !selectedFile ? (
                <div style={{ padding: 36, textAlign: "center" }}>
                  <FileText
                    size={28}
                    style={{
                      color: "var(--text-muted)",
                      opacity: 0.45,
                      margin: "0 auto 10px",
                    }}
                  />
                  <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                    Select a file to preview or edit it.
                  </p>
                </div>
              ) : selectedFile.isBinary ? (
                imagePreviewUrl ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        background: "rgba(59,130,246,0.08)",
                        border: "1px solid rgba(59,130,246,0.18)",
                        borderRadius: 10,
                        padding: 12,
                        color: "#60a5fa",
                        fontSize: 13,
                      }}
                    >
                      Image preview is shown read-only. Use Download if you want
                      the original file.
                    </div>
                    <div
                      style={{
                        background: "rgba(15,23,42,0.6)",
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        padding: 12,
                        display: "flex",
                        justifyContent: "center",
                      }}
                    >
                      <div
                        style={{
                          position: "relative",
                          width: "100%",
                          maxWidth: 720,
                          height: 420,
                        }}
                      >
                        <Image
                          src={imagePreviewUrl}
                          alt={selectedFile.name}
                          fill
                          unoptimized
                          style={{ objectFit: "contain" }}
                        />
                      </div>
                    </div>
                  </div>
                ) : binaryPreviewText ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        background: "rgba(245,158,11,0.12)",
                        border: "1px solid rgba(245,158,11,0.24)",
                        borderRadius: 10,
                        padding: 14,
                        color: "#f59e0b",
                        fontSize: 13,
                      }}
                    >
                      Binary file detected. Showing lightweight read-only
                      preview.
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        padding: 14,
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        background: "var(--bg-input)",
                        color: "var(--text-primary)",
                        fontSize: 12,
                        lineHeight: 1.55,
                        maxHeight: 420,
                        overflow: "auto",
                        fontFamily: "JetBrains Mono, monospace",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {binaryPreviewText}
                    </pre>
                  </div>
                ) : (
                  <div
                    style={{
                      background: "rgba(245,158,11,0.12)",
                      border: "1px solid rgba(245,158,11,0.24)",
                      borderRadius: 10,
                      padding: 14,
                      color: "#f59e0b",
                      fontSize: 13,
                    }}
                  >
                    This file looks binary and is not shown in the text editor.
                  </div>
                )
              ) : selectedFile.tooLarge ? (
                <div
                  style={{
                    background: "rgba(245,158,11,0.12)",
                    border: "1px solid rgba(245,158,11,0.24)",
                    borderRadius: 10,
                    padding: 14,
                    color: "#f59e0b",
                    fontSize: 13,
                  }}
                >
                  This file is too large to load into the editor. Open a smaller
                  text file or inspect it through a terminal.
                </div>
              ) : (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      color: "var(--text-muted)",
                      fontSize: 12,
                    }}
                  >
                    <span>
                      Modified: {formatTimestamp(selectedFile.modified)}
                    </span>
                    <span>{dirty ? "Unsaved changes" : "Saved"}</span>
                  </div>
                  <textarea
                    value={editorValue}
                    onChange={(event) => setEditorValue(event.target.value)}
                    spellCheck={false}
                    style={{
                      width: "100%",
                      minHeight: 530,
                      resize: "vertical",
                      borderRadius: 12,
                      border: "1px solid var(--border)",
                      background: "var(--bg-input)",
                      color: "var(--text-primary)",
                      padding: 14,
                      fontSize: 12,
                      lineHeight: 1.55,
                      fontFamily: "JetBrains Mono, monospace",
                      outline: "none",
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
