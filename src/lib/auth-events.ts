const AUTH_EVENT = "vps-auth-changed";
const AUTH_CHANNEL = "doktainer-auth";

function getAuthChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return null;
  }
  return new BroadcastChannel(AUTH_CHANNEL);
}

export type AuthEventSource = "local" | "broadcast";

export function emitAuthStateChanged(broadcast = false) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_EVENT));
  if (broadcast) {
    const channel = getAuthChannel();
    channel?.postMessage({ type: AUTH_EVENT });
    channel?.close();
  }
}

export function addAuthStateListener(
  listener: (source: AuthEventSource) => void,
) {
  if (typeof window === "undefined") return () => {};

  const onLocalEvent = () => listener("local");
  window.addEventListener(AUTH_EVENT, onLocalEvent);
  const channel = getAuthChannel();
  const onChannelMessage = () => listener("broadcast");
  channel?.addEventListener("message", onChannelMessage);

  return () => {
    window.removeEventListener(AUTH_EVENT, onLocalEvent);
    channel?.removeEventListener("message", onChannelMessage);
    channel?.close();
  };
}
