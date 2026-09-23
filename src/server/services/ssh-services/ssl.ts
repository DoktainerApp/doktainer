import { Server } from "@prisma/client";
import { exec, execStrict } from "./commands";
import { escapeShellArg } from "./internal/shell";
import { privilegedCommand } from "./internal/privilege";
import {
  buildCertbotEmailFlag,
  resolveCertbotCommand,
} from "./internal/certbot";

// NOTE: This file is a modularization of ssh.service.ts (domain: ssl).

export interface SslCertificateResult {
  issuer: string;
  certPem: string;
  keyPem: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
}

export interface SslRenewStepTimings {
  resolveCertificateMs: number;
  certbotRenewMs: number;
  readCertificateMs: number;
  fallbackIssueMs?: number;
  certbotLockWaitMs?: number;
  certbotAttempts?: number;
  totalMs: number;
}

export interface SslRenewCertificateResult extends SslCertificateResult {
  timings: SslRenewStepTimings;
  strategy: "renew" | "fallback-issue";
}

export interface SslRenewProgress {
  stage: string;
  message: string;
  timings?: Partial<SslRenewStepTimings>;
}

export interface DiscoveredSslCertificate extends SslCertificateResult {
  certName: string;
  domainNames: string[];
}

export interface DeletedSslCertificateResult {
  certName: string;
  domainNames: string[];
  deletedFromServer: boolean;
}

export interface ResolvedSslCertificate {
  certName: string;
  domainNames: string[];
}

