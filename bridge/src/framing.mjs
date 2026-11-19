const HOST_NAME = /^(\[[0-9A-Fa-f:.]+]|[A-Za-z0-9.-]+)$/;

function hostName(host) {
  return String(host || "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

/**
 * The address of the DSM page that opened the app (window, tab or Login Portal), when it is on
 * the app's own host: DSM's ports, 80/443 behind them, or a Login Portal port. Else "".
 */
export function framingOrigin(value, host) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.href !== `${url.origin}/`) return "";
  const name = hostName(host);
  if (!HOST_NAME.test(name) || url.hostname !== name) return "";
  return url.origin;
}

/**
 * The app is embedded in a DSM window. DSM has to be allowed to frame it, but nothing else
 * should. Keep the app's own CSP and replace only its framing rule. `origin` is the DSM address
 * the session was opened from (see framingOrigin), next to DSM's own ports.
 */
export function frameAncestors(config, host, origin = "") {
  if (!config.ownOrigin) {
    return "'self'";
  }
  const name = hostName(host);
  const safe = HOST_NAME.test(name) ? name : "nas";
  const sources = [
    "'self'",
    `http://${safe}:${config.dsmHttpPort}`,
    `https://${safe}:${config.dsmHttpsPort}`,
  ];
  const opener = framingOrigin(origin, host);
  if (opener && !sources.includes(opener)) sources.push(opener);
  return sources.join(" ");
}

/** Drops X-Frame-Options and replaces every frame-ancestors directive in the CSP headers. */
export function applyFraming(headers, ancestors) {
  delete headers["x-frame-options"];
  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    const value = headers[name];
    if (!value) continue;
    const directives = String(value)
      .split(";")
      .map((directive) => directive.trim())
      .filter((directive) => directive && !directive.toLowerCase().startsWith("frame-ancestors"));
    if (name === "content-security-policy") directives.push(`frame-ancestors ${ancestors}`);
    if (directives.length) headers[name] = directives.join("; ");
    else delete headers[name];
  }
  if (!headers["content-security-policy"]) {
    headers["content-security-policy"] = `frame-ancestors ${ancestors}`;
  }
}
