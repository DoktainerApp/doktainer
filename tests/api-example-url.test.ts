import assert from "node:assert/strict";
import test from "node:test";
import { resolveApiExampleUrl } from "../src/lib/api-example-url";

test("uses the Panel Access URL stored in settings", () => {
  assert.equal(
    resolveApiExampleUrl({
      panelUrl: "https://panel.example.com/",
      browserOrigin: "http://192.168.1.20:3000",
      apiBaseUrl: "http://localhost:4000/api/v1",
    }),
    "https://panel.example.com/api/v1/servers",
  );
});

test("uses the active browser origin when the stored panel URL is a stale loopback default", () => {
  assert.equal(
    resolveApiExampleUrl({
      panelUrl: "http://localhost:3000",
      browserOrigin: "http://192.168.1.20:3000",
      apiBaseUrl: "http://localhost:4000/api/v1",
    }),
    "http://192.168.1.20:3000/api/v1/servers",
  );
});

test("keeps the stored loopback URL during local access", () => {
  assert.equal(
    resolveApiExampleUrl({
      panelUrl: "http://localhost:3000",
      browserOrigin: "http://127.0.0.1:3000",
      apiBaseUrl: "http://localhost:4000/api/v1",
    }),
    "http://localhost:3000/api/v1/servers",
  );
});

test("falls back to the configured API base when no public panel origin is available", () => {
  assert.equal(
    resolveApiExampleUrl({
      panelUrl: "not-a-url",
      browserOrigin: null,
      apiBaseUrl: "https://api.example.com/api/v1/",
    }),
    "https://api.example.com/api/v1/servers",
  );
});
