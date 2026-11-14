# Pluck

A small Caido plugin that exports the request/response pairs **you select** in the
HTTP history, cherry-pick N rows, export each one in full. This is the
differentiator vs. Caido's native export (which does "all" or "current rows").

Built and tested against the `@caido-community/dev` toolchain, targeting Caido 0.57.

## Features

- **Three clearly-labelled actions** in the row context menu, each in five formats:
  - **Pluck: Copy selected as …**, the highlighted row(s) to the clipboard
  - **Pluck: Save selected as …**, the highlighted row(s) to the export folder
  - **Pluck: Save ALL in-scope as …**, every request of the scope active in HTTP
    History (selection and search filter ignored), to the export folder
  - **Pluck: Save ALL visible as …**, everything HTTP History currently shows
    (active scope **and** search filter), i.e. "select all, then export"
- **Keyboard shortcut** `Ctrl+Shift+E` (Windows/Linux) / `Cmd+Shift+E` (macOS):
  runs *Save ALL visible* in the format chosen in Pluck settings (HAR by default).
  The Caido SDK can read the row selection but not set it, so a real
  `Ctrl/Cmd+A` "select all rows" is not possible from a plugin; this shortcut
  gives the same result without clobbering text selection in the editors.
- Five formats sharing one `Pair` shape:
  - **Raw**, request/response verbatim with readable separators
  - **Markdown**, ` ```http ` blocks, ready to paste into a report
  - **cURL**, reproducible command (method, full URL with http/https inferred from TLS, headers, `--data-raw` body)
  - **JSON**, `{ method, url, host, path, query, reqHeaders, reqBody, status, respHeaders, respBody, timing }`
  - **HAR**, a valid HTTP Archive 1.2 `.har` document (parsed query string, request/response cookies, `postData`, `content`, `timings`), replayable in browser devtools, Burp, or any HAR-aware tool. In bundle mode every selected pair becomes one `entries[]` item in a single log; per-request mode writes one self-contained HAR each.
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
   **Pluck: Copy selected as …** or **Pluck: Save selected as …**.
   To export the whole scope, pick a scope in HTTP History's scope selector,
   right-click any row and pick **Pluck: Save ALL in-scope as …**.

## Notes on the Caido 0.57 SDK

- The plugin menu API has **no nested submenus**, so the four formats are registered
  as flat items whose labels spell out what they act on (selected vs. all in-scope).
- Request/response bytes are read via `sdk.graphql.request({id})` /
  `sdk.graphql.response({id})`; everything else (method, headers, body, status) is
  parsed from the raw bytes, so the plugin doesn't depend on optional GraphQL fields.
- Scheme is inferred from a TLS flag when present, otherwise from the port
  (443 → https), defaulting to https.

## Acknowledgements

The concept, copy/save request/response pairs from Caido for reports and
triage, is inspired by
[v0xyc0n/caido-reqres-exporter](https://github.com/v0xyc0n/caido-reqres-exporter)
by Jakob Pachmann (MIT). Pluck is an independent, from-scratch rewrite with a
different scope: four formatters over a shared `Pair` shape, an enriched metadata
header, an opt-in AI-safe redaction mode, a bundle toggle, and host+path filename
sanitization. No source code was copied; only the SDK boilerplate that Caido
itself dictates is necessarily similar.

## License

MIT