function parseCertbotCertificateLineages(
  output: string,
): ResolvedSslCertificate[] {
  const results: ResolvedSslCertificate[] = [];
  let currentCertName: string | null = null;
  let currentDomainNames: string[] = [];

  const flush = () => {
    if (!currentCertName) {
      return;
    }

    const certName = normalizeDomainName(currentCertName) ?? currentCertName;
    const domainNames = Array.from(
      new Set(
        currentDomainNames
          .map((value) => normalizeDomainName(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );

    if (certName && domainNames.length > 0) {
      results.push({ certName, domainNames });
    }
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("Certificate Name:")) {
      flush();
      currentCertName = line.slice("Certificate Name:".length).trim();
      currentDomainNames = [];
      continue;
    }

    if (line.startsWith("Domains:")) {
      currentDomainNames = line
        .slice("Domains:".length)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    }
  }

  flush();
  return results;
}

async function listCertbotCertificateLineages(
  server: Server,
): Promise<ResolvedSslCertificate[]> {
  const certbotBinary = await resolveCertbotCommand(server);
  const result = await exec(
    server,
    privilegedCommand(server, `${certbotBinary} certificates 2>&1`),
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (result.code !== 0) {
    throw new Error(output || "certbot certificates failed");
  }

  return parseCertbotCertificateLineages(output);
}

async function detectActiveWebServer(
  server: Server,
): Promise<"nginx" | "apache2" | "httpd" | null> {
  const result = await exec(
    server,
    `bash -lc ${escapeShellArg(
      'for svc in nginx apache2 httpd; do if systemctl is-active "$svc" >/dev/null 2>&1; then echo "$svc"; break; fi; done',
    )}`,
  );
  const name = result.stdout.trim();
  if (name === "nginx") return "nginx";
  if (name === "apache2" || name === "httpd") return name;
  return null;
}

function isMissingCertbotWebServerPlugin(output: string): boolean {
  return /requested (nginx|apache) plugin does not appear to be installed/i.test(
    output,
  );
}

async function issueCertificateWithTemporaryWebServerStop(
  server: Server,
  domainName: string,
  serviceName: "nginx" | "apache2" | "httpd",
  options?: {
    forceRenewal?: boolean;
    certName?: string;
    domainNames?: string[];
  },
): Promise<SslCertificateResult> {
  const certbotCommand = await resolveCertbotCommand(server);
  const certName = options?.certName ?? domainName;
  const domainNames = normalizeIssuedDomainNames(
    options?.domainNames ?? [domainName],
  );
  const standaloneCommand = [
    `${certbotCommand} certonly --standalone --non-interactive --agree-tos`,
    buildCertbotEmailFlag(domainName),
    ...domainNames.map(
      (issuedDomainName) => `-d ${escapeShellArg(issuedDomainName)}`,
    ),
    `--cert-name ${escapeShellArg(certName)}`,
    "--expand",
    "--renew-with-new-domains",
    options?.forceRenewal ? "--force-renewal" : "--keep-until-expiring",
  ].join(" ");

  const script = [
    `systemctl stop ${escapeShellArg(serviceName)}`,
    `trap 'systemctl start ${escapeShellArg(serviceName)} >/dev/null 2>&1 || true' EXIT`,
    standaloneCommand,
    "status=$?",
    "trap - EXIT",
    `systemctl start ${escapeShellArg(serviceName)}`,
    "exit $status",
  ].join("\n");

  await execStrict(
    server,
    privilegedCommand(server, `bash -lc ${escapeShellArg(script)}`),
  );

  return readIssuedCertificate(server, certName);
}

function isPort80Conflict(output: string): boolean {
  return (
    output.includes("Could not bind TCP port 80") ||
    output.includes("Problem binding to port 80") ||
    output.includes("port 80 because it is already in use")
  );
}

function isCertbotAlreadyRunning(output: string): boolean {
  return /another instance of certbot is already running/i.test(output);
}

function isUnsupportedNoRandomSleepOption(output: string): boolean {
  return /(?:unrecognized arguments?|no such option|unknown option).*--no-random-sleep-on-renew/i.test(
    output,
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAcmeChallengeFailure(output: string): boolean {
  return /some challenges have failed|unauthorized|invalid response from|dns problem|no valid ip addresses found|nxdomain|servfail/i.test(
    output,
  );
}

function summarizeCertbotOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" | ");
}

async function describeAcmeChallengeFailure(
  server: Server,
  domainName: string,
  output: string,
): Promise<string | null> {
  if (!isAcmeChallengeFailure(output)) {
    return null;
  }

  const lookupResult = await exec(
    server,
    `bash -lc ${escapeShellArg(
      `if command -v getent >/dev/null 2>&1; then getent ahostsv4 ${escapeShellArg(domainName)} | awk '{print $1}' | sort -u; elif command -v host >/dev/null 2>&1; then host ${escapeShellArg(domainName)} | awk '/has address/ {print $4}' | sort -u; elif command -v nslookup >/dev/null 2>&1; then nslookup ${escapeShellArg(domainName)} 2>/dev/null | awk '/^Address: / {print $2}' | sort -u; fi`,
    )}`,
  ).catch(() => null);

  const resolvedIps = `${lookupResult?.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);

  if (resolvedIps.length === 0) {
    return `Let's Encrypt validation failed because ${domainName} does not currently resolve to a public IPv4 address from the server perspective. Ensure the DNS record exists and has propagated before generating SSL.`;
  }

  if (!resolvedIps.includes(server.ip.trim())) {
    return `Let's Encrypt validation failed because ${domainName} currently resolves to ${resolvedIps.join(", ")}, not to this server IP ${server.ip}. Update DNS or wait for propagation before generating SSL.`;
  }

  return `Let's Encrypt validation still failed even though ${domainName} resolves to this server. Ensure port 80 is publicly reachable, firewall/security group allows HTTP, and any CDN/proxy forwards the HTTP-01 challenge to the origin.`;
}

async function issueCertificateWithDetectedPlugin(
  server: Server,
  domainName: string,
  options?: {
    forceRenewal?: boolean;
    certName?: string;
    domainNames?: string[];
  },
): Promise<SslCertificateResult> {
  const certbotCommand = await resolveCertbotCommand(server);
  const webServer = await detectActiveWebServer(server);
  const domainNames = normalizeIssuedDomainNames(
    options?.domainNames ?? [domainName],
  );

  if (
    webServer !== "nginx" &&
    webServer !== "apache2" &&
    webServer !== "httpd"
  ) {
    throw new Error(
      `Port 80 is already in use and no compatible web server plugin (nginx/apache) ` +
        `is active on ${server.name}. Please either free port 80 or ensure nginx/apache ` +
        `is running before issuing the certificate for ${domainName}.`,
    );
  }

  const pluginFlag = webServer === "nginx" ? "--nginx" : "--apache";
  const webServerLabel = webServer === "nginx" ? "nginx" : "apache";
  const pluginCommand = [
    `${certbotCommand} certonly ${pluginFlag} --non-interactive --agree-tos`,
    buildCertbotEmailFlag(domainName),
    ...domainNames.map(
      (issuedDomainName) => `-d ${escapeShellArg(issuedDomainName)}`,
    ),
    `--cert-name ${escapeShellArg(options?.certName ?? domainName)}`,
    "--expand",
    "--renew-with-new-domains",
    options?.forceRenewal ? "--force-renewal" : "--keep-until-expiring",
  ].join(" ");

  try {
    await execStrict(server, privilegedCommand(server, pluginCommand));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isMissingCertbotWebServerPlugin(message)) {
      try {
        return await issueCertificateWithTemporaryWebServerStop(
          server,
          domainName,
          webServer,
          options,
        );
      } catch (standaloneError) {
        const standaloneMessage =
          standaloneError instanceof Error
            ? standaloneError.message
            : String(standaloneError);
        const challengeDiagnostic = await describeAcmeChallengeFailure(
          server,
          domainName,
          standaloneMessage,
        );

        throw new Error(
          challengeDiagnostic
            ? `${challengeDiagnostic} Certbot output: ${summarizeCertbotOutput(standaloneMessage)}`
            : `Port 80 is in use, the Certbot ${webServerLabel} plugin is not installed, and standalone fallback after temporarily stopping ${webServer} also failed: ${standaloneMessage}`,
        );
      }
    }

    throw new Error(
      `Port 80 is in use, so Certbot switched to the ${webServerLabel} plugin, ` +
        `but that also failed: ${message}`,
    );
  }

  return readIssuedCertificate(server, options?.certName ?? domainName);
}

function normalizeDomainName(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[.;]+$/g, "");

  if (!normalized) return null;
  if (normalized === "_" || normalized === "localhost") return null;
  if (normalized.includes("*") || normalized.startsWith("~")) return null;
  if (!normalized.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(normalized)) return null;

  return normalized;
}

