import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import httpProxy from "http-proxy";
import { createAuthenticator } from "./auth.mjs";
import { ConfigError, createConfigFile } from "./config-file.mjs";
import { createUpdates } from "./updates.mjs";
import { loadConfig } from "./config.mjs";
import { dropDsmCookies, publicCookieHeader, scopeCookies, withoutDsmCookies } from "./cookies.mjs";
import { probe, resolveUser } from "./access.mjs";
import { publicTarget } from "./public.mjs";
import { requestUrl } from "./request-url.mjs";
import { dsmAddress } from "./address.mjs";
import { applyIdentity, dsmEmail, ensureSecret } from "./identity.mjs";
import * as dotenv from "./dotenv.mjs";
import { createDocker } from "./docker.mjs";
import { applyFraming, frameAncestors } from "./framing.mjs";
import { pruneSuperseded } from "./images.mjs";
import { writePrivateFile } from "./private-file.mjs";
import { crossSite, sameOrigin, unsafeMethod } from "./origin.mjs";
import { ensureFolder, hostPath, isInside, normalizeDirectory, realFolder } from "./validate.mjs";

const config = loadConfig();
const docker = createDocker({ socketPath: config.dockerSocket });
const inspectContainer = (name) => docker.inspect(name);
const auth = createAuthenticator(config);
// A WebSocket that no HTTP request follows still has to end when its session does.
setInterval(() => auth.sweep(), 60_000).unref();

if (!config.token) {
  console.error("bridge token missing; set BRIDGE_TOKEN or BRIDGE_TOKEN_FILE");
  process.exit(1);
}

const packageOwner = fsSync.existsSync(config.tokenFile)
  ? fsSync.lstatSync(config.tokenFile)
  : null;
let env = dotenv.read(config.envFile, packageOwner?.uid);
if (config.output) {
  // The default folder sits in the share wherever it is; a saved folder outside it (an earlier
  // version, or a share that moved volumes) falls back to it rather than to a path that is gone.
  const defaultDir = config.outputSubdir
    ? path.posix.join(config.allowedRoot, config.outputSubdir)
    : config.defaultOutputDir;
  const saved = env[config.outputKey];
  if (!saved || !isInside(config.allowedRoot, saved) || saved === config.allowedRoot) {
    env[config.outputKey] = defaultDir;
  }
}

function writeEnv() {
  // The bridge runs as root; keep the files writable by the package scripts. The ownership is
  // applied through the open descriptor, never to a path the package user could swap first.
  const owner = packageOwner?.isFile() ? packageOwner : null;
  dotenv.write(config.envFile, env, owner);
  if (config.stateEnvFile) {
    dotenv.write(config.stateEnvFile, env, owner);
  }
}

writeEnv();

let outputDir = env[config.outputKey];
// Shared with the app through its data folder; see identity.mjs.
let identitySecret = "";
// False while a named app user has not been resolved yet, so a later request can retry.
let identitySecretReady = false;
let controlServer = null;

const configFile =
  config.configFile && config.dataDir
    ? createConfigFile({
        dir: config.dataDir,
        file: config.configFile,
        check: config.configCheck,
        ready: config.configReady,
        docker,
        container: config.container,
        reachable: appReachable,
        log,
        settleMs: config.configSettleSeconds * 1000,
        timeoutMs: config.configTimeoutSeconds * 1000,
        stateFile: config.configStateFile,
      })
    : null;

const updates =
  config.updatesImage && config.updatesCurrent
    ? createUpdates({
        image: config.updatesImage,
        current: config.updatesCurrent,
        url: config.updatesUrl,
        stateFile: config.updatesStateFile,
        log,
      })
    : null;

