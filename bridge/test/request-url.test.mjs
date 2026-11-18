import assert from "node:assert/strict";
import test from "node:test";
import { requestUrl } from "../src/request-url.mjs";

test("reads the usual and absolute request targets", () => {
  assert.equal(requestUrl("/x?y=1").pathname, "/x");
  assert.equal(requestUrl("/").pathname, "/");
  assert.equal(requestUrl("").pathname, "/");
  assert.equal(
    requestUrl("http://nas/webman/3rdparty/app/proxy/").pathname,
    "/webman/3rdparty/app/proxy/",
  );
});

test("a malformed target is null instead of an uncaught exception", () => {
  for (const value of ["http://[::1", "http://[", "http://a b"]) {
    assert.equal(requestUrl(value), null, value);
  }
});
