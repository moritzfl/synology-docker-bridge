import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyIdentity, dsmEmail, ensureSecret } from "../src/identity.mjs";

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

test("a symlinked secret is replaced, never followed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-"));
  const target = path.join(dir, "target");
  const planted = "a".repeat(64);
  fs.writeFileSync(target, `${planted}\n`);
  const file = path.join(dir, ".bridge-secret");
  fs.symlinkSync(target, file);
  const secret = await ensureSecret(file, null);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.notEqual(secret, planted, "the planted value is not used");
  assert.equal(fs.readFileSync(target, "utf8"), `${planted}\n`, "the target is untouched");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400);
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

test("passes the DSM full name, and non-ASCII names as UTF-8 bytes", () => {
  const headers = {};
  applyIdentity(headers, { user: "łukasz", groups: ["users"], name: "Łukasz Müller\n" }, true);
  assert.equal(Buffer.from(headers["remote-user"], "latin1").toString("utf8"), "łukasz");
  assert.equal(Buffer.from(headers["remote-name"], "latin1").toString("utf8"), "Łukasz Müller");
  for (const value of Object.values(headers)) {
    assert.match(value, /^[\t\x20-\x7e\x80-\xff]*$/, "valid as an HTTP header value");
  }
  const unnamed = {};
  applyIdentity(unnamed, { user: "anna", groups: [] }, true);
  assert.equal(unnamed["remote-name"], undefined);
});

test("finds a local DSM user's email in DSM's user database and passes it on", () => {
  const db = "admin:0:\nanna:0:anna@example.com\nbob:0:not an address\neve:2:eve@example.org\n";
  const read = () => db;
  assert.equal(dsmEmail("anna", "/db", read), "anna@example.com");
  assert.equal(dsmEmail("admin", "/db", read), "", "no address set");
  assert.equal(dsmEmail("bob", "/db", read), "", "only real addresses");
  assert.equal(dsmEmail("carol", "/db", read), "", "domain users are not in it");
  assert.equal(dsmEmail("anna", "", read), "");
  assert.equal(
    dsmEmail("anna", "/db", () => {
      throw new Error("EACCES");
    }),
    "",
  );
  const headers = { "remote-email": "forged@example.com" };
  applyIdentity(headers, { user: "anna", groups: [], email: "anna@example.com" }, true);
  assert.equal(headers["remote-email"], "anna@example.com");
  const without = { "Remote-Email": "forged@example.com" };
  applyIdentity(without, { user: "admin", groups: [] }, true);
  assert.equal(without["Remote-Email"], undefined, "a forged address never gets through");
  assert.equal(without["remote-email"], undefined);
});
