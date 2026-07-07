import type { SSHExecCommandResponse } from "node-ssh";
import { Server } from "@prisma/client";
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

import {
  closeConnection,
  getConnection,
  withIsolatedConnection,
} from "./connection";

const commandQueues = new Map<string, Promise<unknown>>();
const streamCommandQueues = new Map<string, Promise<unknown>>();
const commandLogSink = new AsyncLocalStorage<(data: string) => void>();
const commandRunContext = new AsyncLocalStorage<{
  runIdPrefix?: string;
  signal?: AbortSignal;
}>();

type ExecOptions = {
  timeoutMs?: number;
  queueTimeoutMs?: number;
};

const REMOTE_JOB_DIR = "/tmp/doktainer-process-jobs";

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeRunId(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
}

function buildTrackedCommand(command: string, runId: string) {
  const safeRunId = sanitizeRunId(runId);
  const script = [
    "set -euo pipefail",
    `RUN_DIR=${shellQuote(REMOTE_JOB_DIR)}`,
    `RUN_ID=${shellQuote(safeRunId)}`,
    'mkdir -p "$RUN_DIR"',
    'PID_FILE="$RUN_DIR/$RUN_ID.pid"',
    'rm -f "$PID_FILE"',
    'cleanup() { rm -f "$PID_FILE"; }',
    "trap cleanup EXIT",
    `setsid bash -lc ${shellQuote(command)} &`,
    "child=$!",
    'printf "%s" "$child" > "$PID_FILE"',
    "set +e",
    'wait "$child"',
    "code=$?",
    "set -e",
    'exit "$code"',
  ].join("\n");

  return `bash -lc ${shellQuote(script)}`;
}

