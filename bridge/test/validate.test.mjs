import assert from "node:assert/strict";
import test from "node:test";
import { hostPath, isInside, normalizeDirectory } from "../src/validate.mjs";

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

test("finds the output share's volume from DSM's package link", async () => {
  const { shareRoot } = await import("../src/config.mjs");
  assert.equal(shareRoot("/run/shares/music", () => "/volume2/music"), "/volume2/music");
  assert.equal(shareRoot("/run/shares/music", () => "/elsewhere/music"), "");
  assert.equal(shareRoot("/run/shares/music", () => { throw new Error("ENOENT"); }), "");
  assert.equal(shareRoot(""), "");
});
