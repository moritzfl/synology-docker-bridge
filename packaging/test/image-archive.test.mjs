import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import { prepareImageArchive } from "../image-archive.mjs";

const tar = (args) => execFileSync("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const json = (archive, member) => JSON.parse(tar(["-xOf", archive, member]));
const digest = (data) => createHash("sha256").update(data).digest("hex");

function fixture(t, { classic = false } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "test-image-archive-"));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const directory = path.join(stage, "contents");
  fs.mkdirSync(directory);
  const write = (name, data) => fs.writeFileSync(path.join(directory, name), data);
  const pack = (name) => {
    const archive = path.join(stage, name);
    tar(["-cf", archive, "-C", directory, ...fs.readdirSync(directory)]);
    return archive;
  };
  const appConfig = { os: "linux", architecture: "arm64", config: { User: "1000" } };
  if (classic) {
    write("app.json", JSON.stringify(appConfig));
    write("manifest.json", JSON.stringify([{ Config: "app.json", Layers: [] }]));
    return { stage, archive: pack("classic.tar") };
  }

  write("file", "layer contents");
  const data = tar(["-cf", "-", "-C", directory, "file"]);
  fs.unlinkSync(path.join(directory, "file"));
  fs.mkdirSync(path.join(directory, "blobs", "sha256"), { recursive: true });
  const blob = (bytes) => {
    const name = `blobs/sha256/${digest(bytes)}`;
    write(name, bytes);
    return name;
  };
  const layer = blob(zlib.gzipSync(data));
  const upperLayer = blob(zlib.zstdCompressSync?.(data) ?? data);
  const bridgeConfig = { ...appConfig, config: { User: "root" } };
  write("index.json", "{}");
  write("oci-layout", '{"imageLayoutVersion":"1.0.0"}');
  blob("attestation not referenced by the Docker manifest");
  write(
    "manifest.json",
    JSON.stringify([
      {
        Config: blob(JSON.stringify(appConfig)),
        Layers: [layer],
        RepoTags: ["app:spk", "registry.example:5000/team/app:1"],
      },
      {
        Config: blob(JSON.stringify(bridgeConfig)),
        Layers: [layer, upperLayer],
        RepoTags: ["bridge:spk"],
      },
    ]),
  );
  return { stage, archive: pack("hybrid.tar"), data, appConfig, bridgeConfig };
}

test("leaves an already classic Docker archive byte-for-byte unchanged", async (t) => {
  const { archive, stage } = fixture(t, { classic: true });
  const original = fs.readFileSync(archive);
  await prepareImageArchive(archive, "linux/arm64", stage);
  assert.deepEqual(fs.readFileSync(archive), original);
});

test("converts a containerd save to a classic archive without changing either image", async (t) => {
  const { archive, stage, data, appConfig, bridgeConfig } = fixture(t);
  await prepareImageArchive(archive, "linux/arm64", stage);
  const members = tar(["-tf", archive]).toString().trim().split("\n");
  assert.ok(!members.some((name) => /^(blobs\/|index\.json$|oci-layout$)/.test(name)));
  const [app, bridge] = json(archive, "manifest.json");
  assert.deepEqual(app.RepoTags, ["app:spk", "registry.example:5000/team/app:1"]);
  assert.deepEqual(bridge.RepoTags, ["bridge:spk"]);
  assert.deepEqual(json(archive, app.Config), appConfig);
  assert.deepEqual(json(archive, bridge.Config), bridgeConfig);
  assert.equal(app.Layers[0], bridge.Layers[0]);
  assert.equal(bridge.Layers.length, 2);
  for (const layer of bridge.Layers) assert.deepEqual(tar(["-xOf", archive, layer]), data);
  const repositories = json(archive, "repositories");
  const top = repositories.app.spk;
  assert.equal(repositories["registry.example:5000/team/app"]["1"], top);
  assert.notEqual(top, repositories.bridge.spk);
  const unpacked = path.join(stage, "unpacked");
  fs.mkdirSync(unpacked);
  tar(["-xf", archive, "-C", unpacked]);
  for (const id of [top, repositories.bridge.spk]) {
    assert.equal(fs.readFileSync(path.join(unpacked, id, "VERSION"), "utf8"), "1.0");
    assert.deepEqual(fs.readFileSync(path.join(unpacked, id, "layer.tar")), data);
  }
});

test("rejects a wrong architecture without replacing the original archive", async (t) => {
  const { archive, stage } = fixture(t);
  const original = fs.readFileSync(archive);
  await assert.rejects(
    prepareImageArchive(archive, "linux/amd64", stage),
    /linux\/arm64, not linux\/amd64/,
  );
  assert.deepEqual(fs.readFileSync(archive), original);
  assert.ok(!fs.readdirSync(stage).some((name) => name.startsWith("image-archive-")));
});
