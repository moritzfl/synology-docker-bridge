import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Only trust state written by this process's uid; never open FIFOs in blocking mode. */
export function readPrivateFile(file, owner = process.getuid()) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.uid !== owner && stat.uid !== 0))
      throw new Error("unexpected state file owner or type");
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Replaces a small package state file as root without following a planted symlink and without
 * leaking the previous mode. The temporary name is random and exclusive; the content is written
 * through the open descriptor, and only then renamed into place.
 */
export function writePrivateFile(file, content, { mode = 0o600, owner } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(descriptor, content);
    fs.fchmodSync(descriptor, mode);
    if (owner) fs.fchownSync(descriptor, owner.uid, owner.gid);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
    throw error;
  }
  fs.closeSync(descriptor);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
