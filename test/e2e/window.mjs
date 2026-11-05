// Drives one package window in a real DSM desktop as an administrator: open, toolbar, folder
// dialog and move, phone access, a hung app's Restart, silent re-login after the bridge loses its
// sessions, and the stopped state. Usage: node window.mjs <package-id> <DSM app class>
import { chromium } from '@playwright/test';
import { HTTPS, OUTPUT, appFrame, guest, launch, logger, signIn, waitForApp, wrapperFrame, wrapperText } from './lib.mjs';

const [id, app] = process.argv.slice(2);
if (!id || !app) {
  console.error('usage: node window.mjs <package-id> <SYNO.SDS.X.Instance>');
  process.exit(2);
}
const log = logger();
const shot = (name) => `${OUTPUT}${id}-${name}.png`;
const browser = await chromium.launch();
const { page } = await signIn(browser, HTTPS);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

try {
  // 1. open
  await launch(page, app);
  await waitForApp(page, id, log, 'open', 900);
  await page.screenshot({ path: shot('1-open') });
  const status = await wrapperFrame(page, id).evaluate(async () => {
    const token = new URLSearchParams(location.search).get('SynoToken');
    const response = await fetch(`status.cgi?SynoToken=${encodeURIComponent(token)}`, { headers: { 'X-SynoToken': token } });
    return response.json();
  });
  const hasOutput = 'outputDir' in status;
  log(`status: ${status.state}, reachable ${status.reachable}, framework ${status.framework || '?'}, output ${hasOutput}`);

  // 2. window chrome: no help, one admin control
  const win = page.locator('.x-window').filter({ has: page.locator(`iframe[src*="/${id}/app.html"]`) }).first();
  const tools = await win.locator('.x-window-header .x-tool').evaluateAll((els) =>
    els.filter((el) => el.offsetParent).map((el) => el.getAttribute('aria-label') || el.className));
  check('no help button', !tools.some((tool) => /help/i.test(tool)), tools.join(', '));
  const toolbar = (await win.locator('.x-toolbar').first().innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
  check('admin toolbar', hasOutput ? toolbar === 'Manage' : toolbar === 'Open on phones…', toolbar);

  async function menuItem(text) {
    if (hasOutput) {
      await win.locator('.x-toolbar button', { hasText: 'Manage' }).click();
      await page.locator('.x-menu:visible .x-menu-item', { hasText: text }).click();
    } else {
      await win.locator('.x-toolbar button', { hasText: text }).click();
    }
  }

  // 3. the folder: hint, rejection outside the share, move there and back
  if (hasOutput) {
    const parent = status.outputParent;
    const dialogFor = async () => {
      await menuItem('folder…');
      const dialog = page.locator('.x-window:visible').filter({ has: page.locator('button:has-text("Save")') }).last();
      await dialog.waitFor();
      return dialog;
    };
    let dialog = await dialogFor();
    const text = (await dialog.innerText()).replace(/\s+/g, ' ');
    check('folder dialog explains where folders may be', text.includes(`inside ${parent}`), text.slice(0, 160));
    await dialog.locator('input[type="text"]').first().fill('/volume1/elsewhere');
    await dialog.locator('button:has-text("Save")').click();
    await page.waitForTimeout(800);
    const invalid = await dialog.locator('.x-form-invalid, [aria-invalid="true"]').count();
    check('a folder outside the share is rejected in the dialog', invalid > 0 && await dialog.isVisible());
    await page.screenshot({ path: shot('2-folder-invalid') });
    await dialog.locator('button:has-text("Cancel")').click();

    const original = guest(`readlink ${parent}/.${id}-folder`).trim();
    guest(`echo e2e > ${parent}/${original}/marker-e2e.txt`);
    for (const target of [`${original}-moved`, original]) {
      dialog = await dialogFor();
      await dialog.locator('input[type="text"]').first().fill(`${parent}/${target}`);
      await dialog.locator('button:has-text("Save")').click();
      const at = Date.now();
      await dialog.waitFor({ state: 'hidden', timeout: 300_000 });
      await waitForApp(page, id, log, `move to ${target}`);
      const there = guest(`readlink ${parent}/.${id}-folder; ls ${parent}/${target} | grep -c marker-e2e.txt || true`)
        .trim().split('\n');
      check(`moved to ${target}`, there[0] === target && there[1] === '1', `${Math.round((Date.now() - at) / 1000)}s`);
    }
    guest(`rm -f ${parent}/${original}/marker-e2e.txt; rmdir ${parent}/${original}-moved 2>/dev/null; true`);
  }

  // 4. phone access: show the Login Portal address, turning it on when it is off
  await menuItem('Open on phones…');
  const phone = page.locator('.x-window:visible').filter({ hasText: 'Phones and browser tabs' }).last();
  await phone.waitFor();
  await page.waitForTimeout(1500);
  if (await phone.locator('button:has-text("Turn on")').isVisible()) {
    await phone.locator('button:has-text("Turn on")').click();
    await page.waitForTimeout(4000);
  }
  const phoneText = (await phone.innerText()).replace(/\s+/g, ' ');
  check('phone dialog shows the address', phoneText.includes(`/${id}/`), phoneText.slice(0, 200));
  await page.screenshot({ path: shot('3-phone') });
  await phone.locator('button:has-text("Close")').click();

  // 5. a hung app: freeze it from the host (inside, the kernel ignores signals to PID 1)
  guest(`for p in $(docker top ${id} -o pid | tail -n +2); do kill -STOP $p; done`);
  await wrapperFrame(page, id).evaluate(() => location.reload());
  const restart = () => wrapperFrame(page, id).getByRole('button', { name: /^Restart/ });
  for (let i = 0; i < 240 && !(await restart().isVisible().catch(() => false)); i++) await page.waitForTimeout(1000);
  check('a hung app offers Restart', await restart().isVisible().catch(() => false), await wrapperText(page, id));
  await page.screenshot({ path: shot('4-hung') });
  await restart().click();
  await waitForApp(page, id, log, 'after restart');

  // 6. the bridge restarts and forgets every session; the app must come back without a sign-in page
  guest(`docker restart ${id}-bridge >/dev/null`);
  for (let i = 0; i < 60; i++) {
    const up = guest(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$(cat /var/packages/${id}/var/bridge-port)/health || true`).trim();
    if (up === '200') break;
    await page.waitForTimeout(1000);
  }
  await appFrame(page, id).evaluate(() => location.reload());
  await waitForApp(page, id, log, 're-login', 90);
  check('silent re-login after the bridge restarted', true);

  // 7. stopped app: Start in the window
  guest(`docker stop ${id} >/dev/null`);
  await wrapperFrame(page, id).evaluate(() => location.reload());
  let stopped = '';
  for (let i = 0; i < 60 && !/not running/.test(stopped); i++) {
    stopped = await wrapperText(page, id);
    await page.waitForTimeout(1000);
  }
  check('a stopped app says so and offers Start', /not running/.test(stopped), stopped);
  await wrapperFrame(page, id).getByRole('button', { name: /^Start/ }).click();
  await waitForApp(page, id, log, 'start');
  await page.screenshot({ path: shot('5-started') });

  const real = errors.filter((message) => !/redundant navigation/.test(message));
  check('no page errors', real.length === 0, real.join(' | '));
} catch (error) {
  failed++;
  log(`FAIL ${error.message.split('\n')[0]}`);
  await page.screenshot({ path: shot('error') }).catch(() => {});
} finally {
  await browser.close();
}
log(failed ? `${id}: ${failed} check(s) failed` : `${id}: all checks passed`);
process.exit(failed ? 1 : 0);
