import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  buildApp,
  dsmNameFor,
  publishPackage,
  renderTemplates,
  resolve,
  squareIconArgs,
  svgAspect,
} from "../generate.mjs";

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
  assert.throws(
    () => resolve({ ...minimal, networkMode: "host", internalPort: 1, containerPort: 2 }, here),
    /internalPort == containerPort/,
  );
});

test("renders every template into valid scripts and JSON", () => {
  for (const raw of [
    minimal,
    { ...minimal, output: false, identityHeaders: true, networkMode: "host" },
  ]) {
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
    const all = fs
      .readdirSync(target, { recursive: true })
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
  assert.deepEqual(
    shares.map((share) => share.name),
    ["my-app", "music"],
  );
  assert.deepEqual(shares[1].permission, {}, "an existing share's permissions are left alone");
  assert.match(read("compose.yml"), /- \/var\/packages\/my-app\/shares\/music:\/output-parent/);
  assert.equal(values.defaultOutputDir, "/volume1/music/my-app");
  const legacy = resolve(
    { ...minimal, outputParent: "/volume1/audio", defaultOutputDir: "/volume1/audio/rec" },
    here,
  );
  assert.equal(legacy.values.outputShare, "audio");
  assert.equal(legacy.values.defaultOutputDir, "/volume1/audio/rec");
  assert.throws(() => resolve({ ...minimal, outputShare: "my-app" }, here), /differ from id/);
});

test("identity headers are off unless asked for", () => {
  assert.match(render(minimal).read("compose.yml"), /BRIDGE_IDENTITY_HEADERS: "false"/);
  assert.match(
    render({ ...minimal, identityHeaders: true }).read("compose.yml"),
    /BRIDGE_IDENTITY_HEADERS: "true"/,
  );
});

test("apps that need the root of an address get ports of their own on DSM's nginx", () => {
  const { read } = render({ ...minimal, webPorts: { http: 4386, https: 4387 } });
  const resource = JSON.parse(read("conf/resource"));
  const configs = resource["web-config"]["nginx-static-config"].enable;
  assert.deepEqual(configs[1], {
    type: "server",
    relpath: "config/server.bridge.conf",
    ports: [
      { port: 4386, protocol: "tcp", schema: "http" },
      { port: 4387, protocol: "tcp", schema: "https" },
    ],
  });
  assert.deepEqual(resource["port-config"], { "protocol-file": "config/my-app.sc" });
  const server = read("config/server.bridge.conf");
  assert.match(server, /listen 4386;/);
  assert.match(server, /listen \[::\]:4387 ssl;/);
  assert.doesNotMatch(server, /ssl_certificate/, "DSM's default certificate applies");
  assert.match(server, /proxy_pass http:\/\/127\.0\.0\.1:\d+\/__proxy\/;/);
  assert.doesNotMatch(server, /X-Forwarded-Prefix/, "the app is at the root");
  assert.match(
    read("config/ports.sc"),
    /\[my-app_https\]\ntitle="My App \(HTTPS\)"\ndst\.ports="4387\/tcp"/,
  );
  const compose = read("compose.yml");
  assert.match(compose, /BRIDGE_OWN_ORIGIN: "true"/);
  assert.match(compose, /BRIDGE_SESSION_COOKIE: "dsm_bridge_session_my-app"/);
  assert.match(compose, /BRIDGE_APP_ID: "SYNO\.SDS\.MyApp\.Instance"/);
  assert.match(read("ui/app.html"), /var OWN_PORTS = \{"http":4386,"https":4387\};/);

  const plain = render(minimal);
  const plainResource = JSON.parse(plain.read("conf/resource"));
  assert.equal(plainResource["web-config"]["nginx-static-config"].enable.length, 1);
  assert.equal(plainResource["port-config"], undefined);
  assert.match(plain.read("compose.yml"), /BRIDGE_SESSION_COOKIE: "dsm_bridge_session"/);
  assert.match(plain.read("ui/app.html"), /var OWN_PORTS = null;/);

  for (const bad of [
    { http: 4386 },
    { http: 5000, https: 5002 },
    { http: 80, https: 4387 },
    { http: 7000, https: 7000 },
    { http: 99, https: 100 },
  ]) {
    assert.throws(
      () => resolve({ ...minimal, webPorts: bad }, here),
      /webPorts/,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => resolve({ ...minimal, controlPort: 4387, webPorts: { http: 4386, https: 4387 } }, here),
    /webPorts must differ/,
  );
});

test("files the package brings are mounted read-only into the unmodified image", () => {
  const { read } = render({
    ...minimal,
    files: { "/data/settings.py": "settings.py", "/app/auth.py": "lib/auth.py" },
  });
  const compose = read("compose.yml");
  assert.match(
    compose,
    /- \/var\/packages\/my-app\/target\/files\/0-settings\.py:\/data\/settings\.py:ro/,
  );
  assert.match(compose, /- \/var\/packages\/my-app\/target\/files\/1-auth\.py:\/app\/auth\.py:ro/);
  assert.doesNotMatch(render(minimal).read("compose.yml"), /target\/files/);
  for (const bad of [
    { "relative.py": "a" },
    { "/dir/": "a" },
    { "/a/../b": "a" },
    { "/a": "" },
    ["/a"],
  ]) {
    assert.throws(() => resolve({ ...minimal, files: bad }, here), /files/, JSON.stringify(bad));
  }
});

test("a logo that is not square is centered on a square icon", () => {
  assert.equal(
    svgAspect('<svg width="41.8pt" height="50.6pt" viewBox="0 0 41.8 50.6">'),
    41.8 / 50.6,
  );
  assert.equal(svgAspect('<?xml version="1.0"?>\n<svg\n  width="200" height="100">'), 2);
  assert.equal(svgAspect("<svg>"), 1);
  assert.deepEqual(squareIconArgs(64, 1), ["-a", "-w", "64", "-h", "64"]);
  assert.deepEqual(squareIconArgs(256, 0.5).slice(5), [
    "--page-width",
    "256",
    "--page-height",
    "256",
    "--left",
    "64",
  ]);
  assert.deepEqual(squareIconArgs(100, 2).slice(-2), ["--top", "25"]);
});

test("DSM's own ports are read from its nginx config for the way back from the app's ports", () => {
  const { target } = render(minimal);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-port-"));
  const nginx = path.join(dir, "nginx.conf");
  const script = path.join(target, "scripts", "bridge-env");
  fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace("/etc/nginx/nginx.conf", nginx));
  const run = (scheme) =>
    execFileSync("sh", ["-c", '. "$1"; dsm_port "$2"', "sh", script, scheme], {
      encoding: "utf8",
    }).trim();
  assert.equal(run("http"), "5000", "defaults without a readable config");
  assert.equal(run("https"), "5001");
  fs.writeFileSync(
    nginx,
    "server {\n        listen 5080 default_server;\n        listen [::]:5080 default_server;\n}\n" +
      "server {\n        listen 5443 default_server ssl;\n}\nserver {\n        listen 80 default_server;\n}\n",
  );
  assert.equal(run("http"), "5080");
  assert.equal(run("https"), "5443");
});

test("as the package user, the app may use its own share and administrators get Folder access", () => {
  const { read, values } = render({ ...minimal, appUser: "package" });
  assert.deepEqual(JSON.parse(read("conf/resource"))["data-share"].shares[0].permission, {
    rw: ["my-app"],
  });
  assert.match(read("ui/bridge.js"), /var PACKAGE_USER = true;/);
  assert.equal(values.packageUser, "true");
  const other = render(minimal);
  assert.deepEqual(JSON.parse(other.read("conf/resource"))["data-share"].shares[0].permission, {});
  assert.match(other.read("ui/bridge.js"), /var PACKAGE_USER = false;/);
});

test("the bridge sees the data folder and the package's share links to check access", () => {
  const compose = render(minimal).read("compose.yml");
  assert.match(
    compose,
    /- \$\{APP_DATA_DIR:-\/var\/packages\/my-app\/shares\/my-app\}:\/run\/app-data/,
  );
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
  const run = (link) =>
    execFileSync(
      "sh",
      [
        "-c",
        `readlink() { printf '%s\\n' "$LINK"; }; . "$1"; host_timezone`,
        "sh",
        path.join(target, "scripts", "bridge-env"),
      ],
      { encoding: "utf8", env: { ...process.env, LINK: link } },
    ).trim();
  assert.equal(run("/usr/share/zoneinfo/Europe/Amsterdam"), "Europe/Amsterdam");
  assert.equal(
    run("/usr/share/zoneinfo/America/Argentina/Buenos_Aires"),
    "America/Argentina/Buenos_Aires",
  );
  assert.equal(run(""), "Etc/UTC");
  assert.equal(run("/usr/share/zoneinfo/Europe/Ber lin;x"), "Etc/UTC");
});

test("public paths get their own nginx location, the bridge's list and the app's address", () => {
  const { read } = render({
    ...minimal,
    publicPaths: ["/media/", "/oauth/callback"],
    appEnv: { MY_URL: "${APP_PUBLIC_URL}" },
  });
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
    assert.throws(
      () => resolve({ ...minimal, publicPaths: bad }, here),
      /publicPaths/,
      JSON.stringify(bad),
    );
  }
});

