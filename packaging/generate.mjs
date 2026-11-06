#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const templateDir = path.join(here, "templates");

function usage() {
  console.error("usage: generate.mjs --config app.json [--arch x86_64|armv8] [--check]"
    + " [--skip-app-build] [--skip-bridge-build] [--output dist]");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { config: "", arch: "", check: false, skipAppBuild: false, skipBridgeBuild: false, output: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") options.config = argv[++i] || "";
    else if (arg === "--arch") {
      options.arch = argv[++i];
      if (!options.arch || options.arch.startsWith("--")) throw new Error("--arch requires an architecture");
    }
    else if (arg === "--check") options.check = true;
    else if (arg === "--skip-app-build") options.skipAppBuild = true;
    else if (arg === "--skip-bridge-build") options.skipBridgeBuild = true;
    else if (arg === "--output") options.output = argv[++i] || "";
    else if (arg === "--help" || arg === "-h") usage();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.config) usage();
  return options;
}

function required(config, key) {
  const value = config[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`missing config field: ${key}`);
  }
  return value;
}

/** JSON that is safe inside an inline script and an HTML page. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function render(text, values) {
  return text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`missing template value: ${key}`);
    return String(values[key]);
  });
}

function copyTree(source, target, values) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, values);
    } else {
      fs.writeFileSync(to, render(fs.readFileSync(from, "utf8"), values));
    }
  }
}

const APP_ICON_SIZES = [16, 24, 32, 48, 64, 72, 256];

/**
 * Icons from one SVG (`icon`), drawn at every size DSM asks for, or from a folder of ready-made
 * PNGs (`icons`) with app_{16,24,32,48,64,72,256}.png and PACKAGE_ICON*.PNG.
 */
