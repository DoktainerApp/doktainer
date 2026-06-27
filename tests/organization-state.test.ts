import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  addOrganizationStateListener,
  clearStoredOrganizationId,
  getStoredOrganizationId,
  setStoredOrganizationId,
} from "../src/lib/organization-state";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

let dispatchedEvents: string[] = [];

beforeEach(() => {
  dispatchedEvents = [];
  const storage = new MemoryStorage();
  globalThis.window = {
    localStorage: storage,
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

test("getStoredOrganizationId returns null when no organization is stored", () => {
  assert.equal(getStoredOrganizationId(), null);
});

test("setStoredOrganizationId stores the value and dispatches event", () => {
  setStoredOrganizationId("org-123");
  assert.equal(getStoredOrganizationId(), "org-123");
  assert.ok(dispatchedEvents.includes("dispatch:vps:organization-changed"));
});

test("setStoredOrganizationId with null clears the stored value", () => {
  setStoredOrganizationId("org-123");
  setStoredOrganizationId(null);
  assert.equal(getStoredOrganizationId(), null);
});

test("clearStoredOrganizationId clears the stored value", () => {
  setStoredOrganizationId("org-123");
  clearStoredOrganizationId();
  assert.equal(getStoredOrganizationId(), null);
});

test("addOrganizationStateListener registers listener and cleanup removes it", () => {
  const cleanup = addOrganizationStateListener(() => {});
  assert.ok(dispatchedEvents.includes("add:vps:organization-changed"));

  cleanup();
  assert.ok(dispatchedEvents.includes("remove:vps:organization-changed"));
});

test("addOrganizationStateListener returns noop when window is undefined", () => {
  delete (globalThis as Record<string, unknown>).window;
  const cleanup = addOrganizationStateListener(() => {});
  assert.equal(typeof cleanup, "function");
  // calling it should not throw
  cleanup();
});

test("setStoredOrganizationId does nothing when window is undefined", () => {
  delete (globalThis as Record<string, unknown>).window;
  setStoredOrganizationId("org-123");
  assert.equal(dispatchedEvents.length, 0);
});