test("the public address is the NAS's LAN address on DSM's HTTP port", () => {
  const { target } = render({ ...minimal, publicPaths: ["/media/"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-url-"));
  const nginx = path.join(dir, "nginx.conf");
  fs.writeFileSync(
    nginx,
    "server {\n    listen 5080 default_server;\n    listen 5443 default_server ssl;\n}\n",
  );
  const script = path.join(target, "scripts", "bridge-env");
  fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace("/etc/nginx/nginx.conf", nginx));
  // ip is stubbed; its output comes in through the environment, never as shell code.
  const run = (route) =>
    execFileSync(
      "sh",
      [
        "-c",
        `ip() { [ "$2" = route ] && printf '%s\\n' "$ROUTE"; return 0; }; . "$1"; public_url`,
        "sh",
        script,
      ],
      { encoding: "utf8", env: { ...process.env, ROUTE: route } },
    ).trim();
  assert.equal(
    run("1.1.1.1 via 192.168.178.1 dev eth0 src 192.168.178.136 uid 0"),
    "http://192.168.178.136:5080/webman/3rdparty/my-app/public",
  );
  assert.equal(run(""), "", "no address, no URL");
});

test("German names fall back to English and land in INFO", () => {
  assert.match(render(minimal).read("INFO"), /displayname_ger="My App"/);
  const info = render({ ...minimal, displayNameGer: "Meine App", descriptionGer: "Test-App" }).read(
    "INFO",
  );
  assert.match(info, /displayname_ger="Meine App"/);
  assert.match(info, /description_ger="Test-App"/);
});

test("every text the UI asks for exists in English and German", () => {
  const texts = JSON.parse(fs.readFileSync(path.join(packaging, "texts.json"), "utf8"));
  assert.deepEqual(Object.keys(texts.ger).sort(), Object.keys(texts.enu).sort());
  const ui = ["bridge.js", "app.html"]
    .map((file) => fs.readFileSync(path.join(packaging, "templates", "ui", file), "utf8"))
    .join("\n");
  const used = new Set([...ui.matchAll(/\bt\("([\w.]+)"/g)].map((match) => match[1]));
  for (const match of ui.matchAll(/"(error\.\w+|state\.\w+)"/g)) used.add(match[1]);
  for (const key of used) {
    assert.ok(key in texts.enu, `missing text: ${key}`);
  }
});

test("closing a standalone window removes its resize hooks", () => {
  const handlers = new Map();
  const callbacks = new Map();
  let layout;
  let resize;
  let disconnected = false;
  let cancelled;
  const { read } = render(minimal);
  runInNewContext(read("ui/bridge.js"), {
    Ext: {
      define: (name, definition) => {
        if (name.endsWith(".Main")) layout = definition;
      },
    },
    window: {
      ResizeObserver: true,
      addEventListener: (name, listener) => handlers.set(name, listener),
      removeEventListener: (name, listener) => {
        assert.equal(handlers.get(name), listener);
        handlers.delete(name);
      },
    },
    document: { body: {} },
    ResizeObserver: class {
      constructor(listener) {
        resize = listener;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
    requestAnimationFrame: () => 17,
    cancelAnimationFrame: (id) => {
      cancelled = id;
    },
  });
  layout.refitOnResize.call({ on: (name, listener) => callbacks.set(name, listener) });
  assert.equal(handlers.get("resize"), resize);
  callbacks.get("destroy")();
  assert.equal(handlers.has("resize"), false);
  assert.equal(disconnected, true);
  assert.equal(cancelled, 17);
});

test("the example config passes --check", () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(packaging, "generate.mjs"),
      "--config",
      path.join(packaging, "..", "examples", "nginx", "app.json"),
      "--check",
    ],
    { encoding: "utf8" },
  );
  assert.match(output, /dsm-nginx-demo .* is valid/);
});

test("--arch packages the same config for ARM", () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(packaging, "generate.mjs"),
      "--config",
      path.join(packaging, "..", "examples", "nginx", "app.json"),
      "--arch",
      "armv8",
      "--check",
    ],
    { encoding: "utf8" },
  );
  assert.match(output, /dsm-nginx-demo .* \(armv8\) is valid/);
});

