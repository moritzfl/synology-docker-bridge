import crypto from "node:crypto";
import fs from "node:fs/promises";

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
  if (secret) {
    headers["x-bridge-secret"] = secret;
  }
}

/**
 * The shared secret in the app's data folder, created once. Only the app's own user may read it
 * (root when the app runs as root); `user` is null when that is not known yet.
 */
export async function ensureSecret(file, user) {
  let secret = "";
  try {
    secret = (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    secret = crypto.randomBytes(32).toString("hex");
    const temporary = `${file}.tmp.${process.pid}`;
    await fs.writeFile(temporary, `${secret}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  await fs.chmod(file, 0o400);
  if (user) {
    await fs.chown(file, user.uid, user.gid);
  }
  return secret;
}
