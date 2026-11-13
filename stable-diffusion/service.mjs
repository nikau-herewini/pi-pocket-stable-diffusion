import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { hash, planRequest } from './config.mjs';

const PREFIX = 'x.stable-diffusion.';
export const MEMO = Object.freeze({ plan: PREFIX + 'plan', started: PREFIX + 'started', outcome: PREFIX + 'outcome', references: PREFIX + 'references' });
export const LIMITS = Object.freeze({ json: 24_000_000, image: 16_000_000, requestMs: 15_000, cancelMs: 15_000, pollMs: 2000 });
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const validId = id => typeof id === 'string' && /^job_[A-Za-z0-9_-]{1,120}$/.test(id);
// This set records only local liveness. The durable document owns the lock.
const running = new Set();
const fail = message => { throw new Error(`SD: ${message}`); };

export function validatePNG(bytes, preset) {
  if (bytes.length < 45 || bytes.length > LIMITS.image || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== preset.width || bytes.readUInt32BE(20) !== preset.height) fail('Backend returned an invalid PNG or unexpected dimensions.');
  let offset = 8, data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) break;
    if (kind === 'IDAT') data = true;
    offset += length + 12;
    if (kind === 'IEND' && length === 0 && data && offset === bytes.length) return;
  }
  fail('Backend returned a truncated or invalid PNG.');
}

