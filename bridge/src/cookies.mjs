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
