// Remembers the editor's drawing settings between launches: per-tool style (pen / highlighter / shapes /
// text colour, width, opacity, font), the custom colour presets, the last drawing tool and the zoom.
//
// Stored as one versioned JSON object in localStorage (`opmPrefs`). EmbedPDF keeps each tool's defaults in
// memory only, so on startup (after the plugins are ready, before a document opens) the saved values are
// pushed back with `annotation.setToolDefaults`; changes are picked up from the plugin's events and written
// out debounced, only when something actually differs. The toolbar level and tablet mode keep their own
// keys (see pdfium-toolbar.ts / pdfium-tablet.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = "opmPrefs";
const VERSION = 1;

/** Tools whose style is remembered. */
const STYLED_TOOLS = [
  "ink",
  "inkHighlighter",
  "highlight",
  "underline",
  "strikeout",
  "squiggly",
  "square",
  "circle",
  "line",
  "lineArrow",
  "polyline",
  "polygon",
  "freeText",
];
/** Style fields that are remembered (only plain strings / numbers; never geometry or content). */
const STYLE_FIELDS = [
  "color",
  "strokeColor",
  "opacity",
  "strokeWidth",
  "strokeStyle",
  "backgroundColor",
  "fontSize",
  "fontColor",
  "fontFamily",
  "textAlign",
];
/** Drawing tools that are re-activated on startup. Anything else (pointer, delete, ...) starts clean. */
const RESTORED_TOOLS = ["ink", "inkHighlighter", "highlight"];
/** EmbedPDF opens documents in its own default mode for a moment; ignore its zoom reports until then. */
const SETTLE_MS = 2000;

interface Prefs {
  v: number;
  tools: Record<string, Record<string, string | number>>;
  colorPresets: string[];
  lastTool: string | null;
  zoom: string | number | null;
}

const empty = (): Prefs => ({ v: VERSION, tools: {}, colorPresets: [], lastTool: null, zoom: null });

function load(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (p && p.v === VERSION) return { ...empty(), ...p };
  } catch {}
  return empty();
}

function store(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
}

const isPlain = (x: unknown): x is string | number =>
  (typeof x === "string" && x.length < 100) || (typeof x === "number" && Number.isFinite(x));

function pickStyle(source: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const field of STYLE_FIELDS) {
    const value = source?.[field];
    if (isPlain(value)) out[field] = value;
  }
  return out;
}

export interface PrefsHost {
  /** In tablet mode the pen tool is managed by the tablet controller, so the last tool is not restored. */
  isTablet(): boolean;
}

/**
 * Restores the saved settings into a freshly created viewer and keeps saving changes.
 * Call after `registry.pluginsReady()` and before the document opens.
 */
export function attachPrefs(registry: any, host: PrefsHost) {
  const prefs = load();
  const ann = registry.getPlugin("annotation")?.provides?.();
  const zoom = registry.getPlugin("zoom")?.provides?.();
  const docs = registry.getPlugin("document-manager")?.provides?.();
  if (!ann) return;

  // EmbedPDF's own defaults: only what the user changed is saved, so a future change of these defaults is
  // not frozen out by a stale copy.
  const stock: Record<string, Record<string, string | number>> = {};
  for (const toolId of STYLED_TOOLS) stock[toolId] = pickStyle(ann.getTool?.(toolId)?.defaults);
  const stockPresets: string[] = ann.getColorPresets?.() ?? [];

  // ---- restore: tool styles + colour presets ----
  for (const toolId of STYLED_TOOLS) {
    const saved = prefs.tools[toolId];
    if (!saved || !ann.getTool?.(toolId)) continue;
    try {
      ann.setToolDefaults(toolId, pickStyle(saved));
    } catch {}
  }
  for (const color of prefs.colorPresets) {
    if (typeof color === "string") {
      try {
        ann.addColorPreset(color);
      } catch {}
    }
  }

  // ---- save ----
  let lastWritten = JSON.stringify(prefs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let zoomIgnoredUntil = 0;

  function snapshot(): Prefs {
    const next: Prefs = { ...prefs, v: VERSION };
    const tools: Prefs["tools"] = {};
    for (const toolId of STYLED_TOOLS) {
      const style = pickStyle(ann.getTool?.(toolId)?.defaults);
      const changed = Object.keys(style).some((field) => style[field] !== stock[toolId]?.[field]);
      if (changed) tools[toolId] = style;
    }
    next.tools = tools;
    try {
      const presets: string[] = ann.getColorPresets?.() ?? [];
      next.colorPresets = presets.filter((c) => !stockPresets.includes(c));
    } catch {}
    return next;
  }

  function flush() {
    timer = undefined;
    const next = snapshot();
    Object.assign(prefs, next);
    const text = JSON.stringify(prefs);
    if (text === lastWritten) return;
    lastWritten = text;
    store(prefs);
  }
  const schedule = () => {
    if (timer === undefined) timer = setTimeout(flush, 400);
  };

  ann.onToolsChange?.(schedule);
  ann.onStateChange?.(schedule); // colour presets have no event of their own

  const activeToolId = (): string | null => {
    const id = docs?.getActiveDocumentId?.();
    return (id && ann.forDocument?.(id)?.getActiveTool?.()?.id) || null;
  };
  ann.onActiveToolChange?.(() => {
    // Restoring (below) and the tablet controller also change tools; only settled, real choices count.
    if (performance.now() < zoomIgnoredUntil) return;
    const id = activeToolId();
    prefs.lastTool = id && RESTORED_TOOLS.includes(id) ? id : null;
    schedule();
  });

  zoom?.onZoomChange?.((e: { level: string | number }) => {
    if (performance.now() < zoomIgnoredUntil) return;
    if (isPlain(e.level)) {
      prefs.zoom = e.level;
      schedule();
    }
  });

  // ---- restore: zoom + last tool, once a document is open ----
  docs?.onDocumentOpened?.((event: any) => {
    const id: string | undefined = (typeof event === "string" ? event : event?.id ?? event?.documentId) ?? docs.getActiveDocumentId?.();
    zoomIgnoredUntil = performance.now() + SETTLE_MS;
    const restore = () => {
      const docId = id ?? docs.getActiveDocumentId?.();
      if (!docId) return;
      try {
        if (prefs.zoom !== null) zoom?.forDocument?.(docId)?.requestZoom(prefs.zoom);
      } catch {}
      try {
        const scope = ann.forDocument?.(docId);
        if (!host.isTablet() && prefs.lastTool && !scope?.getActiveTool?.()) scope?.setActiveTool(prefs.lastTool);
      } catch {}
    };
    // The layout and EmbedPDF's own default mode settle shortly after the document opens; apply once the
    // viewer is ready and once more after, in case the first attempt was overridden.
    setTimeout(restore, 400);
    setTimeout(restore, 1200);
  });

  // Don't lose a pending change when the window closes.
  addEventListener("pagehide", () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      flush();
    }
  });
}
