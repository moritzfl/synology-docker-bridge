import assert from "node:assert/strict";
import test from "node:test";
import { applyFraming, frameAncestors } from "../src/framing.mjs";

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
