// Who may open a package, and what the app learns about them. Uses a second, non-admin DSM user.
// Usage: node rights.mjs <package-id> <DSM app class> [<other package-id> <other app class>]
//   - two packages open side by side keep their own sessions (cookie paths)
//   - no privilege: permission message and no session, also by URL
//   - privilege granted (through DSM's own API): the app opens; identity headers name the user and
//     a header the browser forges does not get through (packages with identityHeaders and /whoami)
//   - privilege revoked: the next open is refused and the open window's re-check closes the app
//   - German: a user whose DSM follows a German browser sees the window in German
import { chromium } from '@playwright/test';
import { HTTPS, OUTPUT, appFrame, guest, launch, logger, signIn, waitForApp, wrapperFrame, wrapperText } from './lib.mjs';

const [id, app, otherId, otherApp] = process.argv.slice(2);
if (!id || !app) {
  console.error('usage: node rights.mjs <package-id> <SYNO.SDS.X.Instance> [<other-id> <other class>]');
  process.exit(2);
}
const base = process.env.DSM_URL || HTTPS;
const tester = { username: 'bridge-e2e-user', password: 'Bridge-e2e-Pass1!' };
const log = logger();
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

guest(`synouser --get ${tester.username} >/dev/null 2>&1 || synouser --add ${tester.username} '${tester.password}' '' 0 '' 0 >/dev/null`);
// Rules go through DSM's own API: writing DSM's privilege database directly races DSM's lock.
function setRule(allowed) {
  const rules = JSON.stringify([{ entity_type: 'user', entity_name: tester.username, app_id: app,
    allow_ip: ['0.0.0.0'], deny_ip: [] }]);
  guest(`synowebapi -s --exec api=SYNO.Core.AppPriv.Rule method=${allowed ? 'set' : 'delete'} version=1 rules='${rules}' >/dev/null`);
}

const browser = await chromium.launch();
try {
  // Two packages side by side keep their own sessions.
  if (otherId) {
    const { context, page } = await signIn(browser, base);
    await launch(page, app);
    await waitForApp(page, id, log, id);
    await launch(page, otherApp);
    await waitForApp(page, otherId, log, otherId);
    const cookies = (await context.cookies()).filter((cookie) => cookie.name === 'dsm_bridge_session');
    check('each package has its own session cookie',
      [id, otherId].every((pkg) => cookies.some((cookie) => cookie.path === `/webman/3rdparty/${pkg}/proxy/`))
        && !cookies.some((cookie) => cookie.path === '/'), cookies.map((cookie) => cookie.path).join(', '));
    for (let round = 0; round < 3; round++) {
      for (const pkg of [id, otherId]) {
        await appFrame(page, pkg).evaluate(() => location.reload());
        await page.waitForTimeout(2500);
      }
    }
    for (const pkg of [id, otherId]) {
      check(`${pkg} still open after alternating reloads`, (await wrapperText(page, pkg)) === 'APP SHOWN');
    }
    await context.close();
  }

  // A user without the privilege, opening the wrapper by URL.
  setRule(false);
  const user = await signIn(browser, base, tester);
  const token = await user.page.evaluate(() => _S('SynoToken'));
  async function open() {
    const page = await user.context.newPage();
    await page.goto(`${base}/webman/3rdparty/${id}/app.html?SynoToken=${encodeURIComponent(token)}`);
    let text = '';
    for (let i = 0; i < 90; i++) {
      text = await page.evaluate(() => {
        const state = document.getElementById('state');
        return state.style.display !== 'none' ? state.innerText.replace(/\s+/g, ' ').trim() : 'APP SHOWN';
      });
      if (!/Opening|Connecting|Starting/.test(text)) break;
      await page.waitForTimeout(1000);
    }
    return { page, text };
  }
  let view = await open();
  const session = await view.page.evaluate((t) => fetch(`session.cgi?SynoToken=${t}`,
    { headers: { 'X-SynoToken': t } }).then((response) => response.text()), token);
  check('without the privilege: permission message', /do not have permission/.test(view.text), view.text.slice(0, 90));
  check('without the privilege: no session token', /"denied"/.test(session) && !/token"/.test(session));
  await view.page.close();

  // Granted: the app opens and learns who is signed in.
  setRule(true);
  view = await open();
  check('with the privilege: the app opens', view.text === 'APP SHOWN', view.text.slice(0, 90));
  const proxy = `/webman/3rdparty/${id}/proxy/whoami`;
  const whoami = await view.page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { 'Remote-User': 'admin', 'Remote-Groups': 'administrators' } });
    return response.ok ? response.text() : `HTTP ${response.status}`;
  }, proxy);
  if (/^user=/.test(whoami)) {
    check('identity headers name the signed-in user', whoami.startsWith(`user=${tester.username} `), whoami.trim());
    check('a forged identity header does not get through', !/administrators/.test(whoami), whoami.trim());
  } else {
    log(`identity: ${proxy} not available (${whoami.trim()}), skipped`);
  }

  // Revoked: the next open is refused, and the open window's background re-check closes the app.
  setRule(false);
  const refused = await open();
  check('revoked: the next open is refused', /do not have permission/.test(refused.text));
  await refused.page.close();
  // The wrapper re-checks every 10 minutes; run that check now instead of waiting.
  const closed = await view.page.evaluate(async (t) => {
    const response = await fetch(`session.cgi?SynoToken=${t}`, { headers: { 'X-SynoToken': t } });
    const data = await response.json();
    const app = await fetch(`proxy/`, { cache: 'no-store' });
    return { session: data.error || 'token', app: app.status };
  }, token);
  check('revoked: the denied re-check ends the open session', closed.session === 'denied' && closed.app === 401,
    JSON.stringify(closed));
  await view.page.close();
  await user.context.close();
} finally {
  setRule(false);
}

// German: DSM follows the browser's language unless the user picked one.
{
  const { page } = await signIn(browser, base, undefined, { locale: 'de-DE' });
  await launch(page, app);
  await waitForApp(page, id, log, 'german');
  const toolbar = await page.locator('.x-window').filter({ has: page.locator(`iframe[src*="/${id}/app.html"]`) })
    .first().locator('.x-toolbar').first().innerText().catch(() => '');
  check('German toolbar', /Verwalten|Auf Smartphones öffnen/.test(toolbar), toolbar.trim());
  guest(`docker stop ${id} >/dev/null`);
  await wrapperFrame(page, id).evaluate(() => location.reload());
  let text = '';
  for (let i = 0; i < 60 && !/läuft nicht/.test(text); i++) {
    text = await wrapperText(page, id);
    await page.waitForTimeout(1000);
  }
  check('German window messages', /läuft nicht/.test(text), text);
  await page.screenshot({ path: `${OUTPUT}${id}-german.png` });
  await wrapperFrame(page, id).getByRole('button', { name: /starten$/ }).click();
  await waitForApp(page, id, log, 'german start');
}

await browser.close();
log(failed ? `rights: ${failed} check(s) failed` : 'rights: all checks passed');
process.exit(failed ? 1 : 0);
