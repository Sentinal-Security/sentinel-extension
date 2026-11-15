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

export function parseUrlSafe(raw: string): URL | null {
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

export function stripWww(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") && lower.length > 4 ? lower.slice(4) : lower;
}

export function getRegistrableDomain(host: string): string {
  const clean = stripWww(host);
  if (clean === "localhost" || clean === "127.0.0.1") return clean;
  for (const suffix of MULTI_TENANT_SUFFIXES) {
    if (clean.endsWith(suffix)) {
      return clean;
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

export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function doesUrlMatchDestination(tabUrlStr: string | undefined, destinationStr: string): boolean {
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

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
