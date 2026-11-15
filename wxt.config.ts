import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: [],
  manifestVersion: 3,
  manifest: {
    name: "Sentinel Autofill Bridge",
    description: "Secure cross-browser autofill middleman bridge for Sentinel Security IAM Web Portal and Credential Vault.",
    version: "1.2.0",
    permissions: [
      "storage",
      "tabs",
      "activeTab",
      "scripting",
    ],
    host_permissions: [
      "<all_urls>",
    ],
    browser_specific_settings: {
      gecko: {
        id: "sentinel-autofill@sentinel.security",
        strict_min_version: "109.0",
      },
    },
    action: {
      default_title: "Sentinel Autofill Bridge",
    },
  },
  vite: () => ({
    build: {
      minify: "esbuild",
      sourcemap: false,
    },
  }),
});
