// The editor's one and only toolbar: EmbedPDF's own main toolbar, extended with this app's buttons
// (Open / Save / Save As, Text, Tablet, page navigation) and offered in two sizes the user picks:
//
//   minimal   (default) one flat bar with the basic tools: pen, highlighter, text, delete, undo / redo,
//             zoom, pages. No mode tabs, no secondary toolbar.
//   extended  EmbedPDF's full bar (view / annotate / shapes / insert / form / redact modes, search,
//             comments), plus the app buttons.
//
// How it hooks in (EmbedPDF 2.15): commands are registered at runtime, the two bars are merged into the
// UI schema before the document opens (so the per-document UI state is built from them), and the bar to
// show is switched with `setActiveToolbar`. A command's `active` / `disabled` are re-evaluated whenever
// the EmbedPDF store changes, so changes to app state (unsaved edits, tablet mode, ...) poke the store
// with a no-op (`refresh`).

import type { TabletController } from "./pdfium-tablet";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Level = "minimal" | "extended";

const LEVEL_KEY = "editorLevel";
const MINIMAL_BAR = "opm-minimal-toolbar";
const EXTENDED_BAR = "main-toolbar"; // EmbedPDF's own, extended in place

export function loadLevel(): Level {
  try {
    return localStorage.getItem(LEVEL_KEY) === "extended" ? "extended" : "minimal";
  } catch {
    return "minimal";
  }
}

function saveLevel(level: Level) {
  try {
    localStorage.setItem(LEVEL_KEY, level);
  } catch {}
}

