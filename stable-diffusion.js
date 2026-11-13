export const pocketApi = 2;

const presetFields = ['label', 'width', 'height', 'steps', 'sampler', 'scheduler', 'cfg', 'negativePrompt', 'references'];
const fail = message => { throw new Error(message); };
const number = (value, min, max, integer = true) => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') fail('Complete all numeric preset fields.');
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) fail(`Enter ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`);
  return result;
};
function record(row) {
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) fail('Preset names must start with a lowercase letter and use only lowercase letters, digits, hyphens, or underscores (40 characters maximum).');
  const label = typeof row.label === 'string' ? row.label.trim() : '';
  if (!label || label.length > 100 || /[\x00-\x1f\x7f]/.test(label)) fail('Each preset needs a label of 1–100 characters.');
  const width = number(row.width, 64, 2048), height = number(row.height, 64, 2048);
  if (width % 64 || height % 64 || width * height > 4_194_304) fail('Dimensions must be multiples of 64, with at most 4,194,304 output pixels.');
  for (const field of ['sampler', 'scheduler']) if (typeof row[field] !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(row[field].trim())) fail('Sampler and scheduler names must use lowercase letters, digits, or underscores.');
  if (typeof row.negativePrompt !== 'boolean' || typeof row.references !== 'boolean') fail('Preset input capabilities must be on or off.');
  return [name, { label, width, height, steps: number(row.steps, 1, 150), sampler: row.sampler.trim(), scheduler: row.scheduler.trim(), cfg: number(row.cfg, 0, 30, false), negativePrompt: row.negativePrompt, references: row.references }];
}
export function presetRows(json) {
  let presets;
  try { presets = JSON.parse(json); } catch { fail('The saved preset JSON is invalid. Repair it below before saving.'); }
  if (!presets || typeof presets !== 'object' || Array.isArray(presets) || !Object.keys(presets).length || Object.keys(presets).length > 16) fail('Configure 1–16 named presets.');
  return Object.entries(presets).map(([name, preset], index) => {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset) || Object.keys(preset).some(key => !presetFields.includes(key)) || ['width', 'height', 'steps', 'cfg'].some(key => typeof preset[key] !== 'number')) fail('A saved preset has unsupported fields or types. Repair its JSON below.');
    const row = { ...preset, name, key: `preset-${index}` };
    record(row);
    return row;
  });
}
export function draftFromSettings(settings) {
  const values = settings.values ?? {};
  let rows = [], repair = '';
  const rawPresets = String(values.presets ?? '');
  try { rows = presetRows(rawPresets); } catch (error) { repair = error.message; }
  return { endpoint: String(values.endpoint ?? ''), timeoutMinutes: String(values.timeoutMinutes ?? 20), token: '', tokenAction: 'keep', tokenSet: settings.set?.includes('token') ?? false, rows, rawPresets, repair };
}
export function settingsPatch(draft) {
  const endpoint = draft.endpoint.trim();
  let url;
  try { url = new URL(endpoint); } catch { fail('Enter a complete HTTP or HTTPS service URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Use an HTTP or HTTPS URL without credentials, a query, or a fragment.');
  if (endpoint.length > 4096) fail('The service URL is too long.');
  if (draft.repair) fail('Repair the saved preset JSON before saving.');
  if (!draft.rows.length || draft.rows.length > 16) fail('Configure 1–16 named presets.');
  const records = draft.rows.map(record);
  if (new Set(records.map(([name]) => name)).size !== records.length) fail('Preset names must be unique.');
  const presets = JSON.stringify(Object.fromEntries(records));
  if (presets.length > 4096) fail('Presets exceed the 4096-character settings limit. Shorten labels or remove a preset.');
  const patch = { endpoint, timeoutMinutes: number(draft.timeoutMinutes, 1, 120), presets };
  if (draft.tokenAction === 'replace') {
    if (!draft.token || draft.token.length > 4096 || /[^\x21-\x7e]/.test(draft.token)) fail('Enter a bearer token without spaces or control characters.');
    patch.token = draft.token;
  } else if (draft.tokenAction === 'clear') patch.token = null;
  else if (draft.tokenAction !== 'keep') fail('Choose whether to keep, replace, or remove the bearer token.');
  return patch;
}

export default function setup(pocket) {
  const { html, useState, useEffect, useRef } = pocket;
  const inputStyle = { width: '100%', boxSizing: 'border-box', minHeight: '44px', fontSize: '16px', padding: '8px 10px', color: 'var(--text)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '8px' };
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', gap: '16px' };
  const labelStyle = { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 };
  const actions = { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' };
  const buttonStyle = { minHeight: '44px', padding: '8px 14px' };

  function Settings({ close }) {
    const [draft, setDraft] = useState(null), [templates, setTemplates] = useState([]);
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
    const [template, setTemplate] = useState(''), [stale, setStale] = useState(false);
    const mounted = useRef(true), savingNow = useRef(false), nextKey = useRef(100);
    const canSave = typeof pocket.saveSettings === 'function';
    async function load() {
      setLoading(true); setError('');
      try {
        const settings = await pocket.settings();
        if (!mounted.current) return;
        setDraft(draftFromSettings(settings));
        const examples = presetRows(settings.fields.find(field => field.name === 'presets')?.default ?? '{}');
        setTemplates(examples); setTemplate(examples[0]?.name ?? ''); setStale(false);
      } catch { if (mounted.current) setError('Settings could not be loaded. Check that the extension is enabled, then retry.'); }
      finally { if (mounted.current) setLoading(false); }
    }
    useEffect(() => {
      mounted.current = true;
      void load();
      const stop = typeof pocket.onSettings === 'function' ? pocket.onSettings(() => {
        // A token-only change is invisible in sanitized values. Treat every
        // event outside our own save as a change, even when visible values match.
        if (mounted.current && !savingNow.current) setStale(true);
      }) : () => {};
      return () => { mounted.current = false; stop(); };
    }, []);
    const update = patch => { setDraft(before => ({ ...before, ...patch })); setNotice(''); setError(''); };
    const updateRow = (key, patch) => { setDraft(before => ({ ...before, rows: before.rows.map(row => row.key === key ? { ...row, ...patch } : row) })); setNotice(''); setError(''); };
    function field(label, name, value, change, extra = {}) {
      return html`<label style=${labelStyle}><span>${label}</span><input name=${name} value=${value} onInput=${event => change(event.currentTarget.value)} style=${inputStyle} disabled=${saving} ...${extra} /></label>`;
    }
    function addPreset() {
      const example = templates.find(row => row.name === template);
      if (!example) return;
      let name = example.name, suffix = 2;
      while (draft.rows.some(row => row.name === name)) name = `${example.name.slice(0, 35)}-${suffix++}`;
      update({ rows: [...draft.rows, { ...example, name, key: `added-${nextKey.current++}` }] });
    }
    function repair() {
      try { update({ rows: presetRows(draft.rawPresets), repair: '' }); }
      catch (failure) { setError(failure.message); }
    }
    async function save(event) {
      event.preventDefault();
      if (!canSave || savingNow.current || saving || stale) return;
      setError(''); setNotice('');
      let patch;
      try { patch = settingsPatch(draft); } catch (failure) { setError(failure.message); return; }
      savingNow.current = true; setSaving(true);
      try {
        await pocket.saveSettings(patch);
        // Read only the sanitized settings. Never retain a submitted token in the form.
        const settings = await pocket.settings();
        if (mounted.current) {
          setDraft(draftFromSettings(settings)); setStale(false);
          setNotice('Settings saved. No restart is needed.');
        }
      } catch { if (mounted.current) setError('Settings could not be saved. Reload to check the current values before retrying.'); }
      finally { savingNow.current = false; if (mounted.current) setSaving(false); }
    }
    if (loading) return html`<div role="status" style=${{ padding: '24px' }}>Loading Stable Diffusion settings…</div>`;
    if (!draft) return html`<div style=${{ padding: '16px' }}><p class="error-box" role="alert">${error}</p><button class="button" style=${buttonStyle} onClick=${load}>Retry</button></div>`;
    return html`<form onSubmit=${save} style=${{ padding: '16px', width: '100%', maxWidth: '64rem', boxSizing: 'border-box', display: 'grid', gap: '24px' }}>
      <p class="muted" style=${{ margin: 0 }}>Configure the service and named presets. Presets must match the model already loaded on your server; saving does not load a model.</p>
      ${!canSave && html`<p class="error-box" role="alert">This Pi Pocket build cannot save from a dedicated settings sheet. Update Pi Pocket or use its inline Extensions settings.</p>`}
      ${stale && html`<p class="error-box" role="alert">Settings changed elsewhere. Reload to review the current values before saving.</p>`}
      <section aria-labelledby="sd-connection"><h3 id="sd-connection">Connection</h3>
        <div style=${grid}>
          ${field('Service URL', 'endpoint', draft.endpoint, endpoint => update({ endpoint }), { type: 'url', required: true, placeholder: 'http://sd-server:8080', autoComplete: 'off', maxLength: 4096 })}
          ${field('Generation timeout (minutes)', 'timeoutMinutes', draft.timeoutMinutes, timeoutMinutes => update({ timeoutMinutes }), { type: 'number', min: 1, max: 120, step: 1, required: true })}
        </div>
        <p class="small muted">The URL must be reachable from the Pi Pocket server, not just your browser. Use HTTPS outside a trusted private network.</p>
        <div style=${grid}>
          <label style=${labelStyle}><span>Bearer token</span><select name="tokenAction" value=${draft.tokenAction} style=${inputStyle} disabled=${saving} onChange=${event => update({ tokenAction: event.currentTarget.value, token: '' })}>
            <option value="keep">${draft.tokenSet ? 'Keep stored token' : 'No token configured'}</option><option value="replace">Set or replace token</option><option value="clear">Remove stored token</option>
          </select></label>
          ${draft.tokenAction === 'replace' && field('New bearer token', 'token', draft.token, token => update({ token }), { type: 'password', autoComplete: 'new-password', required: true, maxLength: 4096, spellCheck: false })}
        </div>
        <p class="small muted">Stored tokens are never displayed. Leaving this unchanged keeps the current token. Finish active image jobs before changing the connection or token.</p>
      </section>
      <section aria-labelledby="sd-presets"><h3 id="sd-presets">Generation presets</h3>
        <p class="small muted">The first preset is the default. Enable negative prompts and references only when your loaded model supports them.</p>
        ${draft.repair ? html`<div class="error-box"><p>${draft.repair}</p><label style=${labelStyle}>Repair saved preset JSON<textarea name="repairPresets" value=${draft.rawPresets} onInput=${event => update({ rawPresets: event.currentTarget.value })} rows="12" style=${{ ...inputStyle, minHeight: '240px', fontFamily: 'monospace' }} /></label><button class="button" style=${buttonStyle} type="button" onClick=${repair}>Use repaired JSON</button></div>` : draft.rows.map((row, index) => html`<fieldset key=${row.key} style=${{ border: '1px solid var(--line)', borderRadius: '10px', padding: '16px', minWidth: 0, margin: '0 0 16px' }}>
          <legend style=${{ maxWidth: '100%', overflowWrap: 'anywhere', padding: '0 4px' }}>${row.label || row.name || 'Preset'}${index === 0 ? ' · Default' : ''}</legend>
          <div style=${grid}>
            ${field('Preset name', `presetName-${row.key}`, row.name, name => updateRow(row.key, { name }), { maxLength: 40, required: true, autoCapitalize: 'none', spellCheck: false })}
            ${field('Label', `label-${row.key}`, row.label, label => updateRow(row.key, { label }), { maxLength: 100, required: true })}
            ${field('Width (pixels)', `width-${row.key}`, row.width, width => updateRow(row.key, { width }), { type: 'number', min: 64, max: 2048, step: 64, required: true })}
            ${field('Height (pixels)', `height-${row.key}`, row.height, height => updateRow(row.key, { height }), { type: 'number', min: 64, max: 2048, step: 64, required: true })}
            ${field('Steps', `steps-${row.key}`, row.steps, steps => updateRow(row.key, { steps }), { type: 'number', min: 1, max: 150, step: 1, required: true })}
            ${field('CFG scale', `cfg-${row.key}`, row.cfg, cfg => updateRow(row.key, { cfg }), { type: 'number', min: 0, max: 30, step: 'any', required: true })}
            ${field('Sampler', `sampler-${row.key}`, row.sampler, sampler => updateRow(row.key, { sampler }), { maxLength: 40, required: true, autoCapitalize: 'none', spellCheck: false })}
            ${field('Scheduler', `scheduler-${row.key}`, row.scheduler, scheduler => updateRow(row.key, { scheduler }), { maxLength: 40, required: true, autoCapitalize: 'none', spellCheck: false })}
          </div>
          <div style=${{ ...actions, gap: '16px', margin: '12px 0' }}>
            <label style=${{ ...actions, minHeight: '44px' }}><input type="checkbox" name=${`negativePrompt-${row.key}`} checked=${row.negativePrompt} disabled=${saving} onChange=${event => updateRow(row.key, { negativePrompt: event.currentTarget.checked })} /> Allow negative prompts</label>
            <label style=${{ ...actions, minHeight: '44px' }}><input type="checkbox" name=${`references-${row.key}`} checked=${row.references} disabled=${saving} onChange=${event => updateRow(row.key, { references: event.currentTarget.checked })} /> Allow reference images</label>
          </div>
          <div style=${actions}>
            ${index > 0 && html`<button class="button" style=${buttonStyle} type="button" disabled=${saving} onClick=${() => update({ rows: [row, ...draft.rows.filter(other => other.key !== row.key)] })}>Make default</button>`}
            <button class="button" style=${buttonStyle} type="button" disabled=${saving || draft.rows.length === 1} onClick=${() => update({ rows: draft.rows.filter(other => other.key !== row.key) })}>Remove preset</button>
          </div>
        </fieldset>`)}
        ${!draft.repair && html`<div style=${actions}><label style=${labelStyle}><span>Add from example</span><select name="template" value=${template} style=${{ ...inputStyle, width: 'auto', maxWidth: '100%' }} disabled=${saving || draft.rows.length >= 16} onChange=${event => setTemplate(event.currentTarget.value)}>${templates.map(row => html`<option value=${row.name}>${row.label}</option>`)}</select></label><button class="button" style=${buttonStyle} type="button" disabled=${saving || draft.rows.length >= 16 || !templates.length} onClick=${addPreset}>Add preset</button></div>`}
      </section>
      <div style=${{ position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--card)', borderTop: '1px solid var(--line)', display: 'grid', gap: '8px' }}>
        ${error && html`<p class="error-box" role="alert" style=${{ margin: 0 }}>${error}</p>`}
        ${notice && html`<p role="status" style=${{ margin: 0, color: 'var(--ok)' }}>${notice}</p>`}
        <div style=${actions}>
          <button class="button primary" style=${buttonStyle} type="submit" disabled=${saving || !canSave || stale || Boolean(draft.repair)}>${saving ? 'Saving…' : 'Save settings'}</button>
          <button class="button" style=${buttonStyle} type="button" disabled=${saving} onClick=${() => { setNotice(''); void load(); }}>Reload saved settings</button>
          <button class="button" style=${buttonStyle} type="button" disabled=${saving} onClick=${close}>Close</button>
        </div>
      </div>
    </form>`;
  }
  pocket.sheet({ id: 'settings', title: 'Stable Diffusion', wide: true, component: Settings });
  pocket.menu({ id: 'settings', label: 'Stable Diffusion settings', sheet: 'settings' });
  pocket.launcher({ id: 'settings', label: 'Stable Diffusion settings', detail: 'Connection, authentication, and generation presets', keywords: ['image', 'diffusion', 'presets'], icon: 'grid', sheet: 'settings' });
}
