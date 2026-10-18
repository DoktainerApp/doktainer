export const NOTIFICATION_ACTION_OPTIONS = [
  {
    value: "server_down",
    label: "Server down",
    description: "Trigger the action when a server stops responding.",
  },
  {
    value: "high_cpu_over_80",
    label: "High CPU (>80%)",
    description: "Trigger the action when CPU usage passes 80%.",
  },
  {
    value: "high_ram_over_90",
    label: "High RAM (>90%)",
    description: "Trigger the action when RAM usage passes 90%.",
  },
  {
    value: "ssl_expiring",
    label: "SSL expiring",
    description: "Trigger the action when an SSL certificate is near expiry.",
  },
  {
    value: "container_crash",
    label: "Container crash",
    description: "Trigger the action when a container stops unexpectedly.",
  },
  {
    value: "security_breach",
    label: "Security breach",
    description: "Trigger the action when a security incident is detected.",
  },
  {
    value: "app_deploy",
    label: "App Deploy",
    description: "Trigger the action when an app is deployed.",
  },
  {
    value: "app_build_error",
    label: "App Build Error",
    description: "Trigger the action when the build fails.",
  },
  {
    value: "database_backup",
    label: "Database Backup",
    description: "Trigger the action for database backup lifecycle updates.",
  },
  {
    value: "doktainer_backup",
    label: "Doktainer Backup",
    description: "Reserved for Doktainer app database backup notifications.",
  },
  {
    value: "volume_backup",
    label: "Volume Backup",
    description: "Trigger the action when a volume backup is created.",
  },
  {
    value: "docker_cleanup",
    label: "Docker Cleanup",
    description: "Trigger the action when Docker cleanup is performed.",
  },
  {
    value: "server_threshold",
    label: "Server Threshold",
    description: "Trigger the action when the server threshold is reached.",
  },
  {
    value: "server_guard_alert",
    label: "Server Guard Alert",
    description:
      "Deliver a policy-qualified Server Guard recommendation for review.",
  },
  {
    value: "server_guard_recovered",
    label: "Server Guard Recovered",
    description:
      "Deliver recovery after a previous Server Guard alert was sent.",
  },
] as const;

const NOTIFICATION_ACTION_ALIASES: Record<string, string> = {
  backup_database: "database_backup",
  backup_doktainer: "doktainer_backup",
};

const NOTIFICATION_ACTION_LABELS = new Map<string, string>(
  NOTIFICATION_ACTION_OPTIONS.map((action) => [action.value, action.label]),
);

export function normalizeNotificationActionKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const normalizedAlias = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (NOTIFICATION_ACTION_ALIASES[normalizedAlias]) {
    return NOTIFICATION_ACTION_ALIASES[normalizedAlias];
  }

  const matchedOption = NOTIFICATION_ACTION_OPTIONS.find(
    (action) => action.value === trimmed || action.label === trimmed,
  );

  if (matchedOption) {
    return matchedOption.value;
  }

  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeNotificationActionKeys(values: string[]) {
  return [
    ...new Set(values.map(normalizeNotificationActionKey).filter(Boolean)),
  ];
}

export function getNotificationActionLabel(value: string) {
  const normalizedValue = normalizeNotificationActionKey(value);
  return (
    NOTIFICATION_ACTION_LABELS.get(normalizedValue) ||
    normalizedValue
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}
