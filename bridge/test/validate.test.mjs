import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureFolder,
  hostPath,
  isInside,
  normalizeDirectory,
  realFolder,
} from "../src/validate.mjs";

test("normalizes a folder below the allowed root", () => {
  assert.equal(
    normalizeDirectory("/volume1/music/airplay-capture/", "/volume1"),
    "/volume1/music/airplay-capture",
  );
});

test("rejects traversal and the volume root itself", () => {
  assert.throws(() => normalizeDirectory("/volume1/../etc", "/volume1"));
  assert.throws(() => normalizeDirectory("/volume1", "/volume1"));
  assert.throws(() => normalizeDirectory("relative/path", "/volume1"));
});

test("maps a container path to the mounted host root", () => {
  assert.equal(
    hostPath("/volume1/music/airplay-capture", "/volume1", "/host/volume1"),
    "/host/volume1/music/airplay-capture",
  );
});

test("checks realpath containment", () => {
  assert.equal(isInside("/host/volume1", "/host/volume1/music"), true);
  assert.equal(isInside("/host/volume1", "/host/volume2/music"), false);
});

test("creates missing folders below the root and refuses symlinks on the way", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "folder-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "folder-outside-"));
  const created = await ensureFolder(root, path.join(root, "a/b"));
  assert.equal(created, path.join(fs.realpathSync(root), "a/b"));
  assert.equal(fs.statSync(created).isDirectory(), true);
  assert.equal(
    await ensureFolder(root, path.join(root, "a")),
    path.join(fs.realpathSync(root), "a"),
  );
  fs.symlinkSync(outside, path.join(root, "link"));
  await assert.rejects(ensureFolder(root, path.join(root, "link/sub")), /outside/);
  await assert.rejects(ensureFolder(root, path.join(root, "link")), /outside/);
  await assert.rejects(realFolder(root, path.join(root, "link")), /outside/);
  fs.symlinkSync(created, path.join(root, "inside"));
  await assert.rejects(realFolder(root, path.join(root, "inside")), /outside/);
  assert.equal(fs.readdirSync(outside).length, 0, "nothing is created through the link");
});

test("finds the output share's volume from DSM's package link", async () => {
  const { shareRoot } = await import("../src/config.mjs");
  assert.equal(
    shareRoot("/run/shares/music", () => "/volume2/music"),
    "/volume2/music",
  );
  assert.equal(
    shareRoot("/run/shares/music", () => "/elsewhere/music"),
    "",
  );
  assert.equal(
    shareRoot("/run/shares/music", () => {
      throw new Error("ENOENT");
    }),
    "",
  );
  assert.equal(shareRoot(""), "");
});
