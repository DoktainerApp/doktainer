import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeContainerConfigurationError } from "../../src/server/services/deployment-error.service";
import {
  extractContainerMemorySwapMb,
  resolveMemorySwapLimitMb,
} from "../../src/server/services/container-configuration.service";
import { buildDockerUpdateCommand } from "../../src/server/services/ssh-services/docker-containers";

test("resource update translates CPU cores and memory MB for Docker CLI", () => {
  assert.equal(
    buildDockerUpdateCommand("nextcloud-app1", {
      cpuLimit: 1,
      memoryLimitMb: 1024,
      memorySwapLimitMb: 2048,
    }),
    "docker update --cpus '1' --memory '1024m' --memory-swap '2048m' 'nextcloud-app1'",
  );
});

test("memory updates preserve or establish an explicit Docker swap policy", () => {
  assert.equal(
    extractContainerMemorySwapMb({ HostConfig: { MemorySwap: 0 } }),
    0,
  );
  assert.equal(
    extractContainerMemorySwapMb({ HostConfig: { MemorySwap: -1 } }),
    -1,
  );
  assert.equal(
    resolveMemorySwapLimitMb({
      currentMemoryLimitMb: 0,
      currentMemorySwapMb: 0,
      targetMemoryLimitMb: 1024,
    }),
    2048,
  );
  assert.equal(
    resolveMemorySwapLimitMb({
      currentMemoryLimitMb: 512,
      currentMemorySwapMb: 512,
      targetMemoryLimitMb: 1024,
    }),
    1024,
  );
  assert.equal(
    resolveMemorySwapLimitMb({
      currentMemoryLimitMb: 512,
      currentMemorySwapMb: -1,
      targetMemoryLimitMb: 1024,
    }),
    -1,
  );
});

test("resource update includes only fields selected by the caller", () => {
  assert.equal(
    buildDockerUpdateCommand("example", { cpuLimit: 0.5 }),
    "docker update --cpus '0.5' 'example'",
  );
  assert.equal(
    buildDockerUpdateCommand("example", { memoryLimitMb: 0 }),
    "docker update --memory '0' 'example'",
  );
  assert.equal(buildDockerUpdateCommand("example", {}), null);
});

test("resource update rejects invalid values before reaching Docker", () => {
  assert.throws(
    () => buildDockerUpdateCommand("example", { cpuLimit: -1 }),
    /CPU limit/,
  );
  assert.throws(
    () => buildDockerUpdateCommand("example", { memoryLimitMb: 1.5 }),
    /Memory limit/,
  );
  assert.throws(
    () =>
      buildDockerUpdateCommand("example", {
        memoryLimitMb: 1024,
        memorySwapLimitMb: 512,
      }),
    /Memory-swap limit/,
  );
});

test("container configuration errors expose safe actionable causes", () => {
  assert.equal(
    sanitizeContainerConfigurationError(
      new Error(
        "Command failed: Error response from daemon: Minimum memory limit allowed is 6MB",
      ),
    ),
    "The memory limit is below the minimum supported by the Docker host.",
  );
  assert.equal(
    sanitizeContainerConfigurationError(
      new Error(
        "Command failed: Memory limit should be smaller than already set memoryswap limit",
      ),
    ),
    "Docker rejected the memory limit because it conflicts with the container's existing memory-swap limit.",
  );
  assert.equal(
    sanitizeContainerConfigurationError(
      new Error("Command failed: docker update --cpus 1 secret-container"),
    ),
    "Failed to apply container configuration",
  );
  assert.equal(
    sanitizeContainerConfigurationError(
      new Error(
        "Command failed: Error response from daemon: Cannot update container abcdef123456: runtime rejected the limit",
      ),
    ),
    "Docker rejected the requested container configuration: Cannot update container [container]: runtime rejected the limit",
  );
});
