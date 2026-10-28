import assert from "node:assert/strict";
import test from "node:test";
import { parseNetworkSyncDetails } from "../../src/server/services/ssh-services/docker-networks";

const network = { name: "bridge", driver: "bridge", scope: "local", containers: 0 };

test("network sync reads Docker network details and real container counts", () => {
  assert.deepEqual(parseNetworkSyncDetails(network, JSON.stringify([{ IPAM: { Config: [{ Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" }] }, Containers: { a: {}, b: {} } }])), {
    ...network, subnet: "172.20.0.0/16", gateway: "172.20.0.1", containers: 2,
  });
  assert.equal(parseNetworkSyncDetails(network, '[{"Containers":null}]').containers, 0);
});

test("network sync rejects incomplete or malformed inspect results instead of reporting zero", () => {
  for (const output of ["[]", "[{}]", '[{"Containers":[]}]', "not json"]) {
    assert.throws(() => parseNetworkSyncDetails(network, output));
  }
});
