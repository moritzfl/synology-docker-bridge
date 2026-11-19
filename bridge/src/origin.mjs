/** Methods that may change state and therefore need an Origin check. */
export function unsafeMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "").toUpperCase());
}

/** A browser request the browser itself marks as cross-site. */
export function crossSite(headers) {
  return String(headers["sec-fetch-site"] || "") === "cross-site";
}

/**
 * Origin and Host name the same address. Requests without Origin are not a browser CSRF
 * (command-line clients use the bridge token or a session cookie they already hold).
 */
export function sameOrigin(origin, host, scheme = "https", allowed = []) {
  if (!origin) return true;
  try {
    const expected = new URL(`${scheme}://${host}`).origin;
    return origin === expected || allowed.includes(origin);
  } catch {
    return false;
  }
}
