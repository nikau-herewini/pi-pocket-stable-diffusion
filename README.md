# Pi Pocket Stable Diffusion

Generate images in [Pi Pocket](https://github.com/nikau-herewini/pi-pocket) using your own [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) service.

**Early implementation.** Automated tests cover the extension and real reference-image processing. Live GPU generation and a complete Pi Pocket deployment have not yet been validated for this standalone version.

## Features

- A **Stable Diffusion** display title and a dedicated, wide owner settings sheet.
- Structured connection, authentication, and preset fields; no JSON editing for normal setup.
- Owner-configured service URL, optional secret bearer token, and named generation presets.
- One PNG per call; configurable dimensions, steps, sampler, scheduler, and CFG through presets.
- Optional negative prompts and up to 3 ordered reference images, enabled per preset.
- Durable receipts, restart-safe polling, local PNG persistence, and conservative cancellation/recovery.
- One generation call at a time across all Pi Pocket conversations using this extension.
- No public routes, telemetry, model downloads, model switching, shell execution, or server provisioning.

## Requirements

- Pi Pocket **0.28.0 or newer**, extension API 2. Tests use its Pi package versions, 1.5.0.
- The dedicated sheet and display title require a Pi Pocket build with `@title`, `web.settings(fields, { sheet })`, and `pocket.saveSettings` support. Older builds retain the filename title and inline settings; the sheet explains when saving is unavailable.
- A reachable `sd-server` with the **native asynchronous API** described below.
- A model already loaded by the server, with a compatible preset and sufficient memory.

The extension targets the API documented at stable-diffusion.cpp revision [`32d516c0197ed5ca31305b8575e14eb1451fad33`](https://github.com/leejet/stable-diffusion.cpp/blob/32d516c0197ed5ca31305b8575e14eb1451fad33/examples/server/api.md):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/sdcpp/v1/models/status` | Check readiness and fingerprint model selection |
| POST | `/sdcpp/v1/img_gen` | Submit one image job; expects HTTP 202 |
| GET | `/sdcpp/v1/jobs/<id>` | Poll status and receive the base64 PNG |
| POST | `/sdcpp/v1/jobs/<id>/cancel` | Request cancellation |

Other revisions are not guaranteed compatible. This does **not** support ComfyUI, AUTOMATIC1111, legacy synchronous endpoints, or the OpenAI-compatible image API. No automatic capability discovery is claimed: the owner configures supported inputs explicitly.

## Install

Review `stable-diffusion.ts` and all files in `stable-diffusion/` before activation. A drop-in runs with the Pi Pocket server's rights.

Copy these files from a reviewed commit into the Pi Pocket **data folder**:

```text
extensions/
├── stable-diffusion.ts
├── stable-diffusion.js
└── stable-diffusion/
    ├── config.mjs
    ├── decode.mjs
    ├── decode-worker.mjs
    ├── references.mjs
    └── service.mjs
```

Do not copy tests, `node_modules`, or your repository checkout into the drop-in folder. No npm install is needed in Pi Pocket; it supplies the imported Pi packages.

For Docker, persist these files in the mounted data directory or mount the source files read-only individually. Leave `extensions/stable-diffusion/outputs/` writable. Do not make changes only inside a running image.

In **Menu → Extensions**, enable **Stable Diffusion**, then choose **Open settings**. You can also open **Stable Diffusion settings** from the app menu or launcher. The wide sheet becomes a full-width form on phones.

Set:

1. **Service URL:** a trusted URL reachable **from the Pi Pocket container**, for example `http://sd-server:8080`. `localhost` means that container itself. A reverse-proxy path prefix such as `https://images.example.org/sd` is supported.
2. **Bearer token:** optional, stored as a secret setting. It is sent only in the `Authorization` header. If your server has no bearer authentication, an authenticated reverse proxy can provide it.
3. **Generation timeout:** 1–120 minutes, default 20. Each HTTP request is also limited to 15 seconds.
4. **Generation presets:** edit the named preset cards described below. Remove incompatible examples, adjust each field, and choose **Make default** for the preset to use first.

Choose **Save settings** to apply changes. No restart is needed. **Reload saved settings** discards unsaved edits and reads current values. If another tab changes the settings, reload before saving your draft.

A stored token is never displayed or copied into the form. **Keep stored token** leaves it unchanged; replacement and removal require an explicit choice. New token inputs are cleared after a successful save. Finish active image jobs before changing the connection or token.

The internal module ID stays `stable-diffusion`; existing settings, receipts, images, and tool names do not change. On older Pi Pocket builds, use the inline settings under `stable-diffusion` until you update the app.

The service URL starts empty, so generation fails closed until configured. Do not put credentials in the URL. Use HTTPS outside a trusted private network. The extension refuses redirects, URL user/password fields, query strings, and fragments. Do not expose an unauthenticated model server to the internet.

After changing helper files, restart Pi Pocket through its normal controls when no calls are active. Reloading the main module alone does not reload cached helpers.

## Presets

The defaults include a conventional diffusion example and a distilled Klein example. **They are examples, not automatic model selection.** Remove incompatible presets or edit them to match the model already loaded by your server.

The sheet provides fields for name, label, dimensions, steps, CFG, sampler, scheduler, and input capability switches. **Add preset** copies an example without replacing current presets. The JSON representation below remains useful for older builds and configuration examples. If previously saved JSON is invalid, the sheet preserves it in a repair textarea instead of discarding it.

```json
{
  "illustration": {
    "label": "My illustration model",
    "width": 768,
    "height": 768,
    "steps": 20,
    "sampler": "euler",
    "scheduler": "discrete",
    "cfg": 7,
    "negativePrompt": true,
    "references": false
  }
}
```

- The first entry is the default. Up to 16 presets are supported.
- Names use lowercase letters, digits, `_`, and `-`, starting with a letter, up to 40 characters.
- Dimensions are multiples of 64, from 64 to 2048, at most 4,194,304 output pixels.
- Steps: 1–150. CFG: 0–30. The server must support the sampler and scheduler names.
- `negativePrompt` and `references` are required boolean capability declarations, not automatic detection. Enable them only for compatible models.
- Batch count stays 1; output stays PNG. High-resolution passes, LoRAs, masks, img2img, ControlNet, video, and model loading are outside this first version.
- Tools cannot change sampling settings, endpoints, authentication, or model files.

A preset is not proof of model identity. The extension hashes model selection, recipe, revision, and origin from backend status before submission. It checks again after reference preparation. It never sends raw backend model paths to the model provider.

This catches reported model transitions, **not in-place weight changes or every backend restart**. The API does not supply weight content hashes or an atomic model lease. Do not replace weights in place or change models from another client during preparation. Use one managed backend for reliable operation.

## Use

Ask Pi to list presets, then generate an image:

```text
Use sd_presets, then generate a lighthouse illustration with the illustration preset and seed 42.
```

Tools:

- `sd_presets`: lists the owner-configured presets. It does not probe the server.
- `sd_generate`: accepts `prompt`, optional `preset`, `negative_prompt`, ordered `reference_images`, and `seed` (-1 for random).

The image appears in the conversation and is saved under `extensions/stable-diffusion/outputs/` in the data folder. The result gives its absolute path and SHA256. Keep the writable data volume in your backups.

### References

References must be absolute local paths to **this conversation's uploads** or **this extension's saved outputs**. URLs, arbitrary server files, and other conversations' uploads are rejected. Generated outputs are shared across conversations using this extension; do not use this folder as a per-conversation privacy boundary.

Limits: 3 images, 8 MB per file, 16 MB combined, 16 million pixels per image. PNG, JPEG, and static WebP are accepted. References are decoded and normalized to fit within 1024×1024, with aspect ratio preserved. EXIF orientation is normalized. Each decode runs in a separate worker with a 30-second deadline. Cancellation terminates the worker before the call releases its lock. Ordered original and normalized hashes are stored, not reference base64 data or original paths.

Describe each reference's role in the prompt in the same order. Reference conditioning is not supported by every model. This is not generic img2img or inpainting support.

## Restarts, errors, and recovery

The extension stores a durable lock, the original request plan, reference hashes, a submission-started receipt, known job ID, deadline, and final outcome.

- A known job resumes polling after a Pi Pocket restart, without another submission or rereading its reference files.
- A saved outcome replays from disk, without contacting the backend. Missing or modified outputs fail instead of regenerating.
- A lost submission reply is **unknown**, not a reason to retry. The lock remains.
- Cancellation acknowledgement alone does not release a lock. The job must reach `completed`, `failed`, or `cancelled`.
- The original deadline is never renewed on replay. A new call does not queue behind a busy lock.
- Connection or token changes prevent an unfinished call from using the replacement connection. Restore the original settings to resume it.
- A prepared call keeps its original preset even if the owner's presets change. Backend model changes before submission reject that call.

Owner commands:

```text
/sd-status
/sd-recover <lock-key>
/sd-reset <lock-key> backend-restarted
```

`sd-recover` releases only a locally stopped request whose known backend job is terminal. It does not retrieve a failed call's finished image.

For unknown submissions, missing backend jobs, or a replaced connection, stop the local call, **restart the original backend and confirm its old work has stopped**, then use `sd-reset`. The confirmation is a human assertion; the extension cannot verify a restart. Never reset merely to bypass a busy lock. Old submitted calls cannot submit again after recovery.

The lock coordinates this extension only, not other API clients, other Pi Pocket installations, language inference, or GPU resource allocation.

## Privacy and security

Prompts and reference pixels go to the configured backend. Result images and tool text can also reach the conversation's configured model provider. The backend can retain its own jobs and logs. Pi Pocket stores tool arguments, receipts, and outcomes; outputs have no automatic expiration.

The optional bearer token stays in Pi Pocket's secret settings. The extension sends it only to the configured service, does not store it in job receipts, and does not return raw network errors or backend error bodies. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm test
npm run test:ui
```

Node 22.18+ is required. CI runs Node 22 and 24. UI tests need Chrome or Chromium; set `BROWSER_BIN` if it is not in a standard location. They run at phone and desktop widths with isolated browser profiles and synthetic settings, not live Pi Pocket data. Dependencies are development-only; the lockfile pins test packages. Tests use fake HTTP services and temporary data, plus the actual public Pi image processor and extension packages. They cover forced process crashes, blocked decoder termination, and real Pi Durable storage across conversations and reopening. They do not use deployment credentials, live Pi Pocket data, model weights, or GPUs.

Before production use, run a fixed-seed live generation against your exact server build, confirm output persistence, test cancellation/restart behavior, and measure memory use. Automated tests do not establish model quality, hardware compatibility, or throughput.
