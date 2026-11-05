// Installs or upgrades SPKs in the guest the way Package Center does, and waits for the package's
// containers. Usage: node install.mjs <file.spk>...
import { guest, logger, packageInfo, upload } from './lib.mjs';

const log = logger();
for (const spk of process.argv.slice(2)) {
  const info = packageInfo(spk);
  const remote = `/volume1/@tmp/e2e-${info.id}.spk`;
  log(`${info.id} ${info.version}: uploading`);
  upload(spk, remote);
  const result = guest(`synopkg install ${remote} 2>&1 | grep -o '"success":[a-z]*' | head -1; rm -f ${remote}`,
    1_800_000).trim();
  if (result !== '"success":true') throw new Error(`${info.id}: install failed: ${result}`);
  guest(`synopkg start ${info.id} >/dev/null 2>&1; true`, 600_000);
  for (let i = 0; i < 60; i++) {
    const running = guest(`docker ps --format '{{.Names}}' | grep -cx -e '${info.id}' -e '${info.id}-bridge' || true`).trim();
    if (running === '2') break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const installed = guest(`grep ^version= /var/packages/${info.id}/INFO`).trim();
  log(`${info.id}: installed ${installed}, ${guest(`docker ps --format '{{.Names}} {{.Status}}' | grep '^${info.id}' | tr '\\n' ';'`).trim()}`);
}
