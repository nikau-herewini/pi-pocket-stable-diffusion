# Security

This is a trusted Pi Pocket drop-in, not a sandbox. Review all runtime files before enabling it.

## Trust boundaries

- Only the owner configures the endpoint, bearer token, timeout, and presets. Generation tools cannot select a URL or arbitrary HTTP path.
- Private and loopback endpoints are intentionally allowed for self-hosting. The endpoint is an owner trust decision, not an untrusted user input. Protect owner access and use HTTPS where appropriate.
- Redirects are refused. Poll and cancel paths are built from validated job IDs, never backend-provided URLs.
- HTTP responses, output image sizes, reference files, decoded reference pixel counts, and execution time are bounded.
- Backend output PNGs receive structural and dimension checks and SHA256 integrity checks on replay. These are not a complete PNG decoder or malware scanner. Use a trusted backend.
- Reference files are canonicalized and constrained to current-conversation uploads and this extension's shared outputs. The final file is opened without following symlinks. Hostile concurrent changes to parent directories by another local process are outside this boundary; keep the data volume trusted.
- Secret bearer tokens are never included in tool schemas, results, raw error text, or durable receipts. Owner-defined preset labels and generation parameters are not secret.
- The owner-only browser settings sheet runs inside Pi Pocket, not a sandbox. It uses the app's settings APIs with the signed-in owner's authority. It receives only sanitized settings and token-presence metadata. Keeping a token omits it from the update; replacing it sends the new value; clearing it sends an explicit reset. No stored token is prefilled or returned. The browser contacts Pi Pocket, not the model server, when it saves settings.
- The settings sheet leaves invalid previously saved preset JSON available for repair. It does not silently replace it with examples. A settings change from another tab requires a reload before saving.
- Reference images are decoded through Pi Pocket's public image processor in terminable workers, with a 30-second deadline and cancellation. Each worker has a 256 MB V8 heap limit; native and WebAssembly allocations are not covered by that heap limit. The input byte and pixel limits still apply. Workers isolate execution time, not filesystem permissions. Keep Pi Pocket and its codecs patched.
- A durable lock prevents concurrent extension calls. It does not protect against direct backend clients, file replacements, or other installations.
- Backend model fingerprints identify reported selections and transitions, not weight bytes. A human must manage model replacement and unknown-job recovery.

No service is deployed, no account is created, and no model license is granted by this extension. Operators must review their chosen models' terms.

## Reporting

Do not put credentials, private endpoints, prompts, or reference images in public issues. Use GitHub private vulnerability reporting if enabled. Otherwise, open a minimal issue asking for a private reporting channel without disclosing the vulnerability or private data.
