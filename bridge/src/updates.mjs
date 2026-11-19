import { readPrivateFile, writePrivateFile } from "./private-file.mjs";

/**
 * Newer versions of the app's image in the registry it is published to. Once a day the bridge
 * lists the image's tags anonymously, as `docker pull` would, and keeps the newest release tag
 * above the version the package carries. Publishers ship a new package with each image, so the
 * window points administrators to that package.
 */

const RELEASE = /^v?(\d+(?:\.\d+){0,3})$/;

/** Registry, repository and tag of an image reference such as ghcr.io/org/app:1.2. */
export function parseImage(reference) {
  const value = String(reference || "").split("@")[0];
  const slash = value.indexOf("/");
  const first = slash > 0 ? value.slice(0, slash) : "";
  const hasRegistry = /[.:]/.test(first) || first === "localhost";
  const registry = hasRegistry ? first : "registry-1.docker.io";
  let path = hasRegistry ? value.slice(slash + 1) : value;
  const colon = path.lastIndexOf(":");
  const tag = colon > path.lastIndexOf("/") ? path.slice(colon + 1) : "";
  if (colon > path.lastIndexOf("/")) path = path.slice(0, colon);
  if (!hasRegistry && !path.includes("/")) path = `library/${path}`;
  return { registry, repository: path, tag };
}

/** The numbers of a release tag (4.1.22, v2.0), or null for anything else (latest, 5.0.0a3). */
export function parseVersion(tag) {
  const match = RELEASE.exec(String(tag || ""));
  return match ? match[1].split(".").map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

/** The newest release tag above `current`, preferring the most specific of equal ones. */
export function newest(tags, current) {
  const base = parseVersion(current);
  if (!base) return null;
  let best = null;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (!version || compare(version, base) <= 0) continue;
    const order = best ? compare(version, best.version) : 1;
    if (order > 0 || (order === 0 && version.length > best.version.length)) {
      best = { tag, version };
    }
  }
  return best ? best.tag.replace(/^v/, "") : null;
}

/** Fields of a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge. */
export function parseChallenge(header) {
  const fields = {};
  for (const match of String(header || "").matchAll(/(\w+)="([^"]*)"/g))
    fields[match[1]] = match[2];
  return /^bearer\s/i.test(String(header || "")) ? fields : null;
}

function registryPage(value, origin) {
  const url = new URL(value, origin);
  if (url.protocol !== "https:" || url.origin !== origin) {
    throw new Error("registry returned a tag page outside its origin");
  }
  return url;
}

/** All tags of the image, through the registry's anonymous pull token where it wants one. */
export async function listTags(image, fetchImpl = fetch) {
  const { registry, repository } = parseImage(image);
  const origin = `https://${registry}`;
  let url = `${origin}/v2/${repository}/tags/list?n=1000`;
  let token = "";
  const tags = [];
  const get = (target, headers) =>
    fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(20_000), headers });
  for (let page = 0; url && page < 20; page++) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let response = await get(url, headers);
    if (response.status === 401 && !token) {
      const challenge = parseChallenge(response.headers.get("www-authenticate"));
      if (!challenge?.realm) throw new Error(`registry wants credentials (${response.status})`);
      const auth = new URL(challenge.realm);
      if (
        auth.origin !== origin &&
        !(origin === "https://registry-1.docker.io" && auth.origin === "https://auth.docker.io")
      ) {
        throw new Error("registry returned an untrusted token endpoint");
      }
      if (challenge.service) auth.searchParams.set("service", challenge.service);
      auth.searchParams.set("scope", challenge.scope || `repository:${repository}:pull`);
      const granted = await get(auth);
      if (!granted.ok) throw new Error(`registry token: HTTP ${granted.status}`);
      const body = await granted.json();
      token = body.token || body.access_token || "";
      if (!token) throw new Error("registry token: none given");
      response = await get(url, { Authorization: `Bearer ${token}` });
    }
    if (!response.ok) throw new Error(`registry tags: HTTP ${response.status}`);
    const body = await response.json();
    tags.push(...(Array.isArray(body.tags) ? body.tags.map(String) : []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") || "");
    url = next ? registryPage(next[1], origin).href : "";
  }
  return tags;
}

export function createUpdates({
  image,
  current,
  url = "",
  stateFile = "",
  fetchImpl = fetch,
  log = () => {},
  everyMs = 24 * 60 * 60 * 1000,
  retryMs = 60 * 60 * 1000,
  firstMs = 60 * 1000,
}) {
  let state = { current, latest: null, checkedAt: 0, skipped: "" };
  let timer = null;

  async function load() {
    if (!stateFile) return;
    try {
      const saved = JSON.parse(readPrivateFile(stateFile));
      state = { ...state, ...saved, current };
      // The package was updated since: what was newer may not be any more.
      if (saved.current !== current) state.latest = newest([saved.latest || ""], current);
    } catch {
      // first start, or an unreadable file: check soon
    }
  }

  async function save() {
    if (!stateFile) return;
    writePrivateFile(stateFile, JSON.stringify(state));
  }

  async function check() {
    try {
      const latest = newest(await listTags(image, fetchImpl), current);
      state = { ...state, latest, checkedAt: Date.now(), error: "" };
      if (latest) log("info", "a newer version is available", { current, latest });
      await save();
      return everyMs;
    } catch (error) {
      state = { ...state, error: error.message };
      log("warn", "update check failed", { error: error.message });
      return retryMs;
    }
  }

  function schedule(delay) {
    timer = setTimeout(async () => schedule(await check()), delay);
    timer.unref?.();
  }

  return {
    async start() {
      await load();
      const due = state.checkedAt + everyMs - Date.now();
      schedule(Math.max(firstMs, Math.min(due, everyMs)));
    },
    stop() {
      clearTimeout(timer);
    },
    check,
    /** What the window and DSM's notification show; latest only when newer. */
    status() {
      return {
        current,
        latest: state.latest,
        url,
        skipped: Boolean(state.latest) && state.skipped === state.latest,
        checkedAt: state.checkedAt,
      };
    },
    /** An administrator does not want to hear about this version again. */
    async skip(version) {
      if (version && version === state.latest) {
        state = { ...state, skipped: version };
        await save();
      }
      return this.status();
    },
  };
}