function normalizeIssuedDomainNames(domainNames: string[]): string[] {
  return Array.from(
    new Set(
      domainNames
        .map((value) => normalizeDomainName(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

async function readIssuedCertificate(
  server: Server,
  domainName: string,
): Promise<SslCertificateResult> {
  const certPath = `/etc/letsencrypt/live/${domainName}/fullchain.pem`;
  const keyPath = `/etc/letsencrypt/live/${domainName}/privkey.pem`;

  const [certPem, keyPem, issuerOut, startDateOut, endDateOut] =
    await Promise.all([
      execStrict(
        server,
        privilegedCommand(server, `cat ${escapeShellArg(certPath)}`),
      ),
      execStrict(
        server,
        privilegedCommand(server, `cat ${escapeShellArg(keyPath)}`),
      ),
      execStrict(
        server,
        privilegedCommand(
          server,
          `openssl x509 -in ${escapeShellArg(certPath)} -noout -issuer | sed 's/^issuer=//'`,
        ),
      ),
      execStrict(
        server,
        privilegedCommand(
          server,
          `openssl x509 -in ${escapeShellArg(certPath)} -noout -startdate | cut -d= -f2-`,
        ),
      ),
      execStrict(
        server,
        privilegedCommand(
          server,
          `openssl x509 -in ${escapeShellArg(certPath)} -noout -enddate | cut -d= -f2-`,
        ),
      ),
    ]);

  const issuedAt = startDateOut.trim() ? new Date(startDateOut.trim()) : null;
  const expiresAt = endDateOut.trim() ? new Date(endDateOut.trim()) : null;

  return {
    issuer: issuerOut.trim() || "Let's Encrypt",
    certPem,
    keyPem,
    issuedAt: issuedAt && !Number.isNaN(issuedAt.getTime()) ? issuedAt : null,
    expiresAt:
      expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
  };
}

export async function listSslCertificates(
  server: Server,
): Promise<DiscoveredSslCertificate[]> {
  const certDirs = await exec(
    server,
    privilegedCommand(
      server,
      `bash -lc ${escapeShellArg(
        'for dir in /etc/letsencrypt/live/*; do if [ -d "$dir" ]; then basename "$dir"; fi; done 2>/dev/null',
      )}`,
    ),
  );

  const certNames = certDirs.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => name !== "README");

  if (certNames.length === 0) {
    return [];
  }

  const results: DiscoveredSslCertificate[] = [];

  for (const certName of certNames) {
    const certPath = `/etc/letsencrypt/live/${certName}/fullchain.pem`;
    const sanOutput = await exec(
      server,
      privilegedCommand(
        server,
        `openssl x509 -in ${escapeShellArg(certPath)} -noout -ext subjectAltName 2>/dev/null`,
      ),
    );

    const domainNames = Array.from(
      new Set(
        [
          certName,
          ...Array.from(sanOutput.stdout.matchAll(/DNS:([^,\s]+)/g)).map(
            (match) => match[1] || "",
          ),
        ]
          .map((value) => normalizeDomainName(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );

    if (domainNames.length === 0) {
      continue;
    }

    const details = await readIssuedCertificate(server, certName);
    results.push({
      certName,
      domainNames,
      ...details,
    });
  }

  return results.sort((left, right) =>
    left.certName.localeCompare(right.certName),
  );
}

async function findSslCertificateForDomain(
  server: Server,
  domainName: string,
): Promise<ResolvedSslCertificate | null> {
  const normalized = normalizeDomainName(domainName);
  if (!normalized) {
    return null;
  }

  let certificates: ResolvedSslCertificate[] = [];

  try {
    certificates = await listCertbotCertificateLineages(server);
  } catch {
    const discoveredCertificates = await listSslCertificates(server);
    certificates = discoveredCertificates.map(({ certName, domainNames }) => ({
      certName,
      domainNames,
    }));
  }

  return (
    certificates.find((certificate) =>
      certificate.domainNames.some((name) => name === normalized),
    ) ?? null
  );
}

export async function resolveSslCertificate(
  server: Server,
  domainName: string,
): Promise<ResolvedSslCertificate | null> {
  const certificate = await findSslCertificateForDomain(server, domainName);
  if (!certificate) {
    return null;
  }

  return {
    certName: certificate.certName,
    domainNames: certificate.domainNames,
  };
}

export async function deleteSslCertificate(
  server: Server,
  domainName: string,
): Promise<DeletedSslCertificateResult> {
  const certbotCommand = await resolveCertbotCommand(server);

  const certificate = await resolveSslCertificate(server, domainName);
  if (!certificate) {
    return {
      certName: domainName,
      domainNames: [domainName],
      deletedFromServer: false,
    };
  }

  const deleteCommand = [
    `${certbotCommand} delete --non-interactive`,
    `--cert-name ${escapeShellArg(certificate.certName)}`,
  ].join(" ");

  const deleteResult = await exec(
    server,
    privilegedCommand(server, `${deleteCommand} 2>&1`),
  );
  const deleteOutput = (deleteResult.stdout + deleteResult.stderr).trim();

  if (deleteResult.code !== 0) {
    throw new Error(
      deleteOutput ||
        `certbot delete failed for certificate lineage ${certificate.certName}`,
    );
  }

  return {
    certName: certificate.certName,
    domainNames: certificate.domainNames,
    deletedFromServer: true,
  };
}

export async function issueSslCertificate(
  server: Server,
  domainName: string,
  options?: {
    domainNames?: string[];
    certName?: string;
  },
): Promise<SslCertificateResult> {
  const issuedDomainNames = normalizeIssuedDomainNames(
    options?.domainNames ?? [domainName],
  );
  const primaryDomainName = normalizeDomainName(domainName);
  const certName = normalizeDomainName(options?.certName ?? domainName);

  if (!primaryDomainName) {
    throw new Error(`Invalid domain name: ${domainName}`);
  }

  if (issuedDomainNames.length === 0) {
    throw new Error("No valid exact domains were provided for SSL issuance");
  }

  if (!issuedDomainNames.includes(primaryDomainName)) {
    issuedDomainNames.unshift(primaryDomainName);
  }

  const certbotBinary = await resolveCertbotCommand(server);

  const certbotCommand = [
    `${certbotBinary} certonly --standalone --non-interactive --agree-tos`,
    buildCertbotEmailFlag(primaryDomainName),
    ...issuedDomainNames.map(
      (issuedDomainName) => `-d ${escapeShellArg(issuedDomainName)}`,
    ),
    `--cert-name ${escapeShellArg(certName ?? primaryDomainName)}`,
    "--expand",
    "--renew-with-new-domains",
    "--keep-until-expiring",
  ].join(" ");

  const issueResult = await exec(
    server,
    privilegedCommand(server, `${certbotCommand} 2>&1`),
  );
  const issueOutput = (issueResult.stdout + issueResult.stderr).trim();

  if (issueResult.code === 0) {
    return readIssuedCertificate(server, certName ?? primaryDomainName);
  }

  if (isPort80Conflict(issueOutput)) {
    return issueCertificateWithDetectedPlugin(server, primaryDomainName, {
      certName: certName ?? primaryDomainName,
      domainNames: issuedDomainNames,
    });
  }

  const challengeDiagnostic = await describeAcmeChallengeFailure(
    server,
    primaryDomainName,
    issueOutput,
  );

  if (challengeDiagnostic) {
    throw new Error(
      `${challengeDiagnostic} Certbot output: ${summarizeCertbotOutput(issueOutput)}`,
    );
  }

  throw new Error(
    issueOutput || `certbot issue failed for ${primaryDomainName}`,
  );
}

export async function renewSslCertificate(
  server: Server,
  domainName: string,
  options?: { onProgress?: (progress: SslRenewProgress) => void },
): Promise<SslRenewCertificateResult> {
  const certbotLockRetryIntervalMs = 5000;
  const certbotLockRetryTimeoutMs = 3 * 60 * 1000;
  const totalStartedAt = Date.now();
  const certbotBinary = await resolveCertbotCommand(server);
  const resolveStartedAt = Date.now();
  const certificate = await resolveSslCertificate(server, domainName);
  const resolveCertificateMs = Date.now() - resolveStartedAt;

  if (!certificate) {
    throw new Error(
      `certificate not found on server ${server.name} for domain ${domainName}`,
    );
  }

  options?.onProgress?.({
    stage: "CERTBOT_RENEW",
    message: `Resolved certificate lineage ${certificate.certName}; starting Certbot renewal`,
    timings: { resolveCertificateMs },
  });

  // Step 1: Use `certbot renew --cert-name` which reads the saved renewal config
  // (respects the original authenticator - webroot, nginx, apache, etc.)
  // Disable Certbot's random sleep because this is a user-triggered action.
  const buildRenewCommand = (includeNoRandomSleep: boolean) =>
    privilegedCommand(
      server,
      [
        `${certbotBinary} renew`,
        `--cert-name ${escapeShellArg(certificate.certName)}`,
        "--force-renewal",
        "--non-interactive",
        includeNoRandomSleep ? "--no-random-sleep-on-renew" : "",
        "2>&1",
      ]
        .filter(Boolean)
        .join(" "),
    );
  let renewCommand = buildRenewCommand(true);
  let retriedWithoutNoRandomSleep = false;
  let renewResult;
  let renewOutput = "";
  let certbotRenewMs = 0;
  let certbotLockWaitMs = 0;
  let certbotAttempts = 0;

  options?.onProgress?.({
    stage: "CERTBOT_RENEW",
    message: `Running Certbot renewal for ${certificate.certName}`,
    timings: { resolveCertificateMs },
  });

  /*
   * Older Certbot builds may not understand --no-random-sleep-on-renew.
   * Retry without it instead of failing the renewal on legacy hosts.
   */
  const retryWithoutNoRandomSleep = () => {
    retriedWithoutNoRandomSleep = true;
    renewCommand = buildRenewCommand(false);
    options?.onProgress?.({
      stage: "CERTBOT_RENEW",
      message:
        "Certbot on this server does not support no-random-sleep; retrying with legacy flags",
      timings: {
        resolveCertificateMs,
        certbotRenewMs,
        certbotLockWaitMs,
        certbotAttempts,
      },
    });
  };

  while (true) {
    certbotAttempts += 1;
    const certbotAttemptStartedAt = Date.now();
    renewResult = await exec(server, renewCommand);
    certbotRenewMs += Date.now() - certbotAttemptStartedAt;
    renewOutput = (renewResult.stdout + renewResult.stderr).trim();

    if (
      !retriedWithoutNoRandomSleep &&
      isUnsupportedNoRandomSleepOption(renewOutput)
    ) {
      retryWithoutNoRandomSleep();
      continue;
    }

    if (!isCertbotAlreadyRunning(renewOutput)) {
      break;
    }

    if (certbotLockWaitMs >= certbotLockRetryTimeoutMs) {
      throw new Error(
        `Another Certbot task is still running on ${server.name} after waiting ${Math.round(certbotLockWaitMs / 1000)}s. This usually means a cron/systemd/manual Certbot renewal is already in progress. Retry after that task finishes. Last output: ${renewOutput}`,
      );
    }

    options?.onProgress?.({
      stage: "CERTBOT_LOCK_WAIT",
      message: `Another Certbot task is running on ${server.name}; waiting ${certbotLockRetryIntervalMs / 1000}s before retry ${certbotAttempts + 1}`,
      timings: {
        resolveCertificateMs,
        certbotRenewMs,
        certbotLockWaitMs: certbotLockWaitMs + certbotLockRetryIntervalMs,
        certbotAttempts,
      },
    });

    await wait(certbotLockRetryIntervalMs);
    certbotLockWaitMs += certbotLockRetryIntervalMs;
  }

  const hasPort80Conflict = isPort80Conflict(renewOutput);

  if (!hasPort80Conflict && renewResult.code === 0) {
    const readStartedAt = Date.now();
    const renewedCertificate = await readIssuedCertificate(
      server,
      certificate.certName,
    );
    const readCertificateMs = Date.now() - readStartedAt;

    return {
      ...renewedCertificate,
      strategy: "renew",
      timings: {
        resolveCertificateMs,
        certbotRenewMs,
        readCertificateMs,
        certbotLockWaitMs,
        certbotAttempts,
        totalMs: Date.now() - totalStartedAt,
      },
    };
  }

  if (!hasPort80Conflict) {
    // Some other certbot error - surface it directly
    throw new Error(renewOutput || `certbot renew failed for ${domainName}`);
  }

  const fallbackStartedAt = Date.now();
  options?.onProgress?.({
    stage: "FALLBACK_ISSUE",
    message: `Port 80 is busy; switching to detected web server plugin for ${domainName}`,
    timings: {
      resolveCertificateMs,
      certbotRenewMs,
      certbotLockWaitMs,
      certbotAttempts,
    },
  });
  const renewedCertificate = await issueCertificateWithDetectedPlugin(
    server,
    domainName,
    {
      certName: certificate.certName,
      forceRenewal: true,
    },
  );

  return {
    ...renewedCertificate,
    strategy: "fallback-issue",
    timings: {
      resolveCertificateMs,
      certbotRenewMs,
      readCertificateMs: 0,
      fallbackIssueMs: Date.now() - fallbackStartedAt,
      certbotLockWaitMs,
      certbotAttempts,
      totalMs: Date.now() - totalStartedAt,
    },
  };
}
