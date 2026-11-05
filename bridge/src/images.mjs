import fs from "node:fs/promises";

/**
 * Package upgrades preload new images under the same tags, which leaves the previous images
 * dangling. Remember which image ids this package's containers ran and, on the next start,
 * remove the ones that were replaced. Only ids recorded here are touched, and removal is never
 * forced, so images used by any container stay.
 */
export async function pruneSuperseded({ stateFile, containers, inspect, remove, log }) {
  let previous = [];
  try {
    previous = JSON.parse(await fs.readFile(stateFile, "utf8")).images || [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      log("warn", "image state could not be read", { error: error.message });
    }
  }
  const current = [];
  for (const name of containers) {
    try {
      const container = await inspect(name);
      if (container?.imageId) current.push(container.imageId);
    } catch {
      // not created yet: keep the previous ids so they are retried next time
    }
  }
  if (current.length < containers.length) {
    return { removed: [], kept: previous };
  }
  const removed = [];
  const kept = [];
  for (const id of previous) {
    if (current.includes(id)) continue;
    if (await remove(id)) {
      removed.push(id);
    } else {
      kept.push(id);
    }
  }
  const next = [...new Set([...current, ...kept])];
  await fs.writeFile(stateFile, JSON.stringify({ images: next }) + "\n", { mode: 0o600 });
  if (removed.length) {
    log("info", "removed images replaced by an upgrade", { removed });
  }
  return { removed, kept };
}
