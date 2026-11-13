import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PRESETS } from '../../stable-diffusion/config.mjs';
import { browserFixture, fill, clickText, loaded, saved } from './harness.mjs';

for (const width of [390, 1280]) test(`structured settings work at ${width}px without horizontal overflow`, { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t, { width }); await loaded(page);
  assert.equal(await page.$eval('h1', node => node.textContent), 'Stable Diffusion');
  assert.equal(await page.$$eval('fieldset', nodes => nodes.length), 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.$$eval('button,input:not([type=checkbox]),select', nodes => nodes.every(node => node.getBoundingClientRect().height >= 44)));
  assert.ok(!(await page.content()).includes('stored-test-token'));
  if (width === 390 && process.env.UI_SCREENSHOT_DIR) {
    await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_SCREENSHOT_DIR, 'settings-mobile.png') });
    await page.$eval('fieldset', element => element.scrollIntoView());
    await page.screenshot({ path: join(process.env.UI_SCREENSHOT_DIR, 'settings-presets-mobile.png') });
    await page.evaluate(() => scrollTo(0, 0));
  }
  await fill(page, 'endpoint', 'https://images.example.org/diffusion');
  await fill(page, 'timeoutMinutes', 35); await fill(page, 'steps-preset-0', 24);
  await clickText(page, 'Make default');
  await clickText(page, 'Save settings'); await saved(page);
  assert.equal(state.patches.length, 1); assert.ok(!Object.hasOwn(state.patches[0], 'token'));
  assert.equal(state.secret, 'stored-test-token'); assert.equal(state.values.timeoutMinutes, 35);
  assert.deepEqual(Object.keys(JSON.parse(state.values.presets)), ['klein', 'standard']);
  assert.equal(JSON.parse(state.values.presets).standard.steps, 24);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
