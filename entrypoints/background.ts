import { browser } from "wxt/browser";

interface SessionUser {
  userId?: number;
  email?: string;
  fullName?: string;
  company?: string;
  role?: string;
  mfaEnabled?: boolean;
}

export interface ExtensionServiceItem {
  id: number | string;
  backendId?: number;
  name: string;
  category?: string;
  loginUrl: string;
  clientId?: string;
  isVault: boolean;
  vaultUsername?: string;
  mfaRequired: boolean;
}

interface SentinelSession {
  isLoggedIn: boolean;
  user: SessionUser | null;
  token?: string;
  portalOrigin?: string;
  services?: ExtensionServiceItem[];
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

const DEFAULT_PORTAL_ORIGIN = "https://web-beta-orcin-33.vercel.app";
const PROD_BACKEND_API = "https://backend-pi68.onrender.com";
const LOCAL_BACKEND_API = "http://localhost:8080";

const MULTI_TENANT_SUFFIXES = [
  ".vercel.app",
  ".onrender.com",
  ".netlify.app",
  ".github.io",
  ".pages.dev",
  ".railway.app",
  ".herokuapp.com",
  ".azurewebsites.net",
  ".firebaseapp.com",
  ".web.app",
  ".fly.dev",
  ".workers.dev",
];

const MULTI_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.ph",
  "edu.ph",
  "gov.ph",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "co.in",
  "co.nz",
  "co.za",
  "com.sg",
  "com.mx",
]);

