import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createUpdates,
  listTags,
  newest,
  parseChallenge,
  parseImage,
  parseVersion,
} from "../src/updates.mjs";

test("reads registry, repository and tag from an image reference", () => {
  assert.deepEqual(parseImage("fiduswriter/fiduswriter:4.1.22"), {
    registry: "registry-1.docker.io",
    repository: "fiduswriter/fiduswriter",
    tag: "4.1.22",
  });
  assert.deepEqual(parseImage("nginx:1.27"), {
    registry: "registry-1.docker.io",
    repository: "library/nginx",
    tag: "1.27",
  });
  assert.deepEqual(parseImage("ghcr.io/org/app:v2.0"), {
    registry: "ghcr.io",
    repository: "org/app",
    tag: "v2.0",
  });
  assert.deepEqual(parseImage("registry.local:5000/team/app"), {
    registry: "registry.local:5000",
    repository: "team/app",
    tag: "",
  });
  assert.equal(parseImage("org/app:1.0@sha256:abc").tag, "1.0");
});

test("only release tags count, newest first, pre-releases and words ignored", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  for (const tag of ["latest", "5.0.0a3", "1.2.3-alpine", "1.2.3.4.5", ""]) {
    assert.equal(parseVersion(tag), null, tag);
  }
  const tags = ["latest", "4", "4.1", "4.1.21", "4.1.22", "4.1.23", "4.2", "5.0.0a3", "4.10.0"];
  assert.equal(newest(tags, "4.1.22"), "4.10.0");
  assert.equal(newest(["4.1.22", "4.1", "4"], "4.1.22"), null);
  assert.equal(newest(["5", "5.0.0"], "4.1.22"), "5.0.0", "the most specific of equal tags");
  assert.equal(newest(["v1.9.0"], "v1.8.0"), "1.9.0");
  assert.equal(newest(["2.0"], "spk"), null, "a package without a release tag never hears of one");
});

test("reads the registry's challenge", () => {
  assert.deepEqual(
    parseChallenge(
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:a/b:pull"',
    ),
    {
      realm: "https://auth.docker.io/token",
      service: "registry.docker.io",
      scope: "repository:a/b:pull",
    },
  );
  assert.equal(parseChallenge('Basic realm="x"'), null);
});

/** A registry that wants an anonymous token and pages its tag list. */
function registry() {
  const calls = [];
  const json = (body, init = {}) => new Response(JSON.stringify(body), init);
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith("https://reg.example/token")) return json({ token: "anon" });
    if (options.headers?.Authorization !== "Bearer anon") {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer realm="https://reg.example/token",service="reg.example"',
        },
      });
    }
    if (href.includes("last=")) return json({ tags: ["4.1.23"] });
    return json(
      { tags: ["4.1.22", "latest"] },
      { headers: { link: '</v2/org/app/tags/list?n=1000&last=latest>; rel="next"' } },
    );
  };
  return { calls, fetchImpl };
}

test("lists every page of tags with an anonymous pull token", async () => {
  const { calls, fetchImpl } = registry();
  assert.deepEqual(await listTags("reg.example/org/app:4.1.22", fetchImpl), [
    "4.1.22",
    "latest",
    "4.1.23",
  ]);
  const auth = new URL(calls.find((call) => call.startsWith("https://reg.example/token")));
  assert.equal(auth.searchParams.get("service"), "reg.example");
  assert.equal(auth.searchParams.get("scope"), "repository:org/app:pull");
});

test("refuses an internal token endpoint from a public registry", async () => {
  await assert.rejects(
    listTags(
      "reg.example/org/app:1.0",
      async () =>
        new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="http://127.0.0.1/token"' },
        }),
    ),
    /token endpoint/,
  );
});

test("refuses a tag page outside the registry's origin", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ tags: [] }), {
      headers: { link: '<https://evil.example/steal>; rel="next"' },
    });
  await assert.rejects(listTags("reg.example/org/app:1.0", fetchImpl), /tag page/);
});

test("keeps the newest version, can skip it, and remembers both across restarts", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "updates-")), "updates.json");
  const { fetchImpl } = registry();
  const updates = createUpdates({
    image: "reg.example/org/app:4.1.22",
    current: "4.1.22",
    url: "https://example.com/releases",
    stateFile,
    fetchImpl,
  });
  await updates.check();
  assert.deepEqual(
    { ...updates.status(), checkedAt: 0 },
    {
      current: "4.1.22",
      latest: "4.1.23",
      url: "https://example.com/releases",
      skipped: false,
      checkedAt: 0,
    },
  );
  await updates.skip("4.0.0");
  assert.equal(updates.status().skipped, false, "only the version on offer can be skipped");
  await updates.skip("4.1.23");
  assert.equal(updates.status().skipped, true);

  const again = createUpdates({
    image: "reg.example/org/app:4.1.22",
    current: "4.1.22",
    stateFile,
    fetchImpl,
  });
  await again.start();
  again.stop();
  assert.equal(again.status().latest, "4.1.23");
  assert.equal(again.status().skipped, true);

  const upgraded = createUpdates({
    image: "reg.example/org/app:4.1.23",
    current: "4.1.23",
    stateFile,
    fetchImpl,
  });
  await upgraded.start();
  upgraded.stop();
  assert.equal(upgraded.status().latest, null, "after installing it, it is no longer news");
});

test("a failed check keeps what was known and says why", async () => {
  const updates = createUpdates({
    image: "org/app:1.0",
    current: "1.0",
    fetchImpl: async () => new Response("", { status: 500 }),
  });
  assert.equal(await updates.check(), 60 * 60 * 1000, "tries again in an hour");
  assert.equal(updates.status().latest, null);
});
