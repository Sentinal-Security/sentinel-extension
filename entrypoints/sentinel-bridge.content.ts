import { browser } from "wxt/browser";

export default defineContentScript({
  matches: [
    "https://web-beta-orcin-33.vercel.app/*",
    "https://sentinal-security.vercel.app/*",
    "http://localhost:3000/*",
    "http://127.0.0.1:3000/*",
  ],
  runAt: "document_start",
  main() {
    const EXTENSION_VERSION = "1.2.0";

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

    function sanitizeServicesList(rawList: any[]): any[] {
      if (!Array.isArray(rawList)) return [];
      return rawList
        .filter((item) => item && (item.loginUrl || item.name))
        .map((item) => ({
          id: item.id,
          backendId: item.backendId ?? (typeof item.id === "number" ? item.id : undefined),
          name: item.name || "Application",
          category: item.category || "Enterprise Service",
          loginUrl: item.loginUrl || "",
          clientId: item.clientId || "",
          isVault: Boolean(
            item.isVault ||
              item.type === "vault" ||
              String(item.authProtocol || "").toLowerCase() === "vault"
          ),
          vaultUsername: item.vaultUsername || "",
          mfaRequired: Boolean(item.mfaRequired ?? item.metrics?.mfaRequired ?? true),
        }));
    }

    function readStoredServices(userId?: number): any[] {
      const keys = userId
        ? [`sentinel_dashboard_integrations_u${userId}`, "sentinel_dashboard_integrations"]
        : ["sentinel_dashboard_integrations"];
      for (const key of keys) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              return sanitizeServicesList(parsed);
            }
          }
        } catch {}
      }
      return [];
    }

    // 3. Inspect and relay session state + service metadata to background worker
    function readStoredPortalSession(): {
      isLoggedIn: boolean;
      user: any;
      token?: string;
      portalOrigin: string;
      services: any[];
    } {
      const portalOrigin = window.location.origin;
      for (const key of ["sentinel_auth_session", "sentinel_session"]) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.user) {
              const services = readStoredServices(parsed.user.userId);
              return {
                isLoggedIn: true,
                user: parsed.user,
                token: parsed.token,
                portalOrigin,
                services,
              };
            }
          }
        } catch {}
      }
      return {
        isLoggedIn: false,
        user: null,
        portalOrigin,
        services: [],
      };
    }

    function checkPortalSession() {
      const session = readStoredPortalSession();
      try {
        browser.runtime.sendMessage({
          type: "SENTINEL_SESSION_UPDATE",
          session,
        }).catch(() => {});
      } catch {}

      if (!session.isLoggedIn) {
        try {
          window.dispatchEvent(new CustomEvent("SENTINEL_GET_SESSION"));
        } catch {}
      }
    }

    checkPortalSession();
    setInterval(checkPortalSession, 3000);

    // Real-time synchronization when login/logout or integrations change in local storage
    window.addEventListener("storage", (e: StorageEvent) => {
      if (
        !e.key ||
        e.key === "sentinel_auth_session" ||
        e.key === "sentinel_session" ||
        e.key.startsWith("sentinel_dashboard_integrations")
      ) {
        checkPortalSession();
      }
    });

    window.addEventListener("SENTINEL_INTEGRATIONS_UPDATED", (e: any) => {
      const session = readStoredPortalSession();
      if (e?.detail?.apps && Array.isArray(e.detail.apps)) {
        session.services = sanitizeServicesList(e.detail.apps);
      }
      try {
        browser.runtime.sendMessage({
          type: "SENTINEL_SESSION_UPDATE",
          session,
        }).catch(() => {});
      } catch {}
    });

    window.addEventListener("SENTINEL_SESSION_RESPONSE", (e: any) => {
      if (e.detail) {
        const stored = readStoredPortalSession();
        const merged = {
          ...stored,
          ...e.detail,
          portalOrigin: window.location.origin,
          services:
            e.detail.services && Array.isArray(e.detail.services) && e.detail.services.length > 0
              ? sanitizeServicesList(e.detail.services)
              : stored.services,
        };
        try {
          browser.runtime.sendMessage({
            type: "SENTINEL_SESSION_UPDATE",
            session: merged,
          }).catch(() => {});
        } catch {}
      }
    });

    // 4. Relay authorized vault launches from the Sentinel Web Portal (/dashboard or /login approval)
    window.addEventListener("SENTINEL_VAULT_LAUNCH", async (e: any) => {
      const detail = e.detail;
      if (!detail || !detail.destination || !detail.password) {
        window.dispatchEvent(
          new CustomEvent("SENTINEL_VAULT_LAUNCH_RESULT", {
            detail: { success: false, reason: "INVALID_PAYLOAD" },
          })
        );
        return;
      }

      const session = readStoredPortalSession();

      try {
        if (session.isLoggedIn) {
          await browser.runtime.sendMessage({
            type: "SENTINEL_SESSION_UPDATE",
            session,
          }).catch(() => {});
        }

        const result = await browser.runtime.sendMessage({
          type: "TRIGGER_VAULT_AUTOFILL",
          destination: detail.destination,
          username: detail.username,
          password: detail.password,
          appName: detail.appName,
          sourceTabId: detail.sourceTabId,
          closeApprovalTab: detail.closeApprovalTab,
          session: session.isLoggedIn ? session : undefined,
        });

        window.dispatchEvent(
          new CustomEvent("SENTINEL_VAULT_LAUNCH_RESULT", {
            detail: result || { success: false, reason: "NO_RESPONSE" },
          })
        );
      } catch (err) {
        window.dispatchEvent(
          new CustomEvent("SENTINEL_VAULT_LAUNCH_RESULT", {
            detail: { success: false, reason: "BRIDGE_ERROR", error: String(err) },
          })
        );
      }
    });

    // 5. Relay SSO redirect handoffs back to an existing external/demo tab opened via in-site popup
    window.addEventListener("SENTINEL_SSO_REDIRECT", async (e: any) => {
      const detail = e.detail;
      if (!detail || !detail.destination) return;
      try {
        const result = await browser.runtime.sendMessage({
          type: "TRIGGER_SSO_REDIRECT",
          destination: detail.destination,
          sourceTabId: detail.sourceTabId,
          closeApprovalTab: detail.closeApprovalTab,
        });
        window.dispatchEvent(
          new CustomEvent("SENTINEL_SSO_REDIRECT_RESULT", {
            detail: result || { success: false },
          })
        );
      } catch (err) {
        window.dispatchEvent(
          new CustomEvent("SENTINEL_SSO_REDIRECT_RESULT", {
            detail: { success: false, error: String(err) },
          })
        );
      }
    });
  },
});