/** Custom icons (merged into EmbedPDF's `icons` config). */
export const toolbarIcons = {
  opmTablet: {
    // A tablet with a pen stroke across it.
    viewBox: "0 0 24 24",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    paths: [
      { d: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", stroke: "primary" as const },
      { d: "M8 15l6-6 2 2-6 6H8z", stroke: "primary" as const },
    ],
  },
  opmMoreTools: {
    viewBox: "0 0 24 24",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    paths: [{ d: "M12 5v14M5 12h14", stroke: "primary" as const }],
  },
  opmFewerTools: {
    viewBox: "0 0 24 24",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    paths: [{ d: "M5 12h14", stroke: "primary" as const }],
  },
};

export interface ToolbarHost {
  tablet: TabletController;
  /** Native desktop app (Save As exists) as opposed to the dev browser build. */
  desktop: boolean;
  open(): void;
  save(): void;
  saveAs(): void;
  /** App state the buttons reflect. */
  canSave(): boolean;
  canSaveAs(): boolean;
  busy(): boolean;
}

export interface Toolbar {
  /** Re-evaluates the buttons' active / disabled state after app state changed. */
  refresh(): void;
  /** Wires the bars into a freshly created viewer. Resolves once documents can be opened. */
  setup(viewer: any): Promise<{ registry: any }>;
}

const btn = (id: string, commandId: string, variant: "icon" | "text" | "icon-text" = "icon") => ({
  type: "command-button" as const,
  id,
  commandId,
  variant,
});
const divider = (id: string) => ({ type: "divider" as const, id, orientation: "vertical" as const });
const spacer = (id: string) => ({ type: "spacer" as const, id, flex: true });
const group = (id: string, items: any[], alignment: "start" | "center" | "end" = "start") => ({
  type: "group" as const,
  id,
  alignment,
  gap: 2,
  items,
});

/**
 * A copy of the stock responsive rules with items moved between a breakpoint's `hide` / `show` lists.
 * (An item listed in both is shown, so it has to be removed from the other list.)
 */
function tweakBreakpoint(responsive: any, breakpoint: string, change: { hide?: string[]; show?: string[] }) {
  const bp = responsive?.breakpoints?.[breakpoint];
  if (!bp) return responsive;
  const hide = change.hide ?? [];
  const show = change.show ?? [];
  return {
    ...responsive,
    breakpoints: {
      ...responsive.breakpoints,
      [breakpoint]: {
        ...bp,
        hide: [...(bp.hide ?? []).filter((id: string) => !show.includes(id)), ...hide],
        show: [...(bp.show ?? []).filter((id: string) => !hide.includes(id)), ...show],
      },
    },
  };
}

const NARROW_HIDDEN = ["opm-m-zoom", "opm-m-pan", "opm-m-highlight", "opm-m-sidebar"];

export function createToolbar(host: ToolbarHost): Toolbar {
  let registry: any = null;
  let level: Level = loadLevel();

  const commands = () => registry?.getPlugin("commands")?.provides?.();
  const ui = () => registry?.getPlugin("ui")?.provides?.();
  const docs = () => registry?.getPlugin("document-manager")?.provides?.();
  const activeDoc = (): string | null => docs()?.getActiveDocumentId?.() ?? null;

  function refresh() {
    const c = commands();
    if (!c) return;
    // A command's state is re-resolved on every store update; this dispatches an unchanged value.
    c.setDisabledCategories([...c.getDisabledCategories()]);
  }

  function showBar(next: Level) {
    level = next;
    saveLevel(next);
    const id = activeDoc();
    const scope = id ? ui()?.forDocument(id) : null;
    if (!scope) return;
    scope.setActiveToolbar("top", "main", next === "extended" ? EXTENDED_BAR : MINIMAL_BAR);
    // The minimal bar has no modes, so a secondary (per-mode) toolbar must not linger below it.
    if (next === "minimal") scope.closeToolbarSlot("top", "secondary");
  }

  function registerCommands() {
    const c = commands();
    const cmd = (command: any) => c.registerCommand(command);

    cmd({ id: "opm:open", label: "Open", icon: "fileImport", action: () => host.open(), disabled: () => host.busy() });
    cmd({
      id: "opm:save",
      label: "Save",
      icon: "deviceFloppy",
      action: () => host.save(),
      disabled: () => !host.canSave(),
    });
    cmd({
      id: "opm:save-as",
      label: "Save As…",
      icon: "copy",
      action: () => host.saveAs(),
      disabled: () => !host.canSaveAs(),
      visible: () => host.desktop,
    });
    cmd({
      id: "opm:text",
      label: "Text",
      icon: "freeText",
      description: "Add text: click where it should go. Hebrew / RTL safe. Double-click a text stamp to edit it.",
      action: () => host.tablet.toggleText(),
      active: () => host.tablet.isTextArmed(),
    });
    cmd({
      id: "opm:tablet",
      label: "Tablet",
      icon: "opmTablet",
      description:
        "Tablet mode: pen draws (barrel button erases), finger scrolls / pinch-zooms / double-tap toggles fit, " +
        "long press adds text (drag after the press to draw its box), mouse never draws",
      action: () => host.tablet.toggleTablet(),
      active: () => host.tablet.isTablet(),
    });
    cmd({ id: "opm:more-tools", label: "More tools", icon: "opmMoreTools", action: () => showBar("extended") });
    cmd({ id: "opm:fewer-tools", label: "Basic tools", icon: "opmFewerTools", action: () => showBar("minimal") });
    // The current page, e.g. "3 / 12" (a command's label is static, so it is re-registered on page change).
    cmd({ id: "opm:page", label: "–", action: () => {} });
  }

  function trackPage() {
    const scroll = registry.getPlugin("scroll")?.provides?.();
    const c = commands();
    let shown = "";
    const show = (page: number, total: number) => {
      const label = total > 0 ? `${page}/${total}` : "–";
      if (label === shown) return;
      shown = label;
      c.registerCommand({ id: "opm:page", label, description: "Current page", action: () => {} });
      refresh();
    };
    const update = () => {
      const id = activeDoc();
      const s = id ? scroll?.forDocument(id) : null;
      if (s) show(s.getCurrentPage?.() ?? 0, s.getTotalPages?.() ?? 0);
    };
    scroll?.onPageChange?.((e: { pageNumber: number; totalPages: number }) => show(e.pageNumber, e.totalPages));
    // The first page is shown before any scroll happens, and the total is known only after layout.
    scroll?.onLayoutChange?.(update);
    docs()?.onDocumentOpened?.(update);
  }

  function mergeBars() {
    const u = ui();
    const base = u.getSchema().toolbars[EXTENDED_BAR];

    // Extended: the stock bar, plus the app buttons. Items are inserted next to related stock ones.
    const extendedItems = base.items.map((item: any) => {
      if (item.id === "left-group") {
        const [menu, div1, ...rest] = item.items;
        return {
          ...item,
          items: [
            menu,
            div1,
            btn("opm-open", "opm:open"),
            btn("opm-save", "opm:save"),
            btn("opm-save-as", "opm:save-as"),
            btn("opm-tablet", "opm:tablet"),
            btn("opm-fewer", "opm:fewer-tools"),
            divider("opm-div-file"),
            ...rest,
          ],
        };
      }
      if (item.id === "center-group") {
        return {
          ...item,
          items: [
            btn("opm-prev-page", "scroll:previous-page"),
            btn("opm-page", "opm:page", "text"),
            btn("opm-next-page", "scroll:next-page"),
            divider("opm-div-pages"),
            ...item.items,
          ],
        };
      }
      if (item.id === "right-group") {
        return {
          ...item,
          items: [
            btn("opm-text", "opm:text"),
            ...item.items,
          ],
        };
      }
      return item;
    });

    const minimalItems = [
      group("opm-m-file", [
        btn("opm-open", "opm:open", "icon-text"),
        btn("opm-save", "opm:save", "icon-text"),
        btn("opm-save-as", "opm:save-as"),
      ]),
      divider("opm-m-d1"),
      group("opm-m-view", [
        btn("opm-m-sidebar", "panel:toggle-sidebar"),
        btn("opm-prev-page", "scroll:previous-page"),
        btn("opm-page", "opm:page", "text"),
        btn("opm-next-page", "scroll:next-page"),
        { type: "custom" as const, id: "opm-m-zoom", componentId: "zoom-toolbar", categories: ["zoom"] },
      ]),
      divider("opm-m-d2"),
      group("opm-m-tools", [
        btn("opm-m-pointer", "pointer:toggle"),
        btn("opm-m-pan", "pan:toggle"),
        btn("opm-m-ink", "annotation:add-ink"),
        btn("opm-m-highlighter", "annotation:add-ink-highlighter"),
        btn("opm-m-highlight", "annotation:add-highlight"),
        btn("opm-text", "opm:text"),
        btn("opm-m-delete", "annotation:delete-selected"),
        // Colour / width / opacity of the active tool (or the selection); these choices are remembered.
        btn("opm-m-style", "annotation:toggle-annotation-style"),
      ]),
      divider("opm-m-d3"),
      group("opm-m-history", [btn("opm-m-undo", "history:undo"), btn("opm-m-redo", "history:redo")]),
      spacer("opm-m-spacer"),
      group(
        "opm-m-right",
        [btn("opm-tablet", "opm:tablet"), btn("opm-more", "opm:more-tools", "icon-text")],
        "end",
      ),
    ];

    // The bar shown first is the (last) `permanent` one, so there is no flash of the other one.
    const minimalFirst = level === "minimal";
    u.mergeSchema({
      toolbars: {
        [EXTENDED_BAR]: {
          ...base,
          items: extendedItems,
          permanent: !minimalFirst,
          // 768-1024px: the stock bar is full, so trade the zoom box and pan for a compact zoom menu.
          responsive: tweakBreakpoint(base.responsive, "md", {
            hide: ["zoom-toolbar", "pan-button"],
            show: ["zoom-menu-button"],
          }),
        },
        [MINIMAL_BAR]: {
          id: MINIMAL_BAR,
          position: { placement: "top", slot: "main", order: 1 },
          permanent: minimalFirst,
          // Tablet widths: drop the least needed tools (pinch zoom / double-tap fit replace the zoom box).
          responsive: {
            // A rule that only hides leaves the item hidden everywhere, so the wide band lists them to show.
            breakpoints: {
              narrow: { maxWidth: 900, hide: NARROW_HIDDEN },
              wide: { minWidth: 901, show: NARROW_HIDDEN },
            },
          },
          items: minimalItems,
        },
      },
    });
    // The stylesheet derived from the schema's responsive rules is cached; drop it.
    const plugin = registry.getPlugin("ui");
    plugin?.invalidateStylesheet?.();
    plugin?.stylesheetInvalidated$?.emit?.();
  }

  async function setup(viewer: any) {
    registry = await viewer.registry;
    // Opening a document before every plugin has initialised fails ("Annotation state not found").
    await registry.pluginsReady();
    registerCommands();
    trackPage();
    mergeBars();
    // The bar has a page indicator now: drop the floating one (it fades out and overlaps the page).
    docs()?.onDocumentOpened?.(() => {
      const id = activeDoc();
      if (id) ui()?.forDocument(id)?.disableOverlay?.("page-controls");
    });
    return { registry };
  }

  return { refresh, setup };
}
