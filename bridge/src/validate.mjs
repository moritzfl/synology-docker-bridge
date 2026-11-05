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
