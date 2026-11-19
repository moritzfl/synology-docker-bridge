/**
 * The app is embedded in a DSM window. DSM has to be allowed to frame it, but nothing else
 * should. Keep the app's own CSP and replace only its framing rule.
 */
export function frameAncestors(config, host) {
  if (!config.ownOrigin) {
    return "'self'";
  }
  const name = String(host || "").replace(/:\d+$/, "");
  const safe = /^(\[[0-9A-Fa-f:.]+]|[A-Za-z0-9.-]+)$/.test(name) ? name : "nas";
  return `'self' http://${safe}:${config.dsmHttpPort} https://${safe}:${config.dsmHttpsPort}`;
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
