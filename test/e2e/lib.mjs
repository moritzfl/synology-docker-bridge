// Shared helpers for the Virtual DSM tests: guest shell, uploads, package metadata, DSM sign-in
// and reading the package window's state.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (file) => fileURLToPath(new URL(file, import.meta.url));

export const HTTP = process.env.DSM_HTTP || 'http://127.0.0.1:15001';
export const HTTPS = process.env.DSM_HTTPS || 'https://127.0.0.1:15002';
export const PATH = 'export PATH=/usr/syno/bin:/usr/syno/sbin:/usr/local/bin:/usr/bin:/bin:$PATH; ';
export const OUTPUT = here('./output/');
mkdirSync(OUTPUT, { recursive: true });

/** The administrator created by setup.mjs. */
export function credentials() {
  const file = here('./.auth/credentials.json');
  if (!existsSync(file)) throw new Error('no .auth/credentials.json; run node setup.mjs first');
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The running vdsm/virtual-dsm container: E2E_DSM_CONTAINER, else the one Docker reports. */
export function vmContainer() {
  if (process.env.E2E_DSM_CONTAINER) return process.env.E2E_DSM_CONTAINER;
  const names = execFileSync('docker', ['ps', '--filter', 'ancestor=vdsm/virtual-dsm', '--format', '{{.Names}}'],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (names.length === 0) {
    const all = execFileSync('docker', ['ps', '--format', '{{.Names}} {{.Image}}'], { encoding: 'utf8' });
    const match = all.split('\n').find((line) => /virtual-dsm/.test(line));
    if (match) return match.split(' ')[0];
    throw new Error('no Virtual DSM container running; docker compose -f compose.yaml up -d');
  }
  return names[0];
}

function ssh(remoteCommand, options) {
  const { username } = credentials();
  return spawnSync('ssh', [
    '-o', `ProxyCommand=docker exec -i ${vmContainer()} nc 127.0.0.1 22`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${here('./.auth/known_hosts')}`,
    '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR',
    `${username}@localhost`, remoteCommand,
  ], {
    env: { ...process.env, SSH_ASKPASS: here('./askpass.mjs'), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' },
    ...options,
  });
}

/** Runs a shell command as root in the guest and returns its output. */
export function guest(command, timeoutMs = Number(process.env.GUEST_TIMEOUT_MS || 180_000)) {
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const result = ssh(`sudo -S -p '' sh -c ${quote(PATH + command)}`, {
    input: credentials().password + '\n',
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.status !== 0) throw new Error(`guest command failed:\n${result.stdout}\n${result.stderr || result.error}`);
  return result.stdout;
}

/**
 * Copies a file into the guest and checks it arrived whole. Use a path on the volume: /tmp in
 * the guest is a small tmpfs that silently truncates large packages.
 */
export function upload(local, remote) {
  const result = ssh(`cat > '${remote}'`, { stdio: [openSync(local, 'r'), 'inherit', 'inherit'], timeout: 1_800_000 });
  if (result.status !== 0) throw new Error(`upload of ${local} failed`);
  const want = execFileSync('shasum', ['-a', '256', local], { encoding: 'utf8' }).split(' ')[0];
  const got = guest(`sha256sum '${remote}'`).split(' ')[0];
  if (want !== got) throw new Error(`upload of ${local} arrived damaged`);
}

/** Package name, version and DSM app class, read from the SPK's INFO. */
export function packageInfo(spk) {
  const info = execFileSync('tar', ['-xOf', spk, 'INFO'], { encoding: 'utf8' });
  const field = (key) => (new RegExp(`^${key}="([^"]*)"`, 'm').exec(info) || [])[1];
  return {
    id: field('package'),
    version: field('version'),
    name: field('displayname'),
    app: `SYNO.SDS.${field('dsmappname')}.Instance`,
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function logger() {
  const t0 = Date.now();
  return (...args) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...args);
}

/** Signs in on DSM's own page and waits for the desktop. */
export async function signIn(browser, base, user = credentials(), contextOptions = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 950 }, ...contextOptions });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  await page.goto(base);
  await page.locator('input[name="username"]').fill(user.username);
  await page.locator('input[name="username"]').press('Enter');
  const password = page.locator('input[name="current-password"]');
  await password.waitFor({ state: 'visible' });
  await password.fill(user.password);
  await password.press('Enter');
  await page.waitForFunction(() => window.SYNO && SYNO.SDS && SYNO.SDS.AppLaunch && window._S && _S('SynoToken'));
  return { context, page };
}

/** Launches a package window; DSM may still be loading its app list right after sign-in. */
export async function launch(page, app) {
  for (let i = 0; ; i++) {
    try {
      await page.evaluate((name) => SYNO.SDS.AppLaunch(name), app);
      return;
    } catch (error) {
      if (i > 30) throw error;
      await page.waitForTimeout(2000);
    }
  }
}

export const wrapperFrame = (page, id) => page.frames().find((frame) => frame.url().includes(`/3rdparty/${id}/app.html`));
export const appFrame = (page, id) => page.frames().find((frame) => frame.url().includes(`/3rdparty/${id}/proxy/`)
  && !frame.url().includes('__bridge_login'));

/** "APP SHOWN" once the app is visible, else the wrapper's message. */
export async function wrapperText(page, id) {
  const frame = wrapperFrame(page, id);
  if (!frame) return '(no wrapper)';
  return frame.evaluate(() => {
    const state = document.getElementById('state');
    return state && state.style.display !== 'none' ? state.innerText.replace(/\s+/g, ' ').trim() : 'APP SHOWN';
  }).catch(() => '(navigating)');
}

/** Waits until the app itself has rendered something in the window. */
export async function waitForApp(page, id, log, label, seconds = 600) {
  let last = '';
  for (let i = 0; i < seconds; i++) {
    const text = await wrapperText(page, id);
    if (text !== last) {
      log(`${label}: ${text}`);
      last = text;
    }
    const frame = appFrame(page, id);
    if (text === 'APP SHOWN' && frame) {
      const content = await frame.evaluate(() => document.readyState === 'complete'
        && document.body && document.body.innerText.trim().length > 0
        && !/Sign in to open|Melden Sie sich an/.test(document.body.innerText)).catch(() => false);
      if (content) return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label}: the app never appeared`);
}
