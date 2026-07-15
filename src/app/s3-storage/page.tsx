"use client";

import { useEffect, useState } from "react";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import GuardedPage from "@/components/GuardedPage";
import ToastViewport from "@/components/ToastViewport";
import S3StorageSettingsPanel from "@/app/s3-storage/components/S3StorageSettingsPanel";
import {
  Banner,
  SettingsLoadingPanel,
} from "@/app/settings/components/SettingsPrimitives";
import {
  servers as serversApi,
  storageDestinationsApi,
  type S3StorageDestinationInput,
  type S3StorageDestinationRecord,
  type Server,
} from "@/lib/api";
import { useToastManager } from "@/lib/use-toast-manager";

type DestinationDraft = S3StorageDestinationInput & {
  id?: string;
  hasSecretAccessKey?: boolean;
};

type PendingConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "info";
  note?: string;
  onConfirm: () => void;
};

function toDestinationInput(
  destination: DestinationDraft | S3StorageDestinationRecord,
  overrides?: Partial<S3StorageDestinationInput>,
): S3StorageDestinationInput {
  return {
    name: overrides?.name ?? destination.name,
    provider: overrides?.provider ?? destination.provider,
    enabled: overrides?.enabled ?? destination.enabled,
    accessKeyId: overrides?.accessKeyId ?? destination.accessKeyId,
    secretAccessKey: overrides?.secretAccessKey ?? destination.secretAccessKey,
    region: overrides?.region ?? destination.region,
    bucket: overrides?.bucket ?? destination.bucket,
    endpoint: overrides?.endpoint ?? destination.endpoint,
    additionalFlags: overrides?.additionalFlags ?? [
      ...destination.additionalFlags,
    ],
    retentionDays: overrides?.retentionDays ?? destination.retentionDays,
    maxBackupCount:
      overrides?.maxBackupCount ?? destination.maxBackupCount,
    objectPrefix: overrides?.objectPrefix ?? destination.objectPrefix,
    serverId: overrides?.serverId ?? destination.serverId,
  };
}

