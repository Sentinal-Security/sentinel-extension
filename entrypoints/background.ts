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

  function zeroizeAndDelete(tabId: number) {
    const item = ephemeralVaultQueue.get(tabId);
    if (item) {
      item.password = null;
      item.username = null;
      ephemeralVaultQueue.delete(tabId);
    }
  }

  // Restore stored session on initialization (awaitable to avoid MV3 worker wake-up races)
  const sessionReady = (async () => {
    try {
      const result: any = await browser.storage.local.get("sentinelSession");
      if (result && result.sentinelSession && !sentinelSession.lastChecked) {
        sentinelSession = result.sentinelSession;
      }
    } catch {}
  })();

  // Clean expired pending injections periodically
  setInterval(() => {
    const now = Date.now();
    for (const [tabId, item] of ephemeralVaultQueue.entries()) {
      if (item.expiresAt < now) {
        zeroizeAndDelete(tabId);
      }
    }
  }, 10000);

  // If a pending target tab is closed by the user before autofill runs, purge credentials immediately
  if (browser.tabs && browser.tabs.onRemoved) {
    browser.tabs.onRemoved.addListener((tabId) => {
      zeroizeAndDelete(tabId);
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
      sessionReady.then(() => {
        sendResponse({
          isLoggedIn: sentinelSession.isLoggedIn,
          user: sentinelSession.user,
          version: "1.1.1",
        });
      });
      return true;
    }

    // 3. Vault launch initiated from Sentinel Web Portal
    if (message.type === "TRIGGER_VAULT_AUTOFILL") {
      sessionReady.then(() => {
        if (message.session?.isLoggedIn && message.session?.user) {
          syncSessionState(message.session);
        }

        if (!sentinelSession.isLoggedIn) {
          sendResponse({ success: false, reason: "NOT_LOGGED_IN" });
          return;
        }

        const { destination, username, password, appName } = message;
        if (!destination || !password) {
          sendResponse({ success: false, reason: "INVALID_PAYLOAD" });
          return;
        }

        let sanitizedUrl = String(destination).trim();
        if (!/^https?:\/\//i.test(sanitizedUrl)) {
          sanitizedUrl = "https://" + sanitizedUrl;
        }

        const nonce = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : String(Math.random()) + Date.now().toString(36);

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
          }).catch((err: any) => {
            sendResponse({ success: false, reason: "TAB_CREATE_FAILED", error: String(err) });
          });
        } catch (err) {
          sendResponse({ success: false, reason: "TAB_CREATE_FAILED", error: String(err) });
        }
      });
      return true;
    }

    // 4. Target tab top frame requests pending credentials (do NOT allow hidden iframes to steal)
    if (message.type === "REQUEST_PENDING_CREDENTIALS") {
      const tabId = sender.tab?.id;
      const isTopFrame = sender.frameId === undefined || sender.frameId === 0;
      if (tabId && isTopFrame && ephemeralVaultQueue.has(tabId)) {
        const item = ephemeralVaultQueue.get(tabId)!;
        if (item.expiresAt < Date.now()) {
          zeroizeAndDelete(tabId);
          sendResponse({ hasCredentials: false });
          return true;
        }
        sendResponse({
          hasCredentials: true,
          username: item.username,
          password: item.password,
          appName: item.appName,
        });
      } else {
        sendResponse({ hasCredentials: false });
      }
      return true;
    }

    // 5. Target tab confirms credentials were injected -> zeroize immediately
    if (message.type === "AUTOFILL_COMPLETED") {
      const tabId = sender.tab?.id;
      if (tabId) {
        zeroizeAndDelete(tabId);
      }
      sendResponse({ success: true });
      return true;
    }
  });

  // Watch for tab loading completion to dispatch injection into the top frame
  if (browser.tabs && browser.tabs.onUpdated) {
    browser.tabs.onUpdated.addListener((tabId: number, changeInfo: any) => {
      if (changeInfo.status === "complete" && ephemeralVaultQueue.has(tabId)) {
        const item = ephemeralVaultQueue.get(tabId)!;
        if (item.expiresAt < Date.now()) {
          zeroizeAndDelete(tabId);
          return;
        }
        setTimeout(() => {
          const current = ephemeralVaultQueue.get(tabId);
          if (!current) return;
          try {
            browser.tabs.sendMessage(
              tabId,
              {
                type: "INJECT_CREDENTIALS",
                username: current.username,
                password: current.password,
                appName: current.appName,
              },
              { frameId: 0 }
            ).catch(() => {});
          } catch {}
        }, 350);
      }
    });
  }
});
