import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { hash } from './config.mjs';

export const REFERENCE_LIMITS = Object.freeze({ count: 3, bytes: 8_000_000, total: 16_000_000, pixels: 16_000_000, edge: 1024, encoded: 2_000_000 });
export function dimensions(bytes) {
  let width, height, mimeType;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mimeType = 'image/png';
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mimeType = 'image/webp';
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && !(bytes[20] & 2)) { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
  } else if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = 'image/jpeg';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
  }
  if (!width || !height || width * height > REFERENCE_LIMITS.pixels) throw new Error('Reference must be PNG, JPEG, or static WebP, with at most 16 million pixels.');
  return { width, height, mimeType };
}

export function referenceLoader(dataDir, outputDir, resizeImage) {
  return async (paths, conversationId, signal) => {
    if (!Array.isArray(paths) || paths.length > 3) throw new Error('Provide up to 3 ordered local reference paths.');
    const images = [], references = [];
    const roots = await Promise.all([join(dataDir, 'uploads', String(conversationId)), outputDir].map(p => realpath(p).catch(() => undefined)));
    let total = 0;
    for (const path of paths) {
      signal.throwIfAborted();
      if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0')) throw new Error('References must be absolute local file paths.');
      let canonical, bytes;
      try {
        canonical = await realpath(path);
        if (!roots.some(root => root && canonical.startsWith(root + sep))) throw new Error();
        const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > REFERENCE_LIMITS.bytes) throw new Error();
          bytes = Buffer.alloc(stat.size + 1);
          let count = 0;
          while (count < bytes.length) {
            signal.throwIfAborted();
            const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
            if (!bytesRead) break;
            count += bytesRead;
          }
          if (count !== stat.size) throw new Error();
          bytes = bytes.subarray(0, count);
        } finally { await file.close(); }
      } catch { throw new Error('Reference is unavailable, exceeds 8 MB, or is outside this conversation’s uploads and this extension’s outputs.'); }
      total += bytes.length;
      if (total > REFERENCE_LIMITS.total) throw new Error('References exceed the combined 16 MB limit.');
      const info = dimensions(bytes);
      // Force pixel normalization for small EXIF images: the public processor
      // can otherwise return their original bytes with orientation tags intact.
      const exif = (info.mimeType === 'image/jpeg' && bytes.includes(Buffer.from('Exif\0\0'))) || (info.mimeType === 'image/webp' && bytes.includes(Buffer.from('EXIF')));
      const longest = Math.max(info.width, info.height);
      const edge = exif && longest > 1 ? Math.min(REFERENCE_LIMITS.edge, longest - 1) : REFERENCE_LIMITS.edge;
      let normalized;
      try {
        const resized = await resizeImage(bytes, info.mimeType, { maxWidth: edge, maxHeight: edge, maxBytes: REFERENCE_LIMITS.encoded });
        if (!resized || typeof resized.data !== 'string' || resized.data.length > REFERENCE_LIMITS.encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(resized.data)) throw new Error();
        normalized = Buffer.from(resized.data, 'base64');
        const out = dimensions(normalized);
        if (normalized.toString('base64') !== resized.data || out.mimeType !== resized.mimeType || Math.max(out.width, out.height) > edge) throw new Error();
        images.push(`data:${out.mimeType};base64,${resized.data}`);
        references.push({ sha256: hash(bytes), normalizedSha256: hash(normalized), width: out.width, height: out.height });
      } catch { throw new Error('Reference could not be safely decoded and resized.'); }
      signal.throwIfAborted();
    }
    return { images, references };
  };
}