test('an existing single-preset configuration does not regain removed examples', { timeout: 30000 }, async t => {
  const presets = JSON.stringify({ klein: JSON.parse(DEFAULT_PRESETS).klein });
  const { page, state } = await browserFixture(t, { presets }); await loaded(page);
  assert.equal(await page.$$eval('fieldset', nodes => nodes.length), 1);
  assert.equal(await page.$eval('[name=presetName-preset-0]', element => element.value), 'klein');
  await clickText(page, 'Save settings'); await saved(page);
  assert.deepEqual(JSON.parse(state.values.presets), JSON.parse(presets));
});
test('token replacement and clearing are explicit; the saved token is not returned or displayed', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t); await loaded(page);
  await page.select('[name=tokenAction]', 'replace'); await fill(page, 'token', 'replacement-test-token');
  await clickText(page, 'Save settings'); await saved(page);
  assert.equal(state.secret, 'replacement-test-token');
  assert.equal(await page.$('[name=token]'), null);
  assert.ok(!(await page.content()).includes('replacement-test-token'));
  await page.select('[name=tokenAction]', 'clear'); await clickText(page, 'Save settings'); await saved(page);
  assert.equal(state.secret, ''); assert.equal(state.patches.at(-1).token, null);
  assert.match(await page.$eval('[name=tokenAction]', element => element.textContent), /No token configured/);
});
test('save errors are safe and reload restores the saved values', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t); await loaded(page);
  const original = state.values.endpoint; state.failSave = true;
  await fill(page, 'endpoint', 'https://new.example.org'); await clickText(page, 'Save settings');
  await page.waitForFunction(() => document.body.textContent.includes('Settings could not be saved.'));
  assert.ok(!(await page.content()).includes('private-error-must-not-be-displayed'));
  assert.equal(state.values.endpoint, original);
  assert.equal(await page.$eval('[name=endpoint]', element => element.value), 'https://new.example.org');
  state.failSave = false; await clickText(page, 'Reload saved settings'); await loaded(page);
  assert.equal(await page.$eval('[name=endpoint]', element => element.value), original);
  await clickText(page, 'Save settings'); await saved(page);
});
test('failed initial load has a retry path', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t, { failLoad: true });
  await page.waitForFunction(() => document.body.textContent.includes('Settings could not be loaded.'));
  state.failLoad = false; await clickText(page, 'Retry'); await loaded(page);
});
test('invalid saved presets stay available for repair, instead of being discarded', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t, { presets: '{broken' }); await loaded(page);
  assert.equal(await page.$eval('[name=repairPresets]', element => element.value), '{broken');
  assert.equal(await page.$eval('[type=submit]', element => element.disabled), true);
  await fill(page, 'repairPresets', DEFAULT_PRESETS); await clickText(page, 'Use repaired JSON');
  await page.waitForSelector('fieldset'); await clickText(page, 'Save settings'); await saved(page);
  assert.deepEqual(JSON.parse(state.values.presets), JSON.parse(DEFAULT_PRESETS));
  assert.equal(state.secret, 'stored-test-token');
});
test('an external settings change requires an explicit reload before saving', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t); await loaded(page);
  await fill(page, 'endpoint', 'https://unsaved.example.org');
  state.values.timeoutMinutes = 90; await page.evaluate(() => window.emitSettings());
  await page.waitForFunction(() => document.body.textContent.includes('Settings changed elsewhere.'));
  assert.equal(await page.$eval('[type=submit]', element => element.disabled), true);
  assert.equal(await page.$eval('[name=endpoint]', element => element.value), 'https://unsaved.example.org');
  await clickText(page, 'Reload saved settings'); await loaded(page);
  assert.equal(await page.$eval('[name=timeoutMinutes]', element => element.value), '90');
});
test('token-only changes in another tab cannot be missed because sanitized values match', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t); await loaded(page);
  await page.select('[name=tokenAction]', 'replace'); await fill(page, 'token', 'pending-test-token');
  state.secret = 'rotated-test-token'; await page.evaluate(() => window.emitSettings());
  await page.waitForFunction(() => document.body.textContent.includes('Settings changed elsewhere.'));
  assert.equal(await page.$eval('[type=submit]', element => element.disabled), true);
  assert.equal(state.patches.length, 0); assert.equal(state.secret, 'rotated-test-token');
  await clickText(page, 'Reload saved settings'); await loaded(page);
  assert.equal(await page.$('[name=token]'), null);
  await clickText(page, 'Save settings'); await saved(page);
  assert.ok(!Object.hasOwn(state.patches.at(-1), 'token')); assert.equal(state.secret, 'rotated-test-token');
  assert.equal(await page.$eval('[type=submit]', element => element.disabled), false);
});
test('preset examples can be added and removed without replacing existing presets', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t); await loaded(page);
  await clickText(page, 'Add preset');
  await page.waitForFunction(() => document.querySelectorAll('fieldset').length === 3);
  assert.equal(await page.$eval('[name=presetName-added-100]', element => element.value), 'standard-2');
  await fill(page, 'label-added-100', 'x'.repeat(100));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await fill(page, 'label-added-100', '<img src=x onerror=alert(1)>');
  assert.equal(await page.$('fieldset img'), null);
  await page.click('fieldset:last-of-type button:last-child');
  await page.waitForFunction(() => document.querySelectorAll('fieldset').length === 2);
  await clickText(page, 'Save settings'); await saved(page);
  assert.deepEqual(JSON.parse(state.values.presets), JSON.parse(DEFAULT_PRESETS));
});
test('duplicate preset names show a useful error without making a save request', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t); await loaded(page);
  await fill(page, 'presetName-preset-0', 'klein'); await clickText(page, 'Save settings');
  await page.waitForFunction(() => document.body.textContent.includes('Preset names must be unique.'));
  assert.equal(state.patches.length, 0);
});
test('older Pi Pocket builds get a clear fallback instead of a broken save button', { timeout: 30000 }, async t => {
  const { page, state } = await browserFixture(t, { legacy: true }); await loaded(page);
  assert.match(await page.$eval('[role=alert]', element => element.textContent), /Update Pi Pocket or use its inline Extensions settings/);
  assert.equal(await page.$eval('[type=submit]', element => element.disabled), true); assert.equal(state.patches.length, 0);
});
