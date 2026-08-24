import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContainerCapabilities } from "../../src/server/services/container-capabilities.service";

describe("container capabilities", () => {
  it("keeps an imported manual container readable without inventing deployment actions", () => {
    const capabilities = buildContainerCapabilities({
      sourceType: "MANUAL",
      deployMode: null,
      hasDeploymentSource: false,
      hasGitSource: false,
      hasAppInstall: false,
      hasDeploymentHistory: false,
      redeployAvailable: false,
      rollbackAvailable: false,
    });

    assert.equal(capabilities.managed, false);
    assert.equal(capabilities.managementLabel, "Docker import");
    assert.equal(capabilities.editConfiguration.available, true);
    assert.equal(capabilities.redeploy.available, false);
    assert.equal(capabilities.rebuild.available, false);
    assert.equal(capabilities.rollback.available, false);
  });

  it("enables supported actions for a tracked Git single-container deployment", () => {
    const capabilities = buildContainerCapabilities({
      sourceType: "GIT_PROVIDER",
      deployMode: "DOCKERFILE",
      hasDeploymentSource: true,
      hasGitSource: true,
      hasAppInstall: false,
      hasDeploymentHistory: true,
      redeployAvailable: true,
      rollbackAvailable: true,
    });

    assert.equal(capabilities.managed, true);
    assert.equal(capabilities.managementLabel, "Doktainer managed");
    assert.equal(capabilities.redeploy.available, true);
    assert.equal(capabilities.rebuild.available, true);
    assert.equal(capabilities.rebuild.mode, "ORCHESTRATED_SINGLE_CONTAINER");
    assert.equal(capabilities.rollback.available, true);
  });

  it("labels Compose rebuild honestly and blocks per-container configuration editing", () => {
    const capabilities = buildContainerCapabilities({
      sourceType: "GIT_CLONE",
      deployMode: "COMPOSE",
      hasDeploymentSource: true,
      hasGitSource: true,
      hasAppInstall: false,
      hasDeploymentHistory: true,
      redeployAvailable: false,
      rollbackAvailable: false,
    });

    assert.equal(capabilities.editConfiguration.available, false);
    assert.match(capabilities.editConfiguration.reason ?? "", /Compose project/);
    assert.equal(capabilities.rebuild.available, true);
    assert.equal(capabilities.rebuild.mode, "COMPOSE_RECREATE");
    assert.match(capabilities.rebuild.reason ?? "", /not a safe/);
  });

  it("does not expose rebuild when source metadata is incomplete", () => {
    const capabilities = buildContainerCapabilities({
      sourceType: "GIT_CLONE",
      deployMode: "DOCKERFILE",
      hasDeploymentSource: true,
      hasGitSource: false,
      hasAppInstall: false,
      hasDeploymentHistory: false,
      redeployAvailable: false,
      rollbackAvailable: false,
    });

    assert.equal(capabilities.rebuild.available, false);
    assert.equal(capabilities.rebuild.mode, null);
    assert.match(capabilities.rebuild.reason ?? "", /missing or incomplete/);
  });

  it("supports App Installer rebuild without pretending that redeploy is available", () => {
    const capabilities = buildContainerCapabilities({
      sourceType: "APP_INSTALLER",
      deployMode: null,
      hasDeploymentSource: false,
      hasGitSource: false,
      hasAppInstall: true,
      hasDeploymentHistory: true,
      redeployAvailable: false,
      rollbackAvailable: false,
    });

    assert.equal(capabilities.managed, true);
    assert.equal(capabilities.rebuild.available, true);
    assert.equal(capabilities.rebuild.mode, "ORCHESTRATED_SINGLE_CONTAINER");
    assert.equal(capabilities.redeploy.available, false);
  });

  it("keeps redeploy and rollback eligibility independent", () => {
    const capabilities = buildContainerCapabilities({
      sourceType: "MANUAL",
      deployMode: null,
      hasDeploymentSource: false,
      hasGitSource: false,
      hasAppInstall: false,
      hasDeploymentHistory: true,
      redeployAvailable: true,
      rollbackAvailable: false,
    });

    assert.equal(capabilities.managementLabel, "Doktainer managed");
    assert.equal(capabilities.redeploy.available, true);
    assert.equal(capabilities.rollback.available, false);
    assert.equal(capabilities.rebuild.available, false);
  });
});
