import { Server } from "@prisma/client";
import type { SSHExecCommandResponse } from "node-ssh";

import { exec } from "../commands";
import { detectServerPlatform } from "../platform";

export const DOCKER_ACCESS_DENIED_MESSAGE =
  "Docker access was denied for the configured SSH user. Grant that user access to the Docker socket (usually by adding it to the docker group), or configure passwordless sudo for Docker commands, then reconnect and retry the deployment.";

function shouldRetryDockerWithSudo(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("permission denied") ||
    lower.includes("docker.sock") ||
    lower.includes("you must be root")
  );
}

export async function execDocker(
  server: Server,
  command: string,
  options: { timeoutMs?: number; queueTimeoutMs?: number } = {},
): Promise<SSHExecCommandResponse> {
  const directResult = await exec(server, command, options);
  if (directResult.code === 0 || server.username === "root") {
    return directResult;
  }

  const output = `${directResult.stderr || ""}\n${directResult.stdout || ""}`;
  if (!shouldRetryDockerWithSudo(output)) {
    return directResult;
  }

  const platform = await detectServerPlatform(server);
  if (!platform.sudoNonInteractive) {
    return directResult;
  }

  const sudoResult = await exec(server, `sudo -n ${command}`, options);
  return sudoResult.code === 0 ? sudoResult : directResult;
}

export function parseDockerJson<T>(output: string, operation: string): T {
  const normalized = output.trim();
  const lower = normalized.toLowerCase();

  if (
    lower.includes("permission denied") &&
    (lower.includes("docker.sock") ||
      lower.includes("docker daemon") ||
      lower.includes("docker api"))
  ) {
    throw new Error(DOCKER_ACCESS_DENIED_MESSAGE);
  }

  if (!normalized) {
    throw new Error(`${operation} returned an empty response from Docker`);
  }

  try {
    return JSON.parse(normalized) as T;
  } catch {
    throw new Error(`${operation} returned an invalid response from Docker`);
  }
}

export async function execDockerStrict(
  server: Server,
  command: string,
  options: { timeoutMs?: number; queueTimeoutMs?: number } = {},
): Promise<string> {
  const result = await execDocker(server, command, options);
  if (result.code !== 0) {
    throw new Error(`Command failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