async function terminateTrackedRemoteCommand(
  server: Server,
  runId: string,
  reason: string,
) {
  const safeRunId = sanitizeRunId(runId);
  const script = [
    "set -euo pipefail",
    `PID_FILE=${shellQuote(`${REMOTE_JOB_DIR}/${safeRunId}.pid`)}`,
    'if [ ! -f "$PID_FILE" ]; then exit 0; fi',
    'pid="$(cat "$PID_FILE" 2>/dev/null || true)"',
    'case "$pid" in ""|*[!0-9]*) rm -f "$PID_FILE"; exit 0 ;; esac',
    `printf "Terminating remote command ${safeRunId}: ${reason.replace(/"/g, "'")}\\n" >&2`,
    'kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || sudo -n kill -TERM -- "-$pid" 2>/dev/null || sudo -n kill -TERM "$pid" 2>/dev/null || true',
    "sleep 5",
    'kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || sudo -n kill -KILL -- "-$pid" 2>/dev/null || sudo -n kill -KILL "$pid" 2>/dev/null || true',
    'rm -f "$PID_FILE"',
  ].join("\n");

  try {
    await withIsolatedConnection(server, async (ssh) => {
      await ssh.execCommand(`bash -lc ${shellQuote(script)}`);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[ssh-cancel-failed] ${JSON.stringify({
        serverId: server.id,
        host: server.ip,
        runId: safeRunId,
        error: message,
      })}`,
    );
  }
}

function isRecoverableSshError(message: string): boolean {
  return (
    message.includes("Channel open failure") ||
    message.includes("Not connected") ||
    message.includes("No response from server") ||
    message.includes("Keepalive timeout") ||
    message.includes("client-timeout") ||
    message.includes("Timed out while waiting for handshake") ||
    message.includes("ECONNRESET")
  );
}

function logCommandTimeout(server: Server, command: string, timeoutMs: number) {
  const type = /\bdocker\s+exec\b/.test(command)
    ? "ssh-exec-timeout"
    : "ssh-timeout";
  console.warn(
    `[${type}] ${JSON.stringify({
      type,
      serverId: server.id,
      host: server.ip,
      duration: timeoutMs,
      command: command.slice(0, 160),
    })}`,
  );
}

function logQueueTimeout(server: Server, command: string, timeoutMs: number) {
  const type = /\bdocker\s+exec\b/.test(command)
    ? "ssh-exec-queue-timeout"
    : "ssh-queue-timeout";
  console.warn(
    `[${type}] ${JSON.stringify({
      type,
      serverId: server.id,
      host: server.ip,
      queueWait: timeoutMs,
      command: command.slice(0, 160),
    })}`,
  );
}

function enqueueCommand<T>(
  queue: Map<string, Promise<unknown>>,
  server: Server,
  command: string,
  task: () => Promise<T>,
  options: { queueTimeoutMs?: number } = {},
): Promise<T> {
  let started = false;
  let cancelled = false;
  const previous = queue.get(server.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (cancelled) {
        throw new Error("Command cancelled before execution");
      }

      started = true;
      return task();
    });

  const queued = next.finally(() => {
    if (queue.get(server.id) === queued) {
      queue.delete(server.id);
    }
  });
  queue.set(server.id, queued);

  const queueTimeoutMs = options.queueTimeoutMs;
  if (!queueTimeoutMs || queueTimeoutMs <= 0) {
    return queued;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled || started) {
        return;
      }

      settled = true;
      cancelled = true;
      logQueueTimeout(server, command, queueTimeoutMs);
      reject(
        new Error(
          `Command queue timed out after ${Math.ceil(queueTimeoutMs / 1000)}s`,
        ),
      );
    }, queueTimeoutMs);
    timeoutId.unref?.();

    void queued
      .then((value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function enqueueServerCommand<T>(
  server: Server,
  command: string,
  task: () => Promise<T>,
  options: { queueTimeoutMs?: number } = {},
): Promise<T> {
  return enqueueCommand(commandQueues, server, command, task, options);
}

function enqueueStreamCommand<T>(
  server: Server,
  command: string,
  task: () => Promise<T>,
): Promise<T> {
  return enqueueCommand(streamCommandQueues, server, command, task);
}

function withCommandTimeout<T>(
  execute: () => Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => void,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return execute();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      onTimeout();
      reject(
        new Error(`Command timed out after ${Math.ceil(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);

    void execute()
      .then((value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * Execute a command and return stdout/stderr
 */
export async function exec(
  server: Server,
  command: string,
  options: ExecOptions = {},
): Promise<SSHExecCommandResponse> {
  const logSink = commandLogSink.getStore();
  if (logSink) {
    let stdout = "";
    let code = 0;

    await streamCommand(
      server,
      command,
      (data) => {
        stdout += data;
        logSink(data);
      },
      (exitCode) => {
        code = exitCode;
      },
    );

    return {
      code,
      signal: null,
      stdout,
      stderr: "",
    };
  }

  return enqueueServerCommand(
    server,
    command,
    async () => {
      try {
        const ssh = await getConnection(server);
        return await withCommandTimeout(
          () => ssh.execCommand(command),
          options.timeoutMs,
          () => {
            logCommandTimeout(server, command, options.timeoutMs!);
            closeConnection(server.id);
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldRetry = isRecoverableSshError(message);

        if (!shouldRetry) {
          throw error;
        }

        closeConnection(server.id);
        const ssh = await getConnection(server);
        return withCommandTimeout(
          () => ssh.execCommand(command),
          options.timeoutMs,
          () => {
            logCommandTimeout(server, command, options.timeoutMs!);
            closeConnection(server.id);
          },
        );
      }
    },
    options,
  );
}

export async function execIsolated(
  server: Server,
  command: string,
  options?: { timeoutMs?: number },
): Promise<SSHExecCommandResponse> {
  const runOnce = () =>
    withIsolatedConnection(server, async (ssh) =>
      withCommandTimeout(
        () => ssh.execCommand(command),
        options?.timeoutMs,
        () => {
          logCommandTimeout(server, command, options!.timeoutMs!);
          try {
            ssh.dispose();
          } catch {
            // Ignore disposal races after timing out an isolated probe.
          }
        },
      ),
    );

  try {
    return await runOnce();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isRecoverableSshError(message)) {
      throw error;
    }

    return runOnce();
  }
}

/**
 * Execute command, throw on non-zero exit
 */
export async function execStrict(
  server: Server,
  command: string,
  options: ExecOptions = {},
): Promise<string> {
  const logSink = commandLogSink.getStore();
  if (logSink) {
    const runContext = commandRunContext.getStore();
    const runId = runContext?.runIdPrefix
      ? `${runContext.runIdPrefix}-${randomUUID()}`
      : undefined;
    let output = "";
    let exitCode = 0;

    await streamCommand(
      server,
      command,
      (data) => {
        output += data;
        logSink(data);
      },
      (code) => {
        exitCode = code;
      },
      {
        runId,
        signal: runContext?.signal,
        timeoutMs: options.timeoutMs,
      },
    );

    if (exitCode !== 0) {
      throw new Error(`Command failed: ${output.trim() || command}`);
    }

    return output;
  }

  const result = await exec(server, command, options);
  if (result.code !== 0) {
    const output = [result.stderr, result.stdout]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(`Command failed: ${output || command}`);
  }
  return result.stdout;
}

export function withCommandLogSink<T>(
  onData: (data: string) => void,
  execute: () => Promise<T>,
  options: { runIdPrefix?: string; signal?: AbortSignal } = {},
): Promise<T> {
  return commandLogSink.run(onData, () =>
    commandRunContext.run(options, execute),
  );
}

export async function execStrictIsolated(
  server: Server,
  command: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  const result = await execIsolated(server, command, options);
  if (result.code !== 0) {
    const output = [result.stderr, result.stdout]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(`Command failed: ${output || command}`);
  }
  return result.stdout;
}

// ─── Process streaming (for WebSocket terminal) ───────────────────────────────

export async function streamCommand(
  server: Server,
  command: string,
  onData: (data: string) => void,
  onClose: (code: number) => void,
  options: { timeoutMs?: number; signal?: AbortSignal; runId?: string } = {},
): Promise<void> {
  return enqueueStreamCommand(server, command, async () => {
    const ssh = await getConnection(server);
    const commandToRun = options.runId
      ? buildTrackedCommand(command, options.runId)
      : command;

    return new Promise((resolve, reject) => {
      let streamRef: { destroy: () => void } | null = null;
      let timeoutId: NodeJS.Timeout | null = null;
      let abortListener: ((event: Event) => void) | null = null;

      const terminate = (reason: string) => {
        if (options.runId) {
          void terminateTrackedRemoteCommand(server, options.runId, reason);
        }

        try {
          streamRef?.destroy();
        } catch {
          // Ignore stream races during remote cancellation.
        }

        closeConnection(server.id);
      };

      ssh.connection!.exec(commandToRun, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        streamRef = stream;
        let settled = false;
        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (abortListener && options.signal) {
            options.signal.removeEventListener("abort", abortListener);
          }
          stream.off("data", onStdout);
          stream.stderr?.off("data", onStderr);
          stream.off("close", onCloseStream);
          stream.off("end", onEnd);
          stream.off("error", onError);
          stream.stderr?.off("error", onError);
          stream.destroy();
        };
        const finish = (code = 0) => {
          if (settled) return;
          settled = true;
          onClose(code);
          cleanup();
          resolve();
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onStdout = (d: Buffer) => onData(d.toString());
        const onStderr = (d: Buffer) => onData(d.toString());
        const onCloseStream = (code: number) => finish(code);
        const onEnd = () => finish(0);
        const onError = (error: Error) => fail(error);

        stream.on("data", onStdout);
        stream.stderr?.on("data", onStderr);
        stream.on("close", onCloseStream);
        stream.on("end", onEnd);
        stream.on("error", onError);
        stream.stderr?.on("error", onError);

        if (options.timeoutMs && options.timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            if (settled) return;
            logCommandTimeout(server, command, options.timeoutMs!);
            terminate(
              `Command timed out after ${Math.ceil(options.timeoutMs! / 1000)}s`,
            );
            fail(
              new Error(
                `Command timed out after ${Math.ceil(options.timeoutMs! / 1000)}s`,
              ),
            );
          }, options.timeoutMs);
          timeoutId.unref?.();
        }

        if (options.signal) {
          if (options.signal.aborted) {
            terminate("Command cancelled");
            fail(new Error("Command cancelled"));
            return;
          }

          abortListener = () => {
            terminate("Command cancelled");
            fail(new Error("Command cancelled"));
          };
          options.signal.addEventListener("abort", abortListener, {
            once: true,
          });
        }
      });
    });
  });
}
