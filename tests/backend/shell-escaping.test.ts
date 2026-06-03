import assert from "node:assert/strict";
import test from "node:test";

import { escapeShellArg } from "../../src/server/services/ssh-services/internal/shell";
import { formatServerActionError } from "../../src/server/routes/server-action-errors";

test("escapeShellArg preserves single quotes inside bash -lc payloads", () => {
  const command =
    "docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null | grep -E '0\\.0\\.0\\.0:(80|443)|:::(80|443)' || true";

  assert.equal(
    escapeShellArg(command),
    "'docker ps --format '\\''{{.Names}}|{{.Image}}|{{.Ports}}'\\'' 2>/dev/null | grep -E '\\''0\\.0\\.0\\.0:(80|443)|:::(80|443)'\\'' || true'",
  );
});

test("server action errors hide raw remote shell syntax failures", () => {
  const message = formatServerActionError(
    new Error(
      "Command failed: bash: -c: line 1: syntax error near unexpected token `|'",
    ),
    "Failed to restart service apache2",
  );

  assert.equal(
    message,
    "The remote host rejected the generated shell command before it could finish. Refresh the server snapshot and retry the action.",
  );
});

test("server action errors normalize host port conflicts", () => {
  const message = formatServerActionError(
    new Error(
      "Command failed: nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)",
    ),
    "Failed to restart web server",
  );

  assert.equal(
    message,
    "The service could not start because port 80 or 443 is already in use by another host process or Docker container.",
  );
});
