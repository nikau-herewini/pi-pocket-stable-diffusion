import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture, loaded } from './harness.mjs';

const display = (page, selector) => page.$eval(selector, element => getComputedStyle(element).display);

test('the core basic-settings fallback is hidden only for this module while its stylesheet is loaded', { timeout: 30000 }, async t => {
  const { page } = await browserFixture(t); await loaded(page);
  await page.waitForSelector('link[href="/style.css"]');
  await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.endsWith('/style.css') && sheet.cssRules.length > 0));
  assert.equal(await display(page, '#ext-more-stable-diffusion-ts details:has(> .ext-settings)'), 'none');
  assert.equal(await display(page, '#ext-more-stable-diffusion-ts details:not(:has(> .ext-settings))'), 'block');
  assert.equal(await display(page, '#ext-more-other-ts details:has(> .ext-settings)'), 'block');
});
test('the fallback stays visible when the browser module did not load its stylesheet', { timeout: 30000 }, async t => {
  const { page } = await browserFixture(t, { applyStyle: false }); await loaded(page);
  assert.equal(await page.$('link[href="/style.css"]'), null);
  assert.equal(await display(page, '#ext-more-stable-diffusion-ts details:has(> .ext-settings)'), 'block');
});
