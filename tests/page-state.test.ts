import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  readCachedPageData,
  readStoredServerSelection,
  writeCachedPageData,
  storeServerSelection,
  clearLegacySensitivePageCaches,
} from "../src/lib/page-state";
import { sensitiveStorageKeys } from "../src/lib/browser-storage";
import { sanitizeDomainForCache } from "../src/lib/domain-cache";
import type { Domain } from "../src/lib/api";

const ORGANIZATION_STORAGE_KEY = sensitiveStorageKeys.organization;

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

type TestWindow = Window & {
  localStorage: Storage;
  sessionStorage: Storage;
};

const originalWindow = globalThis.window;

function createWindow(): TestWindow {
  return {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
  } as TestWindow;
}

beforeEach(() => {
  globalThis.window = createWindow();
});

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
    return;
  }

  globalThis.window = originalWindow;
});

test("stores selected server per organization", () => {
  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-a");
  storeServerSelection("databases", "server-a");

  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-b");

  assert.equal(readStoredServerSelection("databases"), "");

  storeServerSelection("databases", "server-b");

  assert.equal(readStoredServerSelection("databases"), "server-b");

  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-a");

  assert.equal(readStoredServerSelection("databases"), "server-a");
});

test("stores cached page data per organization", () => {
  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-a");
  writeCachedPageData("domains", { items: ["alpha"] }, "server-1");

  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-b");

  assert.equal(readCachedPageData("domains", "server-1"), null);

  writeCachedPageData("domains", { items: ["beta"] }, "server-1");

  assert.deepEqual(readCachedPageData("domains", "server-1"), {
    items: ["beta"],
  });

  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-a");

  assert.deepEqual(readCachedPageData("domains", "server-1"), {
    items: ["alpha"],
  });
});

test("removes legacy domain caches across organizations without deleting preferences or other caches", () => {
  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-a");
  storeServerSelection("domains", "server-a");
  writeCachedPageData("domains", { items: ["old"] }, "server-a");
  writeCachedPageData("domains", { items: ["old-all"] });
  writeCachedPageData("ssl", { domains: [{ sslCert: { keyPem: "test-only" } }] }, "server-a");
  writeCachedPageData("ssl", { domains: [{ sslCert: { status: "VALID" } }] }, "server-safe");
  writeCachedPageData("networks", { items: ["keep"] }, "server-a");
  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-b");
  writeCachedPageData("domains", { items: ["old-b"] }, "server-b");

  clearLegacySensitivePageCaches();
  assert.equal(readCachedPageData("domains", "server-b"), null);
  window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, "org-a");
  assert.equal(readCachedPageData("domains", "server-a"), null);
  assert.equal(readCachedPageData("domains"), null);
  assert.equal(readCachedPageData("ssl", "server-a"), null);
  assert.deepEqual(readCachedPageData("ssl", "server-safe"), { domains: [{ sslCert: { status: "VALID" } }] });
  assert.equal(readStoredServerSelection("domains"), "server-a");
  assert.deepEqual(readCachedPageData("networks", "server-a"), { items: ["keep"] });
});

test("SSL page cache keeps certificate metadata but excludes unexpected secret fields", () => {
  const domain = {
    id: "domain", sslCert: { id: "cert", domainId: "domain", issuer: "issuer", status: "VALID", issuedAt: null, expiresAt: null, autoRenew: true, keyPem: "test-secret", certPem: "test-certificate" },
  } as unknown as Domain;
  const safe = sanitizeDomainForCache(domain);
  assert.equal(safe.sslCert?.id, "cert");
  assert.equal("keyPem" in safe.sslCert!, false);
  assert.equal("certPem" in safe.sslCert!, false);
});
