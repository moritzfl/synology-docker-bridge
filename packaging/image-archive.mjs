import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { canonicalImageTag, taggedImage } from "./image-reference.mjs";

const blobPath = /^blobs\/sha256\/[a-f0-9]{64}$/;
const diffIdPattern = /^sha256:([a-f0-9]{64})$/;
const digestName = (blob) => path.posix.basename(blob);

function readMember(archive, member) {
  return JSON.parse(execFileSync("tar", ["-xOf", archive, "--", member], { encoding: "utf8" }));
}

function verifyPlatform(image, label, platform) {
  const actual = `${image.os}/${image.architecture}`;
  if (actual !== platform) {
    throw new Error(
      `${label} is ${actual}, not ${platform}; pull or build it with --platform ${platform}`,
    );
  }
  console.log(`==> ${label}: ${actual}`);
}

/** Compose uses pull_policy: never, so the archive must load exactly the requested tags. */
function verifyTags(manifest, tags) {
  const expected = new Map(tags.map((tag) => [canonicalImageTag(tag), tag]));
  const found = new Map();
  const unexpected = new Set();
  for (const entry of manifest) {
    if (!Array.isArray(entry.RepoTags) || !entry.RepoTags.length) {
      throw new Error("docker save included an untagged image; use a local image tag");
    }
    for (const tag of entry.RepoTags) {
      if (taggedImage(tag, "docker save tag") !== tag) {
        throw new Error(`docker save included an image reference without a tag: ${tag}`);
      }
      const key = canonicalImageTag(tag);
      if (found.has(key) && found.get(key) !== entry) {
        throw new Error(`docker save included more than one image for tag ${tag}`);
      }
      found.set(key, entry);
      if (!expected.has(key)) unexpected.add(tag);
    }
  }
  const missing = [...expected].filter(([key]) => !found.has(key)).map(([, tag]) => tag);
  if (missing.length || unexpected.size) {
    const problems = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      unexpected.size ? `unexpected ${[...unexpected].join(", ")}` : "",
    ].filter(Boolean);
    throw new Error(
      `docker save did not export exactly the requested image tags (${problems.join("; ")})`,
    );
  }
}

/** Legacy Docker archives (including Podman's) carry uncompressed layer tar files. */
async function copyLayer(source, target, diffId) {
  let decompress;
  let usesZstd = false;
  if (digestName(source) !== diffId) {
    const fd = fs.openSync(source, "r");
    const magic = Buffer.alloc(4);
    try {
      fs.readSync(fd, magic);
    } finally {
      fs.closeSync(fd);
    }
    const marker = magic.readUInt32LE();
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
      decompress = zlib.createGunzip();
    } else if (marker === 0xfd2fb528 || marker >>> 4 === 0x0184d2a5) {
      // The stream can start with a Zstandard skippable frame.
      if (!zlib.createZstdDecompress)
        throw new Error("zstd image layers require Node.js 22.15 or later");
      decompress = zlib.createZstdDecompress();
      usesZstd = true;
    }
  }
  // DiffIDs identify the uncompressed tar stream, independent of how Docker stored each blob.
  async function* verified(input) {
    const hash = createHash("sha256");
    for await (const chunk of input) {
      hash.update(chunk);
      yield chunk;
    }
    if (hash.digest("hex") !== diffId) {
      const hint = usesZstd ? "; if using Node.js 22, try Node.js 26 for multi-frame zstd" : "";
      throw new Error(
        `image layer ${path.basename(source)} does not match sha256:${diffId}${hint}`,
      );
    }
  }
  if (decompress) {
    await pipeline(fs.createReadStream(source), decompress, verified, fs.createWriteStream(target));
  } else {
    for await (const _ of verified(fs.createReadStream(source))) {
      // Verify without making a second copy of the uncompressed layer.
    }
    fs.linkSync(source, target);
  }
}

/**
 * Keep classic Docker saves unchanged. Newer saves include a Docker manifest, but also OCI
 * metadata that older DSM Container Manager importers may reject.
 */
