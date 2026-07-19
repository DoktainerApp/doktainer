import { randomUUID } from "crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Server } from "@prisma/client";
import { authenticate, requireApiKeyPermission } from "../middleware/auth";
import { auditLog } from "../services/audit.service";
import { getAccessibleServer } from "../services/server-access.service";
import { exec, getConnection } from "../services/ssh.service";
import {
  consumeTerminalSocketTicket,
  issueTerminalSocketTicket,
} from "../services/terminal-ticket.service";
import type { TerminalSocketTarget } from "../services/terminal-ticket.service";

const SESSION_TTL_MS = 30 * 60 * 1000;
const TERMINAL_EXEC_TIMEOUT_MS = 20_000;
const terminalAccess = [
  authenticate,
  requireApiKeyPermission("write:containers"),
];

type TerminalStreamHandler = (data: Buffer) => void;

interface TerminalShellStream {
  stderr?: {
    on(event: "data", handler: TerminalStreamHandler): void;
    off(event: "data", handler: TerminalStreamHandler): void;
  };
  on(event: "data", handler: TerminalStreamHandler): void;
  on(event: "close", handler: () => void): void;
  off(event: "data", handler: TerminalStreamHandler): void;
  off(event: "close", handler: () => void): void;
  write(data: string | undefined): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  end?: () => void;
  close?: () => void;
  destroy?: () => void;
}

interface TerminalSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", handler: (raw: Buffer | string, isBinary: boolean) => void): void;
  on(event: "close" | "error", handler: () => void): void;
}

interface TerminalSession {
  id: string;
  userId?: string;
  serverId: string;
  serverName: string;
  serverIp: string;
  target: TerminalSocketTarget;
  shellStream: TerminalShellStream;
  createdAt: number;
  lastActiveAt: number;
  cols: number;
  rows: number;
  attachedSocket?: TerminalSocket;
  onData?: TerminalStreamHandler;
  onStdErr?: TerminalStreamHandler;
  onClose?: () => void;
}

const terminalSessions = new Map<string, TerminalSession>();

function getPublicSession(session: TerminalSession) {
  return {
    id: session.id,
    serverId: session.serverId,
    serverName: session.serverName,
    serverIp: session.serverIp,
    createdAt: new Date(session.createdAt).toISOString(),
    lastActiveAt: new Date(session.lastActiveAt).toISOString(),
    cols: session.cols,
    rows: session.rows,
  };
}

function detachSocket(session: TerminalSession) {
  if (session.onData) session.shellStream.off("data", session.onData);
  if (session.onStdErr)
    session.shellStream.stderr?.off("data", session.onStdErr);
  if (session.onClose) session.shellStream.off("close", session.onClose);
  session.onData = undefined;
  session.onStdErr = undefined;
  session.onClose = undefined;
  session.attachedSocket = undefined;
}

function destroySession(sessionId: string, message?: string) {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  const attachedSocket = session.attachedSocket;
  detachSocket(session);
  session.shellStream?.end?.();
  session.shellStream?.close?.();
  session.shellStream?.destroy?.();
  terminalSessions.delete(sessionId);

  if (attachedSocket?.readyState === 1) {
    if (message) {
      attachedSocket.send(JSON.stringify({ type: "error", data: message }));
    }
    attachedSocket.close();
  }
}

export function closeTerminalSessionsForServer(serverId: string): number {
  let closedSessions = 0;
  for (const [sessionId, session] of terminalSessions.entries()) {
    if (session.serverId !== serverId) continue;
    destroySession(
      sessionId,
      "SSH settings changed. Open a new terminal session to use the updated account.",
    );
    closedSessions += 1;
  }
  return closedSessions;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of terminalSessions.entries()) {
    if (session.attachedSocket) continue;
    if (now - session.lastActiveAt > SESSION_TTL_MS) {
      destroySession(sessionId);
    }
  }
}

