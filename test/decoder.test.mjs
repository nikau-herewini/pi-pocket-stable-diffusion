import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder } from '../stable-diffusion/decode.mjs';
import { referenceLoader } from '../stable-diffusion/references.mjs';
import { fixture, png } from './support.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const blocked = new URL('data:text/javascript,while(true){}');
const options = { maxWidth: 512, maxHeight: 512, maxBytes: 1_000_000 };
test('a stuck decoder worker is terminated on timeout', { timeout: 5000 }, async () => {
  const decode = createDecoder({ timeoutMs: 100, workerURL: blocked });
  await assert.rejects(decode(png(), 'image/png', options, new AbortController().signal), /timed out/);
});
test('a stuck decoder worker is terminated on abort', { timeout: 5000 }, async () => {
  const controller = new AbortController(), decode = createDecoder({ workerURL: blocked });
  const pending = decode(png(), 'image/png', options, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /stopped/);
});
test('decoder timeout releases an unsubmitted generation lock and owner recovery is not blocked', { timeout: 5000 }, async t => {
  let load;
  const f = await fixture(t, { serviceOptions: { prepareReferences: (...args) => load(...args) } });
  const uploads = join(f.root, 'uploads', '1'); await mkdir(uploads, { recursive: true });
  const path = join(uploads, 'reference.png'); await writeFile(path, png());
  load = referenceLoader(f.root, join(f.root, 'outputs'), createDecoder({ timeoutMs: 100, workerURL: blocked }));
  await assert.rejects(f.service.generate({ prompt: 'A lighthouse', preset: 'klein', reference_images: [path] }, f.api, f.context), /Reference preparation failed/);
  assert.equal(f.disk.snapshot().lock.active, undefined);
  assert.equal(f.service.isRunning('task:call'), false);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  await f.service.recover({ key: 'task:call' }, f.controller.signal, true);
});
