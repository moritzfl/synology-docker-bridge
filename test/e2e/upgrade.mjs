// On a disposable Virtual DSM, verify a package upgrade preserves its bridge config and data share.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { guest, packageInfo } from "./lib.mjs";

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error("usage: node upgrade.mjs <old-demo.spk> <new-demo.spk>");
  process.exit(2);
}
const oldPackage = packageInfo(before);
const newPackage = packageInfo(after);
assert.equal(oldPackage.id, "dsm-nginx-demo");
assert.equal(newPackage.id, oldPackage.id);
assert.notEqual(newPackage.version, oldPackage.version, "use two distinct versions");
const install = (spk) =>
  execFileSync(process.execPath, [fileURLToPath(new URL("./install.mjs", import.meta.url)), spk], {
    stdio: "inherit",
  });
const root = `/var/packages/${oldPackage.id}`;
const share = `${root}/shares/${oldPackage.id}`;
const marker = `${share}/bridge-upgrade-${randomUUID()}`;
const config = () =>
  guest(`grep -E '^APP_(DATA_DIR|INTERNAL_PORT|CONTAINER_PORT|OUTPUT_)' '${root}/var/app.env'`)
    .trim()
    .split("\n")
    .sort();

install(before);
const expected = config();
assert.ok(expected.some((line) => line.startsWith("APP_DATA_DIR=")));
guest(`printf '%s\\n' 'bridge upgrade keep me' > '${marker}'`);
try {
  install(after);
  assert.deepEqual(config(), expected);
  assert.equal(guest(`cat '${marker}'`).trim(), "bridge upgrade keep me");
  console.log(
    `${oldPackage.version} → ${newPackage.version}: bridge config and data share preserved`,
  );
} finally {
  guest(`rm -f '${marker}'`);
}
