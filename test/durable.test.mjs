import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import create, { ImageLock } from '../stable-diffusion.ts';
import { values, completed } from './support.mjs';
import { configuration } from '../stable-diffusion/config.mjs';

const context = BACKGROUND_CONTEXT;
test('real Pi Durable stores one lock across conversations and reopening; owner recovery uses the real commit host', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sd-real-durable-'));
  const options = { models: createModels(), registry: createRegistry() };
  let harness = await Harness.open(await openNodeJsonlStorage(directory, context), options, context);
  t.after(async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); });
  const root = await harness.root(context);
  const other = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  await root.commit(async tx => { (await tx.doc(ImageLock)).active = { key: 'task:call', connection: 'original-connection', deadline: Date.now() + 10000 }; }, context);
  const shared = await other.commit(async tx => (await tx.doc(ImageLock)).active.key, context);
  assert.equal(shared, 'task:call');
  await harness.close(context);
  harness = await Harness.open(await openNodeJsonlStorage(directory, context), options, context);
  assert.equal((await harness.snapshot(ImageLock, context)).active.key, 'task:call');
  const commands = new Map(), settings = values();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => { assert.equal(init.method, 'GET'); return completed(); };
    create({ dataDir: '/tmp/example-data' }, {
      settings() {}, setting: name => settings[name], command: (name, command) => commands.set(name, command),
      error: (_code, message) => new Error(message),
    });
  } finally { globalThis.fetch = originalFetch; }
  const commandContext = {
    user: { role: 'owner' }, context, signal: new AbortController().signal,
    snapshot: (...args) => harness.snapshot(...args), commit: fn => harness.commit(fn, context),
  };
  await assert.rejects(commands.get('sd-reset').handler('wrong:key backend-restarted', commandContext), /Lock changed/);
  const result = await commands.get('sd-reset').handler('task:call backend-restarted', commandContext);
  assert.equal(result.type, 'toast');
  assert.equal((await harness.snapshot(ImageLock, context)).active, undefined);
  await harness.commit(async tx => { (await tx.doc(ImageLock)).active = {
    key: 'second:call', connection: configuration(settings).connection, jobId: 'job_test', deadline: Date.now() + 10000,
  }; }, context);
  assert.equal((await commands.get('sd-recover').handler('second:call', commandContext)).type, 'toast');
  assert.equal((await harness.snapshot(ImageLock, context)).active, undefined);
});
