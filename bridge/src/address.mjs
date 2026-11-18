/**
 * Where to sign in. Requests arrive through DSM's own nginx, so Host names DSM's address. On the
 * app's own ports it names the same host with another port: DSM opens the app there after
 * sign-in, and its window brings the session along.
 */
export function dsmAddress(host, secure, ownOrigin, ports, appId) {
  const scheme = secure ? "https" : "http";
  if (!ownOrigin) return `${scheme}://${host || "nas"}/`;
  const name = /^(\[[0-9A-Fa-f:.]+]|[A-Za-z0-9.-]+)(?::\d+)?$/.exec(host || "")?.[1] || "nas";
  const port = secure ? ports.https : ports.http;
  return `${scheme}://${name}:${port}/${appId ? `?launchApp=${encodeURIComponent(appId)}` : ""}`;
}
