import test from "node:test";
import assert from "node:assert/strict";
import {
  getRegistrableDomain,
  isSafeHttpUrl,
  doesUrlMatchDestination,
  escapeHtml,
} from "../utils.ts";

test("isSafeHttpUrl rejects javascript: and data: URIs", () => {
  assert.equal(isSafeHttpUrl("https://app.example.com/login"), true);
  assert.equal(isSafeHttpUrl("http://localhost:3001"), true);
  assert.equal(isSafeHttpUrl("javascript:alert(1)"), false);
  assert.equal(isSafeHttpUrl("data:text/html,<script>alert(1)</script>"), false);
});

test("getRegistrableDomain isolates multi-tenant PaaS and ccSLDs", () => {
  assert.equal(getRegistrableDomain("app1.vercel.app"), "app1.vercel.app");
  assert.equal(getRegistrableDomain("app2.azurewebsites.net"), "app2.azurewebsites.net");
  assert.equal(getRegistrableDomain("login.example.co.jp"), "example.co.jp");
  assert.equal(getRegistrableDomain("www.github.com"), "github.com");
});

test("doesUrlMatchDestination blocks credential delivery after cross-origin redirect", () => {
  assert.equal(
    doesUrlMatchDestination("https://accounts.github.com/login", "https://github.com/login"),
    true
  );
  assert.equal(
    doesUrlMatchDestination("https://evil.com/phish", "https://github.com/login"),
    false
  );
  assert.equal(
    doesUrlMatchDestination("http://localhost:3002/login", "http://localhost:3001/login"),
    false
  );
});

test("escapeHtml neutralizes XSS payloads", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('xss')">`),
    "&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;"
  );
});
