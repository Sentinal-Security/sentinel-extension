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

        // Dispatch standard synthetic input and change events
        element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" }));
        element.dispatchEvent(new Event("blur", { bubbles: true, cancelable: true }));
      } catch {}
    }

    // Smart input field resolution
    function findFormFields(): {
      usernameInput: HTMLInputElement | null;
      passwordInput: HTMLInputElement | null;
    } {
      const passwordInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
        (el) => el.offsetParent !== null && !el.disabled && !el.readOnly
      );

      const passwordInput = passwordInputs[0] || null;

      // Search for username / email field
      let usernameInput: HTMLInputElement | null = null;

      if (passwordInput && passwordInput.form) {
        const formInputs = Array.from(
          passwordInput.form.querySelectorAll<HTMLInputElement>(
            'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"])'
          )
        ).filter((el) => el.offsetParent !== null && !el.disabled && !el.readOnly);

        usernameInput =
          formInputs.find((el) => {
            const str = (el.name + " " + el.id + " " + el.placeholder + " " + el.type + " " + (el.getAttribute("autocomplete") || "")).toLowerCase();
            return str.includes("email") || str.includes("user") || str.includes("login") || str.includes("account");
          }) || formInputs[0];
      }

      if (!usernameInput) {
        const candidates = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="email" i], input[id*="email" i], input[id*="user" i]'
          )
        ).filter((el) => el.offsetParent !== null && !el.disabled && !el.readOnly);
        usernameInput = candidates[0] || null;
      }

      return { usernameInput, passwordInput };
    }

    // Execute autofill
    function performAutofill(username: string | null | undefined, password: string | null | undefined) {
      if (!password && !username) return;

      let attempts = 0;
      const maxAttempts = 20; // 6-second retry window for dynamic / SPA modals

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

          // Trigger form submission or next step if appropriate
          if (passwordInput) {
            clearInterval(timer);
            setTimeout(() => {
              const form = passwordInput.form || passwordInput.closest("form");
              if (form) {
                const submitBtn =
                  form.querySelector<HTMLElement>('button[type="submit"]') ||
                  form.querySelector<HTMLElement>('input[type="submit"]') ||
                  form.querySelector<HTMLElement>('button:not([type="button"])');

                if (submitBtn) {
                  submitBtn.click();
                } else if (typeof (form as any).requestSubmit === "function") {
                  (form as any).requestSubmit();
                }
              }
              // Zeroize references
              username = null;
              password = null;
            }, 350);
          } else if (usernameInput && !passwordInput && attempts > 4) {
            // Two-step sign-in (e.g. Google): Submit username first to reveal password
            clearInterval(timer);
            const form = usernameInput.form || usernameInput.closest("form");
            const nextBtn = form?.querySelector<HTMLElement>('button, input[type="submit"], #identifierNext');
            if (nextBtn) {
              nextBtn.click();
              // Wait for password step to appear in 2-step form
              if (password) {
                setTimeout(() => {
                  performAutofill(null, password);
                }, 1200);
              }
            }
          }
        } else if (attempts >= maxAttempts) {
          clearInterval(timer);
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

    // 2. Poll for pending credentials on script load in case message arrived before injection
    try {
      browser.runtime.sendMessage({ type: "REQUEST_PENDING_CREDENTIALS" }).then((response: any) => {
        if (response && response.hasCredentials && (response.password || response.username)) {
          performAutofill(response.username, response.password);
        }
      }).catch(() => {});
    } catch {}
  },
});
