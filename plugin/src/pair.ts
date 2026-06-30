// The single shape every formatter consumes. Built from the raw request/response
// bytes (parsed) plus whatever structured fields Caido's GraphQL happens to expose.

export type Header = [name: string, value: string];

export interface Pair {
  method: string;
  scheme: "http" | "https";
  host: string;
  port: number | null;
  path: string; // path only (no query)
  query: string;
  url: string; // scheme://host[:port]/path?query
  reqHeaders: Header[];
  reqBody: string;
  status: number;
  statusText: string;
  respHeaders: Header[];
  respBody: string;
  contentType: string | null;
  size: number; // response body size in bytes
  timing: number | null; // roundtrip ms, when Caido exposes it
  createdAt: string;
  reqRaw: string; // verbatim — source of truth in repro mode
  respRaw: string;
}

export type Format = "raw" | "markdown" | "curl" | "json";

/** Split a raw HTTP message into start line, headers, and body. */
function parseHttp(raw: string): { startLine: string; headers: Header[]; body: string } {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, "") : "";
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? "";
  const headers: Header[] = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return { startLine, headers, body };
}

function headerValue(headers: Header[], name: string): string | null {
  const lc = name.toLowerCase();
  for (const [n, v] of headers) if (n.toLowerCase() === lc) return v;
  return null;
}

/**
 * Fetch one request+response by id and assemble a Pair.
 * GraphQL ops (verified against a shipping plugin): `sdk.graphql.request({id})`
 * returns `.request` (id, raw, host, path, query, response.id); the response raw
 * comes from `sdk.graphql.response({id})`. Everything else is parsed from raw so
 * we never depend on fields the generated operation might not select.
 */
export async function buildPair(sdk: any, id: string): Promise<Pair> {
  const request = (await sdk.graphql.request({ id }))?.request ?? {};
  const reqRaw: string = request.raw ?? "";

  let respRaw = "";
  let respObj: any = null;
  const respId = request.response?.id;
  if (respId) {
    respObj = (await sdk.graphql.response({ id: respId }))?.response ?? null;
    respRaw = respObj?.raw ?? "";
  }

  const req = parseHttp(reqRaw);
  const res = parseHttp(respRaw);

  const startParts = req.startLine.split(" ");
  const method = startParts[0] || "GET";
  const target = startParts[1] || request.path || "/";
  const qIdx = target.indexOf("?");
  const path = qIdx >= 0 ? target.slice(0, qIdx) : target;
  const query = qIdx >= 0 ? target.slice(qIdx + 1) : request.query ?? "";

  const host = request.host ?? headerValue(req.headers, "host") ?? "";
  const port: number | null = typeof request.port === "number" ? request.port : null;
  // Prefer an explicit TLS flag; fall back to the port; default to https.
  const isTls: boolean =
    typeof request.isTls === "boolean" ? request.isTls : port != null ? port === 443 : true;
  const scheme: "http" | "https" = isTls ? "https" : "http";
  const showPort = port != null && !((isTls && port === 443) || (!isTls && port === 80));
  const reqTarget = target.startsWith("/") ? target : `/${target}`;
  const url = `${scheme}://${host}${showPort ? `:${port}` : ""}${reqTarget}`;

  const resParts = res.startLine.split(" ");
  const status = parseInt(resParts[1] ?? "0", 10) || 0;
  const statusText = resParts.slice(2).join(" ");

  const contentType = headerValue(res.headers, "content-type");
  const contentLength = headerValue(res.headers, "content-length");
  const size =
    contentLength != null
      ? parseInt(contentLength, 10) || 0
      : new TextEncoder().encode(res.body).length;
  const timing = typeof respObj?.roundtripTime === "number" ? respObj.roundtripTime : null;
  const createdAt = typeof request.createdAt === "string" ? request.createdAt : "";

  return {
    method,
    scheme,
    host,
    port,
    path,
    query,
    url,
    reqHeaders: req.headers,
    reqBody: req.body,
    status,
    statusText,
    respHeaders: res.headers,
    respBody: res.body,
    contentType,
    size,
    timing,
    createdAt,
    reqRaw,
    respRaw,
  };
}

const SENSITIVE = ["authorization", "cookie", "set-cookie", "x-api-key"];

/** Opt-in "AI-safe" pass: drop sensitive headers and mask Bearer tokens, in both
 *  the parsed view and the raw text so every formatter stays consistent. */
export function redactPair(p: Pair): Pair {
  const filter = (hs: Header[]) => hs.filter(([n]) => !SENSITIVE.includes(n.toLowerCase()));
  const scrub = (raw: string) =>
    raw
      .split(/\r?\n/)
      .map((line) => {
        const i = line.indexOf(":");
        const name = i > 0 ? line.slice(0, i).trim().toLowerCase() : "";
        if (name && SENSITIVE.includes(name)) return `${line.slice(0, i)}: [REDACTED]`;
        return line.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
      })
      .join("\r\n");
  return {
    ...p,
    reqHeaders: filter(p.reqHeaders),
    respHeaders: filter(p.respHeaders),
    reqRaw: scrub(p.reqRaw),
    respRaw: scrub(p.respRaw),
  };
}

/** Build a collision-resistant, traversal-proof filename from host + path. */
export function safeFilename(p: Pair, ext: string, index: number): string {
  const clean = (s: string) =>
    s
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.{2,}/g, ".") // collapse any `..`
      .replace(/^[._]+|[._]+$/g, "");
  const host = clean(p.host) || "host";
  const path = clean(p.path) || "root";
  const base = `${String(index).padStart(3, "0")}_${host}_${path}`.slice(0, 150);
  return `${base}.${ext}`;
}
