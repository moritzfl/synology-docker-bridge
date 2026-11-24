const imageId = /^(?:sha256:[a-f0-9]{64}|sha384:[a-f0-9]{96}|sha512:[a-f0-9]{128}|[a-f0-9]{64})$/i;

/** Use a tag that survives offline docker load, never an image ID or registry digest. */
export function taggedImage(value, field) {
  if (typeof value === "string" && (value.includes("@") || imageId.test(value))) {
    throw new Error(
      `${field} must use a local image tag (e.g. my-app:spk), not a digest or image ID; tag the image first`,
    );
  }
  if (typeof value !== "string" || !/^[a-z0-9]/i.test(value) || /[^a-z0-9._/:-]/i.test(value)) {
    throw new Error(`${field} must be an image reference`);
  }
  const colon = value.lastIndexOf(":");
  if (colon <= value.lastIndexOf("/")) return `${value}:latest`;
  if (!/^\w[\w.-]{0,127}$/.test(value.slice(colon + 1))) {
    throw new Error(`${field} must have a valid image tag`);
  }
  return value;
}

/** Normalize Docker Hub aliases for comparison with docker save's familiar tags. */
export function canonicalImageTag(value) {
  const slash = value.indexOf("/");
  if (slash < 0) return `docker.io/library/${value}`;
  const first = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  if (first === "docker.io" || first === "index.docker.io") {
    return rest.includes("/") ? `docker.io/${rest}` : `docker.io/library/${rest}`;
  }
  if (first === "localhost" || /[.:]/.test(first) || first !== first.toLowerCase()) {
    return value;
  }
  return `docker.io/${value}`;
}
