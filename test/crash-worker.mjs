import { join } from 'node:path';
import { configuration } from '../stable-diffusion/config.mjs';
import { createService } from '../stable-diffusion/service.mjs';
import { journal, Lock, ready, response, values } from './support.mjs';

const [root, phase] = process.argv.slice(2);
const disk = await journal(join(root, 'journal.json'));
const service = createService(join(root, 'outputs'), Lock, () => configuration(values()), {
  requestMs: 30000,
  fetch: async (url) => {
    if (url.endsWith('/models/status')) return ready();
    if (url.endsWith('/img_gen')) {
      if (phase === 'unknown') { process.stdout.write('checkpoint\n'); await new Promise(() => {}); }
      return response({ id: 'job_test', kind: 'img_gen' }, 202);
    }
    process.stdout.write('checkpoint\n'); await new Promise(() => {});
  },
});
// Keep the mock process alive until the parent kills it at a durable boundary.
setInterval(() => {}, 1000);
await service.generate({ prompt: 'A lighthouse' }, disk.api(), { abortSignal: new AbortController().signal });
