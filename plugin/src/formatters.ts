import type { Format, Header, Pair } from "./pair";

const PLUCK_VERSION = "1.1.0";

/** Enriched metadata header, what the native export and the original plugin lack. */
function meta(p: Pair): string[] {
  return [
    `${p.method} ${p.url}`,
    `Status: ${p.status}${p.statusText ? ` ${p.statusText}` : ""}`,
    p.contentType ? `Content-Type: ${p.contentType}` : "",
    `Size: ${p.size} bytes`,
    p.timing != null ? `Timing: ${p.timing} ms` : "",
    p.createdAt ? `Date: ${p.createdAt}` : "",
  ].filter(Boolean);
}

/** Single-quote a string for a POSIX shell. */
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function toObject(p: Pair) {
  return {
    method: p.method,
    url: p.url,
    host: p.host,
    path: p.path,
    query: p.query,
    reqHeaders: Object.fromEntries(p.reqHeaders),
    reqBody: p.reqBody,
    status: p.status,
    respHeaders: Object.fromEntries(p.respHeaders),
    respBody: p.respBody,
    timing: p.timing,
  };
}

const formatRaw = (p: Pair): string =>
  `${meta(p)
    .map((l) => `# ${l}`)
    .join("\n")}\n\n===== REQUEST =====\n${p.reqRaw}\n\n===== RESPONSE =====\n${p.respRaw}\n`;

const formatMarkdown = (p: Pair): string =>
  `## ${p.method} ${p.path}\n\n${meta(p)
    .map((l) => `- ${l}`)
    .join("\n")}\n\n**Request**\n\n\`\`\`http\n${p.reqRaw.trimEnd()}\n\`\`\`\n\n**Response**\n\n\`\`\`http\n${p.respRaw.trimEnd()}\n\`\`\`\n`;

