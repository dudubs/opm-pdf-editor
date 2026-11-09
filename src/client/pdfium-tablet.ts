// Tablet mode for the PDFium (EmbedPDF) editor — same behaviour as the pdf.js editor's tablet mode:
//   pen    draws ink; barrel button / eraser end erases the strokes it touches while held
//   finger scrolls (one finger), pinch-zooms (EmbedPDF's own gesture), double-tap toggles fit-page /
//          fit-width, double-tap + hold the second tap opens the text-stamp dialog
//   mouse  never draws; it only interacts with existing annotations
//
// Text stamps (Hebrew-safe: text is rendered to an image, the source text stays in /Contents) are also
// reachable outside tablet mode: the "Text" button (or EmbedPDF's own Text tool) arms a one-shot
// placement click, and double-clicking an existing text stamp edits it.
//
// EmbedPDF sets `touch-action: none` on its pages while the ink tool is active, so finger scrolling
// is done here. Pointer events are filtered in the capture phase on the viewer's host element, before
// they reach the plugin's listeners inside the shadow DOM.

import { promptText, renderTextToCanvas } from "./textStamp";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TABLET_KEY = "tabletMode"; // shared with the pdf.js editor
const BARREL_BUTTONS = 2 | 32; // barrel button, pen eraser end
const INK = 15; // PdfAnnotationSubtype.INK
const STAMP = 13; // PdfAnnotationSubtype.STAMP
const ERASER_MODE = "opm-eraser";
const ERASER_RADIUS_PX = 14; // on screen, so it feels the same at any zoom

const TAP_MAX_MS = 350; // finger down -> up
const TAP_MAX_MOVE = 20; // px
const DOUBLE_TAP_MAX_GAP_MS = 500; // first tap up -> second tap down
const DOUBLE_TAP_MAX_DIST = 60; // px
const DOUBLE_TAP_HOLD_MS = 500;

function loadTabletMode(): boolean {
  try {
    const saved = localStorage.getItem(TABLET_KEY);
    if (saved !== null) return saved === "1";
  } catch {}
  return matchMedia("(pointer: coarse)").matches;
}

interface Caps {
  ann: any;
  zoom: any;
  im: any;
  docs: any;
  scroll: any;
}

export interface TabletController {
  /** Call after every EmbedPDF.init(). */
  attach(viewer: any): void;
  isTablet(): boolean;
  toggleTablet(): void;
  isTextArmed(): boolean;
  toggleText(): void;
}

