import { browser } from "wxt/browser";

export default defineContentScript({
  matches: ["<all_urls>"],
  excludeMatches: [
    "https://web-beta-orcin-33.vercel.app/*",
    "https://sentinal-security.vercel.app/*",
    "http://localhost:3000/*",
    "http://127.0.0.1:3000/*",
  ],
  allFrames: true,
  runAt: "document_idle",
  main() {
    let autofillStarted = false;

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
            const str = (el.name + " " + el.id + " " + el.placeholder + " " + el.type + " " + (el.getAttribute("autocomplete") || "")).toLowerCase();
            return str.includes("email") || str.includes("user") || str.includes("login") || str.includes("account") || str.includes("phone");
          }) || formInputs[0] || null;
      }

      if (!usernameInput) {
        const candidates = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input#email, input[name="email"], input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="email" i], input[id*="email" i], input[id*="user" i]'
          )
        ).filter((el) => isVisibleInput(el));
        usernameInput = candidates[0] || null;
      }

      return { usernameInput, passwordInput };
    }

    function findSubmitButton(form: HTMLFormElement | null): HTMLElement | null {
      const selectors = [
        'button[name="login"]',
        '#loginbutton',
        '[data-testid*="royal-login" i]',
        '[data-testid*="royal_login" i]',
        'button[type="submit"]',
        'input[type="submit"]',
        '[role="button"][aria-label*="log in" i]',
        '[role="button"][aria-label*="sign in" i]',
        'button:not([type="button"])',
      ];
      const scope: ParentNode = form || document;
      for (const selector of selectors) {
        const el = scope.querySelector<HTMLElement>(selector);
        if (el) return el;
      }
      return null;
    }

    // Execute autofill
    function performAutofill(username: string | null | undefined, password: string | null | undefined) {
      if ((!password && !username) || autofillStarted) return;
      autofillStarted = true;

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
            try {
              browser.runtime.sendMessage({ type: "AUTOFILL_COMPLETED" }).catch(() => {});
            } catch {}

            setTimeout(() => {
              const form = passwordInput.form || passwordInput.closest("form");
              const submitBtn = findSubmitButton(form);
              if (submitBtn) {
                submitBtn.click();
              } else if (form && typeof (form as any).requestSubmit === "function") {
                (form as any).requestSubmit();
              } else if (form && typeof form.submit === "function") {
                form.submit();
              }
              username = null;
              password = null;
            }, 350);
          } else if (usernameInput && !passwordInput && attempts > 4) {
            // Two-step sign-in (e.g. Google): Submit username first to reveal password
            clearInterval(timer);
            const form = usernameInput.form || usernameInput.closest("form");
            const nextBtn = form?.querySelector<HTMLElement>('button, input[type="submit"], #identifierNext')
              || document.querySelector<HTMLElement>('#identifierNext, button[type="submit"]');
            if (nextBtn) {
              nextBtn.click();
              if (password) {
                autofillStarted = false;
                setTimeout(() => {
                  performAutofill(null, password);
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

    // 1. Listen for injection messages from background worker
    try {
      browser.runtime.onMessage.addListener((message: any) => {
        if (message && message.type === "INJECT_CREDENTIALS" && (message.password || message.username)) {
          performAutofill(message.username, message.password);
        }
      });
    } catch {}

    // 2. Top frame only: pull pending credentials on script load in case message arrived before listener
    if (window === window.top) {
      try {
        browser.runtime.sendMessage({ type: "REQUEST_PENDING_CREDENTIALS" }).then((response: any) => {
          if (response && response.hasCredentials && (response.password || response.username)) {
            performAutofill(response.username, response.password);
          }
        }).catch(() => {});
      } catch {}
    }
  },
});
