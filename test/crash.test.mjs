import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '../stable-diffusion/config.mjs';
import { createService } from '../stable-diffusion/service.mjs';
import { journal, Lock, completed, values } from './support.mjs';

for (const phase of ['unknown', 'known']) test(`SIGKILL at ${phase} submission boundary never causes a second POST`, { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sd-crash-')); t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [new URL('./crash-worker.mjs', import.meta.url).pathname, root, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject); child.on('exit', () => reject(new Error('worker ended before checkpoint')));
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('checkpoint')) resolve(); });
  });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const disk = await journal(join(root, 'journal.json')); let polls = 0;
  const service = createService(join(root, 'outputs'), Lock, () => configuration(values()), {
    fetch: async (_url, init) => { assert.equal(init.method, 'GET'); polls++; return completed(); },
  });
  const call = service.generate({ prompt: 'A lighthouse' }, disk.api(), { abortSignal: new AbortController().signal });
  if (phase === 'unknown') { await assert.rejects(call, /unknown/); assert.equal(polls, 0); assert.ok(disk.snapshot().lock.active); }
  else { assert.equal((await call).output[1].type, 'image'); assert.equal(polls, 1); assert.equal(disk.snapshot().lock.active, undefined); }
});
