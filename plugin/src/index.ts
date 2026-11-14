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

/**
 * Every request id matching the scope currently active in HTTP History,
 * paginated through `sdk.graphql.requests`. The HTTPQL search bar is
 * deliberately NOT applied: this is "everything in scope", nothing else.
 */
async function idsInScope(sdk: FrontendSDK, scopeId: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const res: any = await sdk.graphql.requests({ first: 500, after, scopeId });
    const conn = res?.requests;
    for (const e of conn?.edges ?? []) if (e?.node?.id) ids.push(e.node.id);
    const info = conn?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return ids;
}

type Source = "selection" | "scope";
type Action = "copy" | "save";

async function run(
  sdk: FrontendSDK,
  action: Action,
  fmt: Format,
  source: Source,
  ctx: any,
): Promise<void> {
  if (action === "save" && !settings.dir) {
    sdk.window.showToast("Set an export folder in Pluck settings first", {
      variant: "warning",
    });
    return;
  }

  let ids: string[];
  let what: string;
  if (source === "scope") {
    const scopeId = sdk.httpHistory.getScopeId();
    if (!scopeId) {
      sdk.window.showToast(
        "No scope active in HTTP History: pick a scope in the scope selector first",
        { variant: "warning" },
      );
      return;
    }
    const scopeName = sdk.scopes.getScopes().find((s) => s.id === scopeId)?.name ?? "current scope";
    what = `in-scope request(s) from "${scopeName}"`;
    try {
      ids = await idsInScope(sdk, scopeId);
    } catch (e) {
      sdk.window.showToast(`Could not list in-scope requests: ${String((e as Error)?.message ?? e)}`, {
        variant: "error",
      });
      return;
    }
    if (ids.length === 0) {
      sdk.window.showToast(`No requests match scope "${scopeName}"`, { variant: "warning" });
      return;
    }
    sdk.window.showToast(`Exporting ${ids.length} ${what}…`, { variant: "info" });
  } else {
    ids = idsFromContext(ctx);
    what = "selected request(s)";
    if (ids.length === 0) {
      sdk.window.showToast("No requests selected", { variant: "warning" });
      return;
    }
  }

  const pairs = await collectPairs(sdk, ids);
  if (pairs.length === 0) {
    sdk.window.showToast(`Could not load the ${what}`, { variant: "error" });
    return;
  }
  const tag = settings.redact ? " (redacted)" : "";

  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(bundle(fmt, pairs));
      sdk.window.showToast(`Copied ${pairs.length} ${what} as ${FORMATS[fmt].label}${tag}`, {
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
  const ext = FORMATS[fmt].ext;
  const files = settings.bundle
    ? [{ name: `pluck_${stamp()}.${ext}`, content: bundle(fmt, pairs) }]
    : pairs.map((p, i) => ({ name: safeFilename(p, ext, i + 1), content: FORMATS[fmt].render(p) }));

  // Chunk the backend calls so a large in-scope export never ships one giant payload.
  let written = 0;
  for (let i = 0; i < files.length; i += 100) {
    const res = await sdk.backend.saveFiles(settings.dir, files.slice(i, i + 100));
    written += res.written;
    if (!res.ok) {
      sdk.window.showToast(`Save failed after ${written} file(s): ${res.error}`, { variant: "error" });
      return;
    }
  }
  sdk.window.showToast(
    `Saved ${pairs.length} ${what} as ${FORMATS[fmt].label} (${written} file(s)) to ${settings.dir}${tag}`,
    { variant: "success" },
  );
}

function buildSettingsPage(sdk: FrontendSDK): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = "padding:1.5rem;max-width:680px;display:flex;flex-direction:column;gap:1rem";

  const title = document.createElement("h2");
  title.textContent = "Pluck";
  const hint = document.createElement("p");
  hint.style.opacity = "0.7";
  hint.textContent =
    "In HTTP History, right-click a row: \"Copy selected\" / \"Save selected\" export only the highlighted row(s); \"Save ALL in-scope\" exports every request of the scope active in HTTP History (search filter ignored, selection ignored). Each pair is exported in full.";
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

  // Context-menu entries, registered grouped by what they act on so the menu
  // reads top to bottom: copy selection, save selection, save whole scope.
  // The menu API has no submenus, so each label spells out its source.
  const formats: Format[] = ["raw", "markdown", "curl", "json", "har"];
  const entries: { action: Action; source: Source; label: string; icon: string }[] = [
    { action: "copy", source: "selection", label: "Copy selected", icon: "fas fa-copy" },
    { action: "save", source: "selection", label: "Save selected", icon: "fas fa-floppy-disk" },
    { action: "save", source: "scope", label: "Save ALL in-scope", icon: "fas fa-layer-group" },
  ];
  for (const e of entries) {
    for (const fmt of formats) {
      const id = `${PLUGIN}.${e.action}-${e.source}-${fmt}`;
      sdk.commands.register(id, {
        name: `Pluck: ${e.label} as ${FORMATS[fmt].label}`,
        group: `Pluck: ${e.label}`,
        run: (ctx: any) => run(sdk, e.action, fmt, e.source, ctx),
      });
      sdk.menu.registerItem({ type: "RequestRow", commandId: id, leadingIcon: e.icon });
    }
  }

  sdk.navigation.addPage(`/${PLUGIN}`, { body: buildSettingsPage(sdk) });
  sdk.sidebar.registerItem("Pluck", `/${PLUGIN}`, { icon: "fas fa-file-export" });
};
