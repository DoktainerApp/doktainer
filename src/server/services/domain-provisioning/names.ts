import { getDomain } from "tldts";

export function sanitizeDomainFileName(domainName: string): string {
  return domainName.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
}

export function sanitizeContainerFileName(containerName: string): string {
  return containerName.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
}

export function buildManagedNginxFileBase(
  containerName: string,
  domainName: string,
): string {
  void containerName;
  return sanitizeDomainFileName(domainName);
}

function normalizeAnchorDomain(domainName: string): string {
  return domainName.trim().toLowerCase().replace(/^\*\./, "");
}

function resolveRegistrableDomain(domainName: string): string {
  const parsed = getDomain(domainName, {
    allowIcannDomains: true,
    allowPrivateDomains: true,
  });

  if (parsed) {
    return parsed;
  }

  const labels = domainName.split(".").filter(Boolean);
  if (labels.length >= 2) {
    return labels.slice(-2).join(".");
  }

  return domainName;
}

export function getLegacyTwoLabelDomainConfigAnchor(
  domainNames: string[],
): string {
  const normalized = Array.from(
    new Set(domainNames.map(normalizeAnchorDomain).filter(Boolean)),
  );

  if (normalized.length === 0) {
    return "shared-domain";
  }

  normalized.sort((left, right) => {
    const leftLabels = left.split(".").length;
    const rightLabels = right.split(".").length;

    if (leftLabels !== rightLabels) {
      return leftLabels - rightLabels;
    }

    return left.localeCompare(right);
  });

  const candidate = normalized[0] ?? "shared-domain";
  const labels = candidate.split(".").filter(Boolean);

  if (labels.length >= 2) {
    return labels.slice(-2).join(".");
  }

  return candidate;
}

export function getDomainConfigAnchor(domainNames: string[]): string {
  const normalized = Array.from(
    new Set(domainNames.map(normalizeAnchorDomain).filter(Boolean)),
  );

  if (normalized.length === 0) {
    return "shared-domain";
  }

  normalized.sort((left, right) => {
    const leftLabels = left.split(".").length;
    const rightLabels = right.split(".").length;

    if (leftLabels !== rightLabels) {
      return leftLabels - rightLabels;
    }

    return left.localeCompare(right);
  });

  const candidate = normalized[0] ?? "shared-domain";
  return resolveRegistrableDomain(candidate);
}

export function buildManagedNginxSharedFileBase(
  containerName: string,
  domainNames: string[],
): string {
  void containerName;
  return sanitizeDomainFileName(getDomainConfigAnchor(domainNames));
}
