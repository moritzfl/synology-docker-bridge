/**
 * The request target as a URL, or null when it is malformed. Node's HTTP parser accepts more
 * request-target forms than `new URL` does, so a local client could otherwise end the process with
 * an absolute-form target such as `http://[::1`.
 */
export function requestUrl(value) {
  try {
    return new URL(value || "/", "http://localhost");
  } catch {
    return null;
  }
}
