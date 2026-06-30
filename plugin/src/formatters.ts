import type { Format, Pair } from "./pair";

/** Enriched metadata header — what the native export and the original plugin lack. */
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

export const FORMATS: Record<
  Format,
  { label: string; ext: string; render: (p: Pair) => string }
> = {
  raw: { label: "Raw", ext: "http", render: formatRaw },
  markdown: { label: "Markdown", ext: "md", render: formatMarkdown },
  curl: { label: "cURL", ext: "sh", render: formatCurl },
  json: { label: "JSON", ext: "json", render: formatJson },
};

const DIVIDER = `\n\n${"─".repeat(60)}\n\n`;

/** Concatenate many pairs for a single clipboard blob or bundled file. */
export function bundle(fmt: Format, pairs: Pair[]): string {
  if (fmt === "json") return JSON.stringify(pairs.map(toObject), null, 2);
  return pairs.map((p) => FORMATS[fmt].render(p)).join(DIVIDER);
}
