import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dsmNameFor, renderTemplates, resolve } from "../generate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packaging = path.dirname(here);
const minimal = {
  id: "my-app",
  version: "1.0.0",
  displayName: "My App",
  description: "Test app",
  maintainer: "Tester",
  image: "my-app:test",
  icon: "icon.svg",
};

function render(raw) {
  const { values } = resolve(raw, here);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "generate-test-"));
  renderTemplates({ ...values, appUser: '    user: "0:0"' }, target);
  return { values, target, read: (file) => fs.readFileSync(path.join(target, file), "utf8") };
}

test("derives names, ports and folders from the id", () => {
  const { values } = resolve(minimal, here);
  assert.equal(values.dsmAppName, "MyApp");
  assert.equal(values.container, "my-app");
  assert.equal(values.dataDirDefault, "/var/packages/my-app/shares/my-app");
  assert.equal(values.dataDir, "", "bridge-env resolves the package share at install time");
  assert.ok(values.hostPort >= 18100 && values.hostPort < 19000);
  assert.ok(values.controlPort >= 8799 && values.controlPort < 9799);
  assert.match(values.frameworkVersion, /^\d+\.\d+\.\d+/);
  assert.equal(dsmNameFor("airplay-capture"), "AirplayCapture");
});

test("rejects configs that would build a broken package", () => {
  assert.throws(() => resolve({ ...minimal, id: "My App" }, here), /id must be/);
  assert.throws(() => resolve({ ...minimal, icon: undefined }, here), /icon/);
  assert.throws(() => resolve({ ...minimal, displayName: 'Say "hi"' }, here), /displayName/);
  assert.throws(() => resolve({ ...minimal, defaultPort: 8080 }, here), /defaultPort/);
  assert.throws(() => resolve({ ...minimal, networkMode: "host", internalPort: 1, containerPort: 2 }, here),
    /internalPort == containerPort/);
});

test("renders every template into valid scripts and JSON", () => {
  for (const raw of [minimal, { ...minimal, output: false, identityHeaders: true, networkMode: "host" }]) {
    const { target, read } = render(raw);
    for (const file of ["conf/resource", "conf/privilege", "ui/config", "config/portal.json"]) {
      JSON.parse(read(file));
    }
    for (const dir of ["scripts", "ui"]) {
      for (const file of fs.readdirSync(path.join(target, dir))) {
        if (dir === "scripts" || /\.(cgi|sh)$/.test(file)) {
          execFileSync("sh", ["-n", path.join(target, dir, file)]);
        }
      }
    }
    const all = fs.readdirSync(target, { recursive: true })
      .filter((file) => fs.statSync(path.join(target, file)).isFile());
    for (const file of all) {
      assert.doesNotMatch(read(file), /\{\{[A-Za-z]+\}\}/, `${file} has an unfilled value`);
    }
  }
});

test("apps without an output folder mount no share", () => {
  const { read } = render({ ...minimal, output: false });
  assert.doesNotMatch(read("compose.yml"), /- \/var\/packages\/my-app\/shares/);
  assert.equal(JSON.parse(read("conf/resource"))["data-share"].shares.length, 1);
});

test("the output share is declared, so DSM creates it when missing, and mounted via DSM's link", () => {
  const { read, values } = render(minimal);
  const shares = JSON.parse(read("conf/resource"))["data-share"].shares;
  assert.deepEqual(shares.map((share) => share.name), ["my-app", "music"]);
  assert.deepEqual(shares[1].permission, {}, "an existing share's permissions are left alone");
  assert.match(read("compose.yml"), /- \/var\/packages\/my-app\/shares\/music:\/output-parent/);
  assert.equal(values.defaultOutputDir, "/volume1/music/my-app");
  const legacy = resolve({ ...minimal, outputParent: "/volume1/audio", defaultOutputDir: "/volume1/audio/rec" }, here);
  assert.equal(legacy.values.outputShare, "audio");
  assert.equal(legacy.values.defaultOutputDir, "/volume1/audio/rec");
  assert.throws(() => resolve({ ...minimal, outputShare: "my-app" }, here), /differ from id/);
});

test("identity headers are off unless asked for", () => {
  assert.match(render(minimal).read("compose.yml"), /BRIDGE_IDENTITY_HEADERS: "false"/);
  assert.match(render({ ...minimal, identityHeaders: true }).read("compose.yml"),
    /BRIDGE_IDENTITY_HEADERS: "true"/);
});

test("German names fall back to English and land in INFO", () => {
  assert.match(render(minimal).read("INFO"), /displayname_ger="My App"/);
  const info = render({ ...minimal, displayNameGer: "Meine App", descriptionGer: "Test-App" }).read("INFO");
  assert.match(info, /displayname_ger="Meine App"/);
  assert.match(info, /description_ger="Test-App"/);
});

test("every text the UI asks for exists in English and German", () => {
  const texts = JSON.parse(fs.readFileSync(path.join(packaging, "texts.json"), "utf8"));
  assert.deepEqual(Object.keys(texts.ger).sort(), Object.keys(texts.enu).sort());
  const ui = ["bridge.js", "app.html"]
    .map((file) => fs.readFileSync(path.join(packaging, "templates", "ui", file), "utf8")).join("\n");
  const used = new Set([...ui.matchAll(/\bt\("([\w.]+)"/g)].map((match) => match[1]));
  for (const match of ui.matchAll(/"(error\.\w+|state\.\w+)"/g)) used.add(match[1]);
  for (const key of used) {
    assert.ok(key in texts.enu, `missing text: ${key}`);
  }
});

test("the example config passes --check", () => {
  const output = execFileSync(process.execPath, [path.join(packaging, "generate.mjs"), "--config",
    path.join(packaging, "..", "examples", "nginx", "app.json"), "--check"], { encoding: "utf8" });
  assert.match(output, /dsm-nginx-demo .* is valid/);
});

test("builds a complete SPK from a prebuilt image", { skip: !process.env.GENERATE_BUILD_TEST }, () => {
  // Opt-in: needs Docker and the demo images. GENERATE_BUILD_TEST=1 npm test
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "generate-build-"));
  execFileSync(process.execPath, [path.join(packaging, "generate.mjs"), "--config",
    path.join(packaging, "..", "examples", "nginx", "app.json"), "--skip-app-build", "--skip-bridge-build",
    "--output", out], { stdio: "ignore" });
  assert.ok(fs.readdirSync(out).some((file) => file.endsWith(".spk")));
});
