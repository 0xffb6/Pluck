import type { Caido } from "@caido/sdk-frontend";

import type { API } from "../../backend/src/index";
import { bundle, FORMATS } from "./formatters";
import { buildPair, redactPair, safeFilename, type Format, type Pair } from "./pair";

type FrontendSDK = Caido<API>;

const PLUGIN = "pluck";

const ALL_FORMATS: Format[] = ["raw", "markdown", "curl", "json", "har"];

interface Settings {
  dir: string;
  bundle: boolean;
  redact: boolean;
  shortcutFormat: Format; // format used by the "Save ALL visible" keyboard shortcut
}

// Single source of truth, kept in sync with sdk.storage.
let settings: Settings = { dir: "", bundle: false, redact: false, shortcutFormat: "har" };

function applyStored(value: unknown): void {
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    settings = {
      dir: typeof o.dir === "string" ? o.dir : settings.dir,
      bundle: Boolean(o.bundle),
      redact: Boolean(o.redact),
      shortcutFormat: ALL_FORMATS.includes(o.shortcutFormat as Format)
        ? (o.shortcutFormat as Format)
        : settings.shortcutFormat,
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
 * Every request id matching a scope and/or an HTTPQL filter, paginated through
 * `sdk.graphql.requests`. Either may be omitted.
 */
async function idsMatching(
  sdk: FrontendSDK,
  scopeId: string | undefined,
  filter: string | undefined,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const res: any = await sdk.graphql.requests({ first: 500, after, scopeId, filter });
    const conn = res?.requests;
    for (const e of conn?.edges ?? []) if (e?.node?.id) ids.push(e.node.id);
    const info = conn?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return ids;
}

/**
 * selection: the highlighted rows.
 * scope:     every request of the active scope (search filter ignored).
 * visible:   everything HTTP History currently shows (active scope + search filter),
 *            i.e. the equivalent of "select all rows, then export".
 */
type Source = "selection" | "scope" | "visible";
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
      ids = await idsMatching(sdk, scopeId, undefined);
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
  } else if (source === "visible") {
    const scopeId = sdk.httpHistory.getScopeId();
    const filter = sdk.httpHistory.getQuery()?.trim() || undefined;
    const scopeName = scopeId
      ? (sdk.scopes.getScopes().find((s) => s.id === scopeId)?.name ?? "current scope")
      : undefined;
    const parts = [scopeName ? `scope "${scopeName}"` : "no scope", filter ? `filter "${filter}"` : "no filter"];
    what = `visible request(s) (${parts.join(", ")})`;
    try {
      ids = await idsMatching(sdk, scopeId, filter);
    } catch (e) {
      sdk.window.showToast(`Could not list visible requests: ${String((e as Error)?.message ?? e)}`, {
        variant: "error",
      });
      return;
    }
    if (ids.length === 0) {
      sdk.window.showToast(`No requests visible in HTTP History (${parts.join(", ")})`, {
        variant: "warning",
      });
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

const IS_MAC = /mac|iphone|ipad/i.test(
  (navigator as any).userAgentData?.platform ?? navigator.platform ?? "",
);
const SHORTCUT_KEYS = [IS_MAC ? "Meta" : "Control", "Shift", "E"];
const shortcutLabel = () => (IS_MAC ? "Cmd+Shift+E" : "Ctrl+Shift+E");

function buildSettingsPage(sdk: FrontendSDK): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = "padding:1.5rem;max-width:680px;display:flex;flex-direction:column;gap:1rem";

  const title = document.createElement("h2");
  title.textContent = "Pluck";
  const hint = document.createElement("p");
  hint.style.opacity = "0.7";
  hint.textContent =
    "In HTTP History, right-click a row: \"Copy selected\" / \"Save selected\" export only the highlighted row(s); \"Save ALL in-scope\" exports every request of the scope active in HTTP History (search filter ignored); \"Save ALL visible\" exports everything HTTP History currently shows (scope + search filter), like select-all then export. Each pair is exported in full.";
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

  const fmtLabel = document.createElement("label");
  fmtLabel.textContent = `Format for the "Save ALL visible" shortcut (${shortcutLabel()})`;
  const fmtSelect = document.createElement("select");
  fmtSelect.style.cssText = "padding:0.4rem;max-width:240px";
  for (const f of ALL_FORMATS) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = FORMATS[f].label;
    fmtSelect.append(opt);
  }
  fmtSelect.value = settings.shortcutFormat;
  fmtSelect.addEventListener("change", () => {
    void sdk.storage.set({ ...settings, shortcutFormat: fmtSelect.value as Format });
  });
  root.append(fmtLabel, fmtSelect);

  // Reflect external storage changes back into the controls.
  sdk.storage.onChange((value) => {
    applyStored(value);
    dirInput.value = settings.dir;
    bundleBox.checked = settings.bundle;
    redactBox.checked = settings.redact;
    fmtSelect.value = settings.shortcutFormat;
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
  const formats = ALL_FORMATS;
  const entries: { action: Action; source: Source; label: string; icon: string }[] = [
    { action: "copy", source: "selection", label: "Copy selected", icon: "fas fa-copy" },
    { action: "save", source: "selection", label: "Save selected", icon: "fas fa-floppy-disk" },
    { action: "save", source: "scope", label: "Save ALL in-scope", icon: "fas fa-layer-group" },
    { action: "save", source: "visible", label: "Save ALL visible", icon: "fas fa-list-check" },
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

  // Keyboard shortcut: "select all + export" without touching the table
  // (the SDK can read the row selection but not set it). Deliberately not
  // Ctrl/Cmd+A, which the request/response editors need for text selection.
  const shortcutId = `${PLUGIN}.save-visible-shortcut`;
  sdk.commands.register(shortcutId, {
    name: `Pluck: Save ALL visible (format from Pluck settings)`,
    group: "Pluck: Save ALL visible",
    run: () => run(sdk, "save", settings.shortcutFormat, "visible", null),
  });
  sdk.shortcuts.register(shortcutId, SHORTCUT_KEYS);

  sdk.navigation.addPage(`/${PLUGIN}`, { body: buildSettingsPage(sdk) });
  sdk.sidebar.registerItem("Pluck", `/${PLUGIN}`, { icon: "fas fa-file-export" });
};