function attachSocket(session: TerminalSession, socket: TerminalSocket) {
  detachSocket(session);
  session.attachedSocket = socket;
  session.lastActiveAt = Date.now();

  session.onData = (data: Buffer) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: "data", data: data.toString() }));
    }
  };
  session.onStdErr = (data: Buffer) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: "data", data: data.toString() }));
    }
  };
  session.onClose = () => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: "exit", data: "" }));
      socket.close();
    }
    destroySession(session.id);
  };

  session.shellStream.on("data", session.onData);
  session.shellStream.stderr?.on("data", session.onStdErr);
  session.shellStream.on("close", session.onClose);

  socket.send(
    JSON.stringify({
      type: "ready",
      sessionId: session.id,
      data: `Connected to ${session.serverName} (${session.serverIp})\r\n`,
    }),
  );
}

async function createTerminalSession(
  server: Server,
  userId: string | undefined,
  cols: number,
  rows: number,
  sessionId?: string,
  target: TerminalSocketTarget = { type: "shell" },
) {
  const ssh = await getConnection(server);
  const id = sessionId || randomUUID();

  const shellStream = await new Promise<TerminalShellStream>(
    (resolve, reject) => {
      const handleStream = (err: Error | undefined, stream: unknown) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stream as TerminalShellStream);
      };

      const pty = { term: "xterm-256color", cols, rows };
      if (target.type === "command") {
        ssh.connection!.exec(target.command, { pty }, handleStream);
        return;
      }

      ssh.connection!.shell(pty, handleStream);
    },
  );

  const session: TerminalSession = {
    id,
    userId,
    serverId: server.id,
    serverName: server.name,
    serverIp: server.ip,
    target,
    shellStream,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    cols,
    rows,
  };

  terminalSessions.set(id, session);
  return session;
}

/**
 * Terminal routes — WebSocket-based interactive SSH terminal
 * and HTTP endpoint for one-shot command execution
 */
