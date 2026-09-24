"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

interface LatestRelease {
  version: string;
  url: string;
}

const RELEASE_CACHE_KEY = "doktainer-latest-release";
const RELEASE_CACHE_TTL = 6 * 60 * 60 * 1000;

function parseVersion(value: string): [number, number, number] | null {
  const match = value.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = parseVersion(latest);
  const currentParts = parseVersion(current);
  if (!latestParts || !currentParts) return false;

  for (let index = 0; index < latestParts.length; index += 1) {
    if (latestParts[index] !== currentParts[index]) {
      return latestParts[index] > currentParts[index];
    }
  }
  return false;
}

async function getLatestRelease(): Promise<LatestRelease | null> {
  try {
    const cached = window.localStorage.getItem(RELEASE_CACHE_KEY);
    if (cached) {
      const entry = JSON.parse(cached) as {
        expiresAt?: number;
        release?: LatestRelease;
      };
      if (
        typeof entry.expiresAt === "number" &&
        entry.expiresAt > Date.now() &&
        typeof entry.release?.version === "string" &&
        typeof entry.release.url === "string"
      ) {
        return entry.release;
      }
    }
  } catch {
    // Storage may be disabled; continue with the network request.
  }

  try {
    const response = await fetch("/api/app-version", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      success?: boolean;
      data?: LatestRelease;
    };
    const release = payload.data;
    if (
      !payload.success ||
      !release ||
      typeof release.version !== "string" ||
      typeof release.url !== "string" ||
      !release.url.startsWith("https://github.com/DoktainerApp/doktainer/releases/")
    ) {
      return null;
    }

    try {
      window.localStorage.setItem(
        RELEASE_CACHE_KEY,
        JSON.stringify({
          release,
          expiresAt: Date.now() + RELEASE_CACHE_TTL,
        }),
      );
    } catch {
      // The notice remains usable when browser storage is unavailable.
    }
    return release;
  } catch {
    return null;
  }
}

export default function VersionUpdateNotice() {
  const currentVersion = process.env.NEXT_PUBLIC_VERSION || "unknown";
  const [release, setRelease] = useState<LatestRelease | null>(null);

  useEffect(() => {
    let active = true;
    void getLatestRelease().then((latest) => {
      if (active) setRelease(latest);
    });
    return () => {
      active = false;
    };
  }, []);

  if (
    !release ||
    currentVersion === "unknown" ||
    !isNewerVersion(release.version, currentVersion)
  ) {
    return null;
  }

  return (
    <section
      className="version-update-notice"
      aria-label="Doktainer update available"
    >
      <div
        className="version-update-notice__message"
        role="status"
        aria-live="polite"
      >
        <Download size={16} aria-hidden="true" />
        <p>
          Doktainer{" "}
          <strong className="version-update-notice__version">
            {release.version}
          </strong>{" "}
          is available
          <span className="version-update-notice__current">
            (current: <code>{currentVersion}</code>)
          </span>
        </p>
      </div>
      <a
        className="btn btn-primary btn-sm version-update-notice__action"
        href={release.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        View Update
      </a>
    </section>
  );
}
