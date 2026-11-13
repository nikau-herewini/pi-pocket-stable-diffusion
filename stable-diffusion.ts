/**
 * Generate images through an owner-configured self-hosted stable-diffusion.cpp service.
 * Sends prompts and optional local references to that service, with an optional secret bearer token.
 * Reads only current-conversation uploads and this extension's saved images as references.
 * Writes PNG outputs below the data folder and durable job receipts in Pi Pocket.
 * Results can reach the conversation's model provider. Adds no public routes or telemetry.
 */
import { join } from 'node:path';
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { arr, int, obj, opt, str } from '@earendil-works/pi-schema';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { configuration, DEFAULT_PRESETS } from './stable-diffusion/config.mjs';
import { referenceLoader } from './stable-diffusion/references.mjs';
import { createService } from './stable-diffusion/service.mjs';

export const pocketApi = 2;
export const ImageLock = defineDoc({
  kind: 'x.stable-diffusion.lock', version: 1, scope: 'session',
  initial: () => ({}), checkpointWhen: () => true,
});

export default function stableDiffusion(host, web) {
  if (typeof web.settings !== 'function' || typeof web.setting !== 'function') {
    throw new Error('This extension requires Pi Pocket extension settings support (0.22 or newer).');
  }
  web.settings([
    { name: 'endpoint', label: 'Service URL', type: 'text', default: '', description: 'Owner-trusted http(s) URL reachable from Pi Pocket. Optional reverse-proxy path prefix. No credentials in the URL.' },
    { name: 'token', label: 'Bearer token', type: 'text', secret: true, default: '', description: 'Optional token for the server or its reverse proxy. Use HTTPS outside a trusted local network.' },
    { name: 'timeoutMinutes', label: 'Generation timeout (minutes)', type: 'number', default: 20, min: 1, max: 120 },
    { name: 'presets', label: 'Generation presets (JSON)', type: 'text', default: DEFAULT_PRESETS, description: 'Named presets for the model already loaded by the server. This extension does not load models.' },
  ]);
  const config = () => configuration(Object.fromEntries(['endpoint', 'token', 'timeoutMinutes', 'presets'].map(name => [name, web.setting(name)])));
  const directory = join(host.dataDir, 'extensions', 'stable-diffusion', 'outputs');
  const service = createService(directory, ImageLock, config, { prepareReferences: referenceLoader(host.dataDir, directory, resizeImage) });
  const presets = Object.assign(defineTool({
    name: 'sd_presets', description: 'List owner-configured Stable Diffusion presets and their supported inputs. Does not probe or change the backend.',
    parameters: obj({}), replay: 'safe',
    execute: async () => ({ output: [{ type: 'text', text: JSON.stringify(config().presets, null, 2) }] }),
  }), { annotations: { readOnlyHint: true } });
  const generate = defineTool({
    name: 'sd_generate',
    description: 'Generate and display 1 PNG using a configured self-hosted stable-diffusion.cpp preset. Call sd_presets first. The preset controls size and sampling; it does not load a model. Optional ordered references must be absolute paths to this conversation’s uploads or this extension’s saved outputs: up to 3 PNG/JPEG/static WebP, 8 MB each, 16 MB total, normalized within 1024×1024. Describe each reference’s role in prompt order. Negative prompts require preset support. One call at a time across conversations. Unknown submissions must not be retried automatically.',
    parameters: obj({
      prompt: str({ minLength: 1, maxLength: 4000 }),
      preset: opt(str({ minLength: 1, maxLength: 40, description: 'A preset name from sd_presets. Defaults to the first configured preset.' })),
      negative_prompt: opt(str({ maxLength: 4000 })),
      reference_images: opt(arr(str({ minLength: 1, maxLength: 4096 }), { maxItems: 3 })),
      seed: opt(int({ minimum: -1, maximum: 2_147_483_647, description: '-1 chooses a random seed.' })),
    }),
    replay: 'safe', execute: (args, api, context) => service.generate(args, api, context),
  });
  web.command('sd-status', {
    description: 'Inspect the global Stable Diffusion lock and known job', scope: 'global',
    handler: async (_args, ctx) => ({ type: 'card', output: await service.inspect((await ctx.snapshot(ImageLock, ctx.context))?.active, ctx.signal) }),
  });
  for (const reset of [false, true]) web.command(reset ? 'sd-reset' : 'sd-recover', {
    description: reset ? 'Release an unknown request only after restarting its original backend' : 'Release a stopped call only after its backend job is terminal',
    args: reset ? '<lock-key> backend-restarted' : '<lock-key>', scope: 'global',
    handler: async (args, ctx) => {
      if (ctx.user.role !== 'owner') throw web.error(403, 'Only the owner can recover image generation.');
      const parts = args.trim().split(/\s+/);
      if (parts.length !== (reset ? 2 : 1) || !parts[0] || (reset && parts[1] !== 'backend-restarted')) throw web.error(400, reset ? 'Use /sd-reset <lock-key> backend-restarted after restarting the original backend.' : 'Use /sd-recover <lock-key>.');
      const active = (await ctx.snapshot(ImageLock, ctx.context))?.active;
      if (!active || active.key !== parts[0]) throw web.error(409, 'Lock changed. Use /sd-status again.');
      try { await service.recover(active, ctx.signal, reset); }
      catch (error) { throw web.error(409, error instanceof Error && error.message.startsWith('SD:') ? error.message : 'Recovery failed. Check settings and backend state.'); }
      await ctx.commit(async tx => {
        const lock = await tx.doc(ImageLock);
        if (lock.active?.key !== active.key || service.isRunning(active.key)) throw web.error(409, 'Lock changed or its call is running. Use /sd-status again.');
        delete lock.active;
      });
      return { type: 'toast', level: 'info', message: 'Lock released. The previous submission will not be repeated.' };
    },
  });
  return defineExtension({ name: 'stable-diffusion', tools: [presets, generate] });
}
