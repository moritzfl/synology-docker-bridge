import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneSuperseded } from "../src/images.mjs";

const quiet = () => {};

async function stateFile(images) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-images-"));
  const file = path.join(dir, "images.json");
  if (images) await fs.writeFile(file, JSON.stringify({ images }));
  return file;
}

function docker(running, inUse = []) {
  const removed = [];
  return {
    removed,
    inspect: async (name) => (name in running ? { imageId: running[name] } : null),
    remove: async (id) => {
      if (inUse.includes(id)) return false;
      removed.push(id);
      return true;
    },
  };
}

test("first start only records the current images", async () => {
  const file = await stateFile(null);
  const fake = docker({ app: "sha:app1", "app-bridge": "sha:bridge1" });
  await pruneSuperseded({ stateFile: file, containers: ["app", "app-bridge"], ...fake, log: quiet });
  assert.deepEqual(fake.removed, []);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).images, ["sha:app1", "sha:bridge1"]);
});

test("after an upgrade the replaced images are removed", async () => {
  const file = await stateFile(["sha:app1", "sha:bridge1"]);
  const fake = docker({ app: "sha:app2", "app-bridge": "sha:bridge2" });
  const result = await pruneSuperseded({
    stateFile: file, containers: ["app", "app-bridge"], ...fake, log: quiet,
  });
  assert.deepEqual(result.removed, ["sha:app1", "sha:bridge1"]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).images, ["sha:app2", "sha:bridge2"]);
});

test("images still used elsewhere are kept and retried later", async () => {
  const file = await stateFile(["sha:shared"]);
  const fake = docker({ app: "sha:app2", "app-bridge": "sha:bridge2" }, ["sha:shared"]);
  const result = await pruneSuperseded({
    stateFile: file, containers: ["app", "app-bridge"], ...fake, log: quiet,
  });
  assert.deepEqual(result.removed, []);
  assert.ok(JSON.parse(await fs.readFile(file, "utf8")).images.includes("sha:shared"));
});

test("nothing is removed while a container is missing", async () => {
  const file = await stateFile(["sha:app1"]);
  const fake = docker({ "app-bridge": "sha:bridge2" });
  await pruneSuperseded({ stateFile: file, containers: ["app", "app-bridge"], ...fake, log: quiet });
  assert.deepEqual(fake.removed, [], "the old app image may be what Container Manager restores");
});
