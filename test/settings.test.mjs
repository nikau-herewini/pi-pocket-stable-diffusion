import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import setup, { draftFromSettings, presetRows, settingsPatch } from '../stable-diffusion-browser/index.js';
import { DEFAULT_PRESETS, configuration } from '../stable-diffusion/config.mjs';
import { ImageLock } from '../stable-diffusion.ts';

export const snapshot = () => ({ fields: [{ name: 'presets', default: DEFAULT_PRESETS }], values: { endpoint: 'http://127.0.0.1:8080', timeoutMinutes: 20, presets: DEFAULT_PRESETS }, set: ['endpoint', 'presets', 'token'] });

test('settings editor preserves names, preset order, numeric settings, and a stored token by default', () => {
  const settings = snapshot(), draft = draftFromSettings(settings), patch = settingsPatch(draft);
  assert.equal(draft.token, ''); assert.equal(draft.tokenAction, 'keep'); assert.equal(draft.tokenSet, true);
  assert.ok(!Object.hasOwn(patch, 'token'));
  assert.deepEqual(JSON.parse(patch.presets), JSON.parse(DEFAULT_PRESETS));
  assert.deepEqual(Object.keys(configuration({ ...patch, token: 'test-token' }).presets), ['standard', 'klein']);
  assert.equal(patch.timeoutMinutes, 20);
});
test('stored token values are ignored; replacement and removal must be explicit', () => {
  const settings = snapshot(); settings.values.token = 'must-not-be-read';
  const draft = draftFromSettings(settings);
  assert.ok(!JSON.stringify(draft).includes('must-not-be-read'));
  assert.ok(!Object.hasOwn(settingsPatch(draft), 'token'));
  assert.equal(settingsPatch({ ...draft, tokenAction: 'replace', token: 'new-test-token' }).token, 'new-test-token');
  assert.equal(settingsPatch({ ...draft, tokenAction: 'clear' }).token, null);
  assert.throws(() => settingsPatch({ ...draft, tokenAction: 'replace', token: '' }), /Enter a bearer token/);
  assert.throws(() => settingsPatch({ ...draft, tokenAction: 'replace', token: 'a\r\nb' }), /without spaces or control/);
});
test('invalid saved JSON is retained for repair and cannot be overwritten accidentally', () => {
  const settings = snapshot(); settings.values.presets = '{broken';
  const draft = draftFromSettings(settings);
  assert.equal(draft.rawPresets, '{broken'); assert.ok(draft.repair); assert.deepEqual(draft.rows, []);
  assert.throws(() => settingsPatch(draft), /Repair/);
  assert.throws(() => presetRows('[]'), /1–16/);
  const values = JSON.parse(DEFAULT_PRESETS); values.standard.width = '512';
  assert.throws(() => presetRows(JSON.stringify(values)), /unsupported fields or types/);
  assert.ok(settingsPatch({ ...draft, rows: presetRows(DEFAULT_PRESETS), repair: '' }).presets);
});
test('structured editing enforces connection, numeric, name, and preset capability limits', () => {
  const draft = draftFromSettings(snapshot());
  for (const endpoint of ['', 'file:///tmp/service', 'https://user:password@example.org', 'https://example.org/?token=x', 'https://example.org/#x']) assert.throws(() => settingsPatch({ ...draft, endpoint }));
  for (const timeoutMinutes of ['', '0', '121', '1.5']) assert.throws(() => settingsPatch({ ...draft, timeoutMinutes }));
  for (const patch of [{ name: 'Bad name' }, { width: 65 }, { height: '' }, { steps: 0 }, { cfg: 31 }, { references: 'yes' }, { sampler: '../x' }, { scheduler: 'Bad' }]) assert.throws(() => settingsPatch({ ...draft, rows: [{ ...draft.rows[0], ...patch }] }));
  assert.throws(() => settingsPatch({ ...draft, rows: [draft.rows[0], draft.rows[0]] }), /unique/);
  assert.throws(() => settingsPatch({ ...draft, rows: [] }), /1–16/);
  const patch = settingsPatch({ ...draft, rows: [draft.rows[1], { ...draft.rows[0], cfg: '7.5', width: '768' }] });
  assert.deepEqual(Object.keys(JSON.parse(patch.presets)), ['klein', 'standard']);
  assert.equal(JSON.parse(patch.presets).standard.cfg, 7.5);
});
test('client adds one owner settings sheet, its stylesheet, and menu/launcher entries, without changing identifiers', async () => {
  const registered = {};
  setup({ style: path => { registered.style = path; }, sheet: spec => { registered.sheet = spec; }, menu: spec => { registered.menu = spec; }, launcher: spec => { registered.launcher = spec; } });
  assert.equal(registered.style, 'style.css');
  assert.equal(registered.sheet.title, 'Stable Diffusion'); assert.equal(registered.sheet.wide, true);
  assert.equal(registered.sheet.id, 'settings'); assert.equal(registered.menu.sheet, 'settings'); assert.equal(registered.launcher.sheet, 'settings');
  assert.equal(ImageLock.definition.kind, 'x.stable-diffusion.lock'); assert.equal(ImageLock.definition.version, 1);
  const source = await readFile(new URL('../stable-diffusion.ts', import.meta.url), 'utf8');
  assert.match(source, /\* @title Stable Diffusion/);
  assert.match(source, /name: 'stable-diffusion'/);
});
