// Paths without sign-in (publicPaths): from outside the NAS, on DSM's HTTP and HTTPS ports and
// without a DSM session, an allowed path reaches the app and everything else is the bridge's
// "Not found". Usage: node public.mjs <package-id> <allowed app path, e.g. /media/x>
import { HTTP, HTTPS, logger } from './lib.mjs';

const [id, allowed] = process.argv.slice(2);
if (!id || !allowed) {
  console.error('usage: node public.mjs <package-id> <allowed app path>');
  process.exit(2);
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const log = logger();
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const BRIDGE_404 = 'Not found\n';

async function get(base, path, headers = {}) {
  const response = await fetch(`${base}/webman/3rdparty/${id}/public${path}`, { headers, redirect: 'manual' });
  return { status: response.status, body: await response.text() };
}

for (const base of [HTTP, HTTPS]) {
  const scheme = base.startsWith('https') ? 'HTTPS' : 'HTTP';
  const app = await get(base, allowed);
  check(`${scheme}: ${allowed} reaches the app without signing in`, app.body !== BRIDGE_404 && app.status !== 401,
    `HTTP ${app.status}`);
  for (const path of ['/', '/login', `${allowed}/../../`, `${allowed.replace(/\/[^/]*$/, '')}/%2e%2e/login`,
    `${allowed.replace(/\/[^/]*$/, '')}/..%2flogin`]) {
    const other = await get(base, path);
    check(`${scheme}: ${path} is not found`, other.status === 404 && other.body === BRIDGE_404,
      `HTTP ${other.status}`);
  }
}
log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
