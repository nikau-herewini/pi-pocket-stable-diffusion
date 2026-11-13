import { Worker } from 'node:worker_threads';

export const DECODE_MS = 30_000;
export function createDecoder({ timeoutMs = DECODE_MS, workerURL = new URL('./decode-worker.mjs', import.meta.url) } = {}) {
  return async (bytes, mimeType, options, signal) => {
    signal.throwIfAborted();
    const data = Uint8Array.from(bytes).buffer;
    const worker = new Worker(workerURL, {
      workerData: { data, mimeType, options }, transferList: [data],
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    });
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = async (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        worker.removeAllListeners();
        // Resolve only after the worker stops, so the caller can safely release
        // its lock. A Promise.race would leave decoder work running in the background.
        try { await worker.terminate(); } catch { error = new Error('Reference decoder could not be stopped.'); }
        if (error) reject(error); else resolve(result);
      };
      const abort = () => { void finish(new Error('Reference decoding stopped.')); };
      worker.on('message', message => { void finish(message?.error || !message?.result ? new Error('Reference decoding failed.') : undefined, message?.result); });
      worker.on('error', () => { void finish(new Error('Reference decoding failed.')); });
      worker.on('exit', () => { void finish(new Error('Reference decoder exited before producing a result.')); });
      timer = setTimeout(() => { void finish(new Error('Reference decoding timed out.')); }, timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  };
}
