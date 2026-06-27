import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  addAuthStateListener,
  emitAuthStateChanged,
} from "../src/lib/auth-events";

let dispatchedEvents: string[] = [];

beforeEach(() => {
  dispatchedEvents = [];
  globalThis.window = {
    addEventListener: (event: string, _listener: EventListener) => {
      dispatchedEvents.push(`add:${event}`);
    },
    removeEventListener: (event: string, _listener: EventListener) => {
      dispatchedEvents.push(`remove:${event}`);
    },
    dispatchEvent: (event: Event) => {
      dispatchedEvents.push(`dispatch:${event.type}`);
      return true;
    },
  } as unknown as Window & typeof globalThis;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

test("emitAuthStateChanged dispatches the vps-auth-changed event on window", () => {
  emitAuthStateChanged();
  assert.ok(dispatchedEvents.includes("dispatch:vps-auth-changed"));
});

test("emitAuthStateChanged does nothing when window is undefined", () => {
  delete (globalThis as Record<string, unknown>).window;
  emitAuthStateChanged();
  assert.equal(dispatchedEvents.length, 0);
});

test("addAuthStateListener registers a listener on vps-auth-changed event", () => {
  addAuthStateListener(() => {});
  assert.ok(dispatchedEvents.includes("add:vps-auth-changed"));
});

test("addAuthStateListener returns a cleanup function that removes the listener", () => {
  const cleanup = addAuthStateListener(() => {});
  cleanup();
  assert.ok(dispatchedEvents.includes("remove:vps-auth-changed"));
});

test("addAuthStateListener returns noop when window is undefined", () => {
  delete (globalThis as Record<string, unknown>).window;
  const cleanup = addAuthStateListener(() => {});
  assert.equal(typeof cleanup, "function");
  // calling it should not throw
  cleanup();
});
