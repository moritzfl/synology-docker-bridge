import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfigFile, versionOf } from "../src/config-file.mjs";

/** A container that restarts on request; `crashes` makes the next starts die after a moment. */
function fakeDocker({ checkExit = 0, checkOutput = "", crashes = 0 } = {}) {
  const docker = {
    starts: 0,
    restarts: 0,
    crashes,
    execs: [],
    state: "running",
    startedAt: "t0",
    async inspect() {
      if (docker.dying && Date.now() > docker.dying) {
        docker.dying = 0;
        docker.startedAt = `t${++docker.starts}`;
      }
      return { state: docker.state, startedAt: docker.startedAt, user: "" };
    },
    async restart() {
      docker.restarts++;
      docker.startedAt = `t${++docker.starts}`;
      if (docker.crashes > 0) {
        docker.crashes--;
        docker.dying = Date.now() + 10;
      }
    },
    async exec(container, command) {
      const file = command.find((arg) => arg.endsWith(".bridge-check/settings.py"));
      docker.execs.push({ command, candidate: file });
      docker.candidateSeen = fs.readFileSync(
        path.join(docker.dir, ".bridge-check/settings.py"),
        "utf8",
      );
      return { exitCode: checkExit, output: checkOutput };
    },
    async logs() {
      return "Traceback: boom\n";
    },
  };
  return docker;
}

function setup(options = {}, initial = "DEBUG = False\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-file-"));
  if (initial !== null) fs.writeFileSync(path.join(dir, "settings.py"), initial);
  const docker = fakeDocker(options);
  docker.dir = dir;
  const config = createConfigFile({
    dir,
    file: "settings.py",
    containerDir: "/data",
    check: options.noCheck ? [] : ["python", "check.py", "{file}"],
    docker,
    container: "app",
    reachable: async () => true,
    pollMs: 5,
    settleMs: 40,
    timeoutMs: 3000,
  });
  return {
    dir,
    docker,
    config,
    read: () => fs.readFileSync(path.join(dir, "settings.py"), "utf8"),
  };
}

async function settled(config) {
  for (let i = 0; i < 400; i++) {
    if (!["checking", "restarting", "restoring"].includes(config.status().state)) {
      return config.status();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("never settled");
}

test("reads the file with a version that changes with its content", async () => {
  const { config } = setup();
  const data = await config.read();
  assert.deepEqual(data, {
    file: "settings.py",
    content: "DEBUG = False\n",
    exists: true,
    version: versionOf("DEBUG = False\n"),
  });
  const missing = setup({}, null).config;
  assert.deepEqual(await missing.read(), {
    file: "settings.py",
    content: "",
    exists: false,
    version: "",
  });
});

test("a save based on an older version is refused", async () => {
  const { config, read } = setup();
  await assert.rejects(config.save({ content: "X = 1\n", version: versionOf("old") }), {
    code: "changed",
  });
  assert.equal(read(), "DEBUG = False\n");
});

test("a failed check leaves the file and the app alone and says why", async () => {
  const { config, docker, dir, read } = setup({
    checkExit: 1,
    checkOutput: "line 1: invalid syntax\n",
  });
  const result = await config.save({ content: "DEBUG = (\n", version: versionOf(read()) });
  assert.deepEqual(result, { ok: false, problem: "line 1: invalid syntax" });
  assert.equal(read(), "DEBUG = False\n");
  assert.equal(docker.restarts, 0);
  assert.equal(docker.candidateSeen, "DEBUG = (\n", "the check saw the new text");
  assert.deepEqual(docker.execs[0].command, [
    "python",
    "check.py",
    "/data/.bridge-check/settings.py",
  ]);
  assert.equal(fs.existsSync(path.join(dir, ".bridge-check")), false, "no scratch left behind");
  assert.equal(config.status().state, "idle");
});

test("a good file is saved, the app restarted, and the check's notes passed on", async () => {
  const { config, docker, read } = setup({ checkOutput: "PASSWORD_LOGIN is kept\n" });
  const result = await config.save({ content: "DEBUG = True\n", version: versionOf(read()) });
  assert.equal(result.ok, true);
  assert.equal(result.notes, "PASSWORD_LOGIN is kept");
  assert.equal(read(), "DEBUG = True\n");
  await assert.rejects(config.save({ content: "X = 2\n", version: result.version }), {
    code: "busy",
  });
  const status = await settled(config);
  assert.equal(status.state, "applied");
  assert.equal(docker.restarts, 1);
});

test("if the app does not stay up, the previous file comes back and the app restarts", async () => {
  const { config, docker, read } = setup({ crashes: 1 });
  const result = await config.save({ content: "DATABASES = {}\n", version: versionOf(read()) });
  assert.equal(result.ok, true);
  const status = await settled(config);
  assert.equal(status.state, "restored");
  assert.equal(status.log, "Traceback: boom");
  assert.equal(read(), "DEBUG = False\n");
  assert.equal(docker.restarts, 2);
});

test("a file that did not exist before is removed again when the app fails with it", async () => {
  const { config, dir } = setup({ crashes: 1, noCheck: true }, null);
  await config.save({ content: "BROKEN = 1\n", version: "" });
  assert.equal((await settled(config)).state, "restored");
  assert.equal(fs.existsSync(path.join(dir, "settings.py")), false);
});

test("an app that does not come back even with the old file is reported", async () => {
  const { config } = setup({ crashes: 2 });
  await config.save({ content: "X = 1\n", version: versionOf("DEBUG = False\n") });
  assert.equal((await settled(config)).state, "failed");
});

test("refuses symlinks and files that are too large", async () => {
  const { config, dir } = setup({}, null);
  fs.symlinkSync("/etc/passwd", path.join(dir, "settings.py"));
  await assert.rejects(config.read(), { code: "not-a-file" });
  const other = setup().config;
  await assert.rejects(
    other.save({ content: "x".repeat(300 * 1024), version: versionOf("DEBUG = False\n") }),
    { code: "too-large" },
  );
  await assert.rejects(other.save({ content: 1, version: "" }), { code: "invalid" });
});

test("with a ready command, an app that only shows a maintenance page is not up yet", async () => {
  const { dir, docker, read } = setup({ noCheck: true });
  let maintenance = true;
  const readyCalls = [];
  docker.exec = async (container, command) => {
    readyCalls.push(command);
    return { exitCode: maintenance ? 1 : 0, output: "" };
  };
  const config = createConfigFile({
    dir,
    file: "settings.py",
    ready: ["python", "ready.py"],
    docker,
    container: "app",
    reachable: async () => true,
    pollMs: 5,
    settleMs: 30,
    timeoutMs: 3000,
  });
  await config.save({ content: "X = 1\n", version: versionOf(read()) });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(config.status().state, "restarting", "still setting up");
  maintenance = false;
  assert.equal((await settled(config)).state, "applied");
  assert.deepEqual(readyCalls[0], ["python", "ready.py"]);
});
