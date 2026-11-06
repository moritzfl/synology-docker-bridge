import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * What a folder allows, checked as the app's own user. DSM's ACLs apply to processes in
 * containers too, so the probe runs as that uid and gid: a folder an administrator can open in
 * File Station may still be closed to the app. The write check creates and removes one empty,
 * uniquely named folder.
 */
const PROBE = `
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[1];
let read = false;
let write = false;
try { fs.readdirSync(dir); read = true; } catch {}
try { fs.rmdirSync(fs.mkdtempSync(path.join(dir, ".bridge-access-"))); write = true; } catch {}
process.stdout.write(JSON.stringify({ read, write }));
`;

/**
 * The app container's user as Docker reports it, e.g. "116095:116095". Container Manager sets
 * the package user's numeric ids there. Root, names and an empty value mean there is nothing a
 * DSM permission could change for the app, so no check is offered.
 */
export function parseUser(value) {
  const match = /^(\d+)(?::(\d+))?$/.exec(String(value || "").trim());
  if (!match) return null;
  const uid = Number(match[1]);
  const gid = Number(match[2] ?? match[1]);
  return uid === 0 ? null : { uid, gid };
}

export async function probe(dir, user, run = execFileAsync) {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return { exists: false, read: false, write: false };
  } catch {
    return { exists: false, read: false, write: false };
  }
  try {
    const { stdout } = await run(process.execPath, ["-e", PROBE, dir],
      { uid: user.uid, gid: user.gid, timeout: 15_000 });
    const result = JSON.parse(stdout);
    return { exists: true, read: result.read === true, write: result.write === true };
  } catch {
    return { exists: true, read: false, write: false };
  }
}
