import { deflateSync } from 'node:zlib';
import { mkdtemp, rm, writeFile, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, DEFAULT_PRESETS } from '../stable-diffusion/config.mjs';
import { createService } from '../stable-diffusion/service.mjs';

export function png(width = 512, height = 512) {
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); data.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))), chunk('IEND', Buffer.alloc(0))]);
}
export const values = () => ({ endpoint: 'http://127.0.0.1:8080', token: '', timeoutMinutes: 20, presets: DEFAULT_PRESETS });
export const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const ready = (revision = 1) => response({ state: 'ready', recipe: null, models: { diffusion_model: 'example.gguf' }, revision });
export const completed = () => response({ id: 'job_test', kind: 'img_gen', status: 'completed', result: { output_format: 'png', images: [{ b64_json: png().toString('base64') }] } });
export const Lock = Symbol('Lock');
// Disk journal implements serialized atomic commits and store-once call memos.
// Restart tests reopen this file with no in-memory state shared with the old API.
export async function journal(path) {
  let state = { lock: {}, memos: {} }, line = Promise.resolve();
  try { state = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const transact = (fn, context) => {
    const next = line.then(async () => {
      context.abortSignal.throwIfAborted();
      const draft = structuredClone(state); const result = await fn(draft);
      context.abortSignal.throwIfAborted();
      await writeFile(path + '.tmp', JSON.stringify(draft)); await rename(path + '.tmp', path); state = draft; return result;
    }); line = next.catch(() => {}); return next;
  };
  return { snapshot: () => structuredClone(state), api(taskId = 'task', callId = 'call') {
    const key = `${taskId}:${callId}`;
    return { taskId, callId, conversationId: 1,
      commit: (fn, context) => transact(draft => fn({ doc: async token => { if (token !== Lock) throw new Error('wrong token'); return draft.lock; } }), context),
      memo: async (name, ...rest) => {
        if (rest.length === 1) { rest[0].abortSignal.throwIfAborted(); return structuredClone(state.memos[key]?.[name]); }
        return transact(draft => { draft.memos[key] ??= {}; draft.memos[key][name] ??= rest[0]; return structuredClone(draft.memos[key][name]); }, rest[1]);
      },
    };
  } };
}
export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sd-extension-')); t.after(() => rm(root, { recursive: true, force: true }));
  const disk = await journal(join(root, 'journal.json')), calls = [], settings = values();
  const controller = new AbortController(), context = { abortSignal: controller.signal };
  const service = createService(join(root, 'outputs'), Lock, () => configuration(settings), {
    pollMs: 1, requestMs: 100, cancelMs: 10,
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (options.handler) return options.handler(url, init, calls);
      if (url.endsWith('/models/status')) return ready();
      if (init.method === 'POST' && url.endsWith('/img_gen')) return response({ id: 'job_test', kind: 'img_gen' }, 202);
      return completed();
    }, ...options.serviceOptions,
  });
  return { root, disk, calls, settings, service, controller, context, api: disk.api() };
}
