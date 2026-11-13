import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ready, response, png } from './support.mjs';
import { LIMITS } from '../stable-diffusion/service.mjs';
const args = { prompt: 'A lighthouse' };
for (const [name, mutate] of [
  ['wrong dimensions', result => { result.images[0].b64_json = png(64, 64).toString('base64'); }],
  ['invalid base64', result => { result.images[0].b64_json = '!bad'; }],
  ['truncated PNG', result => { result.images[0].b64_json = png().subarray(0, -12).toString('base64'); }],
  ['wrong format', result => { result.output_format = 'jpeg'; }],
  ['extra images', result => { result.images.push(result.images[0]); }],
]) test(`invalid output: ${name}`, async t => {
  let cancelled = false;
  const f = await fixture(t, { handler: (url) => {
    if (url.endsWith('/models/status')) return ready();
    if (url.endsWith('/img_gen')) return response({ id: 'job_test', kind: 'img_gen' }, 202);
    if (url.endsWith('/cancel')) { cancelled = true; return response({}); }
    const result = { output_format: 'png', images: [{ b64_json: png().toString('base64') }] }; mutate(result);
    return response({ id: 'job_test', kind: 'img_gen', status: 'completed', result });
  } });
  await assert.rejects(f.service.generate(args, f.api, f.context), /SD:/);
  assert.ok(cancelled); assert.equal(f.disk.snapshot().lock.active, undefined);
});
test('oversized streaming response is cancelled and leaves an unknown submission locked', async t => {
  let cancelled = false;
  const f = await fixture(t, { handler: url => {
    if (url.endsWith('/models/status')) return ready();
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1_000_000)); }, cancel() { cancelled = true; } }), { status: 202, headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(f.service.generate(args, f.api, f.context), /exceeded 24 MB/);
  assert.ok(cancelled); assert.ok(f.disk.snapshot().lock.active); assert.equal(LIMITS.json, 24_000_000);
});
test('HTTP submission timeout is bounded and never retried', async t => {
  const f = await fixture(t, { handler: (url, init) => {
    if (url.endsWith('/models/status')) return ready();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private network failure')), { once: true }));
  }, serviceOptions: { requestMs: 10 } });
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  await assert.rejects(f.service.generate(args, f.api, f.context), /timed out/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(f.disk.snapshot().lock.active);
});
test('user stop cancels known backend work but ended invocation cannot clear its durable lock', async t => {
  let stop, cancelled = false;
  const waitForPoll = new Promise(resolve => { stop = resolve; });
  const f = await fixture(t, { handler: (url, init) => {
    if (url.endsWith('/models/status')) return ready();
    if (url.endsWith('/img_gen')) return response({ id: 'job_test', kind: 'img_gen' }, 202);
    if (url.endsWith('/cancel')) { cancelled = true; return response({}); }
    if (cancelled) return response({ id: 'job_test', kind: 'img_gen', status: 'cancelled' });
    stop(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  } });
  const call = f.service.generate(args, f.api, f.context);
  await waitForPoll; f.controller.abort(); await assert.rejects(call, /stopped/);
  assert.ok(cancelled); assert.ok(f.disk.snapshot().lock.active);
  await f.service.recover(f.disk.snapshot().lock.active, new AbortController().signal, false);
});
