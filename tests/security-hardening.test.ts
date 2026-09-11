import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  clearLegacyAuthStorage,
  sensitiveStorageKeys,
  setSensitiveStorageItem,
} from "../src/lib/browser-storage.ts";
import {
  auth,
  getUser,
  setUser,
} from "../src/lib/api.ts";
import {
  consumeGithubManifestState,
  encodeGithubManifestState,
  storeGithubManifestState,
  type GithubManifestState,
} from "../src/lib/github-manifest-state.ts";
import {
  buildContentSecurityPolicy,
  securityHeaders,
} from "../src/lib/security-headers.ts";
import {
  buildTerminalWebSocketUrl,
  resolveWebSocketBaseUrl,
} from "../src/lib/websocket-security.ts";
import {
  sanitizeLogText,
  sanitizeTerminalStreamChunk,
} from "../src/lib/terminal-output.ts";

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
  location: Location & {
    replace: (url: string) => void;
  };
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  dispatchEvent: (event: Event) => boolean;
};

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

function createWindow(): TestWindow {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let pathname = "/";
  let search = "";

  return {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    location: {
      get pathname() {
        return pathname;
      },
      get search() {
        return search;
      },
      replace(url: string) {
        const target = new URL(url, "http://localhost");
        pathname = target.pathname;
        search = target.search;
      },
    } as TestWindow["location"],
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }

      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      const registered = listeners.get(event.type);
      if (!registered) {
        return true;
      }

      for (const listener of registered) {
        if (typeof listener === "function") {
          listener(event);
          continue;
        }

        listener.handleEvent(event);
      }

      return true;
    },
  } as TestWindow;
}

beforeEach(() => {
  globalThis.window = createWindow();
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalWindow === undefined) {
    delete globalThis.window;
    return;
  }

  globalThis.window = originalWindow;
});

test("removes legacy auth credentials without deleting organization preference", () => {
  window.localStorage.setItem("doktainer_token", "legacy-token");
  window.localStorage.setItem("doktainer_user", '{"id":"legacy"}');
  setSensitiveStorageItem(sensitiveStorageKeys.organization, "org-1");

  clearLegacyAuthStorage();

  assert.equal(window.localStorage.getItem("doktainer_token"), null);
  assert.equal(window.localStorage.getItem("doktainer_user"), null);
  assert.equal(
    window.localStorage.getItem(sensitiveStorageKeys.organization),
    "org-1",
  );
});

test("clears stored session and redirects to login on authenticated 401", async () => {
  setUser({
    id: "user-1",
    name: "User",
    email: "user@example.com",
    role: "OPERATOR",
  });
  let requestInit: RequestInit | undefined;

  globalThis.fetch = async (_input, init) => {
    requestInit = init;
    return new Response(
      JSON.stringify({
        success: false,
        error: "Unauthorized - session expired",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  await assert.rejects(() => auth.logout(), /Unauthorized - session expired/);

  assert.equal(getUser(), null);
  assert.equal(requestInit?.credentials, "include");
  assert.equal(
    (requestInit?.headers as Record<string, string>)["x-doktainer-request"],
    "1",
  );
  assert.equal(window.location.pathname, "/login");
  assert.equal(window.location.search, "?reason=session-expired");
});

test("stores and consumes GitHub manifest state as single-use session data", () => {
  const payload: GithubManifestState = {
    appName: "Doktainer GitHub App",
    configName: "primary",
    organizationScoped: true,
    organizationName: "acme",
    nonce: "nonce-123",
  };
  const rawState = encodeGithubManifestState(payload);

  storeGithubManifestState(rawState);

  assert.deepEqual(consumeGithubManifestState(rawState), payload);
  assert.equal(consumeGithubManifestState(rawState), null);
});

test("rejects mismatched GitHub manifest state", () => {
  const payload: GithubManifestState = {
    appName: "Doktainer GitHub App",
    configName: "primary",
    organizationScoped: false,
    organizationName: "",
    nonce: "nonce-123",
  };

  storeGithubManifestState(encodeGithubManifestState(payload));

  assert.equal(consumeGithubManifestState("tampered-state"), null);
});

test("builds baseline security headers with anti-clickjacking directives", () => {
  const headerMap = new Map(
    securityHeaders.map((header) => [header.key, header.value]),
  );
  const csp = buildContentSecurityPolicy();

  assert.equal(headerMap.get("X-Frame-Options"), "DENY");
  assert.equal(headerMap.get("X-Content-Type-Options"), "nosniff");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /connect-src 'self' http: https: ws: wss:/);
});

test("upgrades websocket URLs on secure origins and keeps terminal params encoded", () => {
  assert.equal(
    resolveWebSocketBaseUrl(undefined, "https://panel.example.com"),
    "wss://panel.example.com",
  );

  const target = new URL(
    buildTerminalWebSocketUrl({
      configuredUrl: "ws://panel.example.com/socket",
      browserOrigin: "https://panel.example.com",
      serverId: "server/id",
      cols: 120,
      rows: 40,
      sessionId: "session id",
      ticket: "ticket/with?chars",
    }),
  );

  assert.equal(target.protocol, "wss:");
  assert.equal(target.pathname, "/api/v1/terminal/ws/server%2Fid");
  assert.equal(target.searchParams.get("sessionId"), "session id");
  assert.equal(target.searchParams.get("ticket"), "ticket/with?chars");
});

test("sanitizes dangerous terminal and log control sequences", () => {
  const terminalChunk =
    "safe\u001b]0;window-title\u0007\u001b[31mred\u001b[0m\u0000text\b \b";
  const logChunk =
    "log\u001b]8;;https://attacker.example\u0007click\u001b]8;;\u0007\u001b[31mred\u001b[0m\u0007";

  assert.equal(
    sanitizeTerminalStreamChunk(terminalChunk),
    "safe\u001b[31mred\u001b[0mtext\b \b",
  );
  assert.equal(sanitizeLogText(logChunk), "logclickred");
});
