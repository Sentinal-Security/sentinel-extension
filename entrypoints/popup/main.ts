import { browser } from "wxt/browser";

const SENTINEL_PORTAL_URL = "https://web-beta-orcin-33.vercel.app";

document.addEventListener("DOMContentLoaded", () => {
  const contentEl = document.getElementById("content");
  if (!contentEl) return;

  try {
    browser.runtime.sendMessage({ type: "GET_SENTINEL_STATUS" }).then((response: any) => {
      if (response && response.isLoggedIn && response.user) {
        renderLoggedIn(response.user);
      } else {
        browser.storage.local.get("sentinelSession").then((stored: any) => {
          const s = stored?.sentinelSession;
          if (s && s.isLoggedIn && s.user) {
            renderLoggedIn(s.user);
          } else {
            renderLoggedOut();
          }
        }).catch(() => renderLoggedOut());
      }
    }).catch(() => {
      renderLoggedOut();
    });
  } catch {
    renderLoggedOut();
  }

  function renderLoggedIn(user: any) {
    if (!contentEl) return;
    contentEl.innerHTML = `
      <div class="status-card">
        <div class="status-badge" style="color: #34d399;">
          <span class="dot online"></span>
          <span>Sentinel Connected</span>
        </div>
        <div class="user-info">${user.email || user.username || "Authenticated User"}</div>
        <div class="desc" style="margin-top: 6px;">
          Autofill bridge is active. When you launch vaulted credentials from the Sentinel Web Portal, this extension injects them directly into the target login form.
        </div>
      </div>
      <button id="openDashboardBtn" class="btn btn-primary">Open Sentinel Launchpad</button>
    `;

    document.getElementById("openDashboardBtn")?.addEventListener("click", () => {
      browser.tabs.create({ url: `${SENTINEL_PORTAL_URL}/dashboard` });
    });
  }

  function renderLoggedOut() {
    if (!contentEl) return;
    contentEl.innerHTML = `
      <div class="status-card">
        <div class="status-badge" style="color: #f87171;">
          <span class="dot offline"></span>
          <span>Authentication Required</span>
        </div>
        <div class="desc">
          You are not signed in to Sentinel Security. Please log in to your web portal account to enable credential autofill.
        </div>
      </div>
      <button id="loginBtn" class="btn btn-primary">Sign In to Sentinel</button>
    `;

    document.getElementById("loginBtn")?.addEventListener("click", () => {
      browser.tabs.create({ url: `${SENTINEL_PORTAL_URL}/login` });
    });
  }
});
