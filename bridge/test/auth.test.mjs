import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticator } from "../src/auth.mjs";

function config(overrides = {}) {
  return {
    authMode: "token",
    oneTimeSeconds: 60,
    sessionSeconds: 3600,
    ...overrides,
  };
}

test("none mode allows requests and leaves cookies alone", () => {
  const auth = createAuthenticator(config({ authMode: "none" }));
  assert.ok(auth.authenticate({ headers: {} }));
  assert.equal(auth.stripCookies("dsm_bridge_session=abc; app=1"), "app=1");
});

test("one-time token becomes a session cookie", () => {
  const auth = createAuthenticator(config());
  const token = auth.mint("admin");
  const session = auth.login(token);
  assert.ok(session);
  assert.equal(auth.authenticate({
    headers: { cookie: `dsm_bridge_session=${session}` },
  }).user, "admin");
  assert.equal(auth.login(token), null, "one-time token must not be reusable");
});

test("invalid and missing sessions are rejected", () => {
  const auth = createAuthenticator(config());
  assert.equal(auth.authenticate({ headers: {} }), null);
  assert.equal(auth.authenticate({
    headers: { cookie: "dsm_bridge_session=invalid" },
  }), null);
});

test("strips only the bridge session cookie", () => {
  const auth = createAuthenticator(config());
  assert.equal(
    auth.stripCookies("dsm_bridge_session=abc; JSESSIONID=xyz; theme=dark"),
    "JSESSIONID=xyz; theme=dark",
  );
  assert.match(auth.cookie("abc"), /SameSite=Lax/);
});

test("sessions slide on use and expire only after idling", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const auth = createAuthenticator(config({ sessionSeconds: 60 }));
  const session = auth.login(auth.mint("admin"));
  const request = { headers: { cookie: `dsm_bridge_session=${session}` } };
  t.mock.timers.tick(50_000);
  assert.ok(auth.authenticate(request), "used within the idle window");
  t.mock.timers.tick(50_000);
  assert.ok(auth.authenticate(request), "100 s after login, but only 50 s idle");
  t.mock.timers.tick(61_000);
  assert.equal(auth.authenticate(request), null, "idle longer than the timeout");
});

test("cookie is scoped to the package proxy path", () => {
  const auth = createAuthenticator(config());
  assert.match(auth.cookie("abc"), /; Path=\/;/);
  assert.match(auth.cookie("abc", false, "/webman/3rdparty/app/proxy/"),
    /; Path=\/webman\/3rdparty\/app\/proxy\/;/);
});

test("a stale cookie of another package does not hide this package's session", () => {
  const auth = createAuthenticator(config());
  const session = auth.login(auth.mint("admin"));
  assert.ok(auth.authenticate({
    headers: { cookie: `dsm_bridge_session=${session}; dsm_bridge_session=stale` },
  }));
  assert.ok(auth.authenticate({
    headers: { cookie: `dsm_bridge_session=stale; dsm_bridge_session=${session}` },
  }));
});

test("cookie is a browser-session cookie and secure over HTTPS", () => {
  const auth = createAuthenticator(config());
  assert.doesNotMatch(auth.cookie("abc"), /Max-Age/);
  assert.doesNotMatch(auth.cookie("abc", false), /Secure/);
  assert.match(auth.cookie("abc", true), /; Secure$/);
});

test("sessions carry the DSM user and groups", () => {
  const auth = createAuthenticator(config());
  const session = auth.login(auth.mint({ user: "anna", groups: ["users", "family"] }));
  const identity = auth.authenticate({ headers: { cookie: `dsm_bridge_session=${session}` } });
  assert.equal(identity.user, "anna");
  assert.deepEqual(identity.groups, ["users", "family"]);
});

test("a session needs a fresh privilege check within verifySeconds", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const auth = createAuthenticator(config({ sessionSeconds: 3600, verifySeconds: 600 }));
  const session = auth.login(auth.mint("anna"));
  const request = { headers: { cookie: `dsm_bridge_session=${session}` } };
  t.mock.timers.tick(500_000);
  assert.equal(auth.refresh(request, auth.mint("bob")), false, "another user's token renews nothing");
  assert.equal(auth.refresh(request, "made-up"), false);
  assert.equal(auth.refresh(request, auth.mint("anna")), true);
  t.mock.timers.tick(500_000);
  assert.ok(auth.authenticate(request), "renewed 500 s ago");
  t.mock.timers.tick(200_000);
  assert.equal(auth.authenticate(request), null, "not renewed for 700 s");
});

test("revoking a user ends only that user's sessions", () => {
  const auth = createAuthenticator(config());
  const anna = auth.login(auth.mint("anna"));
  const bob = auth.login(auth.mint("bob"));
  assert.equal(auth.revoke("anna"), 1);
  assert.equal(auth.authenticate({ headers: { cookie: `dsm_bridge_session=${anna}` } }), null);
  assert.ok(auth.authenticate({ headers: { cookie: `dsm_bridge_session=${bob}` } }));
});
