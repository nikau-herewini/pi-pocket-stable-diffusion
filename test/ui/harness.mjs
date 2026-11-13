import { createServer } from 'node:http';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { DEFAULT_PRESETS } from '../../stable-diffusion/config.mjs';

export async function browserFixture(t, { width = 390, height = 844, failLoad = false, legacy = false, presets = DEFAULT_PRESETS } = {}) {
  const state = { values: { endpoint: 'https://images.example.org/sd', timeoutMinutes: 20, presets }, secret: 'stored-test-token', patches: [], failLoad, failSave: false };
  const files = new Map([
    ['/extension.js', new URL('../../stable-diffusion.js', import.meta.url)],
    ['/preact.js', import.meta.resolve('preact')],
    ['/hooks.js', import.meta.resolve('preact/hooks')],
    ['/htm.js', import.meta.resolve('htm')],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (files.has(path)) { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(new URL(files.get(path)))); return; }
      if (path === '/settings' && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/json');
        if (state.failLoad) { response.statusCode = 503; response.end('{}'); return; }
        response.end(JSON.stringify({ fields: [{ name: 'presets', default: DEFAULT_PRESETS }], values: state.values, set: [...Object.keys(state.values), ...(state.secret ? ['token'] : [])] })); return;
      }
      if (path === '/settings' && request.method === 'POST') {
        let text = ''; for await (const bytes of request) text += bytes;
        const patch = JSON.parse(text); state.patches.push(patch); response.setHeader('Content-Type', 'application/json');
        if (state.failSave) { response.statusCode = 400; response.end(JSON.stringify({ error: 'private-error-must-not-be-displayed' })); return; }
        if (Object.hasOwn(patch, 'token')) state.secret = patch.token ?? '';
        for (const name of ['endpoint', 'timeoutMinutes', 'presets']) if (Object.hasOwn(patch, name)) state.values[name] = patch[name];
        response.end('{}'); return;
      }
      if (path !== '/') { response.statusCode = 404; response.end(); return; }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Settings test</title>
<style>:root{--text:#ecf0f4;--muted:#aeb8c2;--accent:#7ad3c2;--bg:#15191e;--card:#20262d;--line:#46515e;--err:#ffaaa8;--ok:#9be1a9}*{box-sizing:border-box}body{margin:0;background:var(--card);color:var(--text);font:16px system-ui}h1{font-size:21px;margin:16px}h3{font-size:18px}button,input,select,textarea{font:inherit}.button{border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}.primary{background:#235d51}button:disabled{opacity:.55}.small{font-size:14px}.muted{color:var(--muted)}.error-box{padding:12px;border:1px solid var(--err);border-radius:8px;color:var(--err)}p{line-height:1.5}#sheet{max-width:1000px;margin:auto}</style>
<script type="importmap">{"imports":{"preact":"/preact.js"}}</script></head><body><div id="sheet"></div><script type="module">
import {h,render} from '/preact.js';import{useState,useEffect,useRef}from'/hooks.js';import htm from'/htm.js';import setup from'/extension.js';
const root=document.querySelector('#sheet'), listeners=new Set();let spec;
const read=async()=>{const response=await fetch('/settings');if(!response.ok)throw Error('Load failed');return response.json()};
const pocket={html:htm.bind(h),useState,useEffect,useRef,settings:read,onSettings:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
saveSettings:async patch=>{const response=await fetch('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});if(!response.ok)throw Error((await response.json()).error);for(const fn of listeners)fn()},
sheet:given=>{spec=given},menu(){},launcher(){}};
${legacy ? 'delete pocket.saveSettings;' : ''}
setup(pocket);window.emitSettings=()=>{for(const fn of listeners)fn()};
render(h('div',{},h('h1',{},spec.title),h(spec.component,{close:()=>render(null,root)})),root);
</script></body></html>`);
    } catch { response.statusCode = 500; response.end('Test server error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  let executablePath;
  for (const path of [process.env.BROWSER_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'].filter(Boolean)) {
    try { await access(path); executablePath = path; break; } catch {}
  }
  if (!executablePath) throw new Error('UI tests require Chrome or Chromium. Set BROWSER_BIN to its executable.');
  const home = await mkdtemp(join(tmpdir(), 'sd-settings-browser-'));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), LANG: 'C.UTF-8' } });
  t.after(async () => { await browser.close(); await rm(home, { recursive: true, force: true }); });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width, height, isMobile: width < 600, hasTouch: width < 600 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  t.after(() => { if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`); });
  return { page, state };
}
export async function fill(page, name, value) {
  await page.waitForSelector(`[name="${name}"]`);
  await page.$eval(`[name="${name}"]`, (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
}
export async function clickText(page, text) {
  const buttons = await page.$$('button');
  for (const button of buttons) if ((await button.evaluate(element => element.textContent.trim())) === text) { await button.click(); return; }
  throw new Error(`Button not found: ${text}`);
}
export const loaded = page => page.waitForSelector('[name="endpoint"]');
export const saved = page => page.waitForFunction(() => document.body.textContent.includes('Settings saved.'));