const formatCurl = (p: Pair): string => {
  const lines = [`curl -X ${p.method} ${shq(p.url)}`];
  for (const [n, v] of p.reqHeaders) {
    if (n.toLowerCase() === "content-length") continue; // curl sets it
    lines.push(`  -H ${shq(`${n}: ${v}`)}`);
  }
  if (p.reqBody) lines.push(`  --data-raw ${shq(p.reqBody)}`);
  return `${meta(p)
    .map((l) => `# ${l}`)
    .join("\n")}\n${lines.join(" \\\n")}\n`;
};

const formatJson = (p: Pair): string => JSON.stringify(toObject(p), null, 2);

// ---- HAR (HTTP Archive 1.2) --------------------------------------------------
// HAR is a collection format (log.entries[]), so, like JSON, it is special-cased
// in `bundle`. A single-pair render still yields a complete, valid HAR document
// with one entry, which keeps the "one file per request" mode consistent.

const byteLen = (s: string): number => (s ? new TextEncoder().encode(s).length : 0);

function headerValue(headers: Header[], name: string): string | null {
  const lc = name.toLowerCase();
  for (const [n, v] of headers) if (n.toLowerCase() === lc) return v;
  return null;
}

/** `HTTP/1.1` from a start line, defaulting when the version token is absent. */
function httpVersion(startLine: string): string {
  const m = startLine.match(/HTTP\/[\d.]+/i);
  return m ? m[0].toUpperCase() : "HTTP/1.1";
}

const harHeaders = (hs: Header[]) => hs.map(([name, value]) => ({ name, value }));

/** Parse a query string into HAR `{name, value}` pairs (values URL-decoded). */
function harQuery(query: string) {
  if (!query) return [];
  return query.split("&").map((part) => {
    const i = part.indexOf("=");
    const raw = i >= 0 ? part.slice(0, i) : part;
    const val = i >= 0 ? part.slice(i + 1) : "";
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, " "));
      } catch {
        return s;
      }
    };
    return { name: dec(raw), value: dec(val) };
  });
}

/** Request cookies come from a single `Cookie` header: `a=1; b=2`. */
function harReqCookies(headers: Header[]) {
  const raw = headerValue(headers, "cookie");
  if (!raw) return [];
  return raw
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const i = c.indexOf("=");
      return i >= 0
        ? { name: c.slice(0, i).trim(), value: c.slice(i + 1).trim() }
        : { name: c, value: "" };
    });
}

/** Response cookies come from one or more `Set-Cookie` headers, with attributes. */
function harRespCookies(headers: Header[]) {
  const out: Record<string, unknown>[] = [];
  for (const [n, v] of headers) {
    if (n.toLowerCase() !== "set-cookie") continue;
    const parts = v.split(";").map((s) => s.trim());
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const cookie: Record<string, unknown> = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
    };
    for (const attr of parts) {
      const [k, ...rest] = attr.split("=");
      const key = k.trim().toLowerCase();
      const val = rest.join("=").trim();
      if (key === "path") cookie.path = val;
      else if (key === "domain") cookie.domain = val;
      else if (key === "expires") cookie.expires = val;
      else if (key === "httponly") cookie.httpOnly = true;
      else if (key === "secure") cookie.secure = true;
    }
    out.push(cookie);
  }
  return out;
}

function harEntry(p: Pair) {
  const reqStart = p.reqRaw.split(/\r?\n/, 1)[0] ?? "";
  const respStart = p.respRaw.split(/\r?\n/, 1)[0] ?? "";
  const reqBodySize = byteLen(p.reqBody);
  const reqContentType = headerValue(p.reqHeaders, "content-type");

  const request: Record<string, unknown> = {
    method: p.method,
    url: p.url,
    httpVersion: httpVersion(reqStart),
    cookies: harReqCookies(p.reqHeaders),
    headers: harHeaders(p.reqHeaders),
    queryString: harQuery(p.query),
    headersSize: -1,
    bodySize: reqBodySize,
  };
  if (p.reqBody) {
    request.postData = {
      mimeType: reqContentType ?? "application/octet-stream",
      text: p.reqBody,
    };
  }

  const respBodySize = byteLen(p.respBody);
  const response = {
    status: p.status,
    statusText: p.statusText,
    httpVersion: httpVersion(respStart),
    cookies: harRespCookies(p.respHeaders),
    headers: harHeaders(p.respHeaders),
    content: {
      size: respBodySize,
      mimeType: p.contentType ?? "",
      text: p.respBody,
    },
    redirectURL: headerValue(p.respHeaders, "location") ?? "",
    headersSize: -1,
    bodySize: respBodySize,
  };

  const wait = p.timing != null ? p.timing : -1;
  return {
    startedDateTime: p.createdAt || "",
    time: p.timing != null ? p.timing : -1,
    request,
    response,
    cache: {},
    timings: { send: 0, wait, receive: 0 },
  };
}

/** Wrap HAR entries in a complete HTTP Archive 1.2 log document. */
function harLog(entries: unknown[]) {
  return {
    log: {
      version: "1.2",
      creator: { name: "Pluck", version: PLUCK_VERSION },
      entries,
    },
  };
}

const formatHar = (p: Pair): string => JSON.stringify(harLog([harEntry(p)]), null, 2);

export const FORMATS: Record<
  Format,
  { label: string; ext: string; render: (p: Pair) => string }
> = {
  raw: { label: "Raw", ext: "http", render: formatRaw },
  markdown: { label: "Markdown", ext: "md", render: formatMarkdown },
  curl: { label: "cURL", ext: "sh", render: formatCurl },
  json: { label: "JSON", ext: "json", render: formatJson },
  har: { label: "HAR", ext: "har", render: formatHar },
};

const DIVIDER = `\n\n${"─".repeat(60)}\n\n`;

/** Concatenate many pairs for a single clipboard blob or bundled file. */
export function bundle(fmt: Format, pairs: Pair[]): string {
  if (fmt === "json") return JSON.stringify(pairs.map(toObject), null, 2);
  // HAR is a collection: bundle every pair as entries in one HAR log document.
  if (fmt === "har") return JSON.stringify(harLog(pairs.map(harEntry)), null, 2);
  return pairs.map((p) => FORMATS[fmt].render(p)).join(DIVIDER);
}
