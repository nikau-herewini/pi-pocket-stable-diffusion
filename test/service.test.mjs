import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '../stable-diffusion/config.mjs';
import { createService, MEMO } from '../stable-diffusion/service.mjs';
import { fixture, journal, Lock, ready, response, completed } from './support.mjs';

const args = { prompt: 'A small lighthouse', seed: 42 };
test('generates one persisted image, then replays from disk without any network calls', async t => {
  const f = await fixture(t);
  const result = await f.service.generate(args, f.api, f.context);
  assert.equal(result.output[1].type, 'image'); assert.equal(f.disk.snapshot().lock.active, undefined);
  assert.ok((await readFile(result.details.path)).length > 45);
  const reopened = await journal(join(f.root, 'journal.json'));
  const service = createService(join(f.root, 'outputs'), Lock, () => { throw new Error('settings unavailable'); }, { fetch: () => { throw new Error('must not fetch'); } });
  assert.deepEqual(await service.generate(args, reopened.api(), f.context), result);
  await writeFile(result.details.path, 'changed');
  await assert.rejects(service.generate(args, reopened.api(), f.context), /missing or changed/);
});
test('bearer credentials stay in headers, redirects are refused, and proxy prefixes work', async t => {
  const f = await fixture(t); f.settings.token = 'test-token'; f.settings.endpoint = 'https://example.org/sd';
  await f.service.generate(args, f.api, f.context);
  assert.ok(f.calls.every(c => c.url.startsWith('https://example.org/sd/sdcpp/') && c.redirect === 'error' && c.headers.Authorization === 'Bearer test-token'));
  assert.ok(!JSON.stringify(f.disk.snapshot()).includes('test-token'));
});
test('lost submission reply keeps its lock and never POSTs again on replay', async t => {
  const f = await fixture(t, { handler: (url) => { if (url.endsWith('/models/status')) return ready(); throw new Error('secret backend error'); } });
  await assert.rejects(f.service.generate(args, f.api, f.context), /Backend request failed/);
  assert.ok(f.disk.snapshot().lock.active);
  const count = f.calls.length;
  await assert.rejects(f.service.generate(args, f.api, f.context), /outcome is unknown/);
  assert.equal(f.calls.length, count);
  await assert.rejects(f.service.generate(args, f.disk.api('other'), f.context), /busy/);
});
test('known jobs resume with stored settings and no model probe or submission', async t => {
  const f = await fixture(t);
  const config = configuration(f.settings);
  await f.api.memo(MEMO.plan, { connection: config.connection, preset: { name: 'original', width: 512, height: 512 }, model: 'original' }, f.context);
  await f.api.memo(MEMO.started, true, f.context);
  await f.api.commit(async tx => { (await tx.doc(Lock)).active = { key: 'task:call', jobId: 'job_test', connection: config.connection, deadline: Date.now() + 1000 }; }, f.context);
  f.settings.presets = JSON.stringify({ replacement: { ...JSON.parse(f.settings.presets).klein, label: 'Replacement' } });
  const result = await f.service.generate(args, f.api, f.context);
  assert.equal(result.details.preset.name, 'original'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
});
test('connection changes never poll, cancel or resubmit on the replacement backend', async t => {
  const f = await fixture(t, { handler: url => { if (url.endsWith('/models/status')) return ready(); throw new Error(); } });
  await assert.rejects(f.service.generate(args, f.api, f.context));
  f.settings.endpoint = 'https://example.org/replacement'; const count = f.calls.length;
  await assert.rejects(f.service.generate(args, f.api, f.context), /Connection settings changed/);
  assert.equal(f.calls.length, count);
});
test('model transitions during preparation prevent submission and release the unsubmitted lock', async t => {
  let revision = 0;
  const f = await fixture(t, { handler: () => ready(++revision) });
  await assert.rejects(f.service.generate(args, f.api, f.context), /model changed/);
  assert.ok(f.calls.every(c => c.method === 'GET')); assert.equal(f.disk.snapshot().lock.active, undefined);
});
test('backend errors are sanitized, saved, and never repeated', async t => {
  const f = await fixture(t, { handler: (url, init) => {
    if (url.endsWith('/models/status')) return ready();
    if (init.method === 'POST') return response({ id: 'job_test', kind: 'img_gen' }, 202);
    return response({ id: 'job_test', kind: 'img_gen', status: 'failed', error: 'private backend details' });
  } });
  await assert.rejects(f.service.generate(args, f.api, f.context), /^Error: SD: Generation failed\.$/);
  assert.equal(f.disk.snapshot().lock.active, undefined);
  const count = f.calls.length; await assert.rejects(f.service.generate(args, f.api, f.context), /Generation failed/); assert.equal(f.calls.length, count);
});
for (const [name, submission] of [
  ['unsafe id', () => response({ id: '../../secret', kind: 'img_gen' }, 202)],
  ['HTTP error', () => response({ error: 'secret' }, 401)],
  ['non-JSON', () => new Response('secret', { status: 202 })],
  ['invalid JSON', () => new Response('{', { status: 202, headers: { 'content-type': 'application/json' } })],
]) test(`${name} leaves uncertain submissions locked`, async t => {
  const f = await fixture(t, { handler: url => url.endsWith('/models/status') ? ready() : submission() });
  await assert.rejects(f.service.generate(args, f.api, f.context), error => !error.message.includes('secret'));
  assert.ok(f.disk.snapshot().lock.active); const count = f.calls.length;
  await assert.rejects(f.service.generate(args, f.api, f.context), /unknown/); assert.equal(f.calls.length, count);
});
test('reference order and hashes survive replay; failed preparation never submits', async t => {
  const refs = [{ sha256: 'one' }, { sha256: 'two' }];
  const f = await fixture(t, { serviceOptions: { prepareReferences: async paths => { assert.deepEqual(paths, ['/one', '/two']); return { images: ['data:first', 'data:second'], references: refs }; } } });
  const result = await f.service.generate({ ...args, preset: 'klein', reference_images: ['/one', '/two'] }, f.api, f.context);
  assert.deepEqual(result.details.references, refs);
  const submitted = JSON.parse(f.calls.find(c => c.method === 'POST').body); assert.deepEqual(submitted.ref_images, ['data:first', 'data:second']);
  const broken = await fixture(t, { serviceOptions: { prepareReferences: async () => { throw new Error('private path'); } } });
  await assert.rejects(broken.service.generate({ ...args, preset: 'klein', reference_images: ['/missing'] }, broken.api, broken.context), /Reference preparation failed/);
  assert.equal(broken.disk.snapshot().lock.active, undefined); assert.ok(broken.calls.every(c => c.method === 'GET'));
});
test('deadline is not renewed and cancellation acknowledgement alone does not release a lock', async t => {
  const f = await fixture(t, { handler: (_url, init) => init.method === 'POST' ? response({}) : response({ id: 'job_test', kind: 'img_gen', status: 'generating' }) });
  const connection = configuration(f.settings).connection;
  await f.api.memo(MEMO.started, true, f.context);
  await f.api.memo(MEMO.plan, { connection }, f.context);
  await f.api.commit(async tx => { (await tx.doc(Lock)).active = { key: 'task:call', jobId: 'job_test', connection, deadline: Date.now() - 1 }; }, f.context);
  await assert.rejects(f.service.generate(args, f.api, f.context), /deadline expired/);
  assert.ok(f.disk.snapshot().lock.active); assert.ok(f.calls.some(c => c.url.endsWith('/cancel')));
});
test('recovery requires terminal backend state; reset does not contact a replacement backend', async t => {
  const f = await fixture(t, { handler: () => response({ id: 'job_test', kind: 'img_gen', status: 'generating' }) });
  const active = { key: 'old:call', jobId: 'job_test', connection: configuration(f.settings).connection };
  await assert.rejects(f.service.recover(active, f.controller.signal, false), /not terminal/);
  f.settings.endpoint = 'https://example.org/other';
  await assert.rejects(f.service.recover(active, f.controller.signal, false), /Restore/);
  const count = f.calls.length; await f.service.recover(active, f.controller.signal, true); assert.equal(f.calls.length, count);
});
test('terminal cancellation releases the lock', async t => {
  const f = await fixture(t, { handler: (url, init) => {
    if (url.endsWith('/models/status')) return ready();
    if (url.endsWith('/img_gen')) return response({ id: 'job_test', kind: 'img_gen' }, 202);
    if (url.endsWith('/cancel')) return response({});
    if (init.signal.aborted) throw new Error('aborted');
    return response({ id: 'job_test', kind: 'img_gen', status: 'cancelled' });
  } });
  await assert.rejects(f.service.generate(args, f.api, f.context), /cancelled/);
  assert.equal(f.disk.snapshot().lock.active, undefined);
});
test('busy calls do not queue across conversations', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { handler: async (url, init) => {
    if (url.endsWith('/models/status')) { await gate; return ready(); }
    return init.method === 'POST' ? response({ id: 'job_test', kind: 'img_gen' }, 202) : completed();
  } });
  const first = f.service.generate(args, f.api, f.context);
  while (!f.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(f.service.generate(args, f.disk.api('other'), f.context), /busy/);
  release(); await first;
});
