// The package's Login Portal address on a desktop browser and on an iPhone: DSM's sign-in, then
// the app on its own at device width with a Home Screen name and icon, and its tab without DSM's
// header.
// Usage: node portal.mjs <package-id> <DSM app class>  (the alias must be on; window.mjs turns it on)
import { chromium, devices, webkit } from "@playwright/test";
import { HTTPS, OUTPUT, enterCredentials, logger, waitForApp } from "./lib.mjs";

const [id] = process.argv.slice(2);
if (!id) {
  console.error("usage: node portal.mjs <package-id>");
  process.exit(2);
}
const log = logger();
let failed = 0;
const check = (label, ok, detail = "") => {
  log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

async function visit(label, engine, options, expectedWidth) {
  const browser = await engine.launch();
  try {
    const page = await (
      await browser.newContext({ ignoreHTTPSErrors: true, locale: "en-US", ...options })
    ).newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(`${HTTPS}/${id}/`);
    await enterCredentials(page);
    await waitForApp(page, id, log, label);
    // DSM refits its window a moment after the layout pass
    await page.waitForTimeout(1000);
    const shape = await page.evaluate(() => ({
      width: window.innerWidth,
      window: document.querySelector(".sds-standalone-main-window")?.offsetWidth || 0,
      title: document.title,
      icon: document.querySelector("link[rel=apple-touch-icon]")?.getAttribute("href") || "",
      standalone: _S("standalone"),
      tabButton: document.querySelectorAll(".x-tool-bridge-tab").length,
    }));
    await page.screenshot({ path: `${OUTPUT}${id}-portal-${label}.png` });
    check(`${label}: the app on its own page`, shape.standalone === true, JSON.stringify(shape));
    check(
      `${label}: laid out at the device width`,
      shape.width === expectedWidth,
      `${shape.width}px`,
    );
    check(
      `${label}: the window fills the page width`,
      shape.window === shape.width,
      `${shape.window}px of ${shape.width}px`,
    );
    check(`${label}: no window title bar buttons on a page of its own`, shape.tabButton === 0);
    check(
      `${label}: Home Screen icon is the app's`,
      shape.icon.includes(`/${id}/images/`),
      shape.icon,
    );

    // The app without DSM's header: "Open in new tab" left of the account name, as in the window.
    const account = page.locator(".sds-standalone-main-window-header__toolbar__btn button");
    const tabButton = page.locator(".sds-standalone-main-window-header .bridge-portal-tab");
    const tabBox = await tabButton.boundingBox();
    const accountBox = await account.boundingBox();
    check(
      `${label}: the header offers "Open in new tab" left of the account name`,
      (await tabButton.getAttribute("aria-label")) === "Open in new tab" &&
        !!tabBox &&
        !!accountBox &&
        tabBox.x + tabBox.width <= accountBox.x,
      JSON.stringify({ tabBox, accountBox }),
    );
    const headerBox = await page.locator(".sds-standalone-main-window-header").boundingBox();
    const middle = (box) => (box ? box.y + box.height / 2 : -100);
    check(
      `${label}: the button leaves the header row as it was`,
      Math.abs(middle(accountBox) - middle(headerBox)) <= 2 &&
        Math.abs(middle(tabBox) - middle(accountBox)) <= 1,
      JSON.stringify({ headerBox, accountBox, tabBox }),
    );
    const tabAddress = new RegExp(`/3rdparty/${id}/app\\.html\\?lang=\\w+$`);
    const [tab] = await Promise.all([
      page.context().waitForEvent("page"),
      options.isMobile ? tabButton.tap() : tabButton.click(),
    ]);
    await tab.waitForURL(tabAddress);
    await waitForApp(tab, id, log, `${label} tab`, 120);
    const alone = await tab.evaluate(() => ({
      width: window.innerWidth,
      header: !!document.querySelector(".sds-standalone-main-window-header"),
      frame: document.getElementById("frame").getBoundingClientRect().toJSON(),
      homeScreen: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
      icon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") || "",
    }));
    await tab.screenshot({ path: `${OUTPUT}${id}-portal-${label}-tab.png` });
    check(
      `${label}: the tab shows the app without DSM's header, at the full width`,
      !alone.header && alone.frame.top === 0 && alone.frame.width === expectedWidth,
      JSON.stringify(alone),
    );
    check(
      `${label}: the tab can go on the Home Screen with the app's icon`,
      alone.homeScreen === "yes" && alone.icon.endsWith("images/app_256.png"),
      JSON.stringify(alone),
    );
    await tab.close();
    // Started from the Home Screen, the tab has no token yet and gets one through DSM.
    const start = await page.context().newPage();
    await start.goto(`${HTTPS}/webman/3rdparty/${id}/app.html`);
    await start.waitForURL(tabAddress, { timeout: 180_000 });
    await waitForApp(start, id, log, `${label} Home Screen start`, 120);
    check(`${label}: a Home Screen start opens the tab through DSM`, true);
    await start.close();

    await (options.isMobile ? account.tap() : account.click());
    const signOut = page.locator(
      ".sds-standalone-main-window-header__toolbar__menu a.sds-standalone-logout",
    );
    const help = page.locator(
      ".sds-standalone-main-window-header__toolbar__menu a.sds-standalone-help",
    );
    await signOut.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: `${OUTPUT}${id}-portal-${label}-account.png` });
    check(`${label}: the account menu offers Sign Out`, await signOut.isVisible());
    check(`${label}: the account menu has no empty Help`, !(await help.isVisible()));
  } finally {
    await browser.close();
  }
}

await visit("desktop", chromium, { viewport: { width: 1280, height: 800 } }, 1280);
await visit("iphone", webkit, { ...devices["iPhone 15"] }, devices["iPhone 15"].viewport.width);
log(failed ? `portal: ${failed} check(s) failed` : "portal: all checks passed");
process.exit(failed ? 1 : 0);
