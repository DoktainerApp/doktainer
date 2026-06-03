import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagedNginxFileBase,
  buildManagedNginxSharedFileBase,
  getDomainConfigAnchor,
  getLegacyTwoLabelDomainConfigAnchor,
} from "../../src/server/services/domain-provisioning/names";

test("isolated nginx config uses a single domain file name", () => {
  assert.equal(
    buildManagedNginxFileBase("my-next-app", "app.example.com"),
    "app.example.com",
  );
});

test("shared nginx config anchor uses the common parent domain", () => {
  assert.equal(
    getDomainConfigAnchor([
      "api.example.com",
      "admin.example.com",
      "app.example.com",
    ]),
    "example.com",
  );

  assert.equal(
    buildManagedNginxSharedFileBase("my-next-app", [
      "api.example.com",
      "admin.example.com",
      "app.example.com",
    ]),
    "example.com",
  );
});

test("shared nginx config anchor keeps service files separate across roots", () => {
  assert.equal(
    getDomainConfigAnchor(["app.example.com", "app.example.net"]),
    "example.com",
  );

  assert.equal(
    buildManagedNginxSharedFileBase("my-next-app", [
      "*.example.com",
      "api.example.com",
    ]),
    "example.com",
  );
});

test("shared nginx config anchor respects public suffix domains", () => {
  assert.equal(
    getDomainConfigAnchor(["stream.appku.web.id"]),
    "appku.web.id",
  );

  assert.equal(getDomainConfigAnchor(["api.appku.co.id"]), "appku.co.id");
  assert.equal(
    getDomainConfigAnchor(["foo.example.co.uk"]),
    "example.co.uk",
  );

  assert.equal(
    buildManagedNginxSharedFileBase("livestream-app", [
      "stream.appku.web.id",
    ]),
    "appku.web.id",
  );

  assert.equal(
    getLegacyTwoLabelDomainConfigAnchor(["stream.appku.web.id"]),
    "web.id",
  );
});
