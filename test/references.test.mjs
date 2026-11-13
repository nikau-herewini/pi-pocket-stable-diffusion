import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { referenceLoader, dimensions } from '../stable-diffusion/references.mjs';
import { createDecoder } from '../stable-diffusion/decode.mjs';
import { png } from './support.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'sd-reference-')); t.after(() => rm(root, { recursive: true, force: true }));
  const uploads = join(root, 'uploads', '1'), outputs = join(root, 'extensions', 'stable-diffusion', 'outputs');
  await mkdir(uploads, { recursive: true }); await mkdir(outputs, { recursive: true });
  return { root, uploads, outputs, signal: new AbortController().signal, load: referenceLoader(root, outputs, createDecoder()) };
}
test('real image processor normalizes ordered uploads and generated outputs', async t => {
  const f = await setup(t); const a = join(f.uploads, 'wide.png'), b = join(f.outputs, 'tall.png');
  await writeFile(a, png(1600, 800)); await writeFile(b, png(600, 1200));
  const result = await f.load([a, b], 1, f.signal);
  assert.deepEqual(result.references.map(r => [r.width, r.height]), [[1024, 512], [512, 1024]]);
  assert.equal(result.images.length, 2); assert.notEqual(result.references[0].sha256, result.references[1].sha256);
});
test('arbitrary files, other conversations, traversal, and escaping symlinks are rejected', async t => {
  const f = await setup(t), outside = join(f.root, 'secret.png'); await writeFile(outside, png());
  await mkdir(join(f.root, 'uploads', '2')); const other = join(f.root, 'uploads', '2', 'other.png'); await writeFile(other, png());
  const link = join(f.uploads, 'link.png'); await symlink(outside, link);
  for (const path of [outside, other, link, join(f.uploads, '..', '..', 'secret.png')]) await assert.rejects(f.load([path], 1, f.signal), /outside/);
  for (const path of ['relative.png', 'https://example.org/image.png', '/bad\0name']) await assert.rejects(f.load([path], 1, f.signal), /absolute/);
  await assert.rejects(f.load(['/a', '/b', '/c', '/d'], 1, f.signal), /up to 3/);
});
test('size and pixel limits apply before decoding; corrupt compressed data is rejected by the real decoder', async t => {
  const f = await setup(t), path = join(f.uploads, 'input.png');
  await writeFile(path, Buffer.alloc(8_000_001)); await assert.rejects(f.load([path], 1, f.signal), /8 MB/);
  await writeFile(path, Buffer.alloc(0)); await assert.rejects(f.load([path], 1, f.signal), /8 MB/);
  const header = png().subarray(0, 33); header.writeUInt32BE(100000, 16);
  await writeFile(path, header); await assert.rejects(f.load([path], 1, f.signal), /16 million/);
  await writeFile(path, png().subarray(0, 33)); await assert.rejects(f.load([path], 1, f.signal), /decoded/);
});
test('combined size is bounded even for repeated paths', async t => {
  const f = await setup(t), path = join(f.uploads, 'input.png');
  const bytes = Buffer.concat([png(64, 64), Buffer.alloc(7_900_000)]); await writeFile(path, bytes);
  // Use an identity decoder so this test targets the byte counter, not a codec’s trailing-data rules.
  const load = referenceLoader(f.root, f.outputs, async () => ({ data: png(64, 64).toString('base64'), mimeType: 'image/png' }));
  await assert.rejects(load([path, path, path], 1, f.signal), /combined/);
});
test('real processor accepts static WebP and rejects animated WebP headers', async t => {
  const f = await setup(t), path = join(f.uploads, 'pixel.webp');
  await writeFile(path, Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
  assert.equal((await f.load([path], 1, f.signal)).references.length, 1);
  const animated = Buffer.alloc(30); animated.write('RIFF'); animated.write('WEBP', 8); animated.write('VP8X', 12); animated[20] = 2;
  assert.throws(() => dimensions(animated), /static WebP/);
});
test('small EXIF JPEG references encode orientation in pixels', async t => {
  const f = await setup(t), path = join(f.uploads, 'rotated.jpg');
  // Make the public processor choose JPEG by restricting its byte target.
  const { randomBytes } = await import('node:crypto');
  // Re-encode an image through a temporary PNG with random RGB data.
  const { deflateSync } = await import('node:zlib');
  const original = png(512, 256);
  // Build a valid noisy PNG by replacing the IDAT chunk and CRC.
  const pixels = randomBytes(256 * (1 + 512 * 3)); for (let row = 0; row < 256; row++) pixels[row * (1 + 512 * 3)] = 0;
  const compressed = deflateSync(pixels), chunk = Buffer.alloc(compressed.length + 12); chunk.writeUInt32BE(compressed.length); chunk.write('IDAT', 4); compressed.copy(chunk, 8);
  let crc = 0xffffffff; for (const byte of chunk.subarray(4, -4)) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  const jpeg = await resizeImage(Buffer.concat([original.subarray(0, 33), chunk, original.subarray(-12)]), 'image/png', { maxWidth: 512, maxHeight: 512, maxBytes: 200000 });
  assert.equal(jpeg.mimeType, 'image/jpeg');
  const tiff = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const exif = Buffer.alloc(tiff.length + 4); exif.writeUInt16BE(0xffe1); exif.writeUInt16BE(tiff.length + 2, 2); tiff.copy(exif, 4);
  const bytes = Buffer.from(jpeg.data, 'base64'); await writeFile(path, Buffer.concat([bytes.subarray(0, 2), exif, bytes.subarray(2)]));
  const normalized = await f.load([path], 1, f.signal);
  assert.ok(normalized.references[0].height > normalized.references[0].width);
  assert.ok(!Buffer.from(normalized.images[0].split(',')[1], 'base64').includes(Buffer.from('Exif\0\0')));
});
