/**
 * The app runs at / behind a package prefix on DSM's own origin. A cookie it sets on Path=/
 * would land on every DSM page and could replace DSM's own cookies of the same name, so move
 * absolute cookie paths under the prefix. Cookies without a Path already default to the
 * request's directory, which lies under the prefix.
 */
export function scopeCookie(setCookie, prefix) {
  if (!prefix) {
    return setCookie;
  }
  return String(setCookie).replace(/(;\s*path\s*=\s*)([^;]*)/i, (match, attribute, value) => {
    const path = value.trim();
    if (!path.startsWith("/") || path === prefix || path.startsWith(`${prefix}/`)) {
      return match;
    }
    return `${attribute}${prefix}${path}`;
  });
}

export function scopeCookies(headers, prefix) {
  const value = headers["set-cookie"];
  if (!value || !prefix) {
    return;
  }
  headers["set-cookie"] = Array.isArray(value)
    ? value.map((cookie) => scopeCookie(cookie, prefix))
    : scopeCookie(value, prefix);
}

/**
 * DSM's own sign-in cookies. Browsers send cookies to every port of a host, so an app on ports
 * of its own receives them too and could replace them. The app needs none of them: they are
 * removed from what it receives, and cookies it sets under these names are dropped.
 */
const DSM_COOKIES = new Set(["id", "did", "smid", "_SSID", "stay_login", "_CrPoSt", "io"]);

function cookieName(part) {
  return String(part).split("=", 1)[0].trim();
}

export function withoutDsmCookies(header) {
  if (!header) {
    return header;
  }
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !DSM_COOKIES.has(cookieName(part)))
    .join("; ");
}

/** Removes Set-Cookie headers for DSM's cookie names; returns the names that were dropped. */
export function dropDsmCookies(headers) {
  const value = headers["set-cookie"];
  if (!value) {
    return [];
  }
  const cookies = Array.isArray(value) ? value : [value];
  const kept = cookies.filter((cookie) => !DSM_COOKIES.has(cookieName(cookie)));
  if (kept.length === cookies.length) {
    return [];
  }
  if (kept.length) {
    headers["set-cookie"] = kept;
  } else {
    delete headers["set-cookie"];
  }
  return cookies.filter((cookie) => DSM_COOKIES.has(cookieName(cookie))).map(cookieName);
}
