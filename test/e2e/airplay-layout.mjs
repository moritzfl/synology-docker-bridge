// Run against an installed AirPlay Capture SPK in Virtual DSM.
import assert from 'node:assert/strict';
import { chromium, devices, expect, webkit } from '@playwright/test';
import { HTTPS, OUTPUT, launch, logger, signIn, waitForApp } from './lib.mjs';

const id = 'airplay-capture';
const app = 'SYNO.SDS.AirplayCapture.Instance';
const log = logger();
const shot = (name) => `${OUTPUT}airplay-layout-${name}.png`;
const wrapper = `iframe[src*="/${id}/app.html"]`;

async function geometry(shell, page) {
  const metrics = await shell.evaluate((_, outer) => ({
    width: innerWidth,
    height: innerHeight,
    outer,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }), page.viewportSize());
  assert.ok(metrics.width > 0 && metrics.width <= metrics.outer.width + 1, JSON.stringify(metrics));
  assert.ok(metrics.height > 0 && metrics.height <= metrics.outer.height + 1, JSON.stringify(metrics));
  assert.ok(metrics.overflow <= 1, JSON.stringify(metrics));
  return metrics;
}

async function scrollSettings(frame, page, { wheel = true } = {}) {
  await frame.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  const section = frame.getByRole('button', { name: 'Updates', exact: true });
  await section.click();
  const heading = frame.getByRole('heading', { name: 'Updates', exact: true });
  await expect(heading).toBeInViewport();
  const shell = frame.locator('.app-header');
  await expect(shell).toBeInViewport();
  const scrollTop = () => heading.evaluate(() => document.scrollingElement.scrollTop);
  const before = await scrollTop();
  assert.ok(before > 0, 'section jump must scroll app document');
  if (wheel) {
    const { x, y, width, height } = await heading.boundingBox();
    await page.mouse.move(x + width / 2, y + height / 2);
    await page.mouse.wheel(0, -760);
  } else {
    await frame.getByRole('button', { name: 'Receiver', exact: true }).click();
  }
  await expect.poll(scrollTop).toBeLessThan(before);
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0);
}

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const { page, context } = await signIn(browser, HTTPS);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await launch(page, app);
    await waitForApp(page, id, log, `${engine.name()} open`);
    const win = page.locator('.x-window').filter({ has: page.locator(wrapper) }).first();
    const frame = page.frameLocator(wrapper).frameLocator('#frame');
    const shell = frame.locator('.app-shell');
    await expect(shell).toBeVisible();
    const original = await geometry(shell, page);
    await page.screenshot({ path: shot(`${engine.name()}-desktop`) });

    const handle = win.locator('.x-resizable-handle-southeast').first();
    const corner = await handle.boundingBox();
    assert.ok(corner, 'DSM window must expose its resize handle');
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x - 230, corner.y - 150, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => shell.evaluate(() => innerWidth)).toBeLessThan(original.width);
    const small = await geometry(shell, page);
    await scrollSettings(frame, page);
    await page.screenshot({ path: shot(`${engine.name()}-resized-scroll`) });

    const maximize = win.locator('.x-tool-maximize');
    await maximize.click();
    await expect.poll(() => shell.evaluate(() => innerWidth)).toBeGreaterThan(small.width);
    await geometry(shell, page);
    await page.screenshot({ path: shot(`${engine.name()}-maximized`) });
    await win.locator('.x-tool-restore').click();
    await expect.poll(() => shell.evaluate(() => innerWidth)).toBe(small.width);
    await geometry(shell, page);
    await win.locator('.x-tool-close').click();
    await expect(win).toBeHidden();
    await launch(page, app);
    await waitForApp(page, id, log, `${engine.name()} reopen`);
    await expect(shell).toBeVisible();
    assert.deepEqual(errors, []);
    log(`${engine.name()}: drag resize, nested scrolling, maximize, restore, close/reopen passed`);
    await context.close();
  } finally {
    await browser.close();
  }
}

if (process.argv.includes('--portal')) {
  const browser = await webkit.launch();
  try {
    const { page } = await signIn(browser, `${HTTPS}/${id}/`, undefined, devices['iPhone 15']);
    await waitForApp(page, id, log, 'iPhone portal');
    const frame = page.frameLocator(wrapper).frameLocator('#frame');
    const shell = frame.locator('.app-shell');
    await expect(shell).toBeVisible();
    const portrait = page.viewportSize();
    await geometry(shell, page);
    await scrollSettings(frame, page, { wheel: false });
    await page.screenshot({ path: shot('portal-portrait') });
    await page.setViewportSize({ width: portrait.height, height: portrait.width });
    await expect.poll(() => shell.evaluate(() => innerWidth)).toBeGreaterThan(portrait.width);
    await geometry(shell, page);
    await page.screenshot({ path: shot('portal-landscape') });
    await page.setViewportSize(portrait);
    await expect.poll(() => shell.evaluate(() => innerWidth)).toBeLessThanOrEqual(portrait.width);
    await geometry(shell, page);
    log('WebKit portal: nested scrolling and portrait/landscape/portrait refit passed');
  } finally {
    await browser.close();
  }
}
