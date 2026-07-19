import { Server } from "@prisma/client";

export function privilegedCommand(server: Server, command: string): string {
  return server.username === "root" ? command : `sudo ${command}`;
}

export function nonInteractivePrivilegedCommand(
  server: Server,
  command: string,
): string {
  return server.username === "root" ? command : `sudo -n ${command}`;
}
