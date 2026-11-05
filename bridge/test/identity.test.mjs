import assert from "node:assert/strict";
import test from "node:test";
import { applyIdentity } from "../src/identity.mjs";

test("drops identity headers a browser sends, even when the feature is off", () => {
  const headers = { "remote-user": "admin", "Remote-Groups": "administrators", accept: "*/*" };
  applyIdentity(headers, { user: "anna", groups: ["users"] }, false);
  assert.deepEqual(headers, { accept: "*/*" });
});

test("sets the signed-in user and groups when enabled", () => {
  const headers = { "remote-user": "admin" };
  applyIdentity(headers, { user: "anna", groups: ["users", "administrators"] }, true);
  assert.equal(headers["remote-user"], "anna");
  assert.equal(headers["remote-groups"], "users,administrators");
});

test("sets nothing without a user", () => {
  const headers = {};
  applyIdentity(headers, { user: "", groups: [] }, true);
  assert.deepEqual(headers, {});
});
