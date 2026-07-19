import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("server SSH updates invalidate terminal sessions and pooled connections", () => {
  const source = readFileSync("src/server/routes/servers.ts", "utf8");
  const updateRoute = source.slice(
    source.indexOf('// PUT /servers/:id'),
    source.indexOf('// DELETE /servers/:id'),
  );

  assert.match(updateRoute, /const sshConfigChanged =/);
  assert.match(updateRoute, /closeTerminalSessionsForServer\(id\)/);
  assert.match(updateRoute, /ssh\.closeConnection\(id\)/);
});

test("pooled SSH connections are bound to their credential fingerprint", () => {
  const source = readFileSync(
    "src/server/services/ssh-services/connection.ts",
    "utf8",
  );

  assert.match(source, /function getConnectionFingerprint/);
  assert.match(source, /server\.username/);
  assert.match(source, /server\.authType/);
  assert.match(source, /server\.sshKeyEnc/);
  assert.match(source, /server\.passwordEnc/);
  assert.match(source, /existing\?\.fingerprint === fingerprint/);
});
