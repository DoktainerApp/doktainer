import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDeploymentStrategy } from "../../src/server/services/deployment-strategy";

describe("deployment strategy", () => {
  it("uses atomic rename when no published ports are configured", () => {
    assert.equal(resolveDeploymentStrategy(""), "ATOMIC_RENAME");
    assert.equal(resolveDeploymentStrategy("   "), "ATOMIC_RENAME");
  });

  it("uses recreate with recovery when published ports are configured", () => {
    assert.equal(resolveDeploymentStrategy("8080:80"), "RECREATE_WITH_RECOVERY");
  });
});


