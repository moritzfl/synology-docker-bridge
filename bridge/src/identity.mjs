/**
 * Headers that tell the app who is signed in, the convention of Authelia, Authentik and
 * oauth2-proxy. Whatever a browser sends under these names is removed on every request, so the
 * app can trust them when the bridge sets them.
 */
const NAMES = ["remote-user", "remote-groups", "remote-name", "remote-email"];

export function applyIdentity(headers, identity, enabled) {
  for (const name of Object.keys(headers)) {
    if (NAMES.includes(name.toLowerCase())) {
      delete headers[name];
    }
  }
  if (!enabled || !identity || !identity.user) {
    return;
  }
  headers["remote-user"] = identity.user;
  headers["remote-groups"] = (identity.groups || []).join(",");
}
