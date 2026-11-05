import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

await mkdir(new URL('./.auth/', import.meta.url), { recursive: true, mode: 0o700 });
let credentials;
try {
  credentials = JSON.parse(await readFile(new URL('./.auth/credentials.json', import.meta.url), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  credentials = { username: 'bridge-e2e', password: randomBytes(24).toString('base64url') + 'aA1!' };
  await writeFile(new URL('./.auth/credentials.json', import.meta.url), JSON.stringify(credentials), { mode: 0o600 });
}
const base = process.env.DSM_HTTP || 'http://127.0.0.1:15001';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(180_000);
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('textbox', { name: /Gerätename:|Device name:/ }).fill('bridge-e2e');
  await page.getByRole('textbox', { name: /Administrator-Konto:|Administrator account:/ }).fill(credentials.username);
  await page.getByRole('textbox', { name: /Kennwort:|Password:/ }).first().fill(credentials.password);
  await page.getByRole('textbox', { name: /Kennwort bestätigen:|Confirm password:/ }).fill(credentials.password);
  await page.getByRole('button', { name: /^(Weiter|Next)$/ }).click();
  await page.getByRole('textbox', { name: /Gerätename:|Device name:/ }).waitFor({ state: 'hidden' });
  await page.getByText(/Verständigen, wenn DSM- oder Paket-Updates verfügbar sind|Notify me when DSM or package updates are available/).click();
  await page.getByRole('button', { name: /^(Weiter|Next)$/ }).click();
  await page.getByRole('button', { name: /^(Überspringen|Skip)$/ }).click();
  await page.getByRole('button', { name: /^(Absenden|Submit)$/ }).click();
  await page.getByRole('button', { name: /^(Absenden|Submit)$/ }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^(Nein, danke|No, thanks)$/ }).click();
  await page.getByRole('button', { name: /^(Jetzt aktivieren|Enable Now)$/ }).waitFor();
  await page.getByRole('button', { name: /^(Nein, danke|No, thanks)$/ }).click();
  await page.getByRole('button', { name: /^(Ich möchte mein Konto nicht schützen|I don't want to secure my account)$/ }).click();
  await page.getByRole('button', { name: /^OK$/ }).click();
  await mkdir(new URL('./output/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('./output/setup.png', import.meta.url).pathname });
  console.log(await page.locator('body').innerText());
  await page.context().storageState({ path: new URL('./.auth/admin.json', import.meta.url).pathname });
} finally {
  await browser.close();
}