function upsertDestinationState(
  current: S3StorageDestinationRecord[],
  next: S3StorageDestinationRecord,
) {
  const existingIndex = current.findIndex((item) => item.id === next.id);
  if (existingIndex === -1) {
    return [...current, next].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  const updated = [...current];
  updated[existingIndex] = next;
  return updated;
}

export default function S3StoragePage() {
  const [destinations, setDestinations] = useState<
    S3StorageDestinationRecord[]
  >([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingDestinationId, setSavingDestinationId] = useState<string | null>(
    null,
  );
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] =
    useState<PendingConfirmAction | null>(null);
  const { toasts, pushToast, dismissToast } = useToastManager();

  useEffect(() => {
    let mounted = true;

    const loadDestinations = async () => {
      setLoading(true);
      setError(null);

      try {
        const [destinationsResponse, serversResponse] = await Promise.all([
          storageDestinationsApi.list(),
          serversApi.list(),
        ]);
        if (!mounted) return;
        setDestinations(destinationsResponse.data);
        setServers(serversResponse.data);
      } catch (err) {
        if (!mounted) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load storage destinations",
        );
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void loadDestinations();
    return () => {
      mounted = false;
    };
  }, []);

  const upsertDestination = async (draft: DestinationDraft) => {
    const missing = [
      !draft.accessKeyId && "Access Key ID",
      !draft.secretAccessKey && "Secret Access Key",
      !draft.region && "Region",
      !draft.bucket && "Bucket",
      !draft.name && "Destination Name",
      draft.provider !== "awsS3" && !draft.endpoint && "Endpoint",
      (draft.retentionDays || draft.maxBackupCount) &&
        !draft.objectPrefix &&
        "Object Prefix",
    ].filter(Boolean) as string[];

    if (missing.length > 0) {
      pushToast({
        tone: "warning",
        // message: `Fill in the following fields before saving: ${missing.join(", ")}`,
        message: `Fill in the available fields before proceeding with saving.`,
      });
      return false;
    }

    const pendingId = draft.id || "new-destination";
    setSavingDestinationId(pendingId);
    try {
      const payload = toDestinationInput(draft);
      const response = draft.id
        ? await storageDestinationsApi.update(draft.id, payload)
        : await storageDestinationsApi.create(payload);

      setDestinations((current) =>
        upsertDestinationState(current, response.data),
      );
      pushToast({
        tone: "success",
        message:
          response.message ||
          (draft.id
            ? "Storage destination has been updated successfully"
            : "Storage destination has been created successfully"),
      });
      return true;
    } catch (err) {
      pushToast({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to save storage destination",
      });
      return false;
    } finally {
      setSavingDestinationId(null);
    }
  };

  const verifyDestination = async (draft: DestinationDraft) => {
    const missing = [
      !draft.accessKeyId && "Access Key ID",
      !draft.secretAccessKey && "Secret Access Key",
      !draft.region && "Region",
      !draft.bucket && "Bucket",
      !draft.name && "Destination Name",
      draft.provider !== "awsS3" && !draft.endpoint && "Endpoint",
      (draft.retentionDays || draft.maxBackupCount) &&
        !draft.objectPrefix &&
        "Object Prefix",
    ].filter(Boolean) as string[];

    if (missing.length > 0) {
      pushToast({
        tone: "warning",
        // message: `Fill in the following fields before verifying: ${missing.join(", ")}`,
        message: `Fill in the available fields before proceeding with verification.`,
      });
      return;
    }

    setActionLoading(`verify-${draft.id ?? "draft"}`);

    try {
      const response = await storageDestinationsApi.verify({
        ...toDestinationInput(draft),
        id: draft.id,
      });
      pushToast({
        tone: "success",
        message: response.message || "Storage connection verified successfully",
      });
    } catch (err) {
      pushToast({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to verify destination connection",
      });
    } finally {
      setActionLoading(null);
    }
  };

  const toggleDestination = async (destination: S3StorageDestinationRecord) => {
    const pendingId = `toggle-${destination.id}`;
    setSavingDestinationId(pendingId);

    try {
      const response = await storageDestinationsApi.update(
        destination.id,
        toDestinationInput(destination, {
          enabled: !destination.enabled,
          secretAccessKey: "",
        }),
      );

      setDestinations((current) =>
        upsertDestinationState(current, response.data),
      );
      pushToast({
        tone: "success",
        message:
          response.message || "Storage destination status updated successfully",
      });
    } catch (err) {
      pushToast({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to update storage destination status",
      });
    } finally {
      setSavingDestinationId(null);
    }
  };

  const performDeleteDestination = async (
    destination: S3StorageDestinationRecord,
  ) => {
    const destinationId = destination.id;
    setSavingDestinationId(`delete-${destinationId}`);

    try {
      const response = await storageDestinationsApi.remove(destinationId);
      setDestinations((current) =>
        current.filter((destination) => destination.id !== destinationId),
      );
      pushToast({
        tone: "success",
        message:
          response.message ||
          "Storage destination has been deleted successfully",
      });
    } catch (err) {
      pushToast({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to delete storage destination",
      });
    } finally {
      setSavingDestinationId(null);
    }
  };

  const handleDeleteDestination = (destination: S3StorageDestinationRecord) => {
    setConfirmDialog({
      title: "Delete Storage Destination",
      description: `Delete storage destination "${destination.name}"?`,
      confirmLabel: "Delete Destination",
      tone: "danger",
      note: "This removes the saved S3 storage destination and its credentials from Doktainer.",
      onConfirm: () => {
        void performDeleteDestination(destination);
      },
    });
  };

  return (
    <GuardedPage
      route="/s3-storage"
      title="S3 Storage"
      subtitle="Manage your S3-compatible storage destinations for backups and more"
      redirectSubtitle="Redirecting to a page allowed for your role"
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
        {error ? <Banner message={error} tone="error" /> : null}

        {loading ? (
          <SettingsLoadingPanel />
        ) : (
          <S3StorageSettingsPanel
            destinations={destinations}
            servers={servers}
            actionLoading={actionLoading}
            savingDestinationId={savingDestinationId}
            onUpsertDestination={upsertDestination}
            onVerifyDestination={verifyDestination}
            onToggleDestination={toggleDestination}
            onDeleteDestination={handleDeleteDestination}
          />
        )}
      </div>
    </GuardedPage>
  );
}