export default defineBackground(() => {
  let sentinelSession: SentinelSession = {
    isLoggedIn: false,
    user: null,
    portalOrigin: DEFAULT_PORTAL_ORIGIN,
    services: [],
    lastChecked: null,
  };

  let lastKnownServices: ExtensionServiceItem[] = [];
  let lastKnownUserId: number | undefined = undefined;
  let lastBackendFetchAt = 0;

  let lastWrittenSessionSnapshot = "";

  // Secure ephemeral store: Map<tabId, EphemeralVaultItem>, mirrored to browser.storage.session
  const ephemeralVaultQueue = new Map<number, EphemeralVaultItem>();
  const sessionStorageApi = (browser.storage as any)?.session;

  function vaultStorageKey(tabId: number): string {
    return `vault_tab_${tabId}`;
  }

  async function setEphemeralVaultItem(tabId: number, item: EphemeralVaultItem): Promise<void> {
    ephemeralVaultQueue.set(tabId, item);
    if (sessionStorageApi?.set) {
      try {
        await sessionStorageApi.set({ [vaultStorageKey(tabId)]: item });
      } catch {}
    }
  }

  async function getEphemeralVaultItem(tabId: number): Promise<EphemeralVaultItem | null> {
    const mem = ephemeralVaultQueue.get(tabId);
    if (mem) return mem;
    if (sessionStorageApi?.get) {
      try {
        const res = await sessionStorageApi.get(vaultStorageKey(tabId));
        const stored = res?.[vaultStorageKey(tabId)] as EphemeralVaultItem | undefined;
        if (stored) {
          ephemeralVaultQueue.set(tabId, stored);
          return stored;
        }
      } catch {}
    }
    return null;
  }

  function getPortalOrigin(): string {
    return sentinelSession.portalOrigin || DEFAULT_PORTAL_ORIGIN;
  }

  function normalizeServices(raw: any[]): ExtensionServiceItem[] {
    if (!Array.isArray(raw)) return [];
    return raw
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

  function syncSessionState(session: any) {
    const isLoggedIn = Boolean(session?.isLoggedIn && session?.user);

    if (!isLoggedIn) {
      lastKnownServices = [];
      lastKnownUserId = undefined;
      sentinelSession = {
        isLoggedIn: false,
        user: null,
        token: undefined,
        portalOrigin: session?.portalOrigin || sentinelSession.portalOrigin || DEFAULT_PORTAL_ORIGIN,
        services: [],
        lastChecked: Date.now(),
      };
    } else {
      const incomingServices = normalizeServices(session?.services || []);
      const mergedServices =
        incomingServices.length > 0 ? incomingServices : sentinelSession.services || lastKnownServices;

      if (mergedServices.length > 0) {
        lastKnownServices = mergedServices;
      }
      if (session?.user?.userId) {
        lastKnownUserId = Number(session.user.userId);
      }

      sentinelSession = {
        isLoggedIn: true,
        user: session?.user || null,
        token: session?.token || sentinelSession.token,
        portalOrigin: session?.portalOrigin || sentinelSession.portalOrigin || DEFAULT_PORTAL_ORIGIN,
        services: mergedServices,
        lastChecked: Date.now(),
      };
    }

    const snapshot = JSON.stringify({
      isLoggedIn: sentinelSession.isLoggedIn,
      userId: sentinelSession.user?.userId,
      email: sentinelSession.user?.email,
      token: sentinelSession.token,
      portalOrigin: sentinelSession.portalOrigin,
      services: sentinelSession.services,
    });

    if (snapshot === lastWrittenSessionSnapshot) return;
    lastWrittenSessionSnapshot = snapshot;

    try {
      browser.storage.local.set({
        sentinelSession,
        lastKnownServices,
        lastKnownUserId: lastKnownUserId ?? null,
      });
    } catch {}
  }

  function zeroizeAndDelete(tabId: number) {
    const item = ephemeralVaultQueue.get(tabId);
    if (item) {
      item.password = null;
      item.username = null;
      ephemeralVaultQueue.delete(tabId);
    }
    if (sessionStorageApi?.remove) {
      try {
        sessionStorageApi.remove(vaultStorageKey(tabId)).catch(() => {});
      } catch {}
    }
  }

  // Restore stored session on initialization (awaitable to avoid MV3 worker wake-up races)
  const sessionReady = (async () => {
    try {
      const result: any = await browser.storage.local.get([
        "sentinelSession",
        "lastKnownServices",
        "lastKnownUserId",
      ]);
      if (result?.lastKnownServices && Array.isArray(result.lastKnownServices)) {
        lastKnownServices = result.lastKnownServices;
      }
      if (result?.lastKnownUserId) {
        lastKnownUserId = Number(result.lastKnownUserId);
      }
      if (result?.sentinelSession && !sentinelSession.lastChecked) {
        sentinelSession = {
          ...sentinelSession,
          ...result.sentinelSession,
          services:
            result.sentinelSession.services?.length > 0
              ? result.sentinelSession.services
              : lastKnownServices,
        };
      }
    } catch {}
    await probeOpenPortalTabs();
  })();

  // Probe any already-open Sentinel Web Portal tabs to sync session immediately after extension reload
  async function probeOpenPortalTabs(): Promise<void> {
    if (sentinelSession.isLoggedIn && sentinelSession.user?.userId) return;
    if (!browser.tabs?.query || !(browser as any).scripting?.executeScript) return;
    try {
      const tabs = await browser.tabs.query({
        url: [
          "https://web-beta-orcin-33.vercel.app/*",
          "https://sentinal-security.vercel.app/*",
          "http://localhost:3000/*",
          "http://127.0.0.1:3000/*",
        ],
      });
      for (const tab of tabs) {
        if (!tab.id) continue;
        try {
          const results = await (browser as any).scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const portalOrigin = window.location.origin;
              let user = null;
              let token = undefined;
              for (const k of ["sentinel_auth_session", "sentinel_session"]) {
                try {
                  const raw = localStorage.getItem(k);
                  if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed?.user) {
                      user = parsed.user;
                      token = parsed.token;
                      break;
                    }
                  }
                } catch {}
              }
              let services: any[] = [];
              if (user?.userId) {
                for (const sk of [
                  `sentinel_dashboard_integrations_u${user.userId}`,
                  "sentinel_dashboard_integrations",
                ]) {
                  try {
                    const rawS = localStorage.getItem(sk);
                    if (rawS) {
                      const parsedS = JSON.parse(rawS);
                      if (Array.isArray(parsedS)) {
                        services = parsedS;
                        break;
                      }
                    }
                  } catch {}
                }
              }
              return { isLoggedIn: Boolean(user), user, token, portalOrigin, services };
            },
          });
          const res = results?.[0]?.result;
          if (res?.isLoggedIn && res?.user) {
            syncSessionState(res);
            return;
          }
        } catch {}
      }
    } catch {}
  }

  // Dynamically fetch latest services from the backend API so newly added services work immediately
  async function refreshServicesFromBackend(force = false): Promise<ExtensionServiceItem[]> {
    const userId = sentinelSession.user?.userId || lastKnownUserId;
    if (!userId) {
      return sentinelSession.services?.length ? sentinelSession.services : lastKnownServices;
    }

    const now = Date.now();
    if (!force && now - lastBackendFetchAt < 8000 && (sentinelSession.services?.length || 0) > 0) {
      return sentinelSession.services!;
    }

    const isLocalPortal =
      getPortalOrigin().includes("localhost") || getPortalOrigin().includes("127.0.0.1");
    const apiCandidates = isLocalPortal
      ? [LOCAL_BACKEND_API, PROD_BACKEND_API]
      : [PROD_BACKEND_API];

    for (const base of apiCandidates) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const headers: Record<string, string> = { Accept: "application/json" };
        if (sentinelSession.token) {
          headers["Authorization"] = `Bearer ${sentinelSession.token}`;
        }
        const res = await fetch(`${base}/api/services?userId=${userId}`, {
          method: "GET",
          headers,
          cache: "no-store",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json?.data)) {
            lastBackendFetchAt = Date.now();
            const normalized = normalizeServices(json.data);
            sentinelSession.services = normalized;
            lastKnownServices = normalized;
            try {
              browser.storage.local.set({
                sentinelSession,
                lastKnownServices,
              });
            } catch {}
            return normalized;
          }
        }
      } catch {}
    }

    return sentinelSession.services?.length ? sentinelSession.services : lastKnownServices;
  }

  function parseUrlSafe(raw: string): URL | null {
    if (!raw || typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("/")) return null;
    try {
      const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      return new URL(withProto);
    } catch {
      return null;
    }
  }

  function stripWww(host: string): string {
    const lower = host.toLowerCase();
    return lower.startsWith("www.") && lower.length > 4 ? lower.slice(4) : lower;
  }

  function getRegistrableDomain(host: string): string {
    const clean = stripWww(host);
    if (clean === "localhost" || clean === "127.0.0.1") return clean;
    for (const suffix of MULTI_TENANT_SUFFIXES) {
      if (clean.endsWith(suffix)) {
        return clean; // Keep full subdomain on shared hosting platforms
      }
    }
    const parts = clean.split(".");
    if (parts.length <= 2) return clean;
    const lastTwo = parts.slice(-2).join(".");
    if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return lastTwo;
  }

  function isSafeHttpUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }

  function isSenderFromSentinelPortal(sender: any): boolean {
    const rawUrl = sender?.url || sender?.tab?.url || "";
    if (!rawUrl) return false;
    try {
      const parsed = new URL(rawUrl);
      return isSentinelPortalUrl(parsed);
    } catch {
      return false;
    }
  }

  function doesUrlMatchDestination(tabUrlStr: string | undefined, destinationStr: string): boolean {
    if (!tabUrlStr) return false;
    const tabUrl = parseUrlSafe(tabUrlStr);
    const destUrl = parseUrlSafe(destinationStr);
    if (!tabUrl || !destUrl) return false;
    const tabHost = stripWww(tabUrl.hostname);
    const destHost = stripWww(destUrl.hostname);
    if (tabHost === destHost) {
      if ((tabHost === "localhost" || tabHost === "127.0.0.1") && destUrl.port) {
        return tabUrl.port === destUrl.port;
      }
      return true;
    }
    return getRegistrableDomain(tabHost) === getRegistrableDomain(destHost);
  }

  function isSentinelPortalUrl(url: URL): boolean {
    const host = stripWww(url.hostname);
    if (
      host === "web-beta-orcin-33.vercel.app" ||
      host === "sentinal-security.vercel.app" ||
      host === "sentinel-control-green.vercel.app"
    ) {
      return true;
    }
    if ((host === "localhost" || host === "127.0.0.1") && (url.port === "3000" || url.port === "3004")) {
      return true;
    }
    return false;
  }

  function resolveDemoAppKey(url: URL | null, clientId?: string, name?: string): string | null {
    const host = url ? stripWww(url.hostname) : "";
    const port = url ? url.port : "";
    const cid = (clientId || "").toLowerCase();
    const nm = (name || "").toLowerCase();

    if (
      host === "demo-apps-blue.vercel.app" ||
      ((host === "localhost" || host === "127.0.0.1") && port === "3001") ||
      cid.includes("acme") ||
      nm.includes("acme hr")
    ) {
      return "acme_hr";
    }
    if (
      host === "demo-apps-sfjl.vercel.app" ||
      ((host === "localhost" || host === "127.0.0.1") && port === "3002") ||
      cid.includes("fintech") ||
      nm.includes("fintech payroll")
    ) {
      return "fintech_payroll";
    }
    if (
      host === "demo-apps-fjk5.vercel.app" ||
      ((host === "localhost" || host === "127.0.0.1") && port === "3003") ||
      cid.includes("devops") ||
      cid.includes("nexus") ||
      nm.includes("devops incident") ||
      nm.includes("nexus ops")
    ) {
      return "devops_incident";
    }
    return null;
  }

  function matchServiceForUrl(
    rawTabUrl: string,
    services: ExtensionServiceItem[]
  ): ExtensionServiceItem | null {
    const tabUrl = parseUrlSafe(rawTabUrl);
    if (!tabUrl || isSentinelPortalUrl(tabUrl)) return null;

    const tabHost = stripWww(tabUrl.hostname);
    const tabBaseDomain = getRegistrableDomain(tabHost);
    const tabDemoFamily = resolveDemoAppKey(tabUrl);

    let bestMatch: ExtensionServiceItem | null = null;
    let bestScore = 0;

    for (const service of services) {
      const serviceUrl = parseUrlSafe(service.loginUrl);
      const serviceDemoFamily = resolveDemoAppKey(serviceUrl, service.clientId, service.name);

      // 1. Check Demo App family equivalence (works across localhost:3001-3003 and vercel demo URLs)
      if (tabDemoFamily && serviceDemoFamily && tabDemoFamily === serviceDemoFamily) {
        const score = service.isVault ? 95 : 90;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = service;
        }
        continue;
      }

      if (!serviceUrl) continue;
      const serviceHost = stripWww(serviceUrl.hostname);

      // 2. Localhost / 127.0.0.1 port-exact match
      if (tabHost === "localhost" || tabHost === "127.0.0.1") {
        if (
          (serviceHost === "localhost" || serviceHost === "127.0.0.1") &&
          tabUrl.port === serviceUrl.port
        ) {
          const score = service.isVault ? 100 : 95;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = service;
          }
        }
        continue;
      }

      // 3. Exact hostname match (e.g. github.com === github.com)
      if (tabHost === serviceHost) {
        let score = service.isVault ? 85 : 80;
        if (
          serviceUrl.pathname &&
          serviceUrl.pathname !== "/" &&
          tabUrl.pathname.toLowerCase().startsWith(serviceUrl.pathname.toLowerCase())
        ) {
          score += 10;
        }
        if (score > bestScore) {
          bestScore = score;
          bestMatch = service;
        }
        continue;
      }

      // 4. Registrable base domain match (e.g. m.facebook.com or accounts.google.com)
      const serviceBaseDomain = getRegistrableDomain(serviceHost);
      if (tabBaseDomain && serviceBaseDomain && tabBaseDomain === serviceBaseDomain) {
        const score = service.isVault ? 75 : 70;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = service;
        }
      }
    }

    return bestMatch;
  }

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
      if (!isSenderFromSentinelPortal(sender)) {
        sendResponse({ success: false, reason: "UNTRUSTED_ORIGIN" });
        return true;
      }
      syncSessionState(message.session);
      if (sentinelSession.user?.userId && (!sentinelSession.services || sentinelSession.services.length === 0)) {
        refreshServicesFromBackend(true).catch(() => {});
      }
      sendResponse({ success: true, isLoggedIn: sentinelSession.isLoggedIn });
      return true;
    }

    // 2. Query session status from popup or bridge
    if (message.type === "GET_SENTINEL_STATUS") {
      sessionReady.then(async () => {
        if (sentinelSession.user?.userId) {
          await refreshServicesFromBackend(false);
        }
        sendResponse({
          isLoggedIn: sentinelSession.isLoggedIn,
          user: sentinelSession.user,
          portalOrigin: getPortalOrigin(),
          servicesCount: (sentinelSession.services || lastKnownServices).length,
          version: "1.2.0",
        });
      });
      return true;
    }

    // 3. Target site checks if current domain is tied to user's Sentinel Security account
    if (message.type === "CHECK_SITE_INTEGRATION") {
      sessionReady.then(async () => {
        const tabId = sender.tab?.id;
        // If this tab already has pending unlocked credentials, do not show the prompt
        if (tabId && (await getEphemeralVaultItem(tabId))) {
          sendResponse({ matched: false, hasPendingAutofill: true });
          return;
        }

        if (!sentinelSession.isLoggedIn || !sentinelSession.user?.userId) {
          await probeOpenPortalTabs();
        }

        const services = await refreshServicesFromBackend(false);
        const targetUrlStr = message.url || sender.tab?.url || "";
        let matchedService = matchServiceForUrl(targetUrlStr, services);

        // If user has not logged into Sentinel yet (so services catalog is not yet known),
        // still allow the in-site popup on login pages so clicking "Authenticate with Sentinel"
        // opens Sentinel /login, authenticates the user, resolves their service from the backend, and signs in.
        if (!matchedService && !sentinelSession.isLoggedIn && services.length === 0) {
          const parsed = parseUrlSafe(targetUrlStr);
          if (parsed && !isSentinelPortalUrl(parsed)) {
            const demoKey = resolveDemoAppKey(parsed);
            if (demoKey || message.hasPasswordInput) {
              const host = stripWww(parsed.hostname);
              let friendlyName = host;
              if (demoKey === "acme_hr") friendlyName = "Acme HR Portal";
              else if (demoKey === "fintech_payroll") friendlyName = "FinTech Payroll Portal";
              else if (demoKey === "devops_incident") friendlyName = "DevOps Incident Command";
              else if (host.includes("facebook.com")) friendlyName = "Facebook";
              else if (host.includes("github.com")) friendlyName = "GitHub";
              else if (host.includes("google.com")) friendlyName = "Google";

              matchedService = {
                id: "",
                name: friendlyName,
                loginUrl: targetUrlStr,
                clientId: demoKey || "",
                isVault: !demoKey,
                mfaRequired: true,
              };
            }
          }
        }

        if (!matchedService) {
          sendResponse({ matched: false });
          return;
        }

        sendResponse({
          matched: true,
          service: matchedService,
          isLoggedIn: sentinelSession.isLoggedIn,
          user: sentinelSession.user,
          portalOrigin: getPortalOrigin(),
        });
      });
      return true;
    }

    // 4. User clicked "Authenticate with Sentinel" inside the in-site popup on an external/integrated app
    if (message.type === "OPEN_SENTINEL_APPROVAL") {
      sessionReady.then(() => {
        const sourceTabId = sender.tab?.id;
        const service: ExtensionServiceItem | undefined = message.service;
        const currentUrl = message.currentUrl || sender.tab?.url || service?.loginUrl || "";
        const portalBase = getPortalOrigin().replace(/\/+$/, "");

        const params = new URLSearchParams();
        params.set("sentinel_ext_approve", "1");
        if (service?.backendId || service?.id) {
          params.set("service_id", String(service.backendId || service.id));
        }
        if (service?.name) {
          params.set("app_name", service.name);
        }
        if (currentUrl) {
          params.set("redirect_uri", currentUrl);
        }
        params.set("is_vault", service?.isVault ? "1" : "0");
        if (service?.clientId) {
          params.set("client_id", service.clientId);
        }
        if (sourceTabId !== undefined) {
          params.set("source_tab_id", String(sourceTabId));
        }

        const approvalUrl = `${portalBase}/login?${params.toString()}`;
        browser.tabs
          .create({ url: approvalUrl, active: true })
          .then((tab) => {
            sendResponse({ success: true, approvalTabId: tab?.id });
          })
          .catch((err: any) => {
            sendResponse({ success: false, error: String(err) });
          });
      });
      return true;
    }

    // 5. Vault launch or approval handoff initiated from Sentinel Web Portal (/dashboard or /login)
    if (message.type === "TRIGGER_VAULT_AUTOFILL") {
      if (!isSenderFromSentinelPortal(sender)) {
        sendResponse({ success: false, reason: "UNTRUSTED_ORIGIN" });
        return true;
      }
      sessionReady.then(async () => {
        if (message.session?.isLoggedIn && message.session?.user) {
          syncSessionState(message.session);
        }

        if (!sentinelSession.isLoggedIn) {
          sendResponse({ success: false, reason: "NOT_LOGGED_IN" });
          return;
        }

        const { destination, username, password, appName, sourceTabId, closeApprovalTab } = message;
        if (!destination || !password) {
          sendResponse({ success: false, reason: "INVALID_PAYLOAD" });
          return;
        }

        let sanitizedUrl = String(destination).trim();
        if (!/^https?:\/\//i.test(sanitizedUrl)) {
          sanitizedUrl = "https://" + sanitizedUrl;
        }
        if (!isSafeHttpUrl(sanitizedUrl)) {
          sendResponse({ success: false, reason: "INVALID_URL" });
          return;
        }

        const nonce =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : String(Math.random()) + Date.now().toString(36);

        const approvalSenderTabId = sender.tab?.id;

        // If triggered from an existing external tab's in-site popup, return to that tab and inject immediately
        if (sourceTabId !== undefined && sourceTabId !== null) {
          const targetTabId = Number(sourceTabId);
          if (!Number.isNaN(targetTabId)) {
            try {
              const existingTab = await browser.tabs.get(targetTabId);
              if (existingTab && existingTab.id) {
                await setEphemeralVaultItem(existingTab.id, {
                  nonce,
                  username: username || "",
                  password: password || "",
                  destination: sanitizedUrl,
                  appName: appName || "Application",
                  expiresAt: Date.now() + 60000,
                });

                await browser.tabs.update(existingTab.id, { active: true });

                setTimeout(() => {
                  browser.tabs
                    .sendMessage(
                      existingTab.id!,
                      {
                        type: "INJECT_CREDENTIALS",
                        username: username || "",
                        password: password || "",
                        appName: appName || "Application",
                      },
                      { frameId: 0 }
                    )
                    .catch(() => {});
                }, 150);

                if (closeApprovalTab && approvalSenderTabId && approvalSenderTabId !== existingTab.id) {
                  setTimeout(() => {
                    browser.tabs.remove(approvalSenderTabId).catch(() => {});
                  }, 450);
                }

                sendResponse({ success: true, tabId: existingTab.id, reusedTab: true });
                return;
              }
            } catch {
              // Source tab was closed; fall through to creating a fresh tab
            }
          }
        }

        try {
          browser.tabs
            .create({ url: sanitizedUrl, active: true })
            .then(async (tab) => {
              if (tab?.id) {
                await setEphemeralVaultItem(tab.id, {
                  nonce,
                  username: username || "",
                  password: password || "",
                  destination: sanitizedUrl,
                  appName: appName || "Application",
                  expiresAt: Date.now() + 60000, // 60-second validity window
                });
              }
              if (closeApprovalTab && approvalSenderTabId && approvalSenderTabId !== tab?.id) {
                setTimeout(() => {
                  browser.tabs.remove(approvalSenderTabId).catch(() => {});
                }, 450);
              }
              sendResponse({ success: true, tabId: tab?.id });
            })
            .catch((err: any) => {
              sendResponse({ success: false, reason: "TAB_CREATE_FAILED", error: String(err) });
            });
        } catch (err) {
          sendResponse({ success: false, reason: "TAB_CREATE_FAILED", error: String(err) });
        }
      });
      return true;
    }

    // 6. SSO redirect back to source tab when an SSO app was launched via the in-site popup
    if (message.type === "TRIGGER_SSO_REDIRECT") {
      if (!isSenderFromSentinelPortal(sender)) {
        sendResponse({ success: false, reason: "UNTRUSTED_ORIGIN" });
        return true;
      }
      sessionReady.then(async () => {
        const { destination, sourceTabId, closeApprovalTab } = message;
        const approvalSenderTabId = sender.tab?.id;
        if (!destination || !isSafeHttpUrl(String(destination))) {
          sendResponse({ success: false, reason: "INVALID_URL" });
          return;
        }

        if (sourceTabId !== undefined && sourceTabId !== null) {
          const targetTabId = Number(sourceTabId);
          if (!Number.isNaN(targetTabId)) {
            try {
              const existingTab = await browser.tabs.get(targetTabId);
              if (existingTab && existingTab.id) {
                await browser.tabs.update(existingTab.id, {
                  url: destination,
                  active: true,
                });
                if (closeApprovalTab && approvalSenderTabId && approvalSenderTabId !== existingTab.id) {
                  setTimeout(() => {
                    browser.tabs.remove(approvalSenderTabId).catch(() => {});
                  }, 350);
                }
                sendResponse({ success: true, tabId: existingTab.id });
                return;
              }
            } catch {}
          }
        }

        sendResponse({ success: false });
      });
      return true;
    }

    // 7. Target tab top frame requests pending credentials (do NOT allow hidden iframes to steal)
    if (message.type === "REQUEST_PENDING_CREDENTIALS") {
      const tabId = sender.tab?.id;
      const isTopFrame = sender.frameId === undefined || sender.frameId === 0;
      if (tabId && isTopFrame) {
        getEphemeralVaultItem(tabId).then((item) => {
          if (!item) {
            sendResponse({ hasCredentials: false });
            return;
          }
          if (item.expiresAt < Date.now() || !doesUrlMatchDestination(sender.tab?.url, item.destination)) {
            zeroizeAndDelete(tabId);
            sendResponse({ hasCredentials: false });
            return;
          }
          sendResponse({
            hasCredentials: true,
            username: item.username,
            password: item.password,
            appName: item.appName,
          });
        });
      } else {
        sendResponse({ hasCredentials: false });
      }
      return true;
    }

    // 8. Target tab confirms credentials were injected -> zeroize immediately
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
    browser.tabs.onUpdated.addListener(async (tabId: number, changeInfo: any, tab: any) => {
      if (changeInfo.status === "complete") {
        const item = await getEphemeralVaultItem(tabId);
        if (!item) return;
        if (item.expiresAt < Date.now() || !doesUrlMatchDestination(tab?.url, item.destination)) {
          zeroizeAndDelete(tabId);
          return;
        }
        setTimeout(async () => {
          const current = await getEphemeralVaultItem(tabId);
          if (!current) return;
          try {
            browser.tabs
              .sendMessage(
                tabId,
                {
                  type: "INJECT_CREDENTIALS",
                  username: current.username,
                  password: current.password,
                  appName: current.appName,
                },
                { frameId: 0 }
              )
              .catch(() => {});
          } catch {}
        }, 350);
      }
    });
  }
});
