// The package's Login Portal address on a desktop browser and on an iPhone: DSM's sign-in, then
// the app on its own at device width with a Home Screen name and icon.
// Usage: node portal.mjs <package-id> <DSM app class>  (the alias must be on; window.mjs turns it on)
import { chromium, devices, webkit } from '@playwright/test';
import { HTTPS, OUTPUT, credentials, logger, waitForApp } from './lib.mjs';

const [id] = process.argv.slice(2);
if (!id) {
  console.error('usage: node portal.mjs <package-id>');
  process.exit(2);
}
const log = logger();
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

async function visit(label, engine, options, expectedWidth) {
  const browser = await engine.launch();
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true, ...options })).newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(`${HTTPS}/${id}/`);
    const user = credentials();
    await page.locator('input[name="username"]').fill(user.username);
    await page.locator('input[name="username"]').press('Enter');
    const password = page.locator('input[name="current-password"]');
    await password.waitFor({ state: 'visible' });
    await password.fill(user.password);
    await password.press('Enter');
    await waitForApp(page, id, log, label);
    // DSM refits its window a moment after the layout pass
    await page.waitForTimeout(1000);
    const shape = await page.evaluate(() => ({
      width: window.innerWidth,
      window: document.querySelector('.sds-standalone-main-window')?.offsetWidth || 0,
      title: document.title,
      icon: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href') || '',
      standalone: _S('standalone'),
    }));
    await page.screenshot({ path: `${OUTPUT}${id}-portal-${label}.png` });
    check(`${label}: the app on its own page`, shape.standalone === true, JSON.stringify(shape));
    check(`${label}: laid out at the device width`, shape.width === expectedWidth, `${shape.width}px`);
    check(`${label}: the window fills the page width`, shape.window === shape.width,
      `${shape.window}px of ${shape.width}px`);
    check(`${label}: Home Screen icon is the app's`, shape.icon.includes(`/${id}/images/`), shape.icon);

    const account = page.locator('.sds-standalone-main-window-header__toolbar__btn button');
    await (options.isMobile ? account.tap() : account.click());
    const signOut = page.locator('.sds-standalone-main-window-header__toolbar__menu a.sds-standalone-logout');
    const help = page.locator('.sds-standalone-main-window-header__toolbar__menu a.sds-standalone-help');
    await signOut.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: `${OUTPUT}${id}-portal-${label}-account.png` });
    check(`${label}: the account menu offers Sign Out`, await signOut.isVisible());
    check(`${label}: the account menu has no empty Help`, !(await help.isVisible()));
  } finally {
    await browser.close();
  }
}

await visit('desktop', chromium, { viewport: { width: 1280, height: 800 } }, 1280);
await visit('iphone', webkit, { ...devices['iPhone 15'] }, devices['iPhone 15'].viewport.width);
log(failed ? `portal: ${failed} check(s) failed` : 'portal: all checks passed');
process.exit(failed ? 1 : 0);
