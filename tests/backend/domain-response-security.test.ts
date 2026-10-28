import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publicSslCertSelect } from "../../src/server/routes/domains";

test("domain response certificate selection omits certificate and private key material", () => {
  assert.equal("keyPem" in publicSslCertSelect, false);
  assert.equal("certPem" in publicSslCertSelect, false);
  for (const field of ["id", "domainId", "issuer", "status", "expiresAt", "autoRenew"]) {
    assert.equal(publicSslCertSelect[field as keyof typeof publicSslCertSelect], true);
  }
});

test("domain list, sync, detail, create and update use the safe certificate selection", () => {
  const source = readFileSync("src/server/routes/domains.ts", "utf8");
  for (const [start, end] of [
    ['app.get("/"', 'app.post("/sync"'],
    ['app.post("/sync"', 'app.get("/:id"'],
    ['app.get("/:id"', 'app.post("/"'],
    ['app.post("/"', 'app.put("/:id"'],
    ['app.put("/:id"', 'app.delete("/:id"'],
  ]) {
    const block = source.slice(source.indexOf(start), source.indexOf(end));
    assert.match(block, /sslCert: \{ select: publicSslCertSelect \}/);
  }
  const getBlock = source.slice(source.indexOf('app.get("/:id"'), source.indexOf('app.post("/"'));
  assert.doesNotMatch(getBlock, /server: true/);
});
