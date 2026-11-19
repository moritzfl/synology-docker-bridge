import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePrivateFile } from "../src/private-file.mjs";

test("replaces a state file with a private regular file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-file-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old", { mode: 0o644 });
  writePrivateFile(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
});

test("a symlink at the destination is replaced, never followed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-file-"));
  const target = path.join(dir, "target");
  const file = path.join(dir, "state.json");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, file);
  writePrivateFile(file, "new");
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
});
