import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuration, planRequest, hash } from '../stable-diffusion/config.mjs';
import { values } from './support.mjs';

test('model fingerprints ignore JSON object key order but preserve array order', () => {
  assert.equal(hash({ models: { b: 'two', a: 'one' }, revision: 1 }), hash({ revision: 1, models: { a: 'one', b: 'two' } }));
  assert.notEqual(hash(['one', 'two']), hash(['two', 'one']));
});
test('connection accepts path prefixes but rejects URL credentials, query, fragments, and unsafe tokens', () => {
  assert.equal(configuration({ ...values(), endpoint: 'https://example.org/diffusion/' }).endpoint, 'https://example.org/diffusion');
  for (const endpoint of ['', 'file:///tmp/service', 'https://user:pass@example.org', 'https://example.org?token=x', 'https://example.org/#x']) assert.throws(() => configuration({ ...values(), endpoint }), /Invalid/);
  for (const token of ['a\r\nb', 'a b', 'é']) assert.throws(() => configuration({ ...values(), token }), /Invalid/);
});
test('strict presets reject unknown fields, invalid sampling, oversized dimensions and malformed JSON', () => {
  const base = JSON.parse(values().presets).standard;
  for (const patch of [{ width: 8192 }, { height: 65 }, { steps: 0 }, { cfg: '7' }, { sampler: '../x' }, { references: 'yes' }, { endpoint: 'https://example.org' }]) {
    assert.throws(() => configuration({ ...values(), presets: JSON.stringify({ example: { ...base, ...patch } }) }), /Invalid/);
  }
  for (const presets of ['null', '[]', '{}', 'invalid']) assert.throws(() => configuration({ ...values(), presets }), /Invalid/);
});
test('presets enforce capability gates and fixed generation settings', () => {
  const config = configuration(values());
  assert.throws(() => planRequest({ prompt: 'test', preset: 'unknown' }, config), /Unknown/);
  assert.throws(() => planRequest({ prompt: 'test', preset: 'klein', negative_prompt: 'bad' }, config), /negative/);
  assert.throws(() => planRequest({ prompt: 'test', reference_images: ['/tmp/a.png'] }, config), /reference/);
  assert.throws(() => planRequest({ prompt: ' ' }, config), /Prompt/);
  assert.throws(() => planRequest({ prompt: 'test', seed: 2.5 }, config), /Seed/);
  const plan = planRequest({ prompt: ' test ', preset: 'klein', seed: 7 }, config);
  assert.equal(plan.body.prompt, 'test'); assert.equal(plan.body.batch_count, 1); assert.equal(plan.body.sample_params.scheduler, 'flux2'); assert.equal(plan.body.sample_params.guidance.txt_cfg, 1);
});
