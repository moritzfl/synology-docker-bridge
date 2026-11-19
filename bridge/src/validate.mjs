import fs from "node:fs/promises";
import path from "node:path";

export function normalizeDirectory(value, allowedRoot) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("folder path is required");
  }
  if (value.includes("\0")) {
    throw new Error("folder path contains a NUL byte");
  }
  const normalized = path.posix.normalize(value.trim());
  if (!normalized.startsWith("/")) {
    throw new Error("folder path must be absolute");
  }
  const root = path.posix.normalize(allowedRoot);
  if (normalized === root || normalized === "/") {
    throw new Error(`choose a folder below ${root}`);
  }
  if (!normalized.startsWith(`${root}/`)) {
    throw new Error(`folder must be below ${root}`);
  }
  return normalized.replace(/\/+$/, "");
}

export function hostPath(containerPath, allowedRoot, hostRoot) {
  const root = path.posix.normalize(allowedRoot);
  const relative = containerPath.slice(root.length).replace(/^\/+/, "");
  return path.posix.join(hostRoot, relative);
}

export function isInside(parent, child) {
  const base = path.posix.resolve(parent);
  const target = path.posix.resolve(child);
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Creates a folder below `hostRoot` one component at a time and refuses symlinks on the way, so
 * the root bridge cannot be led out of the share by a link the app placed there. Returns the
 * folder's real path.
 */
export async function ensureFolder(hostRoot, host) {
  const root = await fs.realpath(hostRoot);
  const relative = path.posix.relative(path.posix.normalize(hostRoot), path.posix.normalize(host));
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative)) {
    throw new Error("folder is outside the allowed volume");
  }
  let current = root;
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === "..") {
      throw new Error("folder is outside the allowed volume");
    }
    current = path.posix.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(current);
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("folder is outside the allowed volume");
    }
  }
  const real = await fs.realpath(current);
  if (!isInside(root, real)) throw new Error("folder is outside the allowed volume");
  return real;
}

/** An existing folder's real path, refusing one outside `hostRoot`. */
export async function realFolder(hostRoot, host) {
  const root = await fs.realpath(hostRoot);
  const real = await fs.realpath(path.posix.normalize(host));
  const stat = await fs.stat(real);
  const expected = path.posix.resolve(root, path.posix.relative(hostRoot, host));
  if (!stat.isDirectory() || real !== expected || real === root || !isInside(root, real)) {
    throw new Error("folder is outside the allowed volume");
  }
  return real;
}
