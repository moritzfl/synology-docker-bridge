// Folder access for a package whose app runs as the package user (appUser "package"): the window
// lists the app's folders as that user sees them, opens DSM's own permission dialogs for them, and
// checks again once a permission changed. Usage: node access.mjs <package-id> <DSM app class>
import { chromium } from '@playwright/test';
import { HTTPS, OUTPUT, guest, launch, logger, signIn, waitForApp, wrapperFrame } from './lib.mjs';

const [id, app] = process.argv.slice(2);
if (!id || !app) {
  console.error('usage: node access.mjs <package-id> <SYNO.SDS.X.Instance>');
  process.exit(2);
}
const log = logger();
const shot = (name) => `${OUTPUT}${id}-access-${name}.png`;
let failed = 0;
const check = (label, ok, detail = '') => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const user = guest(`docker inspect ${id} --format '{{.Config.User}}'`).trim();
log(`app container user: ${user}`);
if (!/^[1-9]\d*:\d+$/.test(user)) {
  log('the app does not run as the package user; nothing to check');
  process.exit(0);
}
const added = [];
const browser = await chromium.launch();
const { page } = await signIn(browser, HTTPS);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const accessDialog = () => page.locator('.x-window:visible').filter({ hasText: 'Folder access' })
  .filter({ has: page.locator('button:has-text("Check again")') }).last();
const rows = () => accessDialog().locator('tr').evaluateAll((trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));

try {
  await launch(page, app);
  await waitForApp(page, id, log, 'open', 900);
  const access = await wrapperFrame(page, id).evaluate(async () => {
    const token = new URLSearchParams(location.search).get('SynoToken');
    const response = await fetch(`access.cgi?SynoToken=${encodeURIComponent(token)}`, { headers: { 'X-SynoToken': token } });
    return response.json();
  });
  log(`access: ${JSON.stringify(access)}`);
  const folders = access.folders || [];
  check('the data folder is listed and usable', folders.some((f) => f.key === 'data' && f.read && f.write));
  const needsAttention = folders.some((f) => !(f.exists && f.read && f.write));

  // Opens by itself when something needs attention, otherwise from Manage.
  if (needsAttention) {
    await accessDialog().waitFor({ timeout: 60_000 }).catch(() => {});
    check('Folder access opens by itself when a folder needs attention', await accessDialog().isVisible());
  }
  if (!(await accessDialog().isVisible())) {
    const win = page.locator('.x-window').filter({ has: page.locator(`iframe[src*="/${id}/app.html"]`) }).first();
    await win.locator('.x-toolbar button', { hasText: 'Manage' }).click();
    await page.locator('.x-menu:visible .x-menu-item', { hasText: 'Folder access' }).click();
    await accessDialog().waitFor();
  }
  await page.waitForFunction(() => !document.querySelector('.x-window:not(.x-hide-display) .ext-el-mask-msg'), null, { timeout: 60_000 }).catch(() => {});
  await page.screenshot({ path: shot('1-list') });
  const listed = await rows();
  log(`rows: ${listed.join(' | ')}`);
  for (const folder of folders) {
    const row = listed.find((text) => text.includes(folder.path));
    const shareClosed = folder.share && !folder.shareOpen;
    const want = folder.exists && folder.read && folder.write ? 'Read and write' : folder.read ? 'Read only'
      : shareClosed ? `No access to the shared folder ${folder.share.split('/').pop()}` : 'No access';
    check(`row for ${folder.key} says ${want}`, !!row && row.includes(want), row || 'missing');
  }

  // DSM's own dialog for each folder: the share's Permissions on the package user, or the
  // folder's permission tab. Closed without saving.
  for (const folder of folders) {
    const index = folders.indexOf(folder);
    await accessDialog().locator(`a[data-folder="${index}"]`).click();
    const native = page.locator('.x-window:visible').last();
    await page.waitForTimeout(4000);
    const title = (await native.locator('.x-window-header-text').first().innerText().catch(() => '')).trim();
    const text = (await native.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await page.screenshot({ path: shot(`2-permissions-${folder.key}`) });
    // While the shared folder is closed to the app, its permissions are the ones offered.
    const target = folder.share && !folder.shareOpen ? folder.share : folder.path;
    const isShare = /^\/volume[^/]+\/[^/]+$/.test(target);
    if (isShare) {
      check(`${folder.key}: the permissions of ${target} show the package user`, text.includes(id) && title.includes(target.split('/').pop()), `${title}: ${text.slice(0, 160)}`);
    } else {
      check(`${folder.key}: the permission tab of ${target} opens`, title.includes(target), title);
    }
    const denied = folder.exists && !(folder.read && folder.write);
    if (denied && isShare) {
      // Grant it the way an administrator would: Read/Write for the package user, Save.
      const row = native.locator('.x-grid3-row', { hasText: id }).first();
      await row.locator('td.x-grid3-cell').nth(2).locator('.x-grid3-cell-inner').click();
      await page.screenshot({ path: shot(`3-grant-${folder.key}`) });
      await native.locator('button', { hasText: 'Save' }).click();
      added.push(target);
      await page.waitForTimeout(8000);
      const after = (await rows()).find((text) => text.includes(folder.path)) || '';
      check(`${folder.key}: after saving, the list shows Read and write by itself`, after.includes('Read and write'), after);
      await page.screenshot({ path: shot(`4-granted-${folder.key}`) });
      if (folder.key === 'output') {
        const wrote = guest(`docker exec ${id} sh -c 'touch /output-parent/.${id}-folder/.e2e-write && rm /output-parent/.${id}-folder/.e2e-write && echo wrote' 2>&1 || true`).trim();
        check('the app itself can now write there', wrote === 'wrote', wrote);
      }
      continue;
    }
    // Close without saving.
    const cancel = native.locator('button', { hasText: /^(Cancel|Close)$/ }).last();
    if (await cancel.count()) await cancel.click(); else await native.locator('.x-tool-close').first().click();
    const dontSave = page.locator('.x-window:visible button', { hasText: "Don't Save" });
    if (await dontSave.count()) await dontSave.first().click();
    await page.waitForTimeout(2000);
  }

  await accessDialog().locator('button', { hasText: 'Close' }).click();
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  failed++;
  log(`FAIL ${error.message}`);
  await page.screenshot({ path: shot('error') }).catch(() => {});
} finally {
  for (const folder of added) {
    // Remove only the entry this test added.
    const acl = guest(`synoacltool -get '${folder}'`);
    const match = new RegExp(`\\[(\\d+)\\] user:${id}:allow:[^ ]+ \\(level:0\\)`).exec(acl);
    if (match) guest(`synoacltool -del '${folder}' ${match[1]}`);
  }
  await browser.close();
}
log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
