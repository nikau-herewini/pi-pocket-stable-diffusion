import { test } from 'node:test';
import assert from 'node:assert/strict';
import create, { pocketApi } from '../stable-diffusion.ts';
import { values } from './support.mjs';

test('module loads against Pi packages and registers settings, tools, and owner-only commands', async () => {
  const settings = values(), commands = new Map(); let declared, options, client;
  const extension = create({ dataDir: '/tmp/example-data' }, {
    settings: (fields, given) => { declared = fields; options = given; }, setting: name => settings[name],
    client: (entry, access) => { client = { entry, ...access }; },
    command: (name, spec) => commands.set(name, spec), error: (_status, message) => new Error(message),
  });
  assert.equal(pocketApi, 2); assert.equal(extension.name, 'stable-diffusion');
  assert.equal(declared.find(s => s.name === 'token').secret, true);
  assert.equal(declared.find(s => s.name === 'endpoint').default, '');
  assert.deepEqual(options, { sheet: 'settings' });
  assert.deepEqual(client, { entry: 'stable-diffusion-browser', access: 'owner' });
  assert.equal(extension.tools.length, 2);
  assert.deepEqual(Object.keys(JSON.parse((await extension.tools.find(t => t.name === 'sd_presets').execute()).output[0].text)), ['standard', 'klein']);
  const tool = extension.tools.find(t => t.name === 'sd_generate'); assert.equal(tool.replay, 'safe');
  assert.equal(tool.parameters.properties.reference_images.maxItems, 3);
  assert.ok(!tool.parameters.required.includes('negative_prompt'));
  for (const command of commands.values()) assert.equal(command.scope, 'global');
  for (const name of ['sd-reset', 'sd-recover']) {
    await assert.rejects(commands.get(name).handler('some-key', { user: { role: 'member' } }), /owner/);
    await assert.rejects(commands.get(name).handler('', { user: { role: 'owner' } }), /Use/);
  }
});