export function initTablet({
  target,
  onChange,
}: {
  target: HTMLElement;
  /** Called whenever tablet mode or the armed state of the Text tool changes (toolbar refresh). */
  onChange: () => void;
}): TabletController {
  let tablet = false;
  let viewer: any = null;
  let caps: Caps | null = null;
  const erasable = new Set<string>(); // docIds that already have eraser handlers

  // ---------- plumbing ----------
  const shadow = () => (viewer?.shadowRoot as ShadowRoot | null) ?? null;
  const docId = (): string | null => caps?.docs.getActiveDocumentId?.() ?? null;
  const annScope = () => {
    const id = docId();
    return caps && id ? caps.ann.forDocument(id) : null;
  };
  const activeToolId = (): string | null => annScope()?.getActiveTool?.()?.id ?? null;

  /** The document area (not the toolbar / sidebars) and its scroll container. */
  function content(): HTMLElement | null {
    return shadow()?.querySelector<HTMLElement>("#document-content") ?? null;
  }
  function scroller(): HTMLElement | null {
    const root = content();
    if (!root) return null;
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.firstElementChild) return el;
    }
    return null;
  }
  const inContent = (e: Event) => {
    const c = content();
    return !!c && e.composedPath().includes(c);
  };

  /** Pen / eraser routing only while ink is the active tool (or the eraser mode is). */
  const inkRouting = () => tablet && (erasing || activeToolId() === "ink");

  // ---------- tool management ----------
  function applyTool() {
    const a = annScope();
    if (!a) return;
    if (tablet) {
      if (a.getActiveTool?.()?.id !== "ink") {
        a.setActiveTool("ink");
      }
    } else if (a.getActiveTool?.()?.id === "ink") {
      a.setActiveTool(null);
    }
  }

  /**
   * Existing ink is rendered as SVG paths that grab the press (to select it) before the ink tool sees it,
   * so a stroke starting on old ink would not draw. While a pen is in range (hover precedes touch) those
   * paths are made transparent to pointer events; the first mouse movement turns that off again.
   */
  const PEN_CLASS = "opm-pen";
  function setPenPassThrough(on: boolean) {
    if (!viewer) return;
    if (on) {
      const root = shadow();
      if (root && !root.getElementById("opm-pen-style")) {
        const style = document.createElement("style");
        style.id = "opm-pen-style";
        style.textContent = `:host(.${PEN_CLASS}) #document-content svg * { pointer-events: none !important; }`;
        root.append(style);
      }
    }
    viewer.classList.toggle(PEN_CLASS, on);
  }

  /** Pen touches never select (no selection box / resize handles); mouse clicks still do. */
  let lastDownType = "";
  function clearSelection() {
    if (!tablet || lastDownType !== "pen") return;
    const a = annScope();
    if (a?.getSelectedAnnotation?.()) a.deselectAnnotation();
  }

  function setTablet(on: boolean, persist = true) {
    tablet = on;
    document.documentElement.classList.toggle("tablet", on);
    if (persist) {
      try {
        localStorage.setItem(TABLET_KEY, on ? "1" : "0");
      } catch {}
    }
    applyTool();
    if (!on) setPenPassThrough(false);
    onChange();
  }

  // ---------- coordinates ----------
  /** Client point -> { pageIndex, x, y } in page points (origin top-left), or null between pages. */
  function pointToPage(cx: number, cy: number) {
    if (!caps) return null;
    const id = docId();
    const sc = scroller();
    const wrap = sc?.firstElementChild as HTMLElement | null;
    if (!id || !wrap) return null;
    const zoom: number = caps.zoom.forDocument(id).getState().currentZoomLevel;
    const items: any[] = caps.scroll.forDocument(id).getLayout().virtualItems;
    const wr = wrap.getBoundingClientRect();
    const relY = (cy - wr.top) / zoom;
    const item = items.find((i) => relY >= i.offset && relY < i.offset + i.height);
    const layout = item?.pageLayouts?.[0];
    if (!item || !layout) return null;
    const x = (cx - wr.left - (wr.width - item.width * zoom) / 2) / zoom;
    const y = relY - item.offset;
    if (x < 0 || x > item.width) return null;
    return { pageIndex: layout.pageIndex as number, x, y, zoom };
  }

  // ---------- eraser ----------
  let erasing = false;
  const ring = document.createElement("div");
  ring.style.cssText =
    `position:fixed;left:0;top:0;width:${ERASER_RADIUS_PX * 2}px;height:${ERASER_RADIUS_PX * 2}px;` +
    "box-sizing:border-box;border:1.5px solid #111;border-radius:50%;pointer-events:none;z-index:1000;" +
    "box-shadow:0 0 0 1px #fff;display:none";
  document.body.append(ring);
  const moveRing = (x: number, y: number) => {
    ring.style.display = "block";
    ring.style.transform = `translate(${x - ERASER_RADIUS_PX}px, ${y - ERASER_RADIUS_PX}px)`;
  };

  function distToSegment(px: number, py: number, a: any, b: any) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  /** Removes the ink strokes within the eraser radius of (x, y) on a page. */
  function eraseAt(pageIndex: number, x: number, y: number, zoom: number) {
    const a = annScope();
    if (!a) return;
    const radius = ERASER_RADIUS_PX / zoom;
    for (const tracked of a.getAnnotations({ pageIndex }) as any[]) {
      const o = tracked.object;
      if (o.type !== INK) continue;
      const reach = radius + (o.strokeWidth ?? 1) / 2;
      const strokes: any[] = o.inkList ?? [];
      const kept = strokes.filter((s) => {
        const pts: any[] = s.points;
        if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y) > reach;
        for (let i = 1; i < pts.length; i++) if (distToSegment(x, y, pts[i - 1], pts[i]) <= reach) return false;
        return true;
      });
      if (kept.length === strokes.length) continue;
      if (kept.length === 0) {
        a.deleteAnnotation(pageIndex, o.id);
        continue;
      }
      // Some strokes survive: shrink the annotation to them.
      const pts = kept.flatMap((s) => s.points as any[]);
      const pad = (o.strokeWidth ?? 1) / 2;
      const minX = Math.min(...pts.map((p) => p.x)) - pad;
      const minY = Math.min(...pts.map((p) => p.y)) - pad;
      const maxX = Math.max(...pts.map((p) => p.x)) + pad;
      const maxY = Math.max(...pts.map((p) => p.y)) + pad;
      a.updateAnnotation(pageIndex, o.id, {
        inkList: kept,
        rect: { origin: { x: minX, y: minY }, size: { width: maxX - minX, height: maxY - minY } },
      });
    }
  }

  function registerEraser() {
    if (!caps) return;
    const id = docId();
    const doc = caps.docs.getActiveDocument?.();
    if (!id || !doc || erasable.has(id)) return;
    erasable.add(id);
    const pages: number = doc.pages?.length ?? 0;
    for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
      const at = (evt: any) => {
        if (!erasing) return;
        const p = pointToPage(evt.clientX, evt.clientY);
        if (p) eraseAt(p.pageIndex, p.x, p.y, p.zoom);
        moveRing(evt.clientX, evt.clientY);
      };
      caps.im.registerHandlers({
        documentId: id,
        modeId: ERASER_MODE,
        pageIndex,
        handlers: { onPointerDown: (_p: any, evt: any) => at(evt), onPointerMove: (_p: any, evt: any) => at(evt) },
      });
    }
  }

  function startErasing() {
    const id = docId();
    if (!caps || !id || erasing) return;
    erasing = true;
    caps.im.forDocument(id).activate(ERASER_MODE);
  }
  function stopErasing() {
    if (!erasing) return;
    erasing = false;
    ring.style.display = "none";
    applyTool();
  }
  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, (e) => {
      if ((e as PointerEvent).pointerType === "pen") stopErasing();
    });
  }

  // ---------- pointer routing ----------
  const touches = new Map<number, { x: number; y: number }>();
  let panBlocked = false; // a second finger joined: pinch owns the gesture until all fingers lift
  let pan: { scroller: HTMLElement; x: number; y: number; t: number; vx: number; vy: number } | null = null;
  let flingRaf = 0;

  function fling(sc: HTMLElement, vx: number, vy: number) {
    cancelAnimationFrame(flingRaf);
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      sc.scrollLeft -= vx * dt;
      sc.scrollTop -= vy * dt;
      const decay = Math.pow(0.995, dt);
      vx *= decay;
      vy *= decay;
      if (Math.hypot(vx, vy) > 0.02) flingRaf = requestAnimationFrame(step);
    };
    flingRaf = requestAnimationFrame(step);
  }

  // Double-tap -> toggle fit; double-tap, holding the second tap -> text stamp.
  let lastTap: { upT: number; x: number; y: number } | null = null;
  let touchDown: { t: number; x: number; y: number; double: boolean } | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdFired = false;
  let multiTouch = false;
  const cancelHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };

  /**
   * Toggles fit-page / fit-width and scrolls to the page that was double-tapped, so fit-page shows that
   * whole page top-to-bottom and fit-width shows it left-to-right (starting at its top edge).
   */
  function toggleFit(clientX: number, clientY: number) {
    const id = docId();
    if (!caps || !id) return;
    const pageIndex = pointToPage(clientX, clientY)?.pageIndex ?? caps.scroll.forDocument(id).getCurrentPage?.() - 1;
    const z = caps.zoom.forDocument(id);
    const sc = caps.scroll.forDocument(id);
    const toPage = () => {
      if (typeof pageIndex === "number" && pageIndex >= 0) {
        sc.scrollToPage({ pageNumber: pageIndex + 1, behavior: "instant", alignX: 0, alignY: 0 });
      }
    };
    // The zoom changes the layout asynchronously: scroll once it has settled (and again if it moves).
    let settle: ReturnType<typeof setTimeout> | null = null;
    const off = sc.onLayoutChange?.(() => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(toPage, 60);
    });
    z.requestZoom(z.getState().zoomLevel === "fit-page" ? "fit-width" : "fit-page");
    setTimeout(() => {
      if (typeof off === "function") off();
      if (settle) clearTimeout(settle);
      toPage();
    }, 600);
  }

  /** Touch pointers: never draw, scroll with one finger, detect tap gestures. */
  function onTouch(e: PointerEvent) {
    e.stopPropagation();
    const type = e.type;
    if (type === "pointerdown") {
      if (e.isPrimary) {
        touches.clear();
        panBlocked = false;
        multiTouch = false;
        holdFired = false;
        cancelAnimationFrame(flingRaf);
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size > 1) {
        panBlocked = true;
        multiTouch = true;
        pan = null;
        cancelHold();
        return;
      }
      const double =
        !!lastTap &&
        e.timeStamp - lastTap.upT < DOUBLE_TAP_MAX_GAP_MS &&
        Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_MAX_DIST;
      touchDown = { t: e.timeStamp, x: e.clientX, y: e.clientY, double };
      cancelHold();
      if (double) {
        const { clientX: x, clientY: y } = e;
        holdTimer = setTimeout(() => {
          holdTimer = null;
          holdFired = true;
          lastTap = null;
          void openTextStamp(x, y);
        }, DOUBLE_TAP_HOLD_MS);
      }
      const sc = scroller();
      if (sc && activeToolId() === "ink") {
        pan = { scroller: sc, x: e.clientX, y: e.clientY, t: e.timeStamp, vx: 0, vy: 0 };
      }
    } else if (type === "pointermove") {
      if (holdTimer && touchDown && Math.hypot(e.clientX - touchDown.x, e.clientY - touchDown.y) > TAP_MAX_MOVE) {
        cancelHold();
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pan && !panBlocked) {
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        const dt = Math.max(1, e.timeStamp - pan.t);
        pan.scroller.scrollLeft -= dx;
        pan.scroller.scrollTop -= dy;
        // Smoothed velocity (px/ms) for the fling on release.
        pan.vx = pan.vx * 0.6 + (dx / dt) * 0.4;
        pan.vy = pan.vy * 0.6 + (dy / dt) * 0.4;
        pan.x = e.clientX;
        pan.y = e.clientY;
        pan.t = e.timeStamp;
      }
    } else {
      // pointerup / pointercancel
      cancelHold();
      touches.delete(e.pointerId);
      const wasPan = pan;
      pan = null;
      if (touches.size > 0) return;
      if (wasPan && !panBlocked && type === "pointerup" && Math.hypot(wasPan.vx, wasPan.vy) > 0.15) {
        fling(wasPan.scroller, wasPan.vx, wasPan.vy);
      }
      if (holdFired) {
        holdFired = false;
        touchDown = null;
        multiTouch = false;
        lastTap = null;
        return;
      }
      const down = touchDown;
      const wasMulti = multiTouch;
      touchDown = null;
      multiTouch = false;
      if (type !== "pointerup" || wasMulti || !down) {
        lastTap = null;
        return;
      }
      const isTap =
        e.timeStamp - down.t < TAP_MAX_MS && Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP_MAX_MOVE;
      if (!isTap) {
        lastTap = null;
      } else if (down.double) {
        lastTap = null;
        toggleFit(e.clientX, e.clientY);
      } else {
        lastTap = { upT: e.timeStamp, x: e.clientX, y: e.clientY };
      }
    }
  }

  // One-shot text placement: the next press on a page opens the text dialog there. The press and
  // everything that follows from the same pointer is kept away from EmbedPDF's active tool.
  let textArmed = false;
  let swallowId: number | null = null;
  function setTextArmed(on: boolean) {
    textArmed = on;
    swallowId = null;
    target.classList.toggle("text-armed", on);
    onChange();
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && textArmed) setTextArmed(false);
  });

  function onPointer(e: PointerEvent) {
    if (!inContent(e)) return;
    if (e.type === "pointerdown") lastDownType = e.pointerType;
    if (e.pointerType === "pen") setPenPassThrough(tablet);
    else if (e.pointerType === "mouse") setPenPassThrough(false);
    if (textArmed && e.type === "pointerdown" && swallowId === null) swallowId = e.pointerId;
    if (swallowId === e.pointerId) {
      e.stopPropagation();
      if (e.type === "pointerup") {
        setTextArmed(false);
        void openTextStamp(e.clientX, e.clientY);
      } else if (e.type === "pointercancel") {
        swallowId = null;
      }
      return;
    }
    if (!tablet) return;
    if (e.pointerType === "touch") {
      // Fingers don't draw. Gestures work with the ink tool or with no tool at all.
      const tool = activeToolId();
      if (tool === "ink" || tool === null || erasing) onTouch(e);
      return;
    }
    if (!inkRouting()) return;
    if (e.pointerType === "mouse") {
      // Mouse selects: block strokes on empty page area, but let clicks reach existing annotations.
      if (!isAnnotationTarget(e)) e.stopPropagation();
    } else if (e.pointerType === "pen" && e.type === "pointerdown") {
      if ((e.buttons & BARREL_BUTTONS) !== 0) startErasing();
      else if (erasing) stopErasing();
    }
  }

  /** Is the event over an annotation (selection box / handles) rather than empty page? */
  function isAnnotationTarget(e: Event): boolean {
    const t = e.composedPath()[0] as HTMLElement | undefined;
    return !!t?.closest?.("[data-annotation-id], [data-epdf-annotation], .annotation-container");
  }

  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    target.addEventListener(type, (e) => onPointer(e as PointerEvent), { capture: true });
  }
  // Double-click an existing text stamp to edit it (mouse; touch uses double-tap + hold).
  target.addEventListener(
    "dblclick",
    (e) => {
      if (!inContent(e)) return;
      void openTextStamp(e.clientX, e.clientY, { onlyExisting: true });
    },
    { capture: true },
  );
  // No browser context menu in tablet mode, nor for any touch long-press (one or two fingers). Registered on
  // window in the capture phase so EmbedPDF's own handlers (which may stop propagation inside #viewer) and
  // events that land outside #viewer (toolbar, gaps between pages) can't let the menu through.
  window.addEventListener(
    "contextmenu",
    (e) => {
      const touch = (e as PointerEvent).pointerType === "touch" || lastDownType === "touch";
      if (tablet || touch) e.preventDefault();
    },
    { capture: true },
  );

  // ---------- text stamps ----------
  // A real Stamp annotation whose /Contents holds the source text, so the same gesture on it
  // reopens the dialog prefilled and replaces it.
  async function openTextStamp(clientX: number, clientY: number, { onlyExisting = false } = {}) {
    const a = annScope();
    const p = pointToPage(clientX, clientY);
    if (!a || !p) return;

    const existing = (a.getAnnotations({ pageIndex: p.pageIndex }) as any[])
      .map((t) => t.object)
      .find(
        (o) =>
          o.type === STAMP &&
          o.contents &&
          p.x >= o.rect.origin.x &&
          p.x <= o.rect.origin.x + o.rect.size.width &&
          p.y >= o.rect.origin.y &&
          p.y <= o.rect.origin.y + o.rect.size.height,
      );
    if (onlyExisting && !existing) return;
    const initial: string = existing?.contents ?? "";
    const text = await promptText(initial);
    if (text === null || text === initial) return;

    const { canvas, width, height } = renderTextToCanvas(text);
    const imageData = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    const cx = existing ? existing.rect.origin.x + existing.rect.size.width / 2 : p.x;
    const cy = existing ? existing.rect.origin.y + existing.rect.size.height / 2 : p.y;
    if (existing) a.deleteAnnotation(p.pageIndex, existing.id);
    a.createAnnotation(
      p.pageIndex,
      {
        type: STAMP,
        id: `opm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, // randomUUID needs https
        pageIndex: p.pageIndex,
        rect: { origin: { x: cx - width / 2, y: cy - height / 2 }, size: { width, height } },
        contents: text,
      },
      { imageData },
    );
    applyTool();
  }

  // ---------- wiring ----------
  async function attach(v: any) {
    viewer = v;
    caps = null;
    erasable.clear();
    if (!v) return;
    const reg = await v.registry;
    if (viewer !== v) return;
    const p = (id: string) => reg.getPlugin(id)?.provides?.();
    const c: Caps = {
      ann: p("annotation"),
      zoom: p("zoom"),
      im: p("interaction-manager"),
      docs: p("document-manager"),
      scroll: p("scroll"),
    };
    caps = c;
    // Pen touches never leave an annotation selected.
    c.ann.onStateChange?.(() => clearSelection());
    // A finished stroke stays unselected, so the next pen stroke never grabs the previous one.
    const ink = c.ann.getTool?.("ink");
    if (ink?.behavior) ink.behavior.selectAfterCreate = false;
    // EmbedPDF's own Text tool would create a FreeText annotation (no Hebrew shaping / RTL): turn it into
    // our text-stamp placement instead.
    c.ann.onActiveToolChange?.((e: any) => {
      const tool = e && "tool" in e ? e.tool : e;
      if (tool?.id !== "freeText") return;
      queueMicrotask(() => {
        c.ann.setActiveTool(null);
        applyTool();
        setTextArmed(true);
      });
    });
    c.im.registerMode({ id: ERASER_MODE, scope: "page", exclusive: true, cursor: "cell" });
    // EmbedPDF's pan plugin re-activates its default (pan) mode while a document opens, which would
    // drop our ink tool; re-assert it for a short settle window. Later changes are the user's.
    let settleUntil = 0;
    c.im.onModeChange?.((e: any) => {
      if (tablet && !erasing && e.activeMode === "panMode" && performance.now() < settleUntil) applyTool();
    });
    const onDoc = () => {
      settleUntil = performance.now() + 4000;
      try {
        registerEraser();
        applyTool();
      } catch {
        // "Active document changed" can fire before the annotation plugin has created its state for the
        // new document; the document-opened event / the polling below call this again once it exists.
      }
    };
    c.docs.onDocumentOpened?.(onDoc);
    c.docs.onActiveDocumentChanged?.(onDoc);
    // The document may already be open, or finish loading after the events above.
    for (let i = 0; i < 60 && viewer === v; i++) {
      if (docId() && c.docs.getActiveDocument?.()) {
        onDoc();
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  setTablet(loadTabletMode(), false);
  return {
    attach: (v) => void attach(v),
    isTablet: () => tablet,
    toggleTablet: () => setTablet(!tablet),
    isTextArmed: () => textArmed,
    toggleText: () => setTextArmed(!textArmed),
  };
}
