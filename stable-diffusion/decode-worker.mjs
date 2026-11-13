import { parentPort, workerData } from 'node:worker_threads';
import { resizeImage } from '@earendil-works/pi-coding-agent';

try {
  const result = await resizeImage(Buffer.from(workerData.data), workerData.mimeType, workerData.options);
  parentPort.postMessage({ result });
} catch {
  // Do not send decoder diagnostics, input bytes, or paths to the parent.
  parentPort.postMessage({ error: true });
}
