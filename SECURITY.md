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
- Reference images are decoded through Pi Pocket's public image processor. Keep Pi Pocket and its codecs patched.
- A durable lock prevents concurrent extension calls. It does not protect against direct backend clients, file replacements, or other installations.
- Backend model fingerprints identify reported selections and transitions, not weight bytes. A human must manage model replacement and unknown-job recovery.

No service is deployed, no account is created, and no model license is granted by this extension. Operators must review their chosen models' terms.

## Reporting

Do not put credentials, private endpoints, prompts, or reference images in public issues. Use GitHub private vulnerability reporting if enabled. Otherwise, open a minimal issue asking for a private reporting channel without disclosing the vulnerability or private data.
