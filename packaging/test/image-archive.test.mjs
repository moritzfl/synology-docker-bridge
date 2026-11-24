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

function fixture(
  t,
  {
    classic = false,
    layerless = false,
    badLayer = false,
    badConfig = false,
    missing = false,
    skippable = false,
  } = {},
) {
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

  function makeLayer(content) {
    write("file", content);
    const bytes = tar(["-cf", "-", "-C", directory, "file"]);
    fs.unlinkSync(path.join(directory, "file"));
    return bytes;
  }
  const data = makeLayer("layer contents");
  const upper = makeLayer("another layer");
  const raw = makeLayer("uncompressed layer");
  fs.mkdirSync(path.join(directory, "blobs", "sha256"), { recursive: true });
  const blob = (bytes) => {
    const name = `blobs/sha256/${digest(bytes)}`;
    write(name, bytes);
    return name;
  };
  const layer = blob(zlib.gzipSync(data));
  const zstd = zlib.zstdCompressSync?.(upper);
  const encodedUpper = skippable
    ? Buffer.concat([Buffer.from("502a4d1800000000", "hex"), zstd])
    : zstd;
  const upperLayer = blob(encodedUpper ?? upper);
  const layerRef = missing ? `blobs/sha256/${"a".repeat(64)}` : layer;
  const diff = (bytes) => `sha256:${digest(bytes)}`;
  const rootfs = (buffers) => ({ type: "layers", diff_ids: buffers.map(diff) });
  appConfig.rootfs = rootfs(layerless ? [] : [data]);
  const bridgeConfig = {
    ...appConfig,
    config: { User: "root" },
    rootfs: rootfs([data, badLayer ? raw : upper, raw]),
  };
  const appConfigRef = blob(JSON.stringify(appConfig));
  if (badConfig) write(appConfigRef, JSON.stringify({ ...appConfig, config: { User: "0" } }));
  write("index.json", "{}");
  write("oci-layout", '{"imageLayoutVersion":"1.0.0"}');
  blob("attestation not referenced by the Docker manifest");
  write(
    "manifest.json",
    JSON.stringify([
      {
        Config: appConfigRef,
        Layers: layerless ? null : [layerRef],
        RepoTags: ["app:spk", "registry.example:5000/team/app:1"],
      },
      {
        Config: blob(JSON.stringify(bridgeConfig)),
        Layers: [blob(data), upperLayer, blob(raw)],
        RepoTags: ["bridge:spk"],
      },
    ]),
  );
  return {
    stage,
    archive: pack("hybrid.tar"),
    data,
    upper,
    encodedUpper,
    raw,
    appConfig,
    bridgeConfig,
  };
}

test("leaves an already classic Docker archive byte-for-byte unchanged", async (t) => {
  const { archive, stage } = fixture(t, { classic: true });
  const original = fs.readFileSync(archive);
  await prepareImageArchive(archive, "linux/arm64", stage);
  assert.deepEqual(fs.readFileSync(archive), original);
});

test("converts a containerd save to a classic archive without changing either image", async (t) => {
  const { archive, stage, data, upper, raw, appConfig, bridgeConfig } = fixture(t);
  await prepareImageArchive(archive, "linux/arm64", stage);
  const members = tar(["-tf", archive]).toString().trim().split("\n");
  assert.ok(!members.some((name) => /^(blobs\/|index\.json$|oci-layout$)/.test(name)));
  const [app, bridge] = json(archive, "manifest.json");
  assert.deepEqual(app.RepoTags, ["app:spk", "registry.example:5000/team/app:1"]);
  assert.deepEqual(bridge.RepoTags, ["bridge:spk"]);
  assert.deepEqual(json(archive, app.Config), appConfig);
  assert.deepEqual(json(archive, bridge.Config), bridgeConfig);
  assert.equal(app.Layers[0], bridge.Layers[0]);
  assert.equal(bridge.Layers.length, 3);
  for (const [index, bytes] of [data, upper, raw].entries()) {
    assert.equal(bridge.Layers[index], `${digest(bytes)}.tar`);
    assert.deepEqual(tar(["-xOf", archive, bridge.Layers[index]]), bytes);
  }
  const repositories = json(archive, "repositories");
  const top = repositories.app.spk;
  assert.equal(repositories["registry.example:5000/team/app"]["1"], top);
  assert.notEqual(top, repositories.bridge.spk);
  const unpacked = path.join(stage, "unpacked");
  fs.mkdirSync(unpacked);
  tar(["-xf", archive, "-C", unpacked]);
  for (const [id, bytes] of [
    [top, data],
    [repositories.bridge.spk, raw],
  ]) {
    assert.equal(fs.readFileSync(path.join(unpacked, id, "VERSION"), "utf8"), "1.0");
    assert.deepEqual(fs.readFileSync(path.join(unpacked, id, "layer.tar")), bytes);
  }
});

test("keeps the tags and config of a layerless Docker image with Layers: null", async (t) => {
  const { archive, stage, appConfig } = fixture(t, { layerless: true });
  await prepareImageArchive(archive, "linux/arm64", stage);
  const [app] = json(archive, "manifest.json");
  assert.deepEqual(app.RepoTags, ["app:spk", "registry.example:5000/team/app:1"]);
  assert.deepEqual(app.Layers, []);
  assert.deepEqual(json(archive, app.Config), appConfig);
  assert.ok(json(archive, "repositories").bridge.spk);
});

test(
  "never publishes a truncated layer when the native zstd decoder stops after the first frame",
  { skip: !zlib.zstdCompressSync },
  async (t) => {
    const { archive, stage, upper, encodedUpper } = fixture(t, { skippable: true });
    const original = fs.readFileSync(archive);
    // Some Node 22 builds return an empty result for a skippable frame and ignore the rest.
    if (zlib.zstdDecompressSync(encodedUpper).equals(upper)) {
      await prepareImageArchive(archive, "linux/arm64", stage);
      assert.deepEqual(tar(["-xOf", archive, `${digest(upper)}.tar`]), upper);
    } else {
      await assert.rejects(prepareImageArchive(archive, "linux/arm64", stage), /multi-frame zstd/);
      assert.deepEqual(fs.readFileSync(archive), original);
    }
  },
);

for (const [reason, options, platform, error] of [
  ["a wrong architecture", {}, "linux/amd64", /linux\/arm64, not linux\/amd64/],
  ["a missing layer", { missing: true }, "linux/arm64", /image archive is missing blob/],
  ["an incorrect layer digest", { badLayer: true }, "linux/arm64", /does not match sha256:/],
  ["a changed config", { badConfig: true }, "linux/arm64", /image config digest does not match/],
]) {
  test(`rejects ${reason} without replacing the original archive`, async (t) => {
    const { archive, stage } = fixture(t, options);
    const original = fs.readFileSync(archive);
    await assert.rejects(prepareImageArchive(archive, platform, stage), error);
    assert.deepEqual(fs.readFileSync(archive), original);
    assert.ok(!fs.readdirSync(stage).some((name) => name.startsWith("image-archive-")));
  });
}