export function createService(directory, Lock, getConfig, options = {}) {
  const http = options.fetch ?? fetch;
  const pollMs = options.pollMs ?? LIMITS.pollMs;
  const requestMs = options.requestMs ?? LIMITS.requestMs;
  const cancelMs = options.cancelMs ?? LIMITS.cancelMs;
  async function json(config, path, method, signal, expected = 200, body) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(requestMs)]);
    try {
      const response = await http(config.endpoint + path, { method, redirect: 'error', signal: bounded,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status !== expected || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        await response.body?.cancel(); fail(`Backend returned HTTP ${response.status} or a non-JSON response.`);
      }
      const reader = response.body?.getReader();
      if (!reader) fail('Backend returned an empty response.');
      const chunks = []; let count = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          count += value.byteLength;
          if (count > LIMITS.json) fail('Backend response exceeded 24 MB.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Backend returned invalid JSON.'); }
    } catch (error) {
      if (bounded.aborted) fail('Backend request timed out or stopped.');
      if (error instanceof Error && error.message.startsWith('SD:')) throw error;
      fail('Backend request failed. Check the connection and authentication.');
    }
  }
  async function model(config, signal) {
    const status = await json(config, '/sdcpp/v1/models/status', 'GET', signal);
    if (status?.state !== 'ready' || !status.models || typeof status.models !== 'object' || Array.isArray(status.models)) fail('Backend model is not ready or its status API is unsupported.');
    // Never return model paths or raw status/error fields to the model provider.
    return hash({ recipe: status.recipe ?? null, models: status.models, revision: status.revision ?? null, origin: status.origin ?? null });
  }
  async function job(config, id, signal) {
    if (!validId(id)) fail('Invalid job identifier.');
    const current = await json(config, `/sdcpp/v1/jobs/${id}`, 'GET', signal);
    if (current?.id !== id || current.kind !== 'img_gen' || !['queued', 'generating', 'completed', 'failed', 'cancelled'].includes(current.status)) fail('Backend returned an invalid job status.');
    return current;
  }
  async function cancel(config, id) {
    const signal = AbortSignal.timeout(cancelMs);
    try {
      await json(config, `/sdcpp/v1/jobs/${id}/cancel`, 'POST', signal);
      while (true) {
        if (terminal((await job(config, id, signal)).status)) return true;
        await sleep(pollMs, undefined, { signal });
      }
    } catch { return false; }
  }
  async function clear(api, context, key) {
    await api.commit(async tx => { const lock = await tx.doc(Lock); if (lock.active?.key === key) delete lock.active; }, context);
  }
  async function persist(key, bytes, plan, references) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, hash(key) + '.png'), temp = path + '.' + randomUUID() + '.tmp';
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temp, { force: true }); }
    return { path, sha256: hash(bytes), preset: plan.preset, model: plan.model, references };
  }
  async function result(saved) {
    if (saved.error) fail(saved.error);
    let bytes;
    try {
      const file = await open(saved.path, 'r');
      try {
        if ((await file.stat()).size > LIMITS.image) throw new Error();
        bytes = await file.readFile();
      } finally { await file.close(); }
      validatePNG(bytes, saved.preset);
      if (hash(bytes) !== saved.sha256) throw new Error();
    } catch { fail('Saved image is missing or changed. It will not be generated again automatically.'); }
    return { output: [
      { type: 'text', text: `Generated ${saved.preset.width}×${saved.preset.height} PNG using preset ${saved.preset.name}. Saved: ${saved.path}` },
      { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
    ], details: { path: saved.path, sha256: saved.sha256, preset: saved.preset, modelFingerprint: saved.model, references: saved.references } };
  }
  return {
    isRunning: key => running.has(key),
    async generate(args, api, context) {
      const key = `${api.taskId}:${api.callId}`;
      const saved = await api.memo(MEMO.outcome, context);
      if (saved) { await clear(api, context, key); return result(saved); }
      const config = getConfig();
      const started = await api.memo(MEMO.started, context);
      let plan = await api.memo(MEMO.plan, context);
      if (plan && plan.connection !== config.connection) fail('Connection settings changed. Restore them to resume this call, or use owner recovery.');
      if (!plan) plan = planRequest(args, config);
      if (running.has(key)) fail('This request is already running.');
      running.add(key);
      let active, submissionStarted = Boolean(started), outcomeSaved = false;
      try {
        await api.commit(async tx => {
          const lock = await tx.doc(Lock);
          if (lock.active && lock.active.key !== key) fail('Image generation is busy or needs recovery. Use /sd-status.');
          if (!lock.active) {
            if (started) fail('This call was submitted or stopped. It will not be submitted again.');
            lock.active = { key, deadline: Date.now() + config.timeoutMs, connection: config.connection };
          }
          active = { ...lock.active };
        }, context);
        if (active.connection !== config.connection) fail('The locked request belongs to another connection. Restore its settings or use owner recovery.');
        if (active.deadline <= Date.now()) fail('Generation deadline expired.');
        const signal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(Math.max(1, active.deadline - Date.now()))]);
        let references = await api.memo(MEMO.references, context) ?? [];
        if (!active.jobId) {
          if (started) fail('Submission outcome is unknown. Owner recovery is required; do not retry.');
          const identity = await model(config, signal);
          if (plan.model && plan.model !== identity) fail('Backend model changed after preparation. Start a new call.');
          plan = await api.memo(MEMO.plan, { ...plan, model: identity }, context);
          const body = structuredClone(plan.body);
          if (args.reference_images?.length) {
            if (!plan.preset.references || !options.prepareReferences) fail('Reference images are unavailable for this preset.');
            let prepared;
            try { prepared = await options.prepareReferences(args.reference_images, api.conversationId, signal); }
            catch { fail('Reference preparation failed. Check local paths, image format, and input limits.'); }
            const receipt = await api.memo(MEMO.references, prepared.references, context);
            if (JSON.stringify(receipt) !== JSON.stringify(prepared.references)) fail('Reference inputs changed after preparation. Start a new call.');
            references = receipt; body.ref_images = prepared.images;
          } else if (references.length) fail('Reference inputs changed after preparation. Start a new call.');
          // Close most of the preparation window. Other clients must not switch
          // model files in place; the API does not provide content hashes or a lease.
          if (await model(config, signal) !== plan.model) fail('Backend model changed during preparation. Start a new call.');
          signal.throwIfAborted();
          submissionStarted = true;
          await api.memo(MEMO.started, true, context);
          const accepted = await json(config, '/sdcpp/v1/img_gen', 'POST', signal, 202, body);
          if (!validId(accepted?.id) || accepted.kind !== 'img_gen') fail('Backend returned an invalid job identifier.');
          active.jobId = accepted.id;
          await api.commit(async tx => {
            const lock = await tx.doc(Lock);
            if (lock.active?.key !== key) fail('Request lost its generation lock.');
            lock.active.jobId = active.jobId;
          }, context);
        }
        while (true) {
          signal.throwIfAborted();
          const current = await job(config, active.jobId, signal);
          if (current.status === 'completed') {
            if (current.result?.output_format !== 'png' || current.result.images?.length !== 1) fail('Backend must return exactly 1 PNG.');
            const b64 = current.result.images[0].b64_json;
            if (typeof b64 !== 'string' || b64.length > Math.ceil(LIMITS.image / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) fail('Invalid or oversized image data.');
            const bytes = Buffer.from(b64, 'base64');
            if (bytes.toString('base64') !== b64) fail('Invalid image encoding.');
            validatePNG(bytes, plan.preset);
            const receipt = await api.memo(MEMO.outcome, await persist(key, bytes, plan, references), context);
            outcomeSaved = true;
            await clear(api, context, key);
            return result(receipt);
          }
          if (terminal(current.status)) {
            const receipt = await api.memo(MEMO.outcome, { error: `Generation ${current.status}.` }, context);
            outcomeSaved = true;
            await clear(api, context, key);
            return result(receipt);
          }
          await sleep(pollMs, undefined, { signal });
        }
      } catch (error) {
        if (!outcomeSaved && active?.jobId && active.connection === config.connection && await cancel(config, active.jobId)) {
          try {
            await api.memo(MEMO.outcome, { error: 'Generation stopped after an error, timeout, or cancellation.' }, context);
            await clear(api, context, key);
          } catch { /* Ended capabilities cannot write. Owner recovery can inspect the terminal job. */ }
        } else if (active && !submissionStarted) {
          try { await clear(api, context, key); } catch { /* Preserve a lock if the call ended. */ }
        }
        if (error instanceof Error && error.message.startsWith('SD:')) throw error;
        fail('Generation stopped or failed. Use /sd-status if its lock remains.');
      } finally { running.delete(key); }
    },
    async inspect(active, signal) {
      if (!active) return 'Stable Diffusion is idle.';
      let status = 'unknown';
      try {
        const config = getConfig();
        if (active.connection !== config.connection) status = 'connection settings changed';
        else if (active.jobId) status = (await job(config, active.jobId, signal)).status;
      } catch { /* No backend bodies, URLs, or secrets in status output. */ }
      return `Lock: ${active.key}\nJob: ${active.jobId ?? 'unknown; submission may have been accepted'}\nStatus: ${status}\nDeadline: ${new Date(active.deadline).toISOString()}`;
    },
    async recover(active, signal, reset) {
      if (running.has(active.key)) fail('Stop the local image call before recovery.');
      if (reset) return;
      const config = getConfig();
      if (active.connection !== config.connection) fail('Restore the original connection settings, or restart the original backend and use /sd-reset.');
      if (!active.jobId) fail('Submission outcome is unknown. Restart the backend, then use /sd-reset.');
      if (!terminal((await job(config, active.jobId, signal)).status)) fail('Backend job is not terminal. Wait or cancel it through the backend.');
    },
  };
}
