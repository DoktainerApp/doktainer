import assert from "node:assert/strict";
import test from "node:test";

import {
  filterSharedSslGroupMembersByRoot,
  selectBestDiscoveredSslCertificateByDomain,
} from "../../src/server/routes/ssl";

test("shared SSL renewal scopes members to the renewed root domain", () => {
  const candidates = [
    {
      id: "root",
      name: "example.com",
      configMode: "SHARED" as const,
      isPrimary: true,
      sslEnabled: true,
      autoRenew: true,
      targetContainerId: "container-1",
      targetPort: 80,
      targetContainer: null,
    },
    {
      id: "api",
      name: "api.example.com",
      configMode: "SHARED" as const,
      isPrimary: false,
      sslEnabled: true,
      autoRenew: true,
      targetContainerId: "container-2",
      targetPort: 8080,
      targetContainer: null,
    },
    {
      id: "other-root",
      name: "other.com",
      configMode: "SHARED" as const,
      isPrimary: true,
      sslEnabled: true,
      autoRenew: true,
      targetContainerId: "container-1",
      targetPort: 80,
      targetContainer: null,
    },
    {
      id: "other-api",
      name: "api.other.com",
      configMode: "SHARED" as const,
      isPrimary: false,
      sslEnabled: true,
      autoRenew: true,
      targetContainerId: "container-2",
      targetPort: 8080,
      targetContainer: null,
    },
  ];

  const members = filterSharedSslGroupMembersByRoot(candidates, {
    rootDomain: "example.com",
  });

  assert.deepEqual(
    members.map((member) => member.name),
    ["example.com", "api.example.com"],
  );
});

test("SSL sync keeps the newest discovered certificate for duplicate domains", () => {
  const oldExpiry = new Date("2026-07-01T00:00:00.000Z");
  const renewedExpiry = new Date("2026-09-01T00:00:00.000Z");

  const selected = selectBestDiscoveredSslCertificateByDomain([
    {
      certName: "example.com",
      domainNames: ["example.com", "api.example.com"],
      issuer: "Let's Encrypt",
      certPem: "old-cert",
      keyPem: "old-key",
      issuedAt: new Date("2026-04-01T00:00:00.000Z"),
      expiresAt: oldExpiry,
    },
    {
      certName: "example.com-0001",
      domainNames: ["example.com", "api.example.com"],
      issuer: "Let's Encrypt",
      certPem: "renewed-cert",
      keyPem: "renewed-key",
      issuedAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: renewedExpiry,
    },
  ]);

  assert.deepEqual(
    selected.map((item) => [
      item.domainName,
      item.certificate.certName,
      item.certificate.expiresAt,
    ]),
    [
      ["api.example.com", "example.com-0001", renewedExpiry],
      ["example.com", "example.com-0001", renewedExpiry],
    ],
  );
});
