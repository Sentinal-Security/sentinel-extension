import { browser } from "wxt/browser";

export default defineContentScript({
  matches: [
    "https://web-beta-orcin-33.vercel.app/*",
    "http://localhost:3000/*",
  ],
  runAt: "document_start",
  main() {
    const EXTENSION_VERSION = "1.1.0";

    // 1. Mark DOM attribute immediately and maintain heartbeat
    function stampPresence() {
      try {
        if (document && document.documentElement) {
          document.documentElement.setAttribute("data-sentinel-extension", "active");
          document.documentElement.setAttribute("data-sentinel-version", EXTENSION_VERSION);
          document.documentElement.setAttribute("data-sentinel-heartbeat", String(Date.now()));
        }
      } catch {}
    }

    stampPresence();
    setInterval(stampPresence, 2000);

    // 2. Announce presence via custom event
    function broadcastPresence() {
      stampPresence();
      try {
        window.dispatchEvent(
          new CustomEvent("SENTINEL_EXTENSION_PONG", {
            detail: {
              active: true,
              version: EXTENSION_VERSION,
              timestamp: Date.now(),
            },
          })
        );
      } catch {}
    }

    // Answer live on-demand pings from the Web Portal
    window.addEventListener("SENTINEL_EXTENSION_PING", () => {
      broadcastPresence();
    });

    // Announce immediately and again upon DOM readiness
    broadcastPresence();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", broadcastPresence);
    }

    // 3. Inspect and relay session state to background worker
    function checkPortalSession() {
      let isLoggedIn = false;
      let user = null;

      try {
        const raw = localStorage.getItem("sentinel_session");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.user) {
            isLoggedIn = true;
            user = parsed.user;
          }
        }
      } catch {}

      try {
        browser.runtime.sendMessage({
          type: "SENTINEL_SESSION_UPDATE",
          session: { isLoggedIn, user },
        }).catch(() => {});
      } catch {}
    }

    checkPortalSession();
    setInterval(checkPortalSession, 3000);

    // Real-time synchronization when login/logout changes in local storage
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key === "sentinel_session") {
        checkPortalSession();
      }
    });

    window.addEventListener("SENTINEL_SESSION_RESPONSE", (e: any) => {
      if (e.detail) {
        try {
          browser.runtime.sendMessage({
            type: "SENTINEL_SESSION_UPDATE",
            session: e.detail,
          }).catch(() => {});
        } catch {}
      }
    });

    // 4. Relay authorized vault launches from the Sentinel Web Portal
    window.addEventListener("SENTINEL_VAULT_LAUNCH", (e: any) => {
      const detail = e.detail;
      if (!detail || !detail.destination || !detail.password) return;

      try {
        browser.runtime.sendMessage({
          type: "TRIGGER_VAULT_AUTOFILL",
          destination: detail.destination,
          username: detail.username,
          password: detail.password,
          appName: detail.appName,
        }).catch(() => {});
      } catch {}
    });
  },
});
