import assert from "node:assert/strict";
import test from "node:test";

import { parseServerSentEventBlock } from "../src/lib/server-sent-events.ts";

test("SSE parser reads JSON events with CRLF delimiters", () => {
  assert.deepEqual(
    parseServerSentEventBlock(
      'event: log\r\ndata: {"id":1,"message":"building"}',
    ),
    { event: "log", data: { id: 1, message: "building" } },
  );
});

test("SSE parser preserves malformed plain-text data instead of throwing", () => {
  assert.deepEqual(
    parseServerSentEventBlock(
      "event: error\ndata: permission denied while trying to connect to /var/run/docker.sock",
    ),
    {
      event: "error",
      data: "permission denied while trying to connect to /var/run/docker.sock",
    },
  );
});
