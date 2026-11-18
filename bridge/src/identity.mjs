import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants, readFileSync } from "node:fs";

/**
 * Headers that tell the app who is signed in, the convention of Authelia, Authentik and
 * oauth2-proxy. Whatever a browser sends under these names is removed on every request, so the
 * app can trust them when the bridge sets them.
 */
const NAMES = ["remote-user", "remote-groups", "remote-name", "remote-email", "x-bridge-secret"];

/**
 * DSM names may be any Unicode, which HTTP headers cannot carry as text. Send their UTF-8 bytes;
 * an app reading the header as Latin-1 (most do) re-decodes it as UTF-8.
 * Control characters are dropped.
 */
export function headerValue(value) {
  return Buffer.from(String(value).replace(/[\u0000-\u001f\u007f]/g, ""), "utf8").toString(
    "latin1",
  );
}

/**
 * With `secret`, every identified request also carries X-Bridge-Secret. The app's port listens
 * on localhost, where other processes on the NAS (host-network containers among them) could send
 * Remote-User themselves; an app that compares this secret trusts only the bridge.
 */
export function applyIdentity(headers, identity, enabled, secret = "") {
  for (const name of Object.keys(headers)) {
    if (NAMES.includes(name.toLowerCase())) {
      delete headers[name];
    }
  }
  if (!enabled || !identity || !identity.user) {
    return;
  }
  headers["remote-user"] = headerValue(identity.user);
  headers["remote-groups"] = headerValue((identity.groups || []).join(","));
  if (identity.name) {
    headers["remote-name"] = headerValue(identity.name);
  }
  if (identity.email) {
    headers["remote-email"] = headerValue(identity.email);
  }
  if (secret) {
    headers["x-bridge-secret"] = secret;
  }
}

/**
 * The shared secret in the app's data folder, created once. Only the app's own user may read it
 * (root when the app runs as root); `user` is null when that is not known yet.
 *
 * The app owns the folder's contents, so it can plant a symlink where the secret should be. The
 * secret is opened without following it and written to a fresh random name, so the root bridge
 * never reads or overwrites another file through such a link.
 */
export async function ensureSecret(file, user) {
  const existing = await readSecret(file, user);
  if (existing) {
    return existing;
  }
  const secret = crypto.randomBytes(32).toString("hex");
  await writeSecret(file, secret, user);
  return secret;
}

/** The secret when it is a regular file owned by root or the app; otherwise "". */
async function readSecret(file, user) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error.code)) return "";
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (user && stat.uid !== 0 && stat.uid !== user.uid)) {
      return "";
    }
    const secret = (await handle.readFile("utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(secret)) {
      return "";
    }
    await handle.chmod(0o400);
    if (user) {
      await handle.chown(user.uid, user.gid);
    }
    return secret;
  } finally {
    await handle.close();
  }
}

async function writeSecret(file, secret, user) {
  for (let attempt = 0; ; attempt++) {
    const temporary = `${file}.tmp.${crypto.randomBytes(8).toString("hex")}`;
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST" && attempt < 5) continue;
      throw error;
    }
    let wrote = false;
    try {
      await handle.writeFile(`${secret}\n`);
      await handle.chmod(0o400);
      if (user) {
        await handle.chown(user.uid, user.gid);
      }
      wrote = true;
    } finally {
      await handle.close();
      if (!wrote) {
        await fs.rm(temporary, { force: true });
      }
    }
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return;
  }
}

const EMAIL = /^[^\s@:<>"(),;\\]+@[^\s@:<>"(),;\\]+\.[^\s@:<>"(),;\\]+$/;

/**
 * A local DSM user's email address (Control Panel > User, or Personal settings), from DSM's user
 * database: lines of name:flags:email. Only root can read it, so the bridge does, through a
 * read-only mount of /etc (DSM replaces the file on every change, so a mount of the file alone
 * would keep showing the old one). Domain and LDAP users are not in it.
 */
export function dsmEmail(user, file, read = readFileSync) {
  if (!user || !file) return "";
  let text;
  try {
    text = read(file, "utf8");
  } catch {
    return "";
  }
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === user) {
      const email = fields.slice(2).join(":").trim();
      return EMAIL.test(email) ? email : "";
    }
  }
  return "";
}
