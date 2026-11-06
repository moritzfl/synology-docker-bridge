/**
 * Paths of the app that other devices on the network fetch without a DSM session: a speaker
 * downloading audio, an OAuth provider returning a browser. They are listed in the package
 * config; everything else on the public prefix is not found. The path is normalized first, so
 * dot segments, backslashes and their encoded forms cannot step out of an allowed prefix.
 */
export function parsePublicPaths(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("/"));
}

/** The app path and query for an allowed request, or null. `url` has the public prefix removed. */
export function publicTarget(url, allowed) {
  let parsed;
  try {
    parsed = new URL(url, "http://bridge");
  } catch {
    return null;
  }
  const pathname = parsed.pathname;
  if (/%2f|%5c|%00/i.test(pathname)) return null;
  const permitted = allowed.some((prefix) => prefix.endsWith("/")
    ? pathname.startsWith(prefix) && pathname.length > prefix.length
    : pathname === prefix);
  return permitted ? pathname + parsed.search : null;
}
