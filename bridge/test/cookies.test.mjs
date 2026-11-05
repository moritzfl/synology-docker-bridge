import assert from "node:assert/strict";
import test from "node:test";
import { scopeCookie, scopeCookies } from "../src/cookies.mjs";

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