const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${config.internalPort}`,
  ws: true,
  xfwd: true,
});

function stripFrameHeaders(headers, prefix = "", request = null) {
  if (prefix && headers.location && String(headers.location).startsWith("/")) {
    const location = String(headers.location);
    if (!location.startsWith(`${prefix}/`)) {
      headers.location = `${prefix}${location}`;
    }
  }
  applyFraming(headers, frameAncestors(config, request?.headers.host));
}

proxy.on("proxyRes", (proxyResponse, request) => {
  stripFrameHeaders(proxyResponse.headers, request._bridgePrefix || "", request);
  scopeCookies(proxyResponse.headers, request._bridgePrefix || "");
  const dropped = dropDsmCookies(proxyResponse.headers, config.sessionCookieBase);
  if (dropped.length) log("warn", "app cookies named like DSM's were dropped", { dropped });
});

/**
 * A visitor without a session on one of the app's public paths: no identity headers, and of the
 * cookies only those the app lists. In particular not the app's own login cookie, which could
 * otherwise outlast a revoked DSM privilege.
 */
function makeAnonymous(request) {
  applyIdentity(request.headers, null, false);
  const cookie = publicCookieHeader(
    request.headers.cookie,
    config.publicCookies,
    config.sessionCookieBase,
  );
  if (cookie) {
    request.headers.cookie = cookie;
  } else {
    delete request.headers.cookie;
  }
}

/** On the app's own ports, a public path the app may serve without a session; else null. */
function ownPublicTarget(request) {
  return config.ownOrigin ? publicTarget(request.url, config.publicPaths) : null;
}

/** The request's cookies the app may see: none of the bridge's, and none of DSM's. */
function appCookies(header) {
  return withoutDsmCookies(auth.stripCookies(header));
}

// The bridge's own pages, in the browser's language. Inside the DSM window the wrapper shows the
// real state instead, in the user's DSM language.
const PAGE_TEXTS = {
  en: {
    starting: "Starting {app}",
    notAnswering: "The app is not answering yet. This page reloads by itself.",
    signInTitle: "Sign in required",
    signIn: "Sign in to open {app}",
    signInBody:
      "Open {app} from the DSM desktop. Its icon signs this window in with your DSM account.",
    openDsm: "Open DSM",
  },
  de: {
    starting: "{app} wird gestartet",
    notAnswering: "Die App antwortet noch nicht. Diese Seite lädt sich selbst neu.",
    signInTitle: "Anmeldung erforderlich",
    signIn: "Melden Sie sich an, um {app} zu öffnen",
    signInBody:
      "Öffnen Sie {app} über den DSM-Desktop. Das Symbol meldet dieses Fenster mit Ihrem DSM-Konto an.",
    openDsm: "DSM öffnen",
  },
};

function pageLanguage(request) {
  return /^de\b/i.test(String(request.headers["accept-language"] || "")) ? "de" : "en";
}

function pageText(request, key) {
  return PAGE_TEXTS[pageLanguage(request)][key].replace("{app}", config.appTitle);
}

proxy.on("error", (error, request, response) => {
  log("warn", "proxy error", { error: error.message });
  if (response && !response.headersSent && response.writeHead) {
    response.writeHead(502, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      page({
        language: pageLanguage(request),
        title: pageText(request, "starting"),
        heading: pageText(request, "starting"),
        body: `<p>${escapeHtml(pageText(request, "notAnswering"))}</p>`,
        // Inside the DSM window the wrapper shows the real state (starting, stopped, ...) and
        // reloads the app when it answers; standalone tabs simply retry.
        script:
          "if (window.parent !== window) { parent.postMessage({ type: 'bridge:unavailable' }," +
          " '*'); } else { setTimeout(function () { location.reload(); }, 3000); }",
      }),
    );
  } else if (response && response.destroy) {
    response.destroy();
  }
});

/**
 * Neutral page for the bridge's own responses. It must not carry any app branding: the bridge
 * serves every packaged app the same way.
 */
function page({ language, title, heading, body, script = "" }) {
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light}
body{font:14px/1.5 -apple-system,"Segoe UI",Roboto,system-ui,sans-serif;background:#f4f6f8;color:#3c4554;
margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}
main{max-width:420px;text-align:center}
h1{margin:0 0 6px;font-size:16px;font-weight:600;color:#1f2a37}
p{margin:0 0 6px;color:#5b6676}
a{color:#057feb}
</style></head><body><main>
<h1>${escapeHtml(heading)}</h1>
${body}
</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function log(level, message, extra = {}) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...extra,
    }),
  );
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function authorized(request) {
  const header = request.headers.authorization || "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    return false;
  }
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(config.token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function readJson(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function appReachable() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port: config.internalPort,
        path: config.appPath,
        timeout: 1500,
        headers: { "User-Agent": "dsm-docker-bridge/1" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode < 500);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function status(admin = false) {
  let container = null;
  try {
    container = await inspectContainer(config.container);
  } catch (error) {
    log("debug", "container inspect failed", { error: error.message });
  }
  const running = container?.state === "running";
  const update = admin && updates ? updates.status() : null;
  return {
    app: config.appTitle,
    framework: config.frameworkVersion,
    state: container?.state || "missing",
    health: container?.health || "",
    reachable: running ? await appReachable() : false,
    ...(admin
      ? {
          container: config.container,
          image: container?.image || "",
          internalPort: config.internalPort,
        }
      : {}),
    path: config.appPath,
    ...(update ? { update } : {}),
    ...(config.output && admin
      ? {
          outputParent: config.allowedRoot,
          outputDir,
          outputContainerDir: env[config.outputContainerKey] || containerLinkPath(),
        }
      : {}),
  };
}

/**
 * The data folder's real path on the NAS, for DSM's permission dialogs. The compose file names
 * it through DSM's per-package link, whose target says which volume the share is on.
 */
async function dataHostPath() {
  const configured = String(env.APP_DATA_DIR || "");
  const match = /^\/var\/packages\/[^/]+\/shares\/([^/]+)(\/.*)?$/.exec(configured);
  if (!match || !config.sharesDir) return configured;
  try {
    const target = await fs.readlink(path.posix.join(config.sharesDir, match[1]));
    return path.posix.join(target, match[2] || "");
  } catch {
    return configured;
  }
}

/** The folders the app uses, and whether its own user may read and write them. */
async function access() {
  const container = await inspectContainer(config.container);
  const user = await resolveUser(container, docker, config.container);
  if (!user) return { folders: [] };
  const folders = [];
  if (config.dataDir) {
    folders.push({
      key: "data",
      path: await dataHostPath(),
      ...(await probe(config.dataDir, user)),
    });
  }
  if (config.output && outputDir) {
    const host = hostPath(outputDir, config.allowedRoot, config.hostRoot);
    // A folder inside a shared folder is out of reach while the shared folder itself is closed.
    const share = await probe(config.hostRoot, user);
    folders.push({
      key: "output",
      path: outputDir,
      share: config.allowedRoot,
      shareOpen: share.read,
      ...(await probe(host, user)),
    });
  }
  return { folders };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listenWithRetry(start, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await start(port);
    } catch (error) {
      if (error.code !== "EADDRINUSE" || Date.now() >= deadline) {
        throw error;
      }
      log("info", "port busy, waiting for the previous container", { port });
      await sleep(500);
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSecure(request) {
  return (
    Boolean(request.socket.encrypted) ||
    String(request.headers["x-forwarded-proto"] || "").toLowerCase() === "https"
  );
}

function forwardedPrefix(request) {
  return String(request.headers["x-forwarded-prefix"] || "").replace(/\/+$/, "");
}

function proxyOriginAllowed(request) {
  const { origin, host } = request.headers;
  if (!origin && (crossSite(request.headers) || request.headers["sec-fetch-site"] === "same-site"))
    return false;
  return sameOrigin(origin, host, isSecure(request) ? "https" : "http", config.allowedOrigins);
}

function refuseCrossSite(response) {
  response.writeHead(403, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end("Cross-site request refused.\n");
}

function redirectLocation(request) {
  return `${forwardedPrefix(request)}${config.appPath}`;
}

function unauthorized(response, request) {
  const login = dsmAddress(
    String(request.headers.host || ""),
    isSecure(request),
    config.ownOrigin,
    { http: config.dsmHttpPort, https: config.dsmHttpsPort },
    config.appId,
  );
  response.writeHead(401, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(
    page({
      language: pageLanguage(request),
      title: pageText(request, "signInTitle"),
      heading: pageText(request, "signIn"),
      body:
        `<p>${escapeHtml(pageText(request, "signInBody"))}</p>` +
        `<p><a href="${escapeHtml(login)}">${escapeHtml(pageText(request, "openDsm"))}</a></p>`,
      // Inside the DSM window the user is still signed in to DSM: ask the wrapper for a fresh
      // bridge session instead of showing this page (sessions end after idling or a restart).
      // The message names no secret, and the window may be on another port than the app.
      // Opened directly on the app's own ports, go to DSM, which opens the app after sign-in.
      script:
        "if (window.parent !== window) { document.body.style.visibility = 'hidden';" +
        " parent.postMessage({ type: 'bridge:reauth' }, '*'); }" +
        (config.ownOrigin
          ? ` else { location.replace(${JSON.stringify(login).replace(/</g, "\\u003c")}); }`
          : ""),
    }),
  );
}

async function publicHandler(request, response) {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/__bridge_ping") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/__bridge_login") {
      const session = auth.login(url.searchParams.get("token") || "");
      if (!session) {
        unauthorized(response, request);
        return;
      }
      response.writeHead(302, {
        Location: redirectLocation(request),
        "Set-Cookie": auth.cookie(session, isSecure(request), `${forwardedPrefix(request)}/`),
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/__bridge_refresh") {
      // The window re-checked the DSM privilege and renews this session with a new token.
      const ok = auth.refresh(request, url.searchParams.get("token") || "");
      response.writeHead(ok ? 204 : 401, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const identity = auth.authenticate(request);
    if (!identity) {
      const target = ownPublicTarget(request);
      if (target && ["GET", "HEAD", "POST"].includes(request.method)) {
        makeAnonymous(request);
        request.url = target;
        request._bridgePrefix = "";
        proxy.web(request, response);
        return;
      }
      unauthorized(response, request);
      return;
    }
    if (
      config.authMode !== "none" &&
      unsafeMethod(request.method) &&
      !proxyOriginAllowed(request)
    ) {
      refuseCrossSite(response);
      return;
    }
    if (config.identityHeaders && identity.user && !identitySecretReady) {
      await prepareSecret();
      if (!identitySecretReady) return sendJson(response, 503, { error: "identity-not-ready" });
    }
    applyIdentity(request.headers, identity, config.identityHeaders, identitySecret);
    const cookie = appCookies(request.headers.cookie);
    if (cookie) {
      request.headers.cookie = cookie;
    } else {
      delete request.headers.cookie;
    }
    // Keep the backend rooted at / so unmodified OCI images do not need to
    // know about the DSM package subpath.
    request._bridgePrefix = forwardedPrefix(request);
    delete request.headers["x-forwarded-prefix"];
    proxy.web(request, response);
  } catch (error) {
    log("warn", "public request failed", { error: error.message });
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("The bridge could not authenticate this request.\n");
    } else {
      response.destroy();
    }
  }
}

/**
 * The app paths listed in publicPaths, for devices that fetch them without a DSM session. They
 * reach the app without identity headers and without any cookie, so the app treats them as
 * anonymous.
 */
function anonymousHandler(request, response) {
  const target = publicTarget(request.url, config.publicPaths);
  if (!target || !["GET", "HEAD", "POST"].includes(request.method)) {
    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end("Not found\n");
    return;
  }
  makeAnonymous(request);
  request._bridgePrefix = forwardedPrefix(request);
  delete request.headers["x-forwarded-prefix"];
  request.url = target;
  proxy.web(request, response);
}

async function upgradeHandler(request, socket, head) {
  try {
    const identity = auth.authenticate(request);
    if (!identity) {
      const target = ownPublicTarget(request);
      if (target) {
        makeAnonymous(request);
        request.url = target;
        delete request.headers["x-forwarded-prefix"];
        proxy.ws(request, socket, head);
        return;
      }
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if (config.authMode !== "none" && !proxyOriginAllowed(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (config.identityHeaders && identity.user && !identitySecretReady) {
      await prepareSecret();
      if (!identitySecretReady)
        return socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    }
    applyIdentity(request.headers, identity, config.identityHeaders, identitySecret);
    const cookie = appCookies(request.headers.cookie);
    if (cookie) {
      request.headers.cookie = cookie;
    } else {
      delete request.headers.cookie;
    }
    const untrack = auth.track(identity.key, () => socket.destroy());
    socket.once("close", untrack);
    delete request.headers["x-forwarded-prefix"];
    proxy.ws(request, socket, head);
  } catch (error) {
    log("warn", "websocket authentication failed", { error: error.message });
    socket.destroy();
  }
}

function linkHostPath() {
  return path.posix.join(config.hostRoot, config.outputLink);
}

function containerLinkPath() {
  return path.posix.join(config.outputContainerRoot, config.outputLink);
}

async function pointLink(target) {
  const root = await fs.realpath(config.hostRoot);
  let host;
  try {
    host = await fs.realpath(hostPath(target, config.allowedRoot, config.hostRoot));
  } catch {
    throw new HttpError(400, "folder is outside the output volume");
  }
  const relative = path.posix.relative(root, host);
  if (!relative || relative.startsWith("..")) {
    throw new HttpError(400, "folder is outside the output volume");
  }
  const link = linkHostPath();
  const stat = await fs.lstat(link).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return null;
  });
  if (stat && !stat.isSymbolicLink()) {
    throw new HttpError(409, "the output link path is occupied by a real folder");
  }
  const temporary = `${link}.tmp.${crypto.randomBytes(8).toString("hex")}`;
  await fs.symlink(relative, temporary, "dir");
  try {
    await fs.rename(temporary, link);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function ensureLink() {
  const link = linkHostPath();
  try {
    const stat = await fs.lstat(link);
    if (!stat.isSymbolicLink()) {
      // A real directory from an older layout: leave it alone rather than
      // destroying user data. The app keeps using the explicit path in that case.
      log("warn", "output link path is not a symlink", { link });
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const root = await fs.realpath(config.hostRoot);
  const host = await ensureFolder(
    config.hostRoot,
    hostPath(outputDir, config.allowedRoot, config.hostRoot),
  );
  await pointLink(outputDir);
  await removeLegacyLink(path.posix.relative(root, host));
}

// Earlier versions used one link name for every package. Drop it once it is ours; another
// package's link (pointing elsewhere) stays until that package upgrades too.
const LEGACY_LINK = ".bridge-current";

async function removeLegacyLink(relative) {
  if (config.outputLink === LEGACY_LINK) {
    return;
  }
  const legacy = path.posix.join(config.hostRoot, LEGACY_LINK);
  try {
    if ((await fs.readlink(legacy)) === relative) {
      await fs.rm(legacy);
      log("info", "removed shared output link of an earlier version", { link: legacy });
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EINVAL") {
      log("warn", "earlier output link could not be checked", { error: error.message });
    }
  }
}

/**
 * Container Manager stores container IDs in its own config files. An upgrade
 * recreates the containers but does not refresh those IDs, so the next boot
 * fails to start the project. Keep them in sync while we are running.
 */
async function syncContainerManager() {
  if (!config.containerManagerDir) {
    return;
  }
  for (const name of [config.container, `${config.container}-bridge`]) {
    const file = path.join(config.containerManagerDir, `${name}.config`);
    let stored;
    try {
      stored = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        log("warn", "container manager config could not be read", { file, error: error.message });
      }
      continue;
    }
    let container;
    try {
      container = await inspectContainer(name);
    } catch {
      continue;
    }
    if (!container || stored.id === container.id) {
      continue;
    }
    stored.id = container.id;
    stored.image = container.image || stored.image;
    stored.labels = container.labels || stored.labels;
    try {
      writePrivateFile(file, JSON.stringify(stored));
      log("info", "container manager state synced", { name, id: container.id });
    } catch (error) {
      log("warn", "container manager config could not be updated", { file, error: error.message });
    }
  }
}

async function ensureOutput(value, moveExisting) {
  if (!config.output) {
    throw new HttpError(400, "this app has no output folder");
  }
  const target = normalizeDirectory(value, config.allowedRoot);
  if (target === config.allowedRoot) {
    throw new HttpError(400, "choose a folder below the output volume");
  }
  if (target === outputDir) {
    return { ...(await status(true)), moved: [], skipped: [] };
  }
  const previous = outputDir;
  if (isInside(previous, target)) {
    throw new HttpError(400, "choose a folder outside the current output folder");
  }

  let moved = [];
  let skipped = [];
  await docker.stop(config.container);
  let host;
  let previousHost;
  try {
    host = await ensureFolder(
      config.hostRoot,
      hostPath(target, config.allowedRoot, config.hostRoot),
    );
    previousHost = await realFolder(
      config.hostRoot,
      hostPath(previous, config.allowedRoot, config.hostRoot),
    ).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  } catch {
    await docker.start(config.container).catch(() => {});
    throw new HttpError(400, "folder escapes the allowed volume");
  }
  try {
    if (moveExisting) {
      ({ moved, skipped } = await moveEntries(previousHost, host));
    }

    await pointLink(target);
    outputDir = target;
    env[config.outputKey] = target;
    env[config.outputContainerKey] = containerLinkPath();
    writeEnv();
    await docker.start(config.container);
  } catch (error) {
    outputDir = previous;
    env[config.outputKey] = previous;
    env[config.outputContainerKey] = containerLinkPath();
    writeEnv();
    await pointLink(previous).catch(() => {});
    await docker.start(config.container).catch(() => {});
    throw error;
  }
  log("info", "output folder changed", { outputDir, moved: moved.length, skipped: skipped.length });
  return { ...(await status(true)), moved, skipped };
}

// Moves the old output folder's entries to the new one; names that already exist there stay.
async function moveEntries(from, to) {
  const moved = [];
  const skipped = [];
  if (!from) {
    return { moved, skipped };
  }
  try {
    for (const entry of await fs.readdir(from)) {
      if (entry === config.outputLink) {
        continue;
      }
      const source = path.posix.join(from, entry);
      const destination = path.posix.join(to, entry);
      if (await exists(destination)) {
        skipped.push(entry);
        continue;
      }
      // Both directories are on the same mounted share. Rename the entry itself; never
      // descend into a destination that became a directory or symlink.
      await fs.rename(source, destination);
      moved.push(entry);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return { moved, skipped };
}

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function restart() {
  await docker.restart(config.container);
  log("info", "application restarted", { container: config.container });
  return status(true);
}

async function handleControl(request, response) {
  const url = requestUrl(request.url);
  if (!url) {
    sendJson(response, 400, { error: "bad request" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (!authorized(request)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/status") {
    sendJson(response, 200, await status(url.searchParams.get("admin") === "1"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/access") {
    sendJson(response, 200, await access());
    return;
  }
  if (request.method === "POST" && url.pathname === "/session") {
    const body = await readJson(request);
    sendJson(response, 200, {
      token: auth.mint({
        user: body.user,
        groups: body.groups,
        name: body.name,
        email: config.identityHeaders ? dsmEmail(String(body.user || ""), config.userDbFile) : "",
      }),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/revoke") {
    const body = await readJson(request);
    const ended = auth.revoke(String(body.user || ""));
    if (ended) log("info", "sessions ended", { count: ended });
    sendJson(response, 200, { ended });
    return;
  }
  if (request.method === "POST" && url.pathname === "/restart") {
    sendJson(response, 200, await restart());
    return;
  }
  if (request.method === "POST" && url.pathname === "/output") {
    const body = await readJson(request);
    sendJson(response, 200, await ensureOutput(body.path, body.moveExisting !== false));
    return;
  }
  if (url.pathname === "/updates" && updates) {
    if (request.method === "POST") {
      const body = await readJson(request);
      sendJson(response, 200, await updates.skip(String(body.skip || "")));
    } else {
      sendJson(response, 200, updates.status());
    }
    return;
  }
  if (url.pathname === "/config" || url.pathname === "/config/status") {
    if (!configFile) {
      sendJson(response, 404, { error: "no settings file" });
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/config/status") {
        sendJson(response, 200, configFile.status());
      } else if (request.method === "GET") {
        sendJson(response, 200, await configFile.read());
      } else if (request.method === "POST") {
        sendJson(response, 200, await configFile.save(await readJson(request, 1024 * 1024)));
      } else {
        sendJson(response, 405, { error: "method" });
      }
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      sendJson(response, error.status, { error: error.code });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/apply") {
    const body = await readJson(request);
    if (body.restart) {
      await docker.restart(config.container);
    }
    if (body.outputDir) {
      await ensureOutput(body.outputDir, body.moveExisting !== false);
    }
    sendJson(response, 200, await status(true));
    return;
  }
  sendJson(response, 404, { error: "not found" });
}

async function startControl(port) {
  const server = http.createServer((request, response) => {
    const url = requestUrl(request.url);
    if (!url) {
      sendJson(response, 400, { error: "bad request" });
      return;
    }
    // DSM's same-origin nginx rule proxies /webman/3rdparty/<id>/proxy/ to the
    // fixed localhost control port, so the desktop window needs no extra port.
    if (url.pathname.startsWith("/__proxy/")) {
      request.url = url.pathname.slice("/__proxy".length) + url.search;
      publicHandler(request, response);
      return;
    }
    if (url.pathname.startsWith("/__public/")) {
      // The raw path: publicTarget normalizes it itself before checking the allowed list.
      request.url = String(request.url).slice("/__public".length);
      anonymousHandler(request, response);
      return;
    }
    handleControl(request, response).catch((error) => {
      const statusCode = error instanceof HttpError ? error.status : 500;
      log("warn", "control request failed", {
        path: request.url,
        error: error.message,
      });
      if (!response.headersSent) {
        sendJson(response, statusCode, { error: error.message || "internal error" });
      } else {
        response.destroy();
      }
    });
  });
  server.on("upgrade", (request, socket, head) => {
    // Node hands the socket over without its own error handler, and http-proxy adds one only
    // once the app accepts the upgrade. A browser that gives up while the app is still starting
    // resets the socket, which would otherwise end the bridge.
    socket.on("error", (error) => {
      log("debug", "websocket client error", { error: error.message });
    });
    const url = requestUrl(request.url);
    if (!url) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname.startsWith("/__proxy/")) {
      request.url = url.pathname.slice("/__proxy".length) + url.search;
      upgradeHandler(request, socket, head);
      return;
    }
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function prepareSecret() {
  if (!config.identityHeaders || !config.dataDir) {
    identitySecretReady = true;
    return;
  }
  try {
    const container = await inspectContainer(config.container);
    const user = await resolveUser(container, docker, config.container);
    if (!container || (container.user && !/^(root|0)(:|$)/.test(container.user) && !user)) return;
    identitySecret = await ensureSecret(path.posix.join(config.dataDir, ".bridge-secret"), user);
    identitySecretReady = true;
  } catch (error) {
    identitySecretReady = false;
    log("warn", "identity secret could not be prepared", { error: error.message });
  }
}

async function main() {
  await prepareSecret();
  if (config.output) {
    await ensureLink().catch((error) => {
      log("warn", "output link could not be prepared", { error: error.message });
    });
  }
  await syncContainerManager().catch((error) => {
    log("warn", "container manager state could not be synced", { error: error.message });
  });
  controlServer = await listenWithRetry(startControl, config.controlPort, 20_000);
  // The app is only reachable through DSM's own nginx, on DSM's ports; the bridge opens no
  // public listener of its own.
  log("info", "serving through DSM nginx", {
    framework: config.frameworkVersion || "unknown",
    control: `127.0.0.1:${config.controlPort}`,
    target: `127.0.0.1:${config.internalPort}`,
  });

  if (configFile) {
    await configFile.resume();
  }

  if (updates) {
    await updates.start();
  }

  if (config.imageStateFile) {
    // Give Container Manager a minute to finish starting both containers after an upgrade.
    setTimeout(() => {
      pruneSuperseded({
        stateFile: config.imageStateFile,
        containers: [config.container, `${config.container}-bridge`],
        inspect: inspectContainer,
        remove: (id) => docker.removeImage(id),
        log,
      }).catch((error) => log("warn", "image cleanup failed", { error: error.message }));
    }, 60_000).unref();
  }

  const shutdown = () => {
    log("info", "shutting down");
    controlServer?.close();
    proxy.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  log("error", "bridge failed to start", { error: error.message });
  process.exit(1);
});
