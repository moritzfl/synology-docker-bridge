import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as dotenv from "../src/dotenv.mjs";

test("parses comments, quotes and blank lines", () => {
  const values = dotenv.parse(`
# comment
APP_PORT=8742
APP_OUTPUT_DIR="/volume1/music/airplay capture"
EMPTY=
`);
  assert.equal(values.APP_PORT, "8742");
  assert.equal(values.APP_OUTPUT_DIR, "/volume1/music/airplay capture");
  assert.equal(values.EMPTY, "");
});

test("writes values atomically and keeps spaces quoted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dotenv-"));
  const file = path.join(dir, ".env");
  dotenv.write(file, { APP_PORT: "8742", APP_OUTPUT_DIR: "/volume1/music/My Recordings" });
  const values = dotenv.read(file);
  assert.equal(values.APP_PORT, "8742");
  assert.equal(values.APP_OUTPUT_DIR, "/volume1/music/My Recordings");
  assert.ok(fs.readFileSync(file, "utf8").includes('APP_OUTPUT_DIR="/volume1/music/My Recordings"'));
});
