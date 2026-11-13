import { createHash } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
export const DEFAULT_PRESETS = JSON.stringify({
  standard: { label: 'Standard diffusion', width: 512, height: 512, steps: 20, sampler: 'euler', scheduler: 'discrete', cfg: 7, negativePrompt: true, references: false },
  klein: { label: 'Distilled Klein', width: 512, height: 512, steps: 4, sampler: 'euler', scheduler: 'flux2', cfg: 1, negativePrompt: false, references: true },
}, null, 2);
const fail = () => { throw new Error('Invalid Stable Diffusion settings. Check the endpoint, token, timeout, and preset JSON.'); };
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
export function configuration(values) {
  let url;
  try { url = new URL(values.endpoint); } catch { fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail();
  const endpoint = url.href.replace(/\/+$/, '');
  const token = values.token ?? '';
  if (typeof token !== 'string' || /[^\x21-\x7e]/.test(token)) fail();
  if (!integer(values.timeoutMinutes, 1, 120)) fail();
  let presets;
  try { presets = JSON.parse(values.presets); } catch { fail(); }
  if (!presets || Array.isArray(presets) || typeof presets !== 'object' || Object.keys(presets).length < 1 || Object.keys(presets).length > 16) fail();
  const fields = new Set(['label', 'width', 'height', 'steps', 'sampler', 'scheduler', 'cfg', 'negativePrompt', 'references']);
  for (const [name, p] of Object.entries(presets)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name) || !p || Array.isArray(p) || typeof p !== 'object' || Object.keys(p).some(k => !fields.has(k))) fail();
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 100 || /[\x00-\x1f\x7f]/.test(p.label)) fail();
    if (![p.width, p.height].every(v => integer(v, 64, 2048) && v % 64 === 0) || p.width * p.height > 4_194_304) fail();
    if (!integer(p.steps, 1, 150) || !Number.isFinite(p.cfg) || p.cfg < 0 || p.cfg > 30) fail();
    if (![p.sampler, p.scheduler].every(v => typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v))) fail();
    if (typeof p.negativePrompt !== 'boolean' || typeof p.references !== 'boolean') fail();
  }
  return { endpoint, token, presets, timeoutMs: values.timeoutMinutes * 60_000, connection: hash([endpoint, token]) };
}

export function planRequest(args, config) {
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 4000) throw new Error('Prompt must contain 1 to 4000 characters.');
  const name = args.preset ?? Object.keys(config.presets)[0];
  if (!Object.hasOwn(config.presets, name)) throw new Error('Unknown preset. Use sd_presets to list configured presets.');
  const preset = config.presets[name];
  if (args.seed !== undefined && !integer(args.seed, -1, 2_147_483_647)) throw new Error('Seed must be an integer from -1 to 2147483647.');
  if (args.negative_prompt !== undefined && (!preset.negativePrompt || typeof args.negative_prompt !== 'string' || args.negative_prompt.length > 4000)) throw new Error('This preset does not accept this negative prompt.');
  if (args.reference_images !== undefined && (!Array.isArray(args.reference_images) || args.reference_images.length > 3 || args.reference_images.some(p => typeof p !== 'string'))) throw new Error('Provide up to 3 ordered local reference paths.');
  if (args.reference_images?.length && !preset.references) throw new Error('This preset does not support reference images.');
  return {
    connection: config.connection, preset: { name, ...preset },
    body: { prompt: args.prompt.trim(), ...(args.negative_prompt === undefined ? {} : { negative_prompt: args.negative_prompt }),
      seed: args.seed ?? -1, width: preset.width, height: preset.height, batch_count: 1,
      sample_params: { sample_steps: preset.steps, sample_method: preset.sampler, scheduler: preset.scheduler, custom_sigmas: [], guidance: { txt_cfg: preset.cfg } },
      hires: { enabled: false }, lora: [], preview: 'none', output_format: 'png', embed_image_metadata: true },
  };
}
