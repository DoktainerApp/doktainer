import assert from "node:assert/strict";
import test from "node:test";
import { createLatestRequestGuard } from "../../src/lib/latest-request";

test("only the last request can update data when A, B, A responses arrive out of order", async () => {
  const begin = createLatestRequestGuard();
  const pending: Array<() => void> = [];
  const displayed: string[] = [];
  const start = (value: string) => {
    const isCurrent = begin();
    return new Promise<void>((resolve) => pending.push(() => {
      if (isCurrent()) displayed.push(value);
      resolve();
    }));
  };
  const requests = [start("A-old"), start("B"), start("A-new")];
  pending[2]();
  pending[1]();
  pending[0]();
  await Promise.all(requests);
  assert.deepEqual(displayed, ["A-new"]);
});