export async function prepareImageArchive(archive, platform, stage, tags) {
  const members = new Set(execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).split("\n"));
  if (!members.has("manifest.json")) {
    throw new Error("docker save did not write manifest.json; a Docker image archive is required");
  }
  const manifest = readMember(archive, "manifest.json");
  if (!Array.isArray(manifest) || !manifest.length)
    throw new Error("docker save produced no images");
  verifyTags(manifest, tags);
  const imageLabel = (entry) => (entry.RepoTags || []).join(", ") || entry.Config;
  if (!members.has("oci-layout") && !members.has("index.json")) {
    for (const entry of manifest)
      verifyPlatform(readMember(archive, entry.Config), imageLabel(entry), platform);
    return;
  }

  console.log("==> converting OCI image archive to classic Docker format for DSM");
  const work = fs.mkdtempSync(path.join(stage, "image-archive-"));
  try {
    const entries = manifest.map((entry) => {
      // docker save writes null for an image with no filesystem layers.
      const layers = entry.Layers ?? [];
      if (!Array.isArray(layers)) throw new Error(`invalid layers for ${imageLabel(entry)}`);
      return { ...entry, Layers: layers };
    });
    const blobs = new Set(entries.flatMap((entry) => [entry.Config, ...entry.Layers]));
    for (const blob of blobs) {
      if (!blobPath.test(blob)) throw new Error(`unexpected image archive blob path: ${blob}`);
      if (!members.has(blob)) throw new Error(`image archive is missing blob: ${blob}`);
    }
    execFileSync("tar", ["-xf", archive, "-C", work, "--", ...blobs]);
    for (const blob of blobs) {
      if (!fs.lstatSync(path.join(work, blob)).isFile())
        throw new Error(`not a regular image blob: ${blob}`);
    }

    const classic = path.join(work, "classic");
    fs.mkdirSync(classic);
    const repositories = Object.create(null);
    const converted = [];
    const configs = new Map();
    const layers = new Set();
    const legacyLayers = new Set();
    for (const entry of entries) {
      const { Config, Layers, RepoTags } = entry;
      const configFile = `${digestName(Config)}.json`;
      if (!configs.has(Config)) {
        const source = path.join(work, Config);
        const config = fs.readFileSync(source);
        if (createHash("sha256").update(config).digest("hex") !== digestName(Config)) {
          throw new Error(`${imageLabel(entry)}: image config digest does not match ${Config}`);
        }
        fs.linkSync(source, path.join(classic, configFile));
        configs.set(Config, JSON.parse(config));
      }
      const image = configs.get(Config);
      verifyPlatform(image, imageLabel(entry), platform);
      const diffIds = image.rootfs?.diff_ids ?? [];
      if (
        image.rootfs?.type !== "layers" ||
        !Array.isArray(diffIds) ||
        diffIds.length !== Layers.length
      ) {
        throw new Error(`${imageLabel(entry)}: image config does not describe the manifest layers`);
      }
      let parent = "";
      const layerFiles = [];
      for (const [index, blob] of Layers.entries()) {
        const diffId = diffIdPattern.exec(diffIds[index])?.[1];
        if (!diffId) throw new Error(`${imageLabel(entry)}: invalid layer digest`);
        const layerFile = `${diffId}.tar`;
        if (!layers.has(diffId)) {
          await copyLayer(path.join(work, blob), path.join(classic, layerFile), diffId);
          layers.add(diffId);
        }
        layerFiles.push(layerFile);

        // Match the classic `repositories` → layer directory layout, without duplicating layers
        // shared between the two images. The top layer ID also includes the image config.
        const top = index === Layers.length - 1;
        const id = createHash("sha256")
          .update(JSON.stringify([parent, diffId, top ? Config : ""]))
          .digest("hex");
        if (!legacyLayers.has(id)) {
          const dir = path.join(classic, id);
          fs.mkdirSync(dir);
          fs.symlinkSync(`../${layerFile}`, path.join(dir, "layer.tar"));
          fs.writeFileSync(path.join(dir, "VERSION"), "1.0");
          const metadata = top
            ? { architecture: image.architecture, config: image.config, created: image.created }
            : { created: "1970-01-01T00:00:00Z" };
          fs.writeFileSync(
            path.join(dir, "json"),
            JSON.stringify({ ...metadata, id, parent, os: image.os }),
          );
          legacyLayers.add(id);
        }
        parent = id;
      }
      for (const tag of parent ? RepoTags || [] : []) {
        const colon = tag.lastIndexOf(":");
        const repository = tag.slice(0, colon);
        (repositories[repository] ??= Object.create(null))[tag.slice(colon + 1)] = parent;
      }
      converted.push({ ...entry, Config: configFile, Layers: layerFiles });
    }
    fs.writeFileSync(path.join(classic, "manifest.json"), JSON.stringify(converted));
    fs.writeFileSync(path.join(classic, "repositories"), JSON.stringify(repositories));
    const output = path.join(work, "classic.tar");
    execFileSync("tar", ["-cf", output, "-C", classic, ...fs.readdirSync(classic)], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    fs.renameSync(output, archive);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
