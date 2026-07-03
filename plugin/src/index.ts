import type { Caido } from "@caido/sdk-frontend";

import type { API } from "../../backend/src/index";
import { bundle, FORMATS } from "./formatters";
import { buildPair, redactPair, safeFilename, type Format, type Pair } from "./pair";

type FrontendSDK = Caido<API>;

const PLUGIN = "pluck";

interface Settings {
  dir: string;
  bundle: boolean;
  redact: boolean;
}

// Single source of truth, kept in sync with sdk.storage.
let settings: Settings = { dir: "", bundle: false, redact: false };

function applyStored(value: unknown): void {
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    settings = {
      dir: typeof o.dir === "string" ? o.dir : settings.dir,
      bundle: Boolean(o.bundle),
      redact: Boolean(o.redact),
    };
  }
}

/**
 * Extract request ids from whatever context the command was fired in.
 * We match on shape, not on the context `type` string, so this keeps working
 * whether Caido hands us `{ requests: [...] }` (row selection) or a single
 * `{ request: {...} }` (request/response pane).
 */
function idsFromContext(ctx: any): string[] {
  if (!ctx) return [];
  if (Array.isArray(ctx.requests)) {
    return ctx.requests.map((r: any) => r?.id).filter((id: unknown): id is string => Boolean(id));
  }
  if (ctx.request?.id) return [ctx.request.id];
  return [];
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

async function collectPairs(sdk: FrontendSDK, ids: string[]): Promise<Pair[]> {
  const out: Pair[] = [];
  for (const id of ids) {
    try {
      let p = await buildPair(sdk, id);
      if (!p.reqRaw) continue; // graphql returned nothing usable, skip
      if (settings.redact) p = redactPair(p);
      out.push(p);
    } catch {
      // Skip a row we can't load rather than aborting the whole export.
    }
  }
  return out;
}

async function run(
  sdk: FrontendSDK,
  action: "copy" | "save",
  fmt: Format,
  ctx: any,
): Promise<void> {
  const ids = idsFromContext(ctx);
  if (ids.length === 0) {
    sdk.window.showToast("No requests selected", { variant: "warning" });
    return;
  }
  const pairs = await collectPairs(sdk, ids);
  if (pairs.length === 0) {
    sdk.window.showToast("Could not load the selected requests", { variant: "error" });
    return;
  }
  const tag = settings.redact ? " (redacted)" : "";

  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(bundle(fmt, pairs));
      sdk.window.showToast(`Copied ${pairs.length} pair(s) as ${FORMATS[fmt].label}${tag}`, {
        variant: "success",
      });
    } catch (e) {
      sdk.window.showToast(`Clipboard failed: ${String((e as Error)?.message ?? e)}`, {
        variant: "error",
      });
    }
    return;
  }

  // save
  if (!settings.dir) {
    sdk.window.showToast("Set an export folder in Pluck settings first", {
      variant: "warning",
    });
    return;
  }
  const ext = FORMATS[fmt].ext;
  const files = settings.bundle
    ? [{ name: `pluck_${stamp()}.${ext}`, content: bundle(fmt, pairs) }]
    : pairs.map((p, i) => ({ name: safeFilename(p, ext, i + 1), content: FORMATS[fmt].render(p) }));

  const res = await sdk.backend.saveFiles(settings.dir, files);
  if (res.ok) {
    sdk.window.showToast(`Saved ${res.written} file(s) to ${settings.dir}${tag}`, {
      variant: "success",
    });
  } else {
    sdk.window.showToast(`Save failed: ${res.error}`, { variant: "error" });
  }
}

function buildSettingsPage(sdk: FrontendSDK): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = "padding:1.5rem;max-width:680px;display:flex;flex-direction:column;gap:1rem";

  const title = document.createElement("h2");
  title.textContent = "Pluck";
  const hint = document.createElement("p");
  hint.style.opacity = "0.7";
  hint.textContent =
    "Select rows in the HTTP history, then right-click → Copy as / Save as. Each selected pair is exported in full.";
  root.append(title, hint);

  const dirLabel = document.createElement("label");
  dirLabel.textContent = "Export folder";
  const dirInput = document.createElement("input");
  dirInput.type = "text";
  dirInput.value = settings.dir;
  dirInput.placeholder = "/path/to/exports";
  dirInput.style.cssText = "width:100%;padding:0.4rem";
  dirInput.addEventListener("change", () => {
    void sdk.storage.set({ ...settings, dir: dirInput.value.trim() });
  });
  root.append(dirLabel, dirInput);

  const bundleRow = document.createElement("label");
  bundleRow.style.cssText = "display:flex;gap:0.5rem;align-items:center";
  const bundleBox = document.createElement("input");
  bundleBox.type = "checkbox";
  bundleBox.checked = settings.bundle;
  bundleBox.addEventListener("change", () => {
    void sdk.storage.set({ ...settings, bundle: bundleBox.checked });
  });
  bundleRow.append(
    bundleBox,
    document.createTextNode("Bundle into a single file (otherwise one file per request)"),
  );
  root.append(bundleRow);

  const redactRow = document.createElement("label");
  redactRow.style.cssText = "display:flex;gap:0.5rem;align-items:center";
  const redactBox = document.createElement("input");
  redactBox.type = "checkbox";
  redactBox.checked = settings.redact;
  redactBox.addEventListener("change", () => {
    void sdk.storage.set({ ...settings, redact: redactBox.checked });
  });
  redactRow.append(
    redactBox,
    document.createTextNode(
      "AI-safe mode: strip Authorization, Cookie, Set-Cookie, X-Api-Key and Bearer tokens",
    ),
  );
  root.append(redactRow);

  // Reflect external storage changes back into the controls.
  sdk.storage.onChange((value) => {
    applyStored(value);
    dirInput.value = settings.dir;
    bundleBox.checked = settings.bundle;
    redactBox.checked = settings.redact;
  });

  return root;
}

export const init = (sdk: FrontendSDK): void => {
  applyStored(sdk.storage.get());
  sdk.storage.onChange((value) => applyStored(value));

  // Seed a default export folder from the backend on first run.
  void (async () => {
    if (!settings.dir) {
      try {
        const dir = await sdk.backend.getDefaultDir();
        await sdk.storage.set({ ...settings, dir });
      } catch {
        // Non-fatal: the user can set the folder manually.
      }
    }
  })();

  const formats: Format[] = ["raw", "markdown", "curl", "json", "har"];
  for (const fmt of formats) {
    for (const action of ["copy", "save"] as const) {
      const id = `${PLUGIN}.${action}-${fmt}`;
      sdk.commands.register(id, {
        name: `${action === "copy" ? "Copy" : "Save"} as ${FORMATS[fmt].label}`,
        group: action === "copy" ? "Copy as" : "Save as",
        run: (ctx: any) => run(sdk, action, fmt, ctx),
      });
      sdk.menu.registerItem({
        type: "RequestRow",
        commandId: id,
        leadingIcon: action === "copy" ? "fas fa-copy" : "fas fa-floppy-disk",
      });
    }
  }

  sdk.navigation.addPage(`/${PLUGIN}`, { body: buildSettingsPage(sdk) });
  sdk.sidebar.registerItem("Pluck", `/${PLUGIN}`, { icon: "fas fa-file-export" });
};
