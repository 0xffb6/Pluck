import { promises as fsp } from "fs";
import { homedir } from "os";

import type { DefineAPI, SDK } from "caido:plugin";

interface SaveFile {
  name: string;
  content: string;
}

interface SaveResult {
  ok: boolean;
  error: string | null;
  written: number;
}

/** Default suggestion for the export folder: <home>/caido-exports. */
async function getDefaultDir(_sdk: SDK): Promise<string> {
  const home = homedir();
  const sep = home.includes("\\") ? "\\" : "/";
  return `${home}${sep}caido-exports`;
}

/**
 * Write each file into `dir` (created if missing). The frontend already builds
 * safe names, but we re-validate here as defense in depth: a name must be a
 * plain filename, no path separators, no `..` traversal.
 */
async function saveFiles(
  _sdk: SDK,
  dir: string,
  files: SaveFile[],
): Promise<SaveResult> {
  if (!dir || typeof dir !== "string") {
    return { ok: false, error: "No export folder set", written: 0 };
  }
  const sep = dir.includes("\\") ? "\\" : "/";
  try {
    await fsp.mkdir(dir, { recursive: true });
    let written = 0;
    for (const f of files) {
      const name = f?.name ?? "";
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
        return { ok: false, error: `Unsafe filename blocked: ${name}`, written };
      }
      const full = dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
      await fsp.writeFile(full, f.content, { encoding: "utf8" });
      written++;
    }
    return { ok: true, error: null, written };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), written: 0 };
  }
}

export type API = DefineAPI<{
  getDefaultDir: typeof getDefaultDir;
  saveFiles: typeof saveFiles;
}>;

export function init(sdk: SDK<API>): void {
  sdk.api.register("getDefaultDir", getDefaultDir);
  sdk.api.register("saveFiles", saveFiles);
}
