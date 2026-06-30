# Pluck

A small Caido plugin that exports the request/response pairs **you select** in the
HTTP history — cherry-pick N rows, export each one in full. This is the
differentiator vs. Caido's native export (which does "all" or "current rows").

Built and tested against the `@caido-community/dev` toolchain, targeting Caido 0.57.

## Features

- **Copy as / Save as** in the row context menu, in four formats sharing one `Pair` shape:
  - **Raw** — request/response verbatim with readable separators
  - **Markdown** — ` ```http ` blocks, ready to paste into a report
  - **cURL** — reproducible command (method, full URL with http/https inferred from TLS, headers, `--data-raw` body)
  - **JSON** — `{ method, url, host, path, query, reqHeaders, reqBody, status, respHeaders, respBody, timing }`
- **Enriched metadata header** on every export: method, status, content-type, size, timing, date.
- **Bundle toggle**: one combined file, or one file per request (bulk).
- **AI-safe mode (opt-in, never default)**: strips `Authorization`, `Cookie`,
  `Set-Cookie`, `X-Api-Key` and masks `Bearer` tokens. Normal "repro" mode keeps
  everything, because the triager needs the tokens to reproduce.
- **Filename sanitization** on both host **and** path; any `..` traversal is stripped
  and re-validated in the backend before writing.

## Privacy

Zero network calls, zero telemetry. The backend uses the filesystem only
(`mkdir` + `writeFile`) inside the folder you choose in settings. Nothing leaves
your machine.

## Build

```bash
pnpm install
pnpm build
```

This produces `dist/plugin_package.zip`.

## Install in Caido

1. Open Caido → **Plugins** → **Install Package**.
2. Select `dist/plugin_package.zip`.
3. Open the **Pluck** entry in the left sidebar and set your **Export folder**
   (and the Bundle / AI-safe toggles if you want them).
4. In **HTTP History**, select one or more rows, right-click, and pick
   **Copy as …** or **Save as …**.

## Notes on the Caido 0.57 SDK

- The plugin menu API has **no nested submenus**, so the four formats are registered
  as flat items grouped under "Copy as" / "Save as".
- Request/response bytes are read via `sdk.graphql.request({id})` /
  `sdk.graphql.response({id})`; everything else (method, headers, body, status) is
  parsed from the raw bytes, so the plugin doesn't depend on optional GraphQL fields.
- Scheme is inferred from a TLS flag when present, otherwise from the port
  (443 → https), defaulting to https.

## Acknowledgements

The concept — copy/save request/response pairs from Caido for reports and
triage — is inspired by
[v0xyc0n/caido-reqres-exporter](https://github.com/v0xyc0n/caido-reqres-exporter)
by Jakob Pachmann (MIT). Pluck is an independent, from-scratch rewrite with a
different scope: four formatters over a shared `Pair` shape, an enriched metadata
header, an opt-in AI-safe redaction mode, a bundle toggle, and host+path filename
sanitization. No source code was copied; only the SDK boilerplate that Caido
itself dictates is necessarily similar.

## License

MIT