test("--arch requires a value", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(packaging, "generate.mjs"),
          "--config",
          path.join(packaging, "..", "examples", "nginx", "app.json"),
          "--arch",
          "--check",
        ],
        { stdio: "pipe" },
      ),
    /--arch requires an architecture/,
  );
});

test("the app build is told the package's architecture and Docker platform", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-app-build-"));
  const config = { appBuild: 'printf "%s %s" "$SPK_ARCH" "$SPK_PLATFORM" > arch.txt', appDir: dir };
  buildApp(config, { arch: "armv8", platform: "linux/arm64" }, false);
  assert.equal(fs.readFileSync(path.join(dir, "arch.txt"), "utf8"), "armv8 linux/arm64");
});

test("a failed archive write preserves the previous SPK and cleans up", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-spk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "test.spk");
  fs.writeFileSync(output, "previous");
  assert.throws(
    () =>
      publishPackage(output, (staged) => {
        fs.writeFileSync(staged, "partial");
        throw new Error("archive failed");
      }),
    /archive failed/,
  );
  assert.equal(fs.readFileSync(output, "utf8"), "previous");
  assert.deepEqual(fs.readdirSync(dir), ["test.spk"]);
  publishPackage(output, (staged) => fs.writeFileSync(staged, "complete"));
  assert.equal(fs.readFileSync(output, "utf8"), "complete");
  assert.deepEqual(fs.readdirSync(dir), ["test.spk"]);
});

test(
  "builds a complete SPK from a prebuilt image",
  { skip: !process.env.GENERATE_BUILD_TEST },
  () => {
    // Opt-in: needs Docker and the demo images. GENERATE_BUILD_TEST=1 npm test
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "generate-build-"));
    execFileSync(
      process.execPath,
      [
        path.join(packaging, "generate.mjs"),
        "--config",
        path.join(packaging, "..", "examples", "nginx", "app.json"),
        "--skip-app-build",
        "--skip-bridge-build",
        "--output",
        out,
      ],
      { stdio: "ignore" },
    );
    assert.ok(fs.readdirSync(out).some((file) => file.endsWith(".spk")));
  },
);
