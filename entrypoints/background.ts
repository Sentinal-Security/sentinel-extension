import { browser } from "wxt/browser";

interface SessionUser {
  userId?: number;
  email?: string;
  fullName?: string;
  company?: string;
  role?: string;
}

interface SentinelSession {
  isLoggedIn: boolean;
  user: SessionUser | null;
  lastChecked: number | null;
}

interface EphemeralVaultItem {
  nonce: string;
  username: string | null;
  password: string | null;
  destination: string;
  appName: string;
  expiresAt: number;
}

export default defineBackground(() => {
  let sentinelSession: SentinelSession = {
    isLoggedIn: false,
    user: null,
    lastChecked: null,
  };

  // Secure ephemeral store: Map<tabId, EphemeralVaultItem>
  const ephemeralVaultQueue = new Map<number, EphemeralVaultItem>();

  function syncSessionState(session: any) {
    sentinelSession = {
      isLoggedIn: Boolean(session?.isLoggedIn && session?.user),
      user: session?.user || null,
      lastChecked: Date.now(),
    };
    try {
      browser.storage.local.set({ sentinelSession });
    } catch {}
  }

  // Restore stored session on initialization
  try {
    browser.storage.local.get("sentinelSession").then((result: any) => {
      if (result && result.sentinelSession) {
        sentinelSession = result.sentinelSession;
      }
    });
  } catch {}

  // Clean expired pending injections periodically
  setInterval(() => {
    const now = Date.now();
    for (const [tabId, item] of ephemeralVaultQueue.entries()) {
      if (item.expiresAt < now) {
        // Zeroize memory
        item.password = null;
        item.username = null;
        ephemeralVaultQueue.delete(tabId);
      }
    }
  }, 10000);

  // If a pending target tab is closed by the user before autofill runs, purge credentials immediately
  if (browser.tabs && browser.tabs.onRemoved) {
    browser.tabs.onRemoved.addListener((tabId) => {
      if (ephemeralVaultQueue.has(tabId)) {
        const item = ephemeralVaultQueue.get(tabId)!;
        item.password = null;
        item.username = null;
        ephemeralVaultQueue.delete(tabId);
      }
    });
  }

  // Runtime message routing
  browser.runtime.onMessage.addListener((message: any, sender: any, sendResponse: any) => {
    if (!message || !message.type) return;

    // 1. Session state update from Sentinel Web Portal
    if (message.type === "SENTINEL_SESSION_UPDATE") {
      syncSessionState(message.session);
      sendResponse({ success: true, isLoggedIn: sentinelSession.isLoggedIn });
      return true;
    }

    // 2. Query session status from popup or bridge
    if (message.type === "GET_SENTINEL_STATUS") {
      sendResponse({
        isLoggedIn: sentinelSession.isLoggedIn,
        user: sentinelSession.user,
        version: "1.1.0",
      });
      return true;
    }

    // 3. Vault launch initiated from Sentinel Web Portal
    if (message.type === "TRIGGER_VAULT_AUTOFILL") {
      if (!sentinelSession.isLoggedIn) {
        sendResponse({ success: false, reason: "NOT_LOGGED_IN" });
        return true;
      }

      const { destination, username, password, appName } = message;
      if (!destination || !password) {
        sendResponse({ success: false, reason: "INVALID_PAYLOAD" });
        return true;
      }

      let sanitizedUrl = String(destination).trim();
      if (!/^https?:\/\//i.test(sanitizedUrl)) {
        sanitizedUrl = "https://" + sanitizedUrl;
      }

      const nonce = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : String(Math.random()) + Date.now().toString(36);

      // Open or switch to target tab
      try {
        browser.tabs.create({ url: sanitizedUrl, active: true }).then((tab) => {
          if (tab?.id) {
            ephemeralVaultQueue.set(tab.id, {
              nonce,
              username: username || "",
              password: password || "",
              destination: sanitizedUrl,
              appName: appName || "Application",
              expiresAt: Date.now() + 60000, // 60-second validity window
            });
          }
          sendResponse({ success: true, tabId: tab?.id });
        });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    // 4. Target tab requests pending credentials
    if (message.type === "REQUEST_PENDING_CREDENTIALS") {
      const tabId = sender.tab?.id;
      if (tabId && ephemeralVaultQueue.has(tabId)) {
        const item = ephemeralVaultQueue.get(tabId)!;
        // Fulfill request and immediately zeroize credentials
        const payload = {
          hasCredentials: true,
          username: item.username,
          password: item.password,
          appName: item.appName,
        };

        item.password = null;
        item.username = null;
        ephemeralVaultQueue.delete(tabId);

        sendResponse(payload);
      } else {
        sendResponse({ hasCredentials: false });
      }
      return true;
    }
  });

  // Watch for tab loading completion to dispatch injection
  if (browser.tabs && browser.tabs.onUpdated) {
    browser.tabs.onUpdated.addListener((tabId: number, changeInfo: any) => {
      if (changeInfo.status === "complete" && ephemeralVaultQueue.has(tabId)) {
        const item = ephemeralVaultQueue.get(tabId)!;
        setTimeout(() => {
          if (!ephemeralVaultQueue.has(tabId)) return;
          try {
            browser.tabs.sendMessage(tabId, {
              type: "INJECT_CREDENTIALS",
              username: item.username,
              password: item.password,
              appName: item.appName,
            }).then(() => {
              if (ephemeralVaultQueue.has(tabId)) {
                item.password = null;
                item.username = null;
                ephemeralVaultQueue.delete(tabId);
              }
            }).catch(() => {});
          } catch {}
        }, 500);
      }
    });
  }
});
