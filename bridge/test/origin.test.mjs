import assert from "node:assert/strict";
import test from "node:test";
import { crossSite, sameOrigin, unsafeMethod } from "../src/origin.mjs";

test("state-changing methods need an origin check", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(unsafeMethod(method), true);
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) assert.equal(unsafeMethod(method), false);
});

test("another origin or a cross-site request is refused", () => {
  assert.equal(sameOrigin("https://nas:5000", "nas:5000"), true);
  assert.equal(sameOrigin("https://nas:4387", "nas:5000"), false);
  assert.equal(sameOrigin("http://nas:5000", "nas:5000", "https"), false);
  assert.equal(
    sameOrigin("https://editor.example", "nas:5000", "https", ["https://editor.example"]),
    true,
  );
  assert.equal(sameOrigin("null", "nas:5000"), false);
  assert.equal(sameOrigin("", "nas:5000"), true, "no Origin is not a browser CSRF");
  assert.equal(crossSite({ "sec-fetch-site": "cross-site" }), true);
  assert.equal(crossSite({ "sec-fetch-site": "same-origin" }), false);
  assert.equal(crossSite({}), false);
});
