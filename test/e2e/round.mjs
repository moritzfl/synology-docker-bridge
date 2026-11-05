// One full verification round: install every SPK, run the window test for each, the rights test
// (first package, next to the second) over HTTPS and HTTP, and the Login Portal test.
// Usage: node round.mjs <first.spk> [<second.spk>...]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HTTP, HTTPS, guest, logger, packageInfo } from './lib.mjs';

const spks = process.argv.slice(2);
if (spks.length === 0) {
  console.error('usage: node round.mjs <file.spk>...');
  process.exit(2);
}
const log = logger();
const packages = spks.map(packageInfo);
const results = [];

function run(label, script, args, env = {}) {
  log(`=== ${label}`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
  results.push([label, result.status === 0]);
}

run('install', 'install.mjs', spks);
log(`listeners: ${guest("netstat -ltnp 2>/dev/null | grep node | awk '{print $4}' | tr '\\n' ' '").trim()}`);
for (const pkg of packages) {
  run(`window ${pkg.id}`, 'window.mjs', [pkg.id, pkg.app]);
}
const [first, second] = packages;
const pair = second ? [second.id, second.app] : [];
run(`rights ${first.id} (HTTPS)`, 'rights.mjs', [first.id, first.app, ...pair], { DSM_URL: HTTPS });
run(`rights ${first.id} (HTTP)`, 'rights.mjs', [first.id, first.app], { DSM_URL: HTTP });
for (const pkg of packages) {
  run(`portal ${pkg.id}`, 'portal.mjs', [pkg.id]);
}

log('=== summary');
for (const [label, ok] of results) log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
