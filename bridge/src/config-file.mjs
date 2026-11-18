import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isInside } from "./validate.mjs";

export const MAX_BYTES = 256 * 1024;

export class ConfigError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Identifies one saved state of the file, so a save can tell whether someone else saved since. */
export function versionOf(content) {
  return content === null ? "" : crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * The app's settings file in its data folder, edited from the DSM window. Saving checks the file
 * first (a command in the app's container), then restarts the app. If the app does not come back
 * and stay up, the previous file is put back and the app restarted again, so a mistake in the
 * settings never leaves the app unusable.
 *
 * `dir` is the data folder as the bridge sees it, `containerDir` as the app sees it. `stateFile`
 * keeps a save the bridge is still watching, with the previous file, so a restart of the bridge
 * (a crash, a reboot of the NAS) does not leave a file behind that the app cannot start with.
 */
export function createConfigFile({
  dir,
  file,
  containerDir = "/data",
  check = [],
  ready = [],
  docker,
  container,
  reachable,
  log = () => {},
  pollMs = 2000,
  settleMs = 30_000,
  timeoutMs = 600_000,
  checkTimeoutMs = 60_000,
  stateFile = "",
}) {
  const target = path.posix.join(dir, file);
  const name = path.posix.basename(file);
  let job = { state: "idle" };
  // While the app restarts with a new file: what to put back ({ previous, stat, since }).
  let pending = null;

  /** Records the job, and while one is pending, the previous file, before anything else. */
  async function remember(next, nextPending = pending) {
    job = next;
    pending = nextPending;
    if (!stateFile) return;
    try {
      await fs.writeFile(stateFile, JSON.stringify({ job, pending }), { mode: 0o600 });
    } catch (error) {
      log("warn", "settings job could not be recorded", { error: error.message });
    }
  }

  /**
   * The data folder and the file's parent with symlinks resolved. The app owns the folder's
   * contents, so a symlinked parent must not lead the root bridge outside it.
   */
  async function resolved() {
    let root;
    try {
      root = await fs.realpath(dir);
    } catch (error) {
      if (error.code === "ENOENT") return { parent: null };
      throw error;
    }
    let parent;
    try {
      parent = await fs.realpath(path.posix.dirname(target));
    } catch (error) {
      if (error.code === "ENOENT") return { parent: null };
      throw error;
    }
    if (!isInside(root, parent)) throw new ConfigError(409, "not-a-file");
    return { parent };
  }

  async function current() {
    const { parent } = await resolved();
    if (!parent) return { content: null, stat: null };
    let handle;
    try {
      handle = await fs.open(
        path.posix.join(parent, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error.code === "ENOENT") return { content: null, stat: null };
      if (["ELOOP", "ENOTDIR"].includes(error.code)) throw new ConfigError(409, "not-a-file");
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ConfigError(409, "not-a-file");
      return { content: await handle.readFile("utf8"), stat };
    } finally {
      await handle.close();
    }
  }

  /** Writes to a fresh random name inside the resolved folder, then renames it into place. */
  async function write(content, stat) {
    const { parent } = await resolved();
    if (!parent) throw new ConfigError(409, "not-a-file");
    const destination = path.posix.join(parent, name);
    if (content === null) {
      await fs.rm(destination, { force: true });
      return;
    }
    let temporary;
    let handle;
    for (let attempt = 0; ; attempt++) {
      temporary = path.posix.join(
        parent,
        `.${name}.bridge-${crypto.randomBytes(8).toString("hex")}`,
      );
      try {
        handle = await fs.open(temporary, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code === "EEXIST" && attempt < 5) continue;
        throw error;
      }
    }
    try {
      await handle.writeFile(content);
      await handle.chmod(stat ? stat.mode & 0o7777 : 0o644);
      if (stat) {
        await handle.chown(stat.uid, stat.gid).catch(() => {});
      } else {
        const owner = await appOwner();
        if (owner) await handle.chown(owner.uid, owner.gid).catch(() => {});
      }
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    await fs.rename(temporary, destination);
  }

  /** A new file belongs to the app's own user, like the files the app creates. */
  async function appOwner() {
    const info = await docker.inspect(container).catch(() => null);
    const match = /^(\d+)(?::(\d+))?$/.exec(String(info?.user || ""));
    return match ? { uid: Number(match[1]), gid: Number(match[2] ?? match[1]) } : null;
  }

  /** Runs the app's own check on the candidate; the app reads it from a scratch folder. */
  async function runCheck(content) {
    if (!check.length) return { ok: true, output: "" };
    // A fresh random folder: the app owns the data folder, so a predictable check path could be
    // swapped for a symlink while the bridge writes the candidate as root.
    const scratch = await fs.mkdtemp(path.posix.join(dir, ".bridge-check-"));
    await fs.chmod(scratch, 0o755);
    const owner = await appOwner();
    try {
      await fs.writeFile(path.posix.join(scratch, name), content, { mode: 0o644 });
      if (owner) {
        await fs.chown(scratch, owner.uid, owner.gid).catch(() => {});
        await fs.chown(path.posix.join(scratch, name), owner.uid, owner.gid).catch(() => {});
      }
      const candidate = path.posix.join(containerDir, path.posix.basename(scratch), name);
      const info = await docker.inspect(container);
      if (info?.state !== "running") return { ok: true, output: "", skipped: true };
      const result = await docker.exec(
        container,
        check.map((arg) => arg.replaceAll("{file}", candidate)),
        { timeout: checkTimeoutMs },
      );
      return { ok: result.exitCode === 0, output: result.output.trim().slice(0, 8000) };
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Whether the app is really up. Some apps answer with a maintenance page while they set up, so
   * an app may name a command (`ready`) that succeeds only then; otherwise any answer counts.
   */
  async function up() {
    if (!ready.length) return reachable();
    const result = await docker.exec(container, ready, { timeout: 15_000 }).catch(() => null);
    return result?.exitCode === 0;
  }

  /**
   * After a restart the app must be up and stay up for `settleMs`, in the container that was
   * started. A crash restarts the container (a new start time) or stops it; either fails.
   */
  async function healthy() {
    const started = Date.now();
    const first = await docker.inspect(container);
    const startedAt = first?.startedAt || "";
    let stableSince = null;
    for (;;) {
      const info = await docker.inspect(container).catch(() => null);
      if (!info || info.state !== "running" || info.startedAt !== startedAt) {
        return false;
      }
      if (await up()) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= settleMs) return true;
      } else {
        stableSince = null;
      }
      if (Date.now() - started > timeoutMs) return false;
      await sleep(pollMs);
    }
  }

  async function restartAndWait() {
    await docker.restart(container);
    return healthy();
  }

  /**
   * Restarts the app with the new file and watches it; `step` picks up where a restarted bridge
   * left off: "watch" when the app was already restarted, "restore" when restoring had begun.
   */
  async function apply({ previous, stat, since }, step = "restart") {
    try {
      if (step !== "restore") {
        if (step === "restart" ? await restartAndWait() : await healthy()) {
          await remember({ ...job, state: "applied" }, null);
          log("info", "settings applied", { file });
          return;
        }
        const output = await docker.logs(container, { since, tail: 60 }).catch(() => "");
        await remember({ ...job, state: "restoring", log: output.trim().slice(-8000) });
        log("warn", "app did not start with the new settings; restoring", { file });
      }
      await write(previous, stat);
      await remember({ ...job, state: (await restartAndWait()) ? "restored" : "failed" }, null);
    } catch (error) {
      log("warn", "settings could not be applied", { error: error.message });
      await remember({ ...job, state: "failed", log: job.log || error.message }, null);
    }
  }

  return {
    file,

    async read() {
      const { content } = await current();
      return {
        file,
        content: content ?? "",
        exists: content !== null,
        version: versionOf(content),
      };
    },

    status() {
      return job;
    },

    /** After a restart of the bridge: sees through a save it was still watching. */
    async resume() {
      if (!stateFile) return;
      let saved;
      try {
        saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
      } catch {
        return;
      }
      if (!saved?.job?.state) return;
      job = saved.job;
      if (!saved.pending || !["restarting", "restoring"].includes(job.state)) return;
      pending = saved.pending;
      log("info", "watching the app with the new settings again", { file });
      void apply(pending, job.state === "restoring" ? "restore" : "watch");
    },

    /** Checks and saves `content`, then restarts the app in the background; see status(). */
    async save({ content, version }) {
      if (typeof content !== "string") throw new ConfigError(400, "invalid");
      if (Buffer.byteLength(content) > MAX_BYTES) throw new ConfigError(413, "too-large");
      if (["checking", "restarting", "restoring"].includes(job.state)) {
        throw new ConfigError(409, "busy");
      }
      const { content: before, stat } = await current();
      if (version !== versionOf(before)) throw new ConfigError(409, "changed");
      job = { state: "checking" };
      let result;
      try {
        result = await runCheck(content);
      } catch (error) {
        job = { state: "idle" };
        throw error;
      }
      if (!result.ok) {
        job = { state: "idle" };
        return { ok: false, problem: result.output || "check failed" };
      }
      const restore = {
        previous: before,
        stat: stat && { mode: stat.mode, uid: stat.uid, gid: stat.gid },
        since: Math.floor(Date.now() / 1000) - 1,
      };
      await remember(
        { state: "restarting", notes: result.output, version: versionOf(content) },
        restore,
      );
      try {
        await write(content, stat);
      } catch (error) {
        await remember({ state: "idle" }, null);
        throw error;
      }
      log("info", "settings saved; restarting the app", { file });
      void apply(restore);
      return { ok: true, notes: result.output, version: versionOf(content) };
    },
  };
}
