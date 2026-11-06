import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp, dsmNameFor, renderTemplates, resolve } from "../generate.mjs";

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
  assert.doesNotMatch(read("compose.yml"), /^ {6}- .*(shares\/music|output-parent|host-output)/m);
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

test("as the package user, the app may use its own share and administrators get Folder access", () => {
  const { read, values } = render({ ...minimal, appUser: "package" });
  assert.deepEqual(JSON.parse(read("conf/resource"))["data-share"].shares[0].permission, { rw: ["my-app"] });
  assert.match(read("ui/bridge.js"), /var PACKAGE_USER = true;/);
  assert.equal(values.packageUser, "true");
  const other = render(minimal);
  assert.deepEqual(JSON.parse(other.read("conf/resource"))["data-share"].shares[0].permission, {});
  assert.match(other.read("ui/bridge.js"), /var PACKAGE_USER = false;/);
});

test("the bridge sees the data folder and the package's share links to check access", () => {
  const compose = render(minimal).read("compose.yml");
  assert.match(compose, /- \$\{APP_DATA_DIR:-\/var\/packages\/my-app\/shares\/my-app\}:\/run\/app-data/);
  assert.match(compose, /- \/var\/packages\/my-app\/shares:\/run\/shares:ro/);
});

test("the app gets DSM's time zone unless it opts out, and an init only when asked", () => {
  const { read } = render(minimal);
  assert.match(read("compose.yml"), /TZ: "\$\{APP_TZ:-Etc\/UTC\}"/);
  assert.doesNotMatch(read("compose.yml"), /init: true/);
  assert.match(read("scripts/preinst"), /SYNOPKG_PKGINST_TEMP_DIR/);
  const custom = render({ ...minimal, hostTimezone: false, init: true }).read("compose.yml");
  assert.doesNotMatch(custom, /APP_TZ/);
  assert.match(custom, /^ {4}init: true$/m);
  const own = render({ ...minimal, appEnv: { TZ: "Europe/Berlin" } }).read("compose.yml");
  assert.match(own, /TZ: "Europe\/Berlin"/, "an app's own TZ wins");
});

test("the NAS time zone is read by name from /etc/localtime", () => {
  const { target } = render(minimal);
  // The link target comes in through the environment, never as shell code.
  const run = (link) => execFileSync("sh", ["-c",
    `readlink() { printf '%s\\n' "$LINK"; }; . "$1"; host_timezone`, "sh",
    path.join(target, "scripts", "bridge-env")], { encoding: "utf8", env: { ...process.env, LINK: link } }).trim();
  assert.equal(run("/usr/share/zoneinfo/Europe/Amsterdam"), "Europe/Amsterdam");
  assert.equal(run("/usr/share/zoneinfo/America/Argentina/Buenos_Aires"), "America/Argentina/Buenos_Aires");
  assert.equal(run(""), "Etc/UTC");
  assert.equal(run("/usr/share/zoneinfo/Europe/Ber lin;x"), "Etc/UTC");
});

test("public paths get their own nginx location, the bridge's list and the app's address", () => {
  const { read } = render({ ...minimal, publicPaths: ["/media/", "/oauth/callback"],
    appEnv: { MY_URL: "${APP_PUBLIC_URL}" } });
  const nginx = read("config/dsm.bridge.conf");
  assert.match(nginx, /location \^~ \/webman\/3rdparty\/my-app\/public\/ \{/);
  assert.match(nginx, /proxy_buffering off;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:\d+\/__public\/;/);
  const compose = read("compose.yml");
  assert.match(compose, /BRIDGE_PUBLIC_PATHS: "\/media\/,\/oauth\/callback"/);
  assert.match(compose, /APP_PUBLIC_URL: "\$\{APP_PUBLIC_URL:-\}"/);
  assert.match(compose, /MY_URL: "\$\{APP_PUBLIC_URL:-\}"/);
  assert.match(read("scripts/bridge-env"), /prefix="\/webman\/3rdparty\/my-app\/public"/);
  const none = render(minimal);
  assert.doesNotMatch(none.read("config/dsm.bridge.conf"), /public/);
  assert.doesNotMatch(none.read("compose.yml"), /APP_PUBLIC_URL/);
  for (const bad of [["/"], ["media/"], ["/a/../b"], ["/a//b"], ["/a b"], "/media/"]) {
    assert.throws(() => resolve({ ...minimal, publicPaths: bad }, here), /publicPaths/, JSON.stringify(bad));
  }
});

test("the public address is the NAS's LAN address on DSM's HTTP port", () => {
  const { target } = render({ ...minimal, publicPaths: ["/media/"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-url-"));
  const nginx = path.join(dir, "nginx.conf");
  fs.writeFileSync(nginx, "server {\n    listen 5080 default_server;\n    listen 5443 default_server ssl;\n}\n");
  const script = path.join(target, "scripts", "bridge-env");
  fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace("/etc/nginx/nginx.conf", nginx));
  // ip is stubbed; its output comes in through the environment, never as shell code.
  const run = (route) => execFileSync("sh", ["-c",
    `ip() { [ "$2" = route ] && printf '%s\\n' "$ROUTE"; return 0; }; . "$1"; public_url`, "sh", script],
  { encoding: "utf8", env: { ...process.env, ROUTE: route } }).trim();
  assert.equal(run("1.1.1.1 via 192.168.178.1 dev eth0 src 192.168.178.136 uid 0"),
    "http://192.168.178.136:5080/webman/3rdparty/my-app/public");
  assert.equal(run(""), "", "no address, no URL");
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

test("--arch packages the same config for ARM", () => {
  const output = execFileSync(process.execPath, [path.join(packaging, "generate.mjs"), "--config",
    path.join(packaging, "..", "examples", "nginx", "app.json"), "--arch", "armv8", "--check"],
  { encoding: "utf8" });
  assert.match(output, /dsm-nginx-demo .* \(armv8\) is valid/);
});

test("--arch requires a value", () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(packaging, "generate.mjs"),
    "--config", path.join(packaging, "..", "examples", "nginx", "app.json"), "--arch", "--check"],
  { stdio: "pipe" }), /--arch requires an architecture/);
});

test("the app build is told the package's architecture and Docker platform", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-app-build-"));
  const config = { appBuild: 'printf "%s %s" "$SPK_ARCH" "$SPK_PLATFORM" > arch.txt', appDir: dir };
  buildApp(config, { arch: "armv8", platform: "linux/arm64" }, false);
  assert.equal(fs.readFileSync(path.join(dir, "arch.txt"), "utf8"), "armv8 linux/arm64");
});

test("builds a complete SPK from a prebuilt image", { skip: !process.env.GENERATE_BUILD_TEST }, () => {
  // Opt-in: needs Docker and the demo images. GENERATE_BUILD_TEST=1 npm test
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "generate-build-"));
  execFileSync(process.execPath, [path.join(packaging, "generate.mjs"), "--config",
    path.join(packaging, "..", "examples", "nginx", "app.json"), "--skip-app-build", "--skip-bridge-build",
    "--output", out], { stdio: "ignore" });
  assert.ok(fs.readdirSync(out).some((file) => file.endsWith(".spk")));
});
