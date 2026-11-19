import http from "node:http";

/**
 * Minimal Docker Engine API client over the local socket.
 *
 * The bridge only needs to inspect, start, stop and restart the app's existing container and to
 * remove images it replaced. Talking to the Engine directly means the image carries no Docker
 * CLI or Compose plugin (about 63 MB), and it never touches the Compose project that Container
 * Manager owns: containers are controlled by name, exactly like `docker compose start/stop/
 * restart` does for an existing service, so DSM's project state and config hash stay untouched.
 */
export class DockerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Output of a container without a TTY: frames of an 8-byte header (stream, three zero bytes,
 * big-endian length) and the payload. Returns the payloads joined, stdout and stderr in order.
 */
export function demux(buffer) {
  const parts = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return Buffer.concat(parts).toString("utf8");
}

export function createDocker({ socketPath = "/var/run/docker.sock", timeoutMs = 60_000 } = {}) {
  function request(method, path, { timeout = timeoutMs, body, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method,
          path,
          headers: { Host: "docker", "Content-Type": "application/json" },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            if (raw) {
              resolve({ status: response.statusCode, body: Buffer.concat(chunks) });
              return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            let body = null;
            if (text) {
              try {
                body = JSON.parse(text);
              } catch {
                body = { message: text.trim() };
              }
            }
            resolve({ status: response.statusCode, body });
          });
          response.on("error", reject);
        },
      );
      req.setTimeout(timeout, () => {
        req.destroy(new DockerError(504, `docker ${method} ${path} timed out`));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  function fail(response, what) {
    const detail = response.body?.message || `HTTP ${response.status}`;
    return new DockerError(response.status, `${what}: ${detail}`);
  }

  const name = (value) => encodeURIComponent(value);

  return {
    /** Container details, or null when it does not exist. */
    async inspect(container) {
      const response = await request("GET", `/containers/${name(container)}/json`, {
        timeout: 15_000,
      });
      if (response.status === 404) return null;
      if (response.status !== 200) throw fail(response, `inspect ${container}`);
      return summarize(response.body);
    },

    async processUser(container, pid) {
      const result = await request(
        "GET",
        `/containers/${name(container)}/top?ps_args=-o%20pid%2Cuid%2Cgid`,
        { timeout: 15_000 },
      );
      if (result.status !== 200) throw fail(result, `top ${container}`);
      const row = result.body.Processes?.find(([id]) => id === String(pid));
      if (!row || !/^\d+$/.test(row[1]) || !/^\d+$/.test(row[2]) || Number(row[1]) === 0)
        return null;
      return { uid: Number(row[1]), gid: Number(row[2]) };
    },

    /** Starts a container; already running counts as success. */
    async start(container) {
      const response = await request("POST", `/containers/${name(container)}/start`);
      if (response.status !== 204 && response.status !== 304) {
        throw fail(response, `start ${container}`);
      }
    },

    /** Stops a container, giving it {@code seconds} to shut down; already stopped is fine. */
    async stop(container, seconds = 30) {
      const response = await request("POST", `/containers/${name(container)}/stop?t=${seconds}`, {
        timeout: (seconds + 30) * 1000,
      });
      if (response.status !== 204 && response.status !== 304) {
        throw fail(response, `stop ${container}`);
      }
    },

    /** Restarts a container; a stopped one is simply started. */
    async restart(container, seconds = 30) {
      const response = await request(
        "POST",
        `/containers/${name(container)}/restart?t=${seconds}`,
        { timeout: (seconds + 60) * 1000 },
      );
      if (response.status !== 204) throw fail(response, `restart ${container}`);
    },

    /** The container's last log lines, stdout and stderr together, since a Unix time. */
    async logs(container, { since = 0, tail = 60 } = {}) {
      const response = await request(
        "GET",
        `/containers/${name(container)}/logs?stdout=1&stderr=1&since=${since}&tail=${tail}`,
        { timeout: 15_000, raw: true },
      );
      if (response.status !== 200) return "";
      return demux(response.body);
    },

    /** Runs a command in the running container and returns its exit code and output. */
    async exec(container, command, { timeout = 60_000 } = {}) {
      const created = await request("POST", `/containers/${name(container)}/exec`, {
        timeout: 15_000,
        body: { Cmd: command, AttachStdout: true, AttachStderr: true, Tty: false },
      });
      if (created.status !== 201) throw fail(created, `exec in ${container}`);
      const id = created.body.Id;
      const started = await request("POST", `/exec/${name(id)}/start`, {
        timeout,
        raw: true,
        body: { Detach: false, Tty: false },
      });
      if (started.status !== 200) {
        throw new DockerError(started.status, `exec in ${container}: HTTP ${started.status}`);
      }
      const inspected = await request("GET", `/exec/${name(id)}/json`, { timeout: 15_000 });
      return { exitCode: inspected.body?.ExitCode ?? -1, output: demux(started.body) };
    },

    /**
     * Removes an image by id unless a container still uses it. Never forced: an image another
     * package or container runs stays put.
     */
    async removeImage(id) {
      const response = await request("DELETE", `/images/${name(id)}?noprune=false`);
      return response.status === 200;
    },
  };
}

function summarize(item) {
  return {
    id: item.Id,
    name: String(item.Name || "").replace(/^\//, ""),
    image: item.Config?.Image || "",
    pid: item.State?.Pid || 0,
    user: item.Config?.User || "",
    imageId: item.Image || "",
    labels: item.Config?.Labels || {},
    state: item.State?.Status || "unknown",
    health: item.State?.Health?.Status || "",
    startedAt: item.State?.StartedAt || "",
    ports: item.NetworkSettings?.Ports || {},
    env: item.Config?.Env || [],
    mounts: (item.Mounts || []).map((mount) => ({
      source: mount.Source,
      destination: mount.Destination,
      type: mount.Type,
    })),
  };
}
