import { browser } from "wxt/browser";

const DEFAULT_PORTAL_URL = "https://web-beta-orcin-33.vercel.app";

document.addEventListener("DOMContentLoaded", () => {
  const contentEl = document.getElementById("content");
  if (!contentEl) return;

  try {
    browser.runtime.sendMessage({ type: "GET_SENTINEL_STATUS" }).then((response: any) => {
      const portalUrl = response?.portalOrigin || DEFAULT_PORTAL_URL;
      if (response && response.isLoggedIn && response.user) {
        renderLoggedIn(response.user, portalUrl, response.servicesCount || 0);
      } else {
        browser.storage.local.get("sentinelSession").then((stored: any) => {
          const s = stored?.sentinelSession;
          if (s && s.isLoggedIn && s.user) {
            renderLoggedIn(
              s.user,
              s.portalOrigin || portalUrl,
              Array.isArray(s.services) ? s.services.length : 0
            );
          } else {
            renderLoggedOut(portalUrl);
          }
        }).catch(() => renderLoggedOut(portalUrl));
      }
    }).catch(() => {
      renderLoggedOut(DEFAULT_PORTAL_URL);
    });
  } catch {
    renderLoggedOut(DEFAULT_PORTAL_URL);
  }

  function renderLoggedIn(user: any, portalUrl: string, servicesCount: number) {
    if (!contentEl) return;
    contentEl.innerHTML = `
      <div class="status-card">
        <div class="status-badge" style="color: #34d399;">
          <span class="dot online"></span>
          <span>Sentinel Connected (${servicesCount} Linked ${servicesCount === 1 ? "App" : "Apps"})</span>
        </div>
        <div class="user-info">${user.email || user.username || "Authenticated User"}</div>
        <div class="desc" style="margin-top: 6px;">
          In-site authentication popup and autofill bridge are active. Open any linked website or launch from Sentinel Web Portal to authenticate and sign in automatically.
        </div>
      </div>
      <button id="openDashboardBtn" class="btn btn-primary">Open Sentinel Launchpad</button>
    `;

    document.getElementById("openDashboardBtn")?.addEventListener("click", () => {
      browser.tabs.create({ url: `${portalUrl}/dashboard` });
    });
  }

  function renderLoggedOut(portalUrl: string) {
    if (!contentEl) return;
    contentEl.innerHTML = `
      <div class="status-card">
        <div class="status-badge" style="color: #f87171;">
          <span class="dot offline"></span>
          <span>Authentication Required</span>
        </div>
        <div class="desc">
          You are not signed in to Sentinel Security. Please log in to your web portal account to enable in-site authentication and credential autofill.
        </div>
      </div>
      <button id="loginBtn" class="btn btn-primary">Sign In to Sentinel</button>
    `;

    document.getElementById("loginBtn")?.addEventListener("click", () => {
      browser.tabs.create({ url: `${portalUrl}/login` });
    });
  }
});
