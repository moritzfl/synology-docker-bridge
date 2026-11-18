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
  assert.equal(
    auth.authenticate({
      headers: { cookie: `dsm_bridge_session=${session}` },
    }).user,
    "admin",
  );
  assert.equal(auth.login(token), null, "one-time token must not be reusable");
});

test("invalid and missing sessions are rejected", () => {
  const auth = createAuthenticator(config());
  assert.equal(auth.authenticate({ headers: {} }), null);
  assert.equal(
    auth.authenticate({
      headers: { cookie: "dsm_bridge_session=invalid" },
    }),
    null,
  );
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
  assert.match(
    auth.cookie("abc", false, "/webman/3rdparty/app/proxy/"),
    /; Path=\/webman\/3rdparty\/app\/proxy\/;/,
  );
});

test("a stale cookie of another package does not hide this package's session", () => {
  const auth = createAuthenticator(config());
  const session = auth.login(auth.mint("admin"));
  assert.ok(
    auth.authenticate({
      headers: { cookie: `dsm_bridge_session=${session}; dsm_bridge_session=stale` },
    }),
  );
  assert.ok(
    auth.authenticate({
      headers: { cookie: `dsm_bridge_session=stale; dsm_bridge_session=${session}` },
    }),
  );
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
  assert.equal(
    auth.refresh(request, auth.mint("bob")),
    false,
    "another user's token renews nothing",
  );
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

test("revoking a user also ends their sockets and unredeemed tokens", () => {
  const auth = createAuthenticator(config());
  const session = auth.login(auth.mint("anna"));
  const identity = auth.authenticate({
    headers: { cookie: `dsm_bridge_session=${session}` },
  });
  const closed = [];
  const untrack = auth.track(identity.key, () => closed.push("socket"));
  const pending = auth.mint("anna");
  const bobsPending = auth.mint("bob");
  assert.equal(auth.revoke("anna"), 1);
  assert.deepEqual(closed, ["socket"], "the open socket is closed at once");
  assert.equal(auth.login(pending), null, "a token minted before revocation is gone");
  assert.ok(auth.login(bobsPending), "another user's token still works");
  untrack();
});

test("an expired session closes its socket without another request", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const auth = createAuthenticator(config({ sessionSeconds: 3600, verifySeconds: 600 }));
  const session = auth.login(auth.mint("anna"));
  const identity = auth.authenticate({
    headers: { cookie: `dsm_bridge_session=${session}` },
  });
  let closed = false;
  auth.track(identity.key, () => {
    closed = true;
  });
  t.mock.timers.tick(601_000);
  auth.sweep();
  assert.equal(closed, true);
});

test("none mode allows websockets without a session to track", () => {
  const auth = createAuthenticator(config({ authMode: "none" }));
  const identity = auth.authenticate({ headers: {} });
  let closed = false;
  auth.track(identity.key, () => {
    closed = true;
  });
  assert.equal(closed, false);
});

test("a package on ports of its own uses its own cookie name and never forwards another's", () => {
  const auth = createAuthenticator(config({ sessionCookie: "dsm_bridge_session_fidus" }));
  const session = auth.login(auth.mint("anna"));
  assert.match(
    auth.cookie(session, true),
    /^dsm_bridge_session_fidus=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Secure$/,
  );
  assert.equal(
    auth.authenticate({ headers: { cookie: `dsm_bridge_session=${session}` } }),
    null,
    "only the package's own name counts",
  );
  assert.equal(
    auth.authenticate({ headers: { cookie: `dsm_bridge_session_fidus=${session}` } }).user,
    "anna",
  );
  assert.equal(
    auth.stripCookies(
      "dsm_bridge_session_fidus=a; dsm_bridge_session_other-app=b; dsm_bridge_session=c; app=1",
    ),
    "app=1",
  );
});

test("the session carries the DSM full name and a refresh updates it", () => {
  const auth = createAuthenticator(config());
  const session = auth.login(auth.mint({ user: "anna", groups: ["users"], name: "Anna A" }));
  const request = { headers: { cookie: `dsm_bridge_session=${session}` } };
  assert.equal(auth.authenticate(request).name, "Anna A");
  assert.ok(auth.refresh(request, auth.mint({ user: "anna", groups: ["users"], name: "Anna B" })));
  assert.equal(auth.authenticate(request).name, "Anna B");
});

test("the session carries the DSM email address", () => {
  const auth = createAuthenticator(config());
  const session = auth.login(auth.mint({ user: "anna", email: "anna@example.com" }));
  const request = { headers: { cookie: `dsm_bridge_session=${session}` } };
  assert.equal(auth.authenticate(request).email, "anna@example.com");
  assert.ok(auth.refresh(request, auth.mint({ user: "anna", email: "anna@example.org" })));
  assert.equal(auth.authenticate(request).email, "anna@example.org");
});
