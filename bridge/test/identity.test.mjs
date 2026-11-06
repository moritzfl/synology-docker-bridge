import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyIdentity, ensureSecret } from "../src/identity.mjs";

test("passes the shared secret with the identity and drops a forged one", () => {
  const forged = { "X-Bridge-Secret": "guess" };
  applyIdentity(forged, null, true, "s3cret");
  assert.deepEqual(forged, {});
  const headers = { "x-bridge-secret": "guess" };
  applyIdentity(headers, { user: "anna", groups: [] }, true, "s3cret");
  assert.equal(headers["x-bridge-secret"], "s3cret");
});

test("creates the secret once, readable only by its owner", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "secret-")), ".bridge-secret");
  const first = await ensureSecret(file, null);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400);
  assert.equal(await ensureSecret(file, null), first);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "short\n");
  assert.notEqual(await ensureSecret(file, null), "short", "a damaged secret is replaced");
});

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
