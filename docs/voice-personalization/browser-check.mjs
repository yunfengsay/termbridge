// Optional browser QA. Use an existing Playwright installation; no project dependencies change.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  playwright: { type: 'string' },
  browser: { type: 'string' },
  out: { type: 'string' },
} });
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(values.out || resolve(root, 'qa'));
const { chromium } = await import(values.playwright
  ? pathToFileURL(resolve(values.playwright)).href : 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(values.browser ? { executablePath: resolve(values.browser) } : {}) });
const url = pathToFileURL(resolve(root, 'index.html')).href;
const errors = [];
const network = [];
const cases = [];
await mkdir(output, { recursive: true });

async function open(viewport, javaScriptEnabled = true, reducedMotion = 'reduce') {
  const context = await browser.newContext({ viewport, javaScriptEnabled, reducedMotion });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  });
  context.on('request', request => {
    if (/^https?:/.test(request.url())) network.push(request.url());
  });
  await context.route(/^https?:/, route => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  return { page, context };
}

async function layout(page, name) {
  const measured = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
    images: [...document.images].map(image => ({
      loaded: image.complete && image.naturalWidth > 0,
      file: image.getAttribute('src'),
    })),
    panels: [...document.querySelectorAll('.diagram-scroll')].map(panel => ({
      width: panel.clientWidth, scrollWidth: panel.scrollWidth,
      labelled: Boolean(panel.getAttribute('aria-label')),
    })),
  }));
  assert(measured.content <= measured.viewport + 1, `${name}: page overflows ${JSON.stringify(measured)}`);
  assert(measured.images.length === 3 && measured.images.every(image => image.loaded), `${name}: missing diagram`);
  assert(measured.panels.every(panel => panel.labelled), `${name}: missing scroll-region label`);
  cases.push({ name, ...measured });
}

async function screenshot(page, file, locator) {
  const options = { path: resolve(output, file) };
  if (locator) await page.locator(locator).screenshot(options);
  else await page.screenshot(options);
}

try {
  const { page, context } = await open({ width: 1440, height: 1000 });
  assert.notEqual(await page.locator('.skip').evaluate(element => getComputedStyle(element).clipPath), 'none');
  await page.keyboard.press('Tab');
  assert(await page.locator('.skip').evaluate(element => element === document.activeElement && getComputedStyle(element).clipPath === 'none'));
  await page.keyboard.press('Tab');
  assert.notEqual(await page.locator('.skip').evaluate(element => getComputedStyle(element).clipPath), 'none');
  await layout(page, 'desktop-1440');
  await screenshot(page, 'desktop-top.png');
  const score = () => page.locator('#personal-score').innerText().then(parseFloat);
  const baseline = await score();
  const bar = () => page.locator('#personal-fill').evaluate(element => getComputedStyle(element).transform);
  const originalBar = await bar();
  assert.equal(baseline, 59.9);
  assert(await page.locator('#undo').isDisabled());
  await page.locator('#negative').click();
  assert.equal(await score(), 52.2);
  assert.notEqual(await bar(), originalBar, 'CSP must allow the demonstration transform update');
  await screenshot(page, 'desktop-learning.png', '#learning-demo');
  await page.locator('#undo').click();
  assert.equal(await score(), baseline);
  await page.locator('#positive').click();
  assert(await score() > baseline);
  await page.locator('#reset').click();
  assert.equal(await score(), baseline);
  for (let index = 0; index < 8; index++) await page.locator('#negative').click();
  assert(await page.locator('#negative').isDisabled() && await page.locator('#positive').isDisabled());
  await page.reload();
  assert.equal(await score(), baseline, 'Refresh must not retain personal data');
  assert(await page.locator('#undo').isDisabled());
  cases.push({ name: 'synthetic-feedback', negative: 52.2, positive: 'increases',
    undo: 'pass', reset: 'pass', budget: 8, refresh: 'clears', cssTransform: 'pass', keyboardSkipLink: 'pass' });

  await screenshot(page, 'desktop-architecture.png', '#models .diagram-figure');
  await screenshot(page, 'desktop-interaction.png', '#attention .diagram-figure');
  await screenshot(page, 'desktop-learning-paths.png', '#learning .diagram-figure');
  await screenshot(page, 'desktop-settings.png', '.settings-layout');
  await screenshot(page, 'desktop-evidence.png', '#evidence');
  await page.emulateMedia({ media: 'print' });
  await layout(page, 'print-media');
  assert(await page.locator('.diagram-figure').first().isVisible());
  assert(await page.locator('#negative').isHidden());
  await context.close();

  for (const width of [390, 320]) {
    const mobile = await open({ width, height: 844 });
    await layout(mobile.page, `mobile-${width}`);
    await screenshot(mobile.page, `mobile-${width}-top.png`);
    await screenshot(mobile.page, `mobile-${width}-settings.png`, '.settings');
    await screenshot(mobile.page, `mobile-${width}-evidence.png`, '#evidence');
    const panel = mobile.page.locator('.diagram-scroll').first();
    const scroll = await panel.evaluate(element => {
      element.scrollLeft = 160;
      return element.scrollLeft;
    });
    assert(scroll > 0, `mobile-${width}: diagrams must be locally scrollable`);
    await mobile.page.locator('#negative').click();
    assert.equal(parseFloat(await mobile.page.locator('#personal-score').innerText()), 52.2);
    await mobile.context.close();
  }

  const noScript = await open({ width: 390, height: 844 }, false);
  await layout(noScript.page, 'no-javascript');
  assert(await noScript.page.locator('noscript').isVisible());
  assert.equal(await noScript.page.locator('.reveal-ready').count(), 0);
  await noScript.context.close();

  const motion = await open({ width: 1440, height: 1000 }, true, 'no-preference');
  const figure = motion.page.locator('#models .diagram-figure');
  await figure.scrollIntoViewIfNeeded();
  await motion.page.waitForFunction(() =>
    document.querySelector('#models .diagram-figure').classList.contains('is-visible'));
  cases.push({ name: 'progressive-reveal', intersectionObserver: 'pass' });
  await motion.context.close();

  assert.deepEqual(network, [], 'Article must not make external requests');
  assert.deepEqual(errors, [], 'Browser console and runtime must be error-free');
  const report = { result: 'pass', at: new Date().toISOString(), browser: browser.version(),
    externalRequests: network.length, runtimeErrors: errors.length, cases,
    scope: 'Static article only; no production DDSD, microphone or phone tested' };
  await writeFile(resolve(output, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
