import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseUser, probe } from "../src/access.mjs";

test("reads the package user's ids from the container", () => {
  assert.deepEqual(parseUser("116095:116095"), { uid: 116095, gid: 116095 });
  assert.deepEqual(parseUser("1026"), { uid: 1026, gid: 1026 });
});

test("offers no check for root, user names or no user", () => {
  for (const value of ["", "0", "0:0", "root", "app:app", undefined]) {
    assert.equal(parseUser(value), null, String(value));
  }
});

test("a missing folder is reported as missing, without running a probe", async () => {
  let ran = false;
  const result = await probe("/no/such/folder", { uid: 1, gid: 1 }, async () => { ran = true; });
  assert.deepEqual(result, { exists: false, read: false, write: false });
  assert.equal(ran, false);
});

test("the probe runs as the app's user and reports what it could do", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-"));
  let options;
  const result = await probe(dir, { uid: 4242, gid: 4343 }, async (command, args, given) => {
    options = given;
    return { stdout: JSON.stringify({ read: true, write: false }) };
  });
  assert.equal(options.uid, 4242);
  assert.equal(options.gid, 4343);
  assert.deepEqual(result, { exists: true, read: true, write: false });
});

test("a probe that cannot run counts as no access", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-"));
  const result = await probe(dir, { uid: 1, gid: 1 }, async () => { throw new Error("EPERM"); });
  assert.deepEqual(result, { exists: true, read: false, write: false });
});

test("the real probe can read and write a folder of the current user", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-"));
  const user = { uid: process.getuid(), gid: process.getgid() };
  assert.deepEqual(await probe(dir, user), { exists: true, read: true, write: true });
  assert.deepEqual(fs.readdirSync(dir), [], "the write check leaves nothing behind");
});
