import { NodeSSH } from "node-ssh";
import { Server } from "@prisma/client";
import { decrypt } from "../../lib/crypto";

type ConnectionEntry = {
  fingerprint: string;
  ssh: NodeSSH;
};

type PendingConnection = {
  fingerprint: string;
  promise: Promise<NodeSSH>;
};

// A server can keep the same id while its SSH account changes. Keep the
// credential fingerprint beside the connection so a stale account is never
// reused after an update.
const pool = new Map<string, ConnectionEntry>();
const connectionPromises = new Map<string, PendingConnection>();
const connectionGenerations = new Map<string, number>();

function getConnectionFingerprint(server: Server): string {
  return JSON.stringify([
    server.ip,
    server.sshPort,
    server.username,
    server.authType,
    server.sshKeyEnc,
    server.passwordEnc,
  ]);
}

function attachConnectionLifecycle(serverId: string, ssh: NodeSSH): void {
  const connection = ssh.connection;
  if (!connection) return;

  const removeIfCurrent = () => {
    if (pool.get(serverId)?.ssh !== ssh) return;
    pool.delete(serverId);
  };

  connection.on("error", removeIfCurrent);
  connection.on("close", removeIfCurrent);
  connection.on("end", removeIfCurrent);
}

type SshConnectOptions = {
  readyTimeout?: number;
};

function buildConnectionOptions(
  server: Server,
  options: SshConnectOptions = {},
) {
  return {
    host: server.ip,
    port: server.sshPort,
    username: server.username,
    readyTimeout: options.readyTimeout ?? 10000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 2,
  };
}

async function connectSsh(
  ssh: NodeSSH,
  server: Server,
  options: SshConnectOptions = {},
): Promise<void> {
  const baseOpts = buildConnectionOptions(server, options);

  if (server.authType === "SSH_KEY") {
    if (!server.sshKeyEnc) {
      throw new Error("No SSH key configured for this server");
    }
    await ssh.connect({
      ...baseOpts,
      privateKey: decrypt(server.sshKeyEnc),
    });
    return;
  }

  if (server.authType === "PASSWORD") {
    if (!server.passwordEnc) {
      throw new Error("No SSH password configured for this server");
    }
    await ssh.connect({
      ...baseOpts,
      password: decrypt(server.passwordEnc),
    });
    return;
  }

  throw new Error("No SSH credentials configured for this server");
}

/**
 * Get or create an SSH connection for a server
 */
export async function getConnection(server: Server): Promise<NodeSSH> {
  const fingerprint = getConnectionFingerprint(server);

  // Return an existing connection only when it was created from the exact
  // same host and credentials.
  const existing = pool.get(server.id);
  if (existing?.fingerprint === fingerprint && existing.ssh.isConnected()) {
    return existing.ssh;
  }
  if (existing) closeConnection(server.id);

  const pending = connectionPromises.get(server.id);
  if (pending?.fingerprint === fingerprint) return pending.promise;
  if (pending) closeConnection(server.id);

  const generation = connectionGenerations.get(server.id) ?? 0;

  const connectPromise = (async () => {
    const ssh = new NodeSSH();
    await connectSsh(ssh, server);

    if ((connectionGenerations.get(server.id) ?? 0) !== generation) {
      ssh.dispose();
      throw new Error("SSH configuration changed while connecting; retry the request");
    }

    attachConnectionLifecycle(server.id, ssh);
    pool.set(server.id, { fingerprint, ssh });
    return ssh;
  })().finally(() => {
    if (connectionPromises.get(server.id)?.promise === connectPromise) {
      connectionPromises.delete(server.id);
    }
  });

  connectionPromises.set(server.id, { fingerprint, promise: connectPromise });
  return connectPromise;
}

/**
 * Close and remove a connection from the pool
 */
export function closeConnection(serverId: string): void {
  const conn = pool.get(serverId)?.ssh;
  pool.delete(serverId);
  connectionPromises.delete(serverId);
  connectionGenerations.set(
    serverId,
    (connectionGenerations.get(serverId) ?? 0) + 1,
  );

  try {
    conn?.dispose();
  } catch {
    // Ignore connection disposal races during keepalive timeout cleanup.
  }
}

export async function withIsolatedConnection<T>(
  server: Server,
  task: (ssh: NodeSSH) => Promise<T>,
  options: SshConnectOptions = {},
): Promise<T> {
  const ssh = new NodeSSH();

  try {
    await connectSsh(ssh, server, options);
    return await task(ssh);
  } finally {
    try {
      ssh.dispose();
    } catch {
      // Ignore disposal races for short-lived isolated probes.
    }
  }
}

/**
 * Test SSH connectivity — returns true/false
 */
export async function testConnection(server: Server): Promise<boolean> {
  try {
    await withIsolatedConnection(server, (ssh) => ssh.execCommand("echo ok"));
    return true;
  } catch {
    return false;
  }
}

export async function testConnectionDetailed(
  server: Server,
): Promise<{ connected: boolean; error?: string }> {
  try {
    const result = await withIsolatedConnection(server, (ssh) =>
      ssh.execCommand("echo ok"),
    );
    if (result.code !== 0) {
      return {
        connected: false,
        error: result.stderr || result.stdout || "SSH command failed",
      };
    }
    return { connected: true };
  } catch (err: unknown) {
    closeConnection(server.id);
    return {
      connected: false,
      error: err instanceof Error ? err.message : "SSH connection failed",
    };
  }
}
