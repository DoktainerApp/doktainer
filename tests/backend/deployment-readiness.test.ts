import assert from "node:assert/strict";
import test from "node:test";
import {
  publishedHttpReadinessCandidates,
  waitForHttpReadiness,
} from "../../src/server/services/deployment-readiness.service";

const server = { id: "server-1" } as never;

test("published HTTP candidates normalize Docker host bindings", () => {
  assert.deepEqual(
    publishedHttpReadinessCandidates(
      "8085:80,0.0.0.0:8085:80,[::]:8085:80,5353:53/udp",
    ),
    ["http://127.0.0.1:8085/"],
  );
});

test("HTTP readiness accepts a reachable candidate endpoint", async () => {
  let command = "";
  const result = await waitForHttpReadiness(
    {
      server,
      upstream: "http://127.0.0.1:49152",
      hostHeader: "app.example.test",
      timeoutMs: 1_000,
    },
    {
      execStrict: async (_server, value) => {
        command = value;
        return "";
      },
      wait: async () => undefined,
    },
  );

  assert.equal(result.ready, true);
  assert.equal(result.attempts, 1);
  assert.match(command, /Host: app\.example\.test/);
  assert.match(command, /2\*\|3\*/);
  assert.doesNotMatch(command, /4\*/);
});

test("HTTP readiness rejects non-IP and non-HTTP probe targets", async () => {
  await assert.rejects(() =>
    waitForHttpReadiness(
      { server, upstream: "https://example.com" },
      {
        execStrict: async () => "",
        wait: async () => undefined,
      },
    ),
  );
  await assert.rejects(() =>
    waitForHttpReadiness(
      {
        server,
        upstream: "http://127.0.0.1:49152",
        hostHeader: "invalid host",
      },
      {
        execStrict: async () => "",
        wait: async () => undefined,
      },
    ),
  );
});
