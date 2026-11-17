import assert from "node:assert/strict";
import test from "node:test";
import { dropDsmCookies, scopeCookie, scopeCookies, withoutDsmCookies } from "../src/cookies.mjs";

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
