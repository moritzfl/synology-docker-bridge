import assert from "node:assert/strict";
import test from "node:test";
import { parsePublicPaths, publicTarget } from "../src/public.mjs";

const allowed = ["/media/", "/mcp/oauth/callback"];

test("reads the configured paths", () => {
  assert.deepEqual(parsePublicPaths("/media/, /mcp/oauth/callback,,x"), allowed);
  assert.deepEqual(parsePublicPaths(""), []);
});

test("passes allowed paths with their query", () => {
  assert.equal(publicTarget("/media/abc?format=flac", allowed), "/media/abc?format=flac");
  assert.equal(publicTarget("/media/live/abc", allowed), "/media/live/abc");
  assert.equal(publicTarget("/mcp/oauth/callback?state=1&code=2", allowed), "/mcp/oauth/callback?state=1&code=2");
});

test("refuses everything else", () => {
  for (const url of ["/", "/login", "/media", "/media/", "/mediax/a", "/mcp/oauth/callback/x",
    "/VAADIN/push", "/mcp/oauth/callbackx"]) {
    assert.equal(publicTarget(url, allowed), null, url);
  }
});

test("dot segments, backslashes and encoded separators cannot leave an allowed prefix", () => {
  for (const url of ["/media/../login", "/media/%2e%2e/login", "/media/%2E%2E/%2e%2e/admin",
    "/media\\..\\login", "/media/..%2flogin", "/media/a%2f..%2f..%2flogin", "/media/a%5c..", "/media/a%00"]) {
    const target = publicTarget(url, allowed);
    assert.ok(target === null || target.startsWith("/media/") && !target.includes(".."), `${url} -> ${target}`);
  }
  assert.equal(publicTarget("/media/../login", allowed), null);
});

test("with no paths configured, nothing is public", () => {
  assert.equal(publicTarget("/media/abc", []), null);
});
