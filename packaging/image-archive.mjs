import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

const blobPath = /^blobs\/sha256\/[a-f0-9]{64}$/;
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

/** Legacy Docker archives (including Podman's) carry uncompressed layer tar files. */
async function copyLayer(source, target) {
  const fd = fs.openSync(source, "r");
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(fd, magic);
  } finally {
    fs.closeSync(fd);
  }
  let decompress;
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    decompress = zlib.createGunzip();
  } else if (magic.readUInt32BE() === 0x28b52ffd) {
    if (!zlib.createZstdDecompress)
      throw new Error("zstd image layers require Node.js 22.15 or later");
    decompress = zlib.createZstdDecompress();
  }
  if (decompress) {
    await pipeline(fs.createReadStream(source), decompress, fs.createWriteStream(target));
  } else {
    fs.linkSync(source, target);
  }
}

/**
 * Keep classic Docker saves unchanged. Newer saves include a Docker manifest, but also OCI
 * metadata that older DSM Container Manager importers may reject.
 */
export async function prepareImageArchive(archive, platform, stage) {
  const members = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).split("\n");
  if (!members.includes("manifest.json")) {
    throw new Error("docker save did not write manifest.json; a Docker image archive is required");
  }
  const manifest = readMember(archive, "manifest.json");
  if (!Array.isArray(manifest) || !manifest.length)
    throw new Error("docker save produced no images");
  const imageLabel = (entry) => (entry.RepoTags || []).join(", ") || entry.Config;
  if (!members.includes("oci-layout") && !members.includes("index.json")) {
    for (const entry of manifest)
      verifyPlatform(readMember(archive, entry.Config), imageLabel(entry), platform);
    return;
  }

  console.log("==> converting OCI image archive to classic Docker format for DSM");
  const work = fs.mkdtempSync(path.join(stage, "image-archive-"));
  try {
    const blobs = new Set(manifest.flatMap((entry) => [entry.Config, ...entry.Layers]));
    for (const blob of blobs) {
      if (!blobPath.test(blob)) throw new Error(`unexpected image archive blob path: ${blob}`);
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
    for (const entry of manifest) {
      const { Config, Layers, RepoTags } = entry;
      const configFile = `${digestName(Config)}.json`;
      if (!configs.has(Config)) {
        fs.linkSync(path.join(work, Config), path.join(classic, configFile));
        configs.set(Config, JSON.parse(fs.readFileSync(path.join(classic, configFile), "utf8")));
      }
      const image = configs.get(Config);
      verifyPlatform(image, imageLabel(entry), platform);
      let parent = "";
      const layerFiles = [];
      for (const [index, blob] of Layers.entries()) {
        const layerFile = `${digestName(blob)}.tar`;
        if (!layers.has(blob)) {
          await copyLayer(path.join(work, blob), path.join(classic, layerFile));
          layers.add(blob);
        }
        layerFiles.push(layerFile);

        // Match the classic `repositories` → layer directory layout, without duplicating layers
        // shared between the two images. The top layer ID also includes the image config.
        const top = index === Layers.length - 1;
        const id = createHash("sha256")
          .update(JSON.stringify([parent, blob, top ? Config : ""]))
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
