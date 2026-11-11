# Sentinel Autofill Bridge (WXT Manifest V3)

Cross-browser browser extension middleware connecting the **Sentinel Security Web Portal** to external login forms (Facebook, GitHub, Gmail, and custom SaaS platforms). Built with **WXT** (Next-gen Web Extension Framework) and Vite.

---

## Architectural Protocol

1. **Session Gate**:
   * Continuous verification of active Sentinel IAM web session (`https://web-beta-orcin-33.vercel.app` or `http://localhost:3000`).
   * If logged out or unauthenticated, the extension is locked and rejects autofill commands.
2. **Zero In-Page Floating UI**:
   * The extension creates **no floating cards, popups, or injected overlays** on destination websites.
   * Authentication remains entirely inside the Sentinel Web Portal modal and Sentinel Mobile Authenticator app (out-of-band 2-digit number match or 6-digit TOTP).
3. **In-Memory Ephemeral Bridge**:
   * Upon push approval on the mobile device, credentials are sent via a single-use memory token.
   * The extension injects inputs via prototype property descriptors (bypassing React 16-19 synthetic event blocks) and submits.
   * Credentials are wiped to `null` immediately after injection, with a hard 60-second RAM TTL.
4. **Tamper-Resistant Bundling**:
   * Compiled with Vite minification and tree-shaking, protecting against reverse engineering.

---

## Development & Build Commands

```bash
# Install dependencies
pnpm install

# Build for Chromium (output: .output/chrome-mv3)
pnpm build

# Build for Firefox (output: .output/firefox-mv3)
pnpm build:firefox

# Compile both distributions
pnpm compile

# Package distribution ZIP archives
pnpm zip
pnpm zip:firefox
```

---

## Loading Unpacked Extension

### Chromium (Chrome, Brave, Edge, Opera)
1. Open `chrome://extensions`.
2. Toggle on **Developer mode** in the upper-right corner.
3. Click **Load unpacked**.
4. Select the build directory: `.output/chrome-mv3`.

### Mozilla Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**
3. Select `manifest.json` inside the `.output/firefox-mv3` folder.