export async function terminalRoutes(app: FastifyInstance) {
  app.get("/sessions", { preHandler: terminalAccess }, async (req, reply) => {
    pruneExpiredSessions();
    const sessions = [...terminalSessions.values()]
      .filter(
        (session) =>
          session.userId === req.userId && session.target.type === "shell",
      )
      .map(getPublicSession)
      .sort((left, right) =>
        right.lastActiveAt.localeCompare(left.lastActiveAt),
      );

    return reply.send({ success: true, data: sessions });
  });

  app.delete(
    "/sessions/:id",
    { preHandler: terminalAccess },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = terminalSessions.get(id);
      if (!session || session.userId !== req.userId) {
        return reply
          .status(404)
          .send({ success: false, error: "Session not found" });
      }

      destroySession(id);
      return reply.send({ success: true, message: "Session closed" });
    },
  );

  app.post("/ws-ticket", { preHandler: terminalAccess }, async (req, reply) => {
    const body = z
      .object({
        serverId: z.string().min(1),
        sessionId: z.string().trim().min(1).max(128).optional(),
        target: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("shell") }),
            z.object({
              type: z.literal("command"),
              command: z.string().trim().min(1).max(4096),
            }),
          ])
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });
    }

    const { serverId, sessionId, target } = body.data;
    const server = await getAccessibleServer(
      req.userId,
      serverId,
      req.organizationId,
    );

    if (!server) {
      return reply.status(403).send({
        success: false,
        error: "Forbidden — you do not have access to this server",
      });
    }

    const ticket = issueTerminalSocketTicket({
      userId: req.userId,
      organizationId: req.organizationId,
      serverId,
      sessionId,
      target: target ?? { type: "shell" },
    });

    return reply.send({
      success: true,
      data: {
        ticket: ticket.id,
        expiresAt: new Date(ticket.expiresAt).toISOString(),
      },
    });
  });

  // POST /terminal/exec — run a single command, get output
  app.post("/exec", { preHandler: terminalAccess }, async (req, reply) => {
    const body = z
      .object({
        serverId: z.string(),
        command: z.string().min(1).max(2048),
      })
      .safeParse(req.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ success: false, error: body.error.flatten() });

    const { serverId, command } = body.data;
    const server = await getAccessibleServer(
      req.userId,
      serverId,
      req.organizationId,
    );
    if (!server) {
      return reply.status(403).send({
        success: false,
        error: "Forbidden — you do not have access to this server",
      });
    }

    try {
      const result = await exec(server, command, {
        timeoutMs: TERMINAL_EXEC_TIMEOUT_MS,
        queueTimeoutMs: TERMINAL_EXEC_TIMEOUT_MS,
      });

      await auditLog({
        userId: req.userId,
        serverId,
        action: "TERMINAL_EXEC",
        category: "TERMINAL",
        level: "INFO",
        message: `Executed: ${command.slice(0, 80)}`,
      });

      return reply.send({
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      });
    } catch (err: unknown) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : "Terminal command failed",
      });
    }
  });

  // GET /terminal/ws/:serverId — WebSocket interactive shell
  app.get(
    "/ws/:serverId",
    { websocket: true },
    async (socket, req) => {
      pruneExpiredSessions();

      const { serverId } = req.params as { serverId: string };
      const {
        ticket,
        cols = "220",
        rows = "50",
        sessionId,
      } = req.query as {
        ticket?: string;
        cols?: string;
        rows?: string;
        sessionId?: string;
      };
      const socketTicket = consumeTerminalSocketTicket({
        ticketId: ticket,
        serverId,
        sessionId,
      });

      if (!socketTicket) {
        socket.send(
          JSON.stringify({
            type: "error",
            data: "Unauthorized — terminal ticket is missing, invalid, or expired",
          }),
        );
        socket.close();
        return;
      }

      req.userId = socketTicket.userId;
      req.organizationId = socketTicket.organizationId;
      const server = await getAccessibleServer(
        req.userId,
        serverId,
        req.organizationId,
      );

      if (!server) {
        socket.send(
          JSON.stringify({
            type: "error",
            data: "Forbidden — you do not have access to this server",
          }),
        );
        socket.close();
        return;
      }

      try {
        const parsedCols = parseInt(cols, 10) || 220;
        const parsedRows = parseInt(rows, 10) || 50;

        let session = sessionId ? terminalSessions.get(sessionId) : undefined;
        if (session && session.userId !== req.userId) {
          session = undefined;
        }

        if (!session) {
          session = await createTerminalSession(
            server,
            req.userId,
            parsedCols,
            parsedRows,
            sessionId,
            socketTicket.target,
          );
        }

        session.cols = parsedCols;
        session.rows = parsedRows;
        attachSocket(session, socket);

        // Client → Server: forward input / resize events
        socket.on("message", (raw: Buffer | string, isBinary: boolean) => {
          const rawText = typeof raw === "string" ? raw : raw.toString("utf8");

          if (isBinary) {
            if (session?.shellStream) {
              session.shellStream.write(rawText);
              session.lastActiveAt = Date.now();
            }
            return;
          }

          try {
            const msg = JSON.parse(rawText) as {
              type: string;
              data?: string;
              cols?: number;
              rows?: number;
            };

            if (msg.type === "input" && session?.shellStream) {
              session.shellStream.write(msg.data);
              session.lastActiveAt = Date.now();
            } else if (msg.type === "resize" && session?.shellStream) {
              session.cols = msg.cols ?? 220;
              session.rows = msg.rows ?? 50;
              session.shellStream.setWindow(session.rows, session.cols, 0, 0);
              session.lastActiveAt = Date.now();
            } else if (msg.type === "ping") {
              socket.send(JSON.stringify({ type: "pong" }));
            }
          } catch {
            // Ignore malformed control frames instead of leaking JSON into shell.
            if (rawText.trimStart().startsWith("{")) {
              return;
            }

            // Backward-compatible raw keypress handling.
            if (session?.shellStream) {
              session.shellStream.write(rawText);
              session.lastActiveAt = Date.now();
            }
          }
        });

        socket.on("close", () => {
          if (session) {
            session.lastActiveAt = Date.now();
            if (session.target.type === "command") {
              destroySession(session.id);
            } else {
              detachSocket(session);
            }
          }
        });

        socket.on("error", () => {
          if (session) {
            session.lastActiveAt = Date.now();
            if (session.target.type === "command") {
              destroySession(session.id);
            } else {
              detachSocket(session);
            }
          }
        });

        await auditLog({
          userId: req.userId,
          serverId,
          action: "TERMINAL_OPEN",
          category: "TERMINAL",
          level: "INFO",
          message: `Interactive shell opened on "${server.name}"`,
        });
      } catch (err: unknown) {
        socket.send(
          JSON.stringify({
            type: "error",
            data: `SSH error: ${err instanceof Error ? err.message : "connection failed"}`,
          }),
        );
        socket.close();
      }
    },
  );
}
