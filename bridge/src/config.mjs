import fs from "node:fs";

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Where the output share really is, e.g. /volume2/music. DSM links each of a package's shares
 * under /var/packages/<id>/shares; the link's target names the volume.
 */
export function shareRoot(link, readlink = fs.readlinkSync) {
  if (!link) {
    return "";
  }
  try {
    const target = readlink(link);
    return /^\/volume[^/]*\/[^/]+$/.test(target) ? target.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

export function loadConfig(env = process.env) {
  const tokenFile = env.BRIDGE_TOKEN_FILE || "/run/bridge/token";
  const token = env.BRIDGE_TOKEN
    || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");
  return {
    token,
    tokenFile,
    controlPort: integer(env.BRIDGE_CONTROL_PORT, 8799),
    dockerSocket: env.BRIDGE_DOCKER_SOCKET || "/var/run/docker.sock",
    container: env.BRIDGE_CONTAINER || env.BRIDGE_SERVICE || "app",
    envFile: env.BRIDGE_ENV_FILE || "/compose/.env",
    stateEnvFile: env.BRIDGE_STATE_ENV || "",
    outputKey: env.BRIDGE_OUTPUT_KEY || "APP_OUTPUT_DIR",
    outputContainerKey: env.BRIDGE_OUTPUT_CONTAINER_KEY || "APP_OUTPUT_CONTAINER_DIR",
    outputContainerRoot: env.BRIDGE_OUTPUT_CONTAINER_ROOT || "/output-parent",
    outputLink: env.BRIDGE_OUTPUT_LINK || ".bridge-current",
    containerManagerDir: env.BRIDGE_CONTAINER_MANAGER_DIR || "",
    imageStateFile: env.BRIDGE_IMAGE_STATE || "",
    internalPort: integer(env.BRIDGE_INTERNAL_PORT, 8080),
    allowedRoot: shareRoot(env.BRIDGE_SHARE_LINK) || env.BRIDGE_ALLOWED_ROOT || "/volume1",
    outputSubdir: env.BRIDGE_OUTPUT_SUBDIR || "",
    hostRoot: env.BRIDGE_HOST_ROOT || "/host/volume1",
    defaultOutputDir: env.BRIDGE_DEFAULT_OUTPUT_DIR || "/volume1/music",
    appTitle: env.BRIDGE_APP_TITLE || "Docker app",
    appPath: env.BRIDGE_APP_PATH || "/",
    authMode: env.BRIDGE_AUTH || "token",
    output: env.BRIDGE_OUTPUT !== "false",
    oneTimeSeconds: integer(env.BRIDGE_ONE_TIME_SECONDS, 60),
    sessionSeconds: integer(env.BRIDGE_SESSION_SECONDS, 28800),
    verifySeconds: integer(env.BRIDGE_VERIFY_SECONDS, 1800),
    identityHeaders: env.BRIDGE_IDENTITY_HEADERS === "true",
    frameworkVersion: env.BRIDGE_FRAMEWORK_VERSION || "",
    // The app's data folder as the bridge sees it, and DSM's links to the package's shares.
    dataDir: env.BRIDGE_DATA_DIR || "",
    sharesDir: env.BRIDGE_SHARES_DIR || "",
  };
}
