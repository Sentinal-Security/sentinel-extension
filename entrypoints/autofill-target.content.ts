import { browser } from "wxt/browser";

export default defineContentScript({
  matches: ["<all_urls>"],
  excludeMatches: [
    "https://web-beta-orcin-33.vercel.app/*",
    "https://sentinal-security.vercel.app/*",
    "https://sentinel-control-green.vercel.app/*",
    "http://localhost:3000/*",
    "http://127.0.0.1:3000/*",
    "http://localhost:3004/*",
    "http://127.0.0.1:3004/*",
  ],
  allFrames: true,
  runAt: "document_idle",
  main() {
    let autofillStarted = false;
    let autofillCompletedAt = 0;
    let promptDismissedForPath: string | null = null;
    let currentPromptHost: HTMLElement | null = null;
    let currentPromptShadow: ShadowRoot | null = null;
    let activePromptServiceId: string | number | null = null;

    function isVisibleInput(el: HTMLInputElement): boolean {
      if (!el || el.disabled || el.readOnly) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    // Native prototype property setter to bypass React 16-19 controlled input overrides
    function setNativeInputValue(element: HTMLInputElement, value: string) {
      if (!element || value === undefined || value === null) return;
      try {
        element.focus();

        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

        if (descriptor && descriptor.set) {
          descriptor.set.call(element, value);
        } else {
          element.value = value;
        }

        // Dispatch standard synthetic input and change events (never Enter, which can submit prematurely)
        element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true, cancelable: true }));
      } catch {}
    }

    // Smart input field resolution across classic forms and React SPAs (Facebook, GitHub, Google, etc.)
    function findFormFields(): {
      usernameInput: HTMLInputElement | null;
      passwordInput: HTMLInputElement | null;
    } {
      const passwordInputs = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="password"], input#pass, input[name="pass"]')
      ).filter((el) => isVisibleInput(el));

      const passwordInput = passwordInputs[0] || null;

      let usernameInput: HTMLInputElement | null = null;

      if (passwordInput && passwordInput.form) {
        const formInputs = Array.from(
          passwordInput.form.querySelectorAll<HTMLInputElement>(
            'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"])'
          )
        ).filter((el) => isVisibleInput(el));

        usernameInput =
          formInputs.find((el) => {
            const str = (
              el.name +
              " " +
              el.id +
              " " +
              el.placeholder +
              " " +
              el.type +
              " " +
              (el.getAttribute("autocomplete") || "")
            ).toLowerCase();
            return (
              str.includes("email") ||
              str.includes("user") ||
              str.includes("login") ||
              str.includes("account") ||
              str.includes("phone")
            );
          }) ||
          formInputs[0] ||
          null;
      }

      if (!usernameInput) {
        const candidates = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input#email, input[name="email"], input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="email" i], input[id*="email" i], input[id*="user" i], input[placeholder*="email" i], input[placeholder*="user" i]'
          )
        ).filter((el) => isVisibleInput(el));
        usernameInput = candidates[0] || null;
      }

      if (!usernameInput && passwordInput) {
        const allTextInputs = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
          )
        ).filter((el) => isVisibleInput(el));
        for (let i = allTextInputs.length - 1; i >= 0; i--) {
          const candidate = allTextInputs[i];
          if (
            candidate.compareDocumentPosition(passwordInput) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ) {
            usernameInput = candidate;
            break;
          }
        }
      }

      return { usernameInput, passwordInput };
    }

    function findSubmitButton(
      form: HTMLFormElement | null,
      passwordInput?: HTMLInputElement | null
    ): HTMLElement | null {
      const explicitSelectors = [
        'button[name="login"]',
        "#loginbutton",
        '[data-testid*="royal-login" i]',
        '[data-testid*="royal_login" i]',
        'button[type="submit"]',
        'input[type="submit"]',
        '[role="button"][aria-label*="log in" i]',
        '[role="button"][aria-label*="sign in" i]',
      ];
      const scope: ParentNode =
        form ||
        passwordInput?.closest("form, [role='dialog'], main, section, div") ||
        document;

      for (const selector of explicitSelectors) {
        const el = scope.querySelector<HTMLElement>(selector);
        if (el) return el;
      }

      // Check buttons by visible text (Sign In, Log In, Submit, Continue, Next)
      const buttons = Array.from(
        (form || document).querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"]')
      );
      const byText = buttons.find((btn) => {
        const text = (
          (btn.textContent || "") +
          " " +
          (btn.getAttribute("value") || "") +
          " " +
          (btn.getAttribute("aria-label") || "")
        )
          .trim()
          .toLowerCase();
        return /\b(sign in|log in|login|submit|continue|authorize)\b/.test(text);
      });
      if (byText) return byText;

      if (form) {
        return form.querySelector<HTMLElement>('button:not([type="button"])');
      }
      return null;
    }

    function removeInPagePrompt() {
      if (currentPromptHost && currentPromptHost.parentNode) {
        currentPromptHost.parentNode.removeChild(currentPromptHost);
      }
      currentPromptHost = null;
      currentPromptShadow = null;
      activePromptServiceId = null;
    }

    function setPromptApprovedState(appName?: string) {
      if (!currentPromptShadow) return;
      const statusBox = currentPromptShadow.getElementById("sentinel-prompt-body");
      if (!statusBox) return;
      statusBox.innerHTML = `
        <div class="approved-box">
          <div class="approved-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div>
            <div class="approved-title">Sentinel Approval Verified</div>
            <div class="approved-sub">Signing you in to ${escapeHtml(appName || "application")}...</div>
          </div>
        </div>
      `;
    }

    function escapeHtml(str: string): string {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderInPagePrompt(service: any, user: any, isLoggedIn: boolean) {
      if (window !== window.top) return;
      const serviceKey = service?.backendId || service?.id || service?.name || "default";
      if (currentPromptHost && activePromptServiceId === serviceKey) {
        return;
      }

      removeInPagePrompt();
      activePromptServiceId = serviceKey;

      const host = document.createElement("div");
      host.id = "sentinel-iam-inpage-prompt";
      host.style.cssText =
        "position: fixed !important; top: 20px !important; right: 20px !important; z-index: 2147483647 !important; pointer-events: auto !important;";

      const shadow = host.attachShadow({ mode: "closed" });
      currentPromptHost = host;
      currentPromptShadow = shadow;

      const appName = service?.name || document.title || window.location.hostname;
      const accountIdentity =
        service?.vaultUsername || user?.email || "Sentinel Linked Account";
      const protocolBadge = service?.isVault ? "Vault Autofill" : "Zero-Trust SSO";

      shadow.innerHTML = `
        <style>
          * {
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
          }
          .sentinel-card {
            width: 340px;
            background: rgba(12, 20, 36, 0.97);
            border: 1px solid rgba(56, 225, 255, 0.4);
            border-radius: 16px;
            padding: 16px;
            color: #f8fafc;
            box-shadow: 0 20px 45px rgba(2, 6, 23, 0.75), 0 0 25px rgba(56, 225, 255, 0.15);
            backdrop-filter: blur(14px);
            animation: sentinelSlideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
          }
          @keyframes sentinelSlideIn {
            from {
              opacity: 0;
              transform: translateY(-10px) scale(0.98);
            }
            to {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }
          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
            padding-bottom: 10px;
            border-bottom: 1px solid rgba(148, 163, 184, 0.16);
          }
          .brand {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .shield-box {
            width: 28px;
            height: 28px;
            border-radius: 8px;
            background: rgba(56, 225, 255, 0.12);
            border: 1px solid rgba(56, 225, 255, 0.35);
            display: flex;
            align-items: center;
            justify-content: center;
            color: #38e1ff;
            flex-shrink: 0;
          }
          .brand-text {
            display: flex;
            flex-direction: column;
          }
          .brand-title {
            font-size: 11px;
            font-weight: 800;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #38e1ff;
          }
          .brand-sub {
            font-size: 10px;
            color: #94a3b8;
            margin-top: 1px;
          }
          .close-btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #94a3b8;
            width: 24px;
            height: 24px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.15s ease;
          }
          .close-btn:hover {
            background: rgba(255, 255, 255, 0.12);
            color: #ffffff;
          }
          .app-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 6px;
          }
          .app-title {
            font-size: 15px;
            font-weight: 700;
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .protocol-pill {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            padding: 2px 7px;
            border-radius: 999px;
            background: rgba(56, 225, 255, 0.12);
            color: #38e1ff;
            border: 1px solid rgba(56, 225, 255, 0.28);
            flex-shrink: 0;
          }
          .desc {
            font-size: 12px;
            line-height: 1.45;
            color: #cbd5e1;
            margin: 0 0 12px 0;
          }
          .identity-pill {
            background: rgba(24, 41, 61, 0.75);
            border: 1px solid rgba(100, 116, 139, 0.35);
            border-radius: 10px;
            padding: 8px 10px;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: ${isLoggedIn ? "#34d399" : "#fbbf24"};
            box-shadow: 0 0 8px ${isLoggedIn ? "#34d399" : "#fbbf24"};
            flex-shrink: 0;
          }
          .identity-info {
            min-width: 0;
            flex: 1;
          }
          .identity-label {
            font-size: 10px;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            font-weight: 600;
          }
          .identity-val {
            font-size: 12px;
            font-weight: 600;
            color: #f1f5f9;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 1px;
          }
          .auth-btn {
            width: 100%;
            padding: 10px 14px;
            border-radius: 10px;
            border: none;
            background: #38e1ff;
            color: #020617;
            font-size: 12.5px;
            font-weight: 700;
            letter-spacing: 0.02em;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: all 0.15s ease;
            box-shadow: 0 0 18px rgba(56, 225, 255, 0.28);
          }
          .auth-btn:hover {
            background: #2bc4e0;
          }
          .auth-btn:disabled {
            opacity: 0.75;
            cursor: default;
          }
          .approved-box {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            border-radius: 10px;
            background: rgba(16, 185, 129, 0.12);
            border: 1px solid rgba(52, 211, 153, 0.35);
          }
          .approved-icon {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            background: rgba(16, 185, 129, 0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          .approved-title {
            font-size: 12.5px;
            font-weight: 700;
            color: #6ee7b7;
          }
          .approved-sub {
            font-size: 11px;
            color: #cbd5e1;
            margin-top: 2px;
          }
        </style>
        <div class="sentinel-card" role="dialog" aria-label="Sentinel Security Authentication">
          <div class="header">
            <div class="brand">
              <div class="shield-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                </svg>
              </div>
              <div class="brand-text">
                <span class="brand-title">Sentinel Security</span>
                <span class="brand-sub">Zero-Trust Identity Bridge</span>
              </div>
            </div>
            <button type="button" class="close-btn" id="sentinel-dismiss-btn" title="Dismiss">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div id="sentinel-prompt-body">
            <div class="app-row">
              <div class="app-title">${escapeHtml(appName)}</div>
              <span class="protocol-pill">${escapeHtml(protocolBadge)}</span>
            </div>
            <p class="desc">
              This site is tied to your Sentinel Security account. Authenticate via Sentinel Web Approval to sign in automatically.
            </p>
            <div class="identity-pill">
              <span class="dot"></span>
              <div class="identity-info">
                <div class="identity-label">Tied Account</div>
                <div class="identity-val">${escapeHtml(accountIdentity)}</div>
              </div>
            </div>
            <button type="button" class="auth-btn" id="sentinel-auth-btn">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
              </svg>
              <span id="sentinel-auth-btn-label">Authenticate with Sentinel</span>
            </button>
          </div>
        </div>
      `;

      const dismissBtn = shadow.getElementById("sentinel-dismiss-btn");
      dismissBtn?.addEventListener("click", () => {
        promptDismissedForPath = window.location.pathname + window.location.search;
        removeInPagePrompt();
      });

      const authBtn = shadow.getElementById("sentinel-auth-btn") as HTMLButtonElement | null;
      const authBtnLabel = shadow.getElementById("sentinel-auth-btn-label");
      authBtn?.addEventListener("click", () => {
        if (authBtn) authBtn.disabled = true;
        if (authBtnLabel) authBtnLabel.textContent = "Waiting for Sentinel Approval...";
        try {
          browser.runtime
            .sendMessage({
              type: "OPEN_SENTINEL_APPROVAL",
              service,
              currentUrl: window.location.href,
            })
            .catch(() => {
              if (authBtn) authBtn.disabled = false;
              if (authBtnLabel) authBtnLabel.textContent = "Authenticate with Sentinel";
            });
        } catch {
          if (authBtn) authBtn.disabled = false;
          if (authBtnLabel) authBtnLabel.textContent = "Authenticate with Sentinel";
        }
      });

      (document.body || document.documentElement).appendChild(host);
    }

    // Execute autofill
    function performAutofill(
      username: string | null | undefined,
      password: string | null | undefined,
      appName?: string
    ) {
      if ((!password && !username) || autofillStarted) return;
      autofillStarted = true;
      setPromptApprovedState(appName);

      let attempts = 0;
      const maxAttempts = 25; // 7.5-second retry window for dynamic / SPA modals

      const timer = setInterval(() => {
        attempts++;
        const { usernameInput, passwordInput } = findFormFields();

        if (passwordInput || usernameInput) {
          if (usernameInput && username) {
            setNativeInputValue(usernameInput, username);
          }

          if (passwordInput && password) {
            setNativeInputValue(passwordInput, password);
          }

          // Trigger form submission or next step once password is populated
          if (passwordInput) {
            clearInterval(timer);
            autofillCompletedAt = Date.now();
            try {
              browser.runtime.sendMessage({ type: "AUTOFILL_COMPLETED" }).catch(() => {});
            } catch {}

            setTimeout(() => {
              removeInPagePrompt();
              const form = passwordInput.form || passwordInput.closest("form");
              const submitBtn = findSubmitButton(form, passwordInput);
              if (submitBtn) {
                submitBtn.click();
              } else if (form && typeof (form as any).requestSubmit === "function") {
                (form as any).requestSubmit();
              } else if (form && typeof form.submit === "function") {
                form.submit();
              }
              autofillStarted = false;
              username = null;
              password = null;
            }, 350);
          } else if (usernameInput && !passwordInput && attempts > 4) {
            // Two-step sign-in (e.g. Google): Submit username first to reveal password
            clearInterval(timer);
            const form = usernameInput.form || usernameInput.closest("form");
            const nextBtn =
              form?.querySelector<HTMLElement>('button, input[type="submit"], #identifierNext') ||
              document.querySelector<HTMLElement>('#identifierNext, button[type="submit"]');
            if (nextBtn) {
              nextBtn.click();
              if (password) {
                autofillStarted = false;
                setTimeout(() => {
                  performAutofill(null, password, appName);
                }, 1200);
              }
            }
          }
        } else if (attempts >= maxAttempts) {
          clearInterval(timer);
          autofillStarted = false;
          username = null;
          password = null;
        }
      }, 300);
    }

    function hasActiveSsoCallbackParams(): boolean {
      const search = window.location.search;
      return search.includes("ssoToken=") || search.includes("ssoUserId=");
    }

    function evaluateSiteForPrompt() {
      if (window !== window.top) return;
      if (autofillStarted) return;
      if (Date.now() - autofillCompletedAt < 8000) return;

      const currentPathKey = window.location.pathname + window.location.search;
      if (promptDismissedForPath === currentPathKey) return;

      if (hasActiveSsoCallbackParams()) {
        removeInPagePrompt();
        return;
      }

      const { usernameInput, passwordInput } = findFormFields();
      const hasLoginForm = Boolean(passwordInput || usernameInput);

      if (!hasLoginForm) {
        if (currentPromptHost) {
          removeInPagePrompt();
        }
        return;
      }

      try {
        browser.runtime
          .sendMessage({
            type: "CHECK_SITE_INTEGRATION",
            url: window.location.href,
          })
          .then((response: any) => {
            if (!response || !response.matched || !response.service) {
              if (currentPromptHost) {
                removeInPagePrompt();
              }
              return;
            }
            renderInPagePrompt(response.service, response.user, Boolean(response.isLoggedIn));
          })
          .catch(() => {});
      } catch {}
    }

    // 1. Listen for injection messages from background worker
    try {
      browser.runtime.onMessage.addListener((message: any) => {
        if (message && message.type === "INJECT_CREDENTIALS" && (message.password || message.username)) {
          performAutofill(message.username, message.password, message.appName);
        }
      });
    } catch {}

    // 2. Top frame only: check pending credentials first, then evaluate for in-site Sentinel popup
    if (window === window.top) {
      try {
        browser.runtime
          .sendMessage({ type: "REQUEST_PENDING_CREDENTIALS" })
          .then((response: any) => {
            if (response && response.hasCredentials && (response.password || response.username)) {
              performAutofill(response.username, response.password, response.appName);
            } else {
              evaluateSiteForPrompt();
            }
          })
          .catch(() => {
            evaluateSiteForPrompt();
          });
      } catch {
        evaluateSiteForPrompt();
      }

      // Observe dynamic SPA transitions and login form rendering
      setInterval(evaluateSiteForPrompt, 1800);
    }
  },
});
