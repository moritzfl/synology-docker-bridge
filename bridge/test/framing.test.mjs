import assert from "node:assert/strict";
import test from "node:test";
import { applyFraming, frameAncestors, framingOrigin } from "../src/framing.mjs";

test("only DSM may frame an app on ports of its own", () => {
  const config = { ownOrigin: true, dsmHttpPort: 5000, dsmHttpsPort: 5001 };
  assert.equal(
    frameAncestors(config, "nas.local:4387"),
    "'self' http://nas.local:5000 https://nas.local:5001",
  );
  assert.equal(frameAncestors(config, "[::1]:4387"), "'self' http://[::1]:5000 https://[::1]:5001");
  assert.equal(frameAncestors({ ownOrigin: false }, "nas.local"), "'self'");
  assert.equal(
    frameAncestors(config, 'evil"host'),
    "'self' http://nas:5000 https://nas:5001",
    "an invalid host falls back instead of injecting a directive",
  );
});

test("the DSM address a session was opened from may frame the app too", () => {
  const config = { ownOrigin: true, dsmHttpPort: 5000, dsmHttpsPort: 5001 };
  // DSM on 443, e.g. behind a router forwarding the default port, or a Login Portal port.
  assert.equal(
    frameAncestors(config, "nas.example:4387", "https://nas.example"),
    "'self' http://nas.example:5000 https://nas.example:5001 https://nas.example",
  );
  assert.equal(
    frameAncestors(config, "NAS.example:4387", "https://nas.example:7443"),
    "'self' http://nas.example:5000 https://nas.example:5001 https://nas.example:7443",
  );
  assert.equal(
    frameAncestors(config, "nas.example:4387", "https://nas.example:5001"),
    "'self' http://nas.example:5000 https://nas.example:5001",
    "DSM's own ports are not listed twice",
  );
  assert.equal(
    frameAncestors(config, "[::1]:4387", "https://[::1]:5443"),
    "'self' http://[::1]:5000 https://[::1]:5001 https://[::1]:5443",
  );
  assert.equal(
    frameAncestors({ ownOrigin: false }, "nas.example", "https://nas.example"),
    "'self'",
  );
});

test("only an address on the app's own host counts as the opening DSM page", () => {
  const host = "nas.example:4387";
  assert.equal(framingOrigin("https://nas.example:5001", host), "https://nas.example:5001");
  assert.equal(framingOrigin("https://nas.example:443", host), "https://nas.example");
  assert.equal(framingOrigin("http://nas.example", host), "http://nas.example");
  for (const value of [
    "",
    "null",
    "https://evil.example",
    "https://nas.example.evil.example",
    "https://nas.example:5001/path",
    "https://user@nas.example",
    "https://nas.example/?a=1",
    "javascript:alert(1)",
    "ftp://nas.example",
    "https://nas.example; script-src *",
  ]) {
    assert.equal(framingOrigin(value, host), "", value);
  }
  assert.equal(framingOrigin("https://nas.example", 'evil"host'), "");
});

test("framing replaces the app's rule and removes X-Frame-Options", () => {
  const headers = {
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; frame-ancestors *; script-src 'self'",
    "content-security-policy-report-only": "frame-ancestors https://evil.example",
  };
  applyFraming(headers, "'self'");
  assert.equal(headers["x-frame-options"], undefined);
  assert.equal(
    headers["content-security-policy"],
    "default-src 'self'; script-src 'self'; frame-ancestors 'self'",
  );
  assert.equal(
    headers["content-security-policy-report-only"],
    undefined,
    "a report-only framing rule cannot override the enforcing one",
  );

  const plain = {};
  applyFraming(plain, "'self' http://nas:5000");
  assert.equal(plain["content-security-policy"], "frame-ancestors 'self' http://nas:5000");
});