function copyIcons(config, target) {
  const images = path.join(target, "ui", "images");
  fs.mkdirSync(images, { recursive: true });
  if (config.icon) {
    const svg = path.resolve(config.appDir, config.icon);
    if (!fs.existsSync(svg)) throw new Error(`missing icon: ${svg}`);
    const draw = (size, file) => execFileSync("rsvg-convert",
      ["-w", String(size), "-h", String(size), "-o", file, svg]);
    try {
      for (const size of APP_ICON_SIZES) draw(size, path.join(images, `app_${size}.png`));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("icon needs rsvg-convert (brew install librsvg)");
      throw error;
    }
    draw(72, path.join(target, "PACKAGE_ICON.PNG"));
    draw(256, path.join(target, "PACKAGE_ICON_256.PNG"));
    return;
  }
  const icons = path.resolve(config.appDir, required(config, "icons"));
  for (const size of APP_ICON_SIZES) {
    const file = path.join(icons, `app_${size}.png`);
    if (!fs.existsSync(file)) throw new Error(`missing icon: ${file}`);
    fs.copyFileSync(file, path.join(images, `app_${size}.png`));
  }
  for (const name of ["PACKAGE_ICON.PNG", "PACKAGE_ICON_256.PNG"]) {
    const candidates = [
      path.join(icons, name),
      path.join(path.dirname(icons), name),
      path.join(path.dirname(path.dirname(icons)), name),
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (!file) throw new Error(`missing package icon: ${candidates[0]}`);
    fs.copyFileSync(file, path.join(target, name));
  }
}

/** "airplay-capture" -> "AirplayCapture", the DSM class name part. */
export function dsmNameFor(id) {
  return String(id).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

/** Bridge version plus the framework commit, so a package on a NAS can be traced back. */
function frameworkVersion() {
  const version = JSON.parse(fs.readFileSync(path.join(repo, "bridge", "package.json"), "utf8")).version;
  try {
    const commit = execFileSync("git", ["-C", repo, "describe", "--always", "--dirty", "--abbrev=7"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return `${version}+${commit}`;
  } catch {
    return version;
  }
}

function platformFor(arch) {
  if (arch === "x86_64" || arch === "amd64") return { arch: "x86_64", platform: "linux/amd64" };
  if (arch === "armv8" || arch === "arm64") return { arch: "armv8", platform: "linux/arm64" };
  throw new Error(`unsupported arch: ${arch}`);
}

function hashOf(id) {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function controlPortFor(id) {
  return 8799 + (hashOf(id) % 1000);
}

/**
 * Localhost port the app is published on. Derived from the id like the control port, so two
 * packages never claim the same port by default (a shared 18080 made the second app fail to
 * start next to a host-network app on that port).
 */
function internalPortFor(id) {
  return 18100 + (hashOf(id) % 900);
}

/** The user an image runs as under plain docker run; root when the image declares none. */
function imageUser(image, platform) {
  const user = execFileSync("docker", ["image", "inspect", "--platform", platform,
    "--format", "{{.Config.User}}", image], { encoding: "utf8" }).trim();
  return user || "0:0";
}

/**
 * DSM nginx forwards the public prefix to the bridge without a session. No buffering, so audio
 * that the app writes while it is still being made reaches the device as it is written.
 */
function publicLocation(id, controlPort) {
  return [
    "",
    `location ^~ /webman/3rdparty/${id}/public/ {`,
    "    proxy_set_header Host $http_host;",
    "    proxy_set_header X-Real-IP $remote_addr;",
    "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "    proxy_set_header X-Forwarded-Proto $scheme;",
    `    proxy_set_header X-Forwarded-Prefix /webman/3rdparty/${id}/public;`,
    "    proxy_http_version 1.1;",
    "    proxy_buffering off;",
    "    proxy_request_buffering off;",
    "    proxy_read_timeout 3600s;",
    "    proxy_intercept_errors off;",
    `    proxy_pass http://127.0.0.1:${controlPort}/__public/;`,
    "}",
  ].join("\n");
}

/** The app runs as the package's own DSM user, so DSM permissions decide what it may access. */
export function packageUser(config) {
  return config.appUser === "package";
}

/** Fails the build when an embedded image is not for the package's platform. */
function verifyPlatform(imageTar, platform, stage) {
  const [os_, architecture] = platform.split("/");
  const dir = fs.mkdtempSync(path.join(stage, "verify-"));
  execFileSync("tar", ["-xf", imageTar, "-C", dir, "manifest.json"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const entry of manifest) {
    execFileSync("tar", ["-xf", imageTar, "-C", dir, entry.Config]);
    const image = JSON.parse(fs.readFileSync(path.join(dir, entry.Config), "utf8"));
    const tags = (entry.RepoTags || []).join(", ") || entry.Config;
    if (image.os !== os_ || image.architecture !== architecture) {
      throw new Error(`${tags} is ${image.os}/${image.architecture}, not ${platform}; `
        + `pull or build it with --platform ${platform}`);
    }
    console.log(`==> ${tags}: ${image.os}/${image.architecture}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  console.log(`==> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function buildBridge(config, platform, skip) {
  if (skip) return;
  run("docker", [
    "buildx", "build", "--platform", platform, "--provenance=false", "--sbom=false",
    "--load", "-t", config.bridgeImage, path.join(repo, "bridge"),
  ]);
}

/** Runs appBuild with the package's architecture in SPK_ARCH and its Docker platform in SPK_PLATFORM. */
export function buildApp(config, archInfo, skip) {
  if (skip) return;
  if (config.appBuild) {
    console.log(`==> app build: ${config.appBuild}`);
    execSync(config.appBuild, {
      cwd: path.resolve(config.appDir || process.cwd()),
      stdio: "inherit",
      shell: "/bin/sh",
      env: { ...process.env, SPK_ARCH: archInfo.arch, SPK_PLATFORM: archInfo.platform },
    });
    return;
  }
  try {
    execFileSync("docker", ["image", "inspect", config.image], { stdio: "ignore" });
  } catch {
    throw new Error(`app image ${config.image} is not local; set appBuild or build it first`);
  }
}

/**
 * Validates an app config and fills in every derived value. Pure apart from reading texts.json,
 * so tests and --check can use it without Docker.
 */
export function resolve(raw, configDir) {
  const config = { ...raw };
  config.appDir = config.appDir ? path.resolve(configDir, config.appDir) : configDir;
  const id = required(config, "id");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error("id must be lowercase letters, digits and dashes, e.g. my-app");
  }
  if (!config.icon && !config.icons) {
    throw new Error("missing config field: icon (an SVG) or icons (a folder of PNGs)");
  }
  const version = required(config, "version");
  const displayName = required(config, "displayName");
  const description = required(config, "description");
  const maintainer = required(config, "maintainer");
  for (const [key, value] of [["displayName", displayName], ["description", description],
    ["maintainer", maintainer]]) {
    // These end up inside JS strings, HTML and INFO; keep them plain text.
    if (/["\\<>\n]/.test(String(value))) {
      throw new Error(`${key} must not contain quotes, backslashes, angle brackets or newlines`);
    }
  }
  const dsmAppName = config.dsmAppName || dsmNameFor(id);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(dsmAppName)) throw new Error("dsmAppName must be letters and digits");
  const archInfo = platformFor(config.arch || "x86_64");
  const networkMode = config.networkMode || "bridge";
  if (networkMode !== "host" && networkMode !== "bridge") {
    throw new Error("networkMode must be host or bridge");
  }
  config.image = required(config, "image");
  // Per-app tag: packages built from different framework versions must not retag each other's
  // bridge image, which Container Manager would pick up on the next container recreate.
  config.bridgeImage = config.bridgeImage || `${id}-bridge:spk`;
  const authMode = config.authMode || "token";
  if (authMode !== "token" && authMode !== "none") {
    throw new Error("authMode must be token or none");
  }
  const showOutput = config.output !== false;
  // A plain string, or one per DSM language: { "enu": "Recordings folder", "ger": "Aufnahmeordner" }.
  const outputLabel = typeof config.outputLabel === "object" && config.outputLabel
    ? { enu: "Output folder", ...config.outputLabel }
    : { enu: config.outputLabel || "Output folder", ger: config.outputLabel ? undefined : "Ausgabeordner" };
  for (const value of Object.values(outputLabel)) {
    if (value !== undefined && /["\\<>\n]/.test(value)) throw new Error("outputLabel must be plain text");
  }
  const displayNameGer = config.displayNameGer || displayName;
  const descriptionGer = config.descriptionGer || description;
  for (const [key, value] of [["displayNameGer", displayNameGer], ["descriptionGer", descriptionGer]]) {
    if (/["\\<>\n]/.test(String(value))) {
      throw new Error(`${key} must not contain quotes, backslashes, angle brackets or newlines`);
    }
  }
  config.container = config.container || id;
  config.service = config.service || "app";
  config.internalPort = Number(config.internalPort || internalPortFor(id));
  config.containerPort = Number(config.containerPort || (networkMode === "host" ? config.internalPort : 8080));
  if (networkMode === "host" && config.internalPort !== config.containerPort) {
    throw new Error("host networking requires internalPort == containerPort");
  }
  if (config.defaultPort !== undefined && Number(config.defaultPort) !== 0) {
    // The app is reached through DSM's own nginx only; a bridge port of its own would only
    // open another port. Apps that need one for their own clients publish it themselves.
    throw new Error("defaultPort is no longer supported; the app is served on DSM's ports only");
  }
  // Empty: the package's own shared folder, on whichever volume DSM created it (see bridge-env).
  config.dataDir = config.dataDir || "";
  const dataDirDefault = config.dataDir || `/var/packages/${id}/shares/${id}`;
  // The folder lives in a shared folder that DSM creates when it is missing (like Synology's own
  // media apps do with "music"), so packages never make plain directories nobody can see.
  // outputParent/defaultOutputDir are the older way to say the same.
  config.outputShare = config.outputShare
    || (config.outputParent ? path.posix.basename(config.outputParent) : "music");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(config.outputShare)) throw new Error("outputShare must be a share name");
  if (config.outputShare === id) throw new Error("outputShare must differ from id, the package's own share");
  config.outputParent = `/volume1/${config.outputShare}`;
  config.defaultOutputDir = `${config.outputParent}/${config.outputSubdir
    || (config.defaultOutputDir ? path.posix.basename(config.defaultOutputDir) : id)}`;
  config.outputContainerRoot = config.outputContainerRoot || "/output-parent";
  // Named per package: apps whose folders share a parent must not repoint each other's link.
  config.outputLink = config.outputLink || `.${id}-folder`;
  config.outputHostRoot = config.outputHostRoot || "/host-output";
  config.outputSubdir = config.outputSubdir || path.basename(config.defaultOutputDir);
  config.controlPort = Number(config.controlPort || controlPortFor(id));
  config.ui = config.ui || {};

  // App paths that devices on the network fetch without a DSM session; see bridge/src/public.mjs.
  const publicPaths = config.publicPaths || [];
  if (!Array.isArray(publicPaths) || publicPaths.some((item) => typeof item !== "string"
      || !/^\/[A-Za-z0-9._~\/-]*$/.test(item) || item === "/" || item.includes("//")
      || item.split("/").some((part) => part === "." || part === ".."))) {
    throw new Error("publicPaths must be app paths such as /media/ (a trailing slash allows everything below)");
  }
  const publicPrefix = `/webman/3rdparty/${id}/public`;

  let appPath = config.appPath || "/";
  if (!appPath.startsWith("/")) appPath = `/${appPath}`;
  if (!appPath.endsWith("/")) appPath = `${appPath}/`;

  const defaultContainerOutput = `${config.outputContainerRoot}/${config.outputLink}`;
  const appEnv = {
    APP_PORT: `\${APP_CONTAINER_PORT:-${config.containerPort}}`,
    ...(showOutput ? { APP_OUTPUT_DIR: `\${APP_OUTPUT_CONTAINER_DIR:-${defaultContainerOutput}}` } : {}),
    APP_DATA_DIR: "/data",
    // Where devices on the network reach the public paths: the NAS address on DSM's HTTP port.
    ...(publicPaths.length ? { APP_PUBLIC_URL: "${APP_PUBLIC_URL:-}" } : {}),
    // DSM's time zone (Control Panel > Regional Options) by name; preinst reads it from the NAS.
    ...(config.hostTimezone === false ? {} : { TZ: "${APP_TZ:-Etc/UTC}" }),
    ...(config.appEnv || {}),
  };
  for (const [key, value] of Object.entries(appEnv)) {
    appEnv[key] = String(value)
      .replaceAll("${APP_CONTAINER_PORT}", `\${APP_CONTAINER_PORT:-${config.containerPort}}`)
      .replaceAll("${APP_PUBLIC_URL}", "${APP_PUBLIC_URL:-}")
      .replaceAll("${APP_INTERNAL_PORT}", `\${APP_INTERNAL_PORT:-${config.internalPort}}`)
      .replaceAll("${APP_OUTPUT_CONTAINER_DIR}", `\${APP_OUTPUT_CONTAINER_DIR:-${defaultContainerOutput}}`);
  }
  const appEnvironment = Object.entries(appEnv)
    .map(([key, value]) => `      ${key}: ${JSON.stringify(String(value))}`)
    .join("\n");
  const network = networkMode === "host" ? "    network_mode: host" : "";
  const ports = networkMode === "host" ? "" : [
    "    ports:",
    `      - "127.0.0.1:\${APP_INTERNAL_PORT:-${config.internalPort}}:\${APP_CONTAINER_PORT:-${config.containerPort}}"`,
  ].join("\n");

  // Apps without an output folder get no share mounted at all, and neither does their bridge.
  // Through DSM's per-package link, so the share is found on whichever volume it lives.
  const shareLink = `/var/packages/${id}/shares/${config.outputShare}`;
  const outputVolume = (target) => showOutput ? `      - ${shareLink}:${target}` : "";
  const outputShareResource = showOutput
    ? `,\n      {\n        "name": ${JSON.stringify(config.outputShare)},\n        "permission": {},\n        "once": true\n      }`
    : "";

  const values = {
    id,
    version,
    displayName,
    description,
    maintainer,
    dsmAppName,
    image: config.image,
    bridgeImage: config.bridgeImage,
    container: config.container,
    hostPort: config.internalPort,
    containerPort: config.containerPort,
    dataDir: config.dataDir,
    dataDirDefault,
    defaultOutputDir: config.defaultOutputDir,
    appTitle: displayName,
    appPath,
    allUsers: config.allUsers === true ? "true" : "false",
    authMode,
    showOutput: showOutput ? "true" : "false",
    identityHeaders: config.identityHeaders === true ? "true" : "false",
    outputLabelJson: scriptJson(outputLabel),
    texts: scriptJson(JSON.parse(fs.readFileSync(path.join(here, "texts.json"), "utf8"))),
    displayNameGer,
    descriptionGer,
    oneTimeSeconds: config.oneTimeSeconds || 60,
    sessionSeconds: config.sessionSeconds || 28800,
    controlPort: config.controlPort,
    service: config.service,
    outputParent: config.outputParent,
    outputContainerRoot: config.outputContainerRoot,
    outputHostRoot: config.outputHostRoot,
    outputSubdir: config.outputSubdir,
    outputLink: config.outputLink,
    networkMode: network,
    ports,
    appUser: "",
    // docker run --init: a minimal init reaps the app's orphaned child processes.
    appInit: config.init === true ? "    init: true" : "",
    packageUser: packageUser(config) ? "true" : "false",
    publicPaths: publicPaths.join(","),
    publicPrefix: publicPaths.length ? publicPrefix : "",
    publicLocation: publicPaths.length ? publicLocation(id, config.controlPort) : "",
    // An app running as the package user may read and write its own share; nothing else.
    dataSharePermission: JSON.stringify(packageUser(config) ? { rw: [id] } : {}),
    frameworkVersion: frameworkVersion(),
    appEnvironment,
    appOutputVolume: outputVolume(config.outputContainerRoot),
    bridgeOutputVolume: showOutput ? outputVolume(config.outputHostRoot) : "",
    outputShare: config.outputShare,
    outputShareResource,
    width: config.ui.width || 1200,
    height: config.ui.height || 800,
  };
  // The app user line is filled in after the app build, from the image itself (see imageUser).
  return { config, values, archInfo };
}

/** Renders every template with the given values; throws on a missing value. */
export function renderTemplates(values, target) {
  copyTree(templateDir, target, values);
}

/** --check: renders the package without Docker and reports what it would build. */
function check(config, values, archInfo) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-bridge-check-"));
  try {
    renderTemplates({ ...values, appUser: packageUser(config) ? "" : '    user: "0:0"' }, stage);
    for (const file of ["conf/resource", "conf/privilege", "ui/config"]) {
      JSON.parse(fs.readFileSync(path.join(stage, file), "utf8"));
    }
    for (const script of fs.readdirSync(path.join(stage, "scripts"))) {
      execFileSync("sh", ["-n", path.join(stage, "scripts", script)]);
    }
    for (const cgi of ["auth.sh", "status.cgi", "session.cgi", "settings.cgi", "access.cgi"]) {
      execFileSync("sh", ["-n", path.join(stage, "ui", cgi)]);
    }
    if (config.icon) {
      if (!fs.existsSync(path.resolve(config.appDir, config.icon))) throw new Error(`missing icon: ${config.icon}`);
    } else {
      copyIcons(config, path.join(stage, "icons-check"));
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  console.log(`${values.id} ${values.version} (${archInfo.arch}) is valid`);
  for (const key of ["displayName", "dsmAppName", "image", "container", "hostPort", "containerPort",
    "dataDirDefault", "outputParent", "defaultOutputDir", "allUsers", "authMode", "identityHeaders",
    "frameworkVersion"]) {
    console.log(`  ${key.padEnd(16)} ${values[key]}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(options.config);
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  // One app.json, one package per architecture.
  if (options.arch) raw.arch = options.arch;
  const { config, values, archInfo } = resolve(raw, path.dirname(configPath));
  if (options.check) {
    check(config, values, archInfo);
    return;
  }
  const { id, version } = values;

  buildApp(config, archInfo, options.skipAppBuild);
  buildBridge(config, archInfo.platform, options.skipBridgeBuild);
  // Container Manager runs every service without an explicit user as the package's own DSM
  // user, so official images that start as root (nginx, most databases) fail on their first
  // mkdir. Always state the user: the configured one, else the image's own, as docker run would.
  // "package": no user line, so Container Manager runs the app as the package's own DSM user.
  if (packageUser(config)) {
    values.appUser = "";
    console.log(`==> app runs as the package user ${id}`);
  } else {
    const user = config.appUser ? String(config.appUser) : imageUser(config.image, archInfo.platform);
    values.appUser = `    user: ${JSON.stringify(user)}`;
    console.log(`==> app runs as ${user}`);
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dsm-bridge-"));
  const payload = path.join(stage, "payload");
  const pkg = path.join(stage, "spk");
  fs.mkdirSync(path.join(payload, "docker"), { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });

  renderTemplates(values, payload);
  copyIcons(config, payload);

  fs.writeFileSync(
    path.join(payload, "INFO"),
    render(fs.readFileSync(path.join(payload, "INFO"), "utf8"), values)
      .replace("__ARCH__", archInfo.arch),
  );
  fs.chmodSync(path.join(payload, "INFO"), 0o644);

  // DSM's app-portal worker looks the registration up by the package name.
  for (const extension of ["json", "mustache"]) {
    fs.renameSync(path.join(payload, "config", `portal.${extension}`),
      path.join(payload, "config", `${id}.${extension}`));
  }
  fs.copyFileSync(path.join(payload, "compose.yml"), path.join(payload, "docker", "compose.yml"));
  fs.rmSync(path.join(payload, "compose.yml"));
  fs.writeFileSync(path.join(payload, "docker", ".env"), [
    `APP_IMAGE=${config.image}`,
    `BRIDGE_IMAGE=${config.bridgeImage}`,
    `APP_CONTAINER=${config.container}`,
    `APP_DATA_DIR=${values.dataDirDefault}`,
    `APP_INTERNAL_PORT=${config.internalPort}`,
    `APP_CONTAINER_PORT=${config.containerPort}`,
    `BRIDGE_CONTROL_PORT=${config.controlPort}`,
    `APP_OUTPUT_PARENT=${config.outputParent}`,
    `APP_OUTPUT_DIR=${config.defaultOutputDir}`,
    `APP_OUTPUT_CONTAINER_DIR=${config.outputContainerRoot}/${config.outputLink}`,
    "",
  ].join("\n"));

  console.log("==> saving images");
  const imageTar = path.join(payload, "image.tar");
  // With the containerd image store, docker save exports the build machine's platform unless
  // told otherwise; an arm64 image in an x86_64 package never starts on the NAS.
  run("docker", ["save", "--platform", archInfo.platform, config.image, config.bridgeImage,
    "-o", imageTar]);
  verifyPlatform(imageTar, archInfo.platform, stage);

  for (const script of fs.readdirSync(path.join(payload, "scripts"))) {
    fs.chmodSync(path.join(payload, "scripts", script), 0o755);
  }
  for (const cgi of ["status.cgi", "settings.cgi", "session.cgi", "access.cgi", "auth.sh"]) {
    fs.chmodSync(path.join(payload, "ui", cgi), 0o755);
  }

  // The package root carries INFO, scripts and conf; package.tgz carries the
  // docker project, the UI payload and the DSM nginx config.
  fs.cpSync(path.join(payload, "scripts"), path.join(pkg, "scripts"), { recursive: true });
  fs.cpSync(path.join(payload, "conf"), path.join(pkg, "conf"), { recursive: true });
  fs.copyFileSync(path.join(payload, "INFO"), path.join(pkg, "INFO"));
  fs.copyFileSync(path.join(payload, "PACKAGE_ICON.PNG"), path.join(pkg, "PACKAGE_ICON.PNG"));
  fs.copyFileSync(path.join(payload, "PACKAGE_ICON_256.PNG"), path.join(pkg, "PACKAGE_ICON_256.PNG"));

  const packageTgz = path.join(pkg, "package.tgz");
  const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" };
  run("tar", ["-C", payload, "-czf", packageTgz, "image.tar", "docker", "ui", "config"], { env: tarEnv });

  const outputDir = path.resolve(options.output || path.join(here, "dist"));
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, `${id}-${version}-${archInfo.arch}.spk`);
  run("tar", [
    "-C", pkg, "-cf", output,
    "INFO", "package.tgz", "PACKAGE_ICON.PNG", "PACKAGE_ICON_256.PNG",
    "scripts", "conf",
  ], { env: tarEnv });

  console.log(`wrote ${output} (${(fs.statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
  const checksum = execFileSync("shasum", ["-a", "256", output], { encoding: "utf8" }).trim();
  console.log(checksum);
  fs.rmSync(stage, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`generate: ${error.message}`);
    process.exit(1);
  }
}
