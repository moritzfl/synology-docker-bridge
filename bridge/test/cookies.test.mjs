import assert from "node:assert/strict";
import test from "node:test";
import {
  dropDsmCookies,
  onlyCookies,
  publicCookieHeader,
  scopeCookie,
  scopeCookies,
  withoutDsmCookies,
} from "../src/cookies.mjs";

const prefix = "/webman/3rdparty/app/proxy";

test("moves absolute cookie paths under the package prefix", () => {
  assert.equal(scopeCookie("id=1; Path=/; HttpOnly", prefix), `id=1; Path=${prefix}/; HttpOnly`);
  assert.equal(scopeCookie("a=1; path=/api", prefix), `a=1; path=${prefix}/api`);
});

test("leaves prefixed, relative and path-less cookies alone", () => {
  assert.equal(scopeCookie(`a=1; Path=${prefix}/x`, prefix), `a=1; Path=${prefix}/x`);
  assert.equal(scopeCookie("a=1; HttpOnly", prefix), "a=1; HttpOnly");
  assert.equal(scopeCookie("a=1; Path=/", ""), "a=1; Path=/");
});

test("does not mistake a value containing path= for the attribute", () => {
  assert.equal(scopeCookie("q=path=/x; Path=/", prefix), `q=path=/x; Path=${prefix}/`);
});

test("rewrites every Set-Cookie header", () => {
  const headers = { "set-cookie": ["a=1; Path=/", "b=2"] };
  scopeCookies(headers, prefix);
  assert.deepEqual(headers["set-cookie"], [`a=1; Path=${prefix}/`, "b=2"]);
});

test("an app on ports of its own never sees DSM's sign-in cookies", () => {
  // Cookie names from a signed-in Virtual DSM 7.2.2 browser; values are synthetic.
  assert.equal(
    withoutDsmCookies("_SSID=a; stay_login=0; id=b; did=c; _CrPoSt=d; io=socket"),
    "io=socket",
  );
  assert.equal(
    withoutDsmCookies("id=dsm; did=x; _SSID=y; sessionid=app; stay_login=0; ident=keep"),
    "sessionid=app; ident=keep",
  );
  assert.equal(withoutDsmCookies(""), "");
});

test("an app on ports of its own cannot replace DSM's sign-in cookies", () => {
  const headers = { "set-cookie": ["id=evil; Path=/", "sessionid=1; Path=/; HttpOnly"] };
  assert.deepEqual(dropDsmCookies(headers), ["id"]);
  assert.deepEqual(headers["set-cookie"], ["sessionid=1; Path=/; HttpOnly"]);
  const only = { "set-cookie": "did=x; Path=/" };
  assert.deepEqual(dropDsmCookies(only), ["did"]);
  assert.equal(only["set-cookie"], undefined);
  const none = { "set-cookie": ["csrftoken=1; Path=/"] };
  assert.deepEqual(dropDsmCookies(none), []);
  assert.deepEqual(none["set-cookie"], ["csrftoken=1; Path=/"]);
});

test("an app cannot replace a bridge session cookie, and io stays its own", () => {
  const headers = {
    "set-cookie": [
      "[REDACTED:known:f5c3aebe2e91]=own",
      "[REDACTED:known:f5c3aebe2e91]_other=other",
      "io=socket",
    ],
  };
  assert.deepEqual(dropDsmCookies(headers, "[REDACTED:known:f5c3aebe2e91]"), [
    "[REDACTED:known:f5c3aebe2e91]",
    "[REDACTED:known:f5c3aebe2e91]_other",
  ]);
  assert.deepEqual(headers["set-cookie"], ["io=socket"]);
});

test("visitors without a session keep only the cookies the app lists", () => {
  const header = "sessionid=login; csrftoken=abc; id=dsm; theme=dark";
  assert.equal(onlyCookies(header, ["csrftoken"]), "csrftoken=abc");
  assert.equal(onlyCookies(header, []), "");
  assert.equal(onlyCookies("", ["csrftoken"]), "");
  assert.equal(onlyCookies("csrftokenx=1; csrftoken=2", ["csrftoken"]), "csrftoken=2");
});

test("a public path never forwards DSM or bridge session cookies", () => {
  const header =
    "id=dsm; _SSID=sso; dsm_bridge_session=own; dsm_bridge_session_other=other; csrftoken=abc";
  assert.equal(
    publicCookieHeader(
      header,
      ["id", "_SSID", "dsm_bridge_session", "dsm_bridge_session_other", "csrftoken"],
      "dsm_bridge_session",
    ),
    "csrftoken=abc",
  );
  assert.equal(publicCookieHeader(header, [], "dsm_bridge_session"), "");
});
