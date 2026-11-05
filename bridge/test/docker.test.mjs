import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDocker } from "../src/docker.mjs";

/** A fake Docker Engine on a unix socket: answers by "METHOD path" and records every request. */
async function engine(routes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-docker-"));
  const socketPath = path.join(dir, "docker.sock");
  const seen = [];
  const server = http.createServer((request, response) => {
    const key = `${request.method} ${request.url}`;
    seen.push(key);
    const [status, body] = routes[key] || [404, { message: `no route ${key}` }];
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body === undefined ? "" : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    docker: createDocker({ socketPath }),
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("inspect maps the fields the bridge uses and treats 404 as missing", async (t) => {
  const fake = await engine({
    "GET /containers/my-app/json": [200, {
      Id: "c1", Name: "/my-app", Image: "sha256:img",
      Config: { Image: "my-app:spk", Labels: { a: "b" }, Env: ["X=1"] },
      State: { Status: "running", Health: { Status: "healthy" } },
    }],
  });
  t.after(fake.close);
  const container = await fake.docker.inspect("my-app");
  assert.equal(container.id, "c1");
  assert.equal(container.name, "my-app");
  assert.equal(container.image, "my-app:spk");
  assert.equal(container.imageId, "sha256:img");
  assert.equal(container.state, "running");
  assert.equal(container.health, "healthy");
  assert.equal(await fake.docker.inspect("other"), null);
});

test("start and stop accept 'already in that state'", async (t) => {
  const fake = await engine({
    "POST /containers/app/start": [304],
    "POST /containers/app/stop?t=30": [304],
  });
  t.after(fake.close);
  await fake.docker.start("app");
  await fake.docker.stop("app");
  assert.deepEqual(fake.seen, ["POST /containers/app/start", "POST /containers/app/stop?t=30"]);
});

test("restart and engine errors carry the Docker message", async (t) => {
  const fake = await engine({
    "POST /containers/app/restart?t=30": [204],
    "POST /containers/broken/start": [500, { message: "cannot start: no such device" }],
  });
  t.after(fake.close);
  await fake.docker.restart("app");
  await assert.rejects(fake.docker.start("broken"), (error) => {
    assert.equal(error.status, 500);
    assert.match(error.message, /no such device/);
    return true;
  });
});

test("image removal is never forced and reports images still in use", async (t) => {
  const fake = await engine({
    "DELETE /images/sha256%3Aold?noprune=false": [200, [{ Deleted: "sha256:old" }]],
    "DELETE /images/sha256%3Aused?noprune=false": [409, { message: "image is being used" }],
  });
  t.after(fake.close);
  assert.equal(await fake.docker.removeImage("sha256:old"), true);
  assert.equal(await fake.docker.removeImage("sha256:used"), false);
  assert.ok(fake.seen.every((request) => !request.includes("force")), "never force");
});

test("container names are path-encoded", async (t) => {
  const fake = await engine({ "POST /containers/a%2Fb/start": [204] });
  t.after(fake.close);
  await fake.docker.start("a/b");
  assert.deepEqual(fake.seen, ["POST /containers/a%2Fb/start"]);
});
