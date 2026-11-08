import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { initDebug } from "./debug.ts";
import { storage, type FileEntry } from "./storage.ts";
import { promptText, renderTextToFile } from "./textStamp.ts";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  container: $<HTMLDivElement>("viewerContainer"),
  viewer: $<HTMLDivElement>("viewer"),
  empty: $<HTMLDivElement>("empty"),
  fileInput: $<HTMLInputElement>("fileInput"),
  fileList: $<HTMLUListElement>("fileList"),
  sidebar: $<HTMLElement>("sidebar"),
  pageNumber: $<HTMLInputElement>("pageNumber"),
  pageCount: $<HTMLSpanElement>("pageCount"),
  zoomSelect: $<HTMLSelectElement>("zoomSelect"),
  save: $<HTMLButtonElement>("save"),
  saveAs: $<HTMLButtonElement>("saveAs"),
  sidebarTitle: $<HTMLElement>("sidebarTitle"),
  download: $<HTMLAnchorElement>("download"),
  status: $<HTMLSpanElement>("status"),
  tools: $<HTMLDivElement>("tools"),
  eraserSizeWrap: $<HTMLLabelElement>("eraserSizeWrap"),
  eraserSize: $<HTMLInputElement>("eraserSize"),
};

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const viewer = new PDFViewer({
  container: els.container,
  viewer: els.viewer,
  eventBus,
  linkService,
  annotationEditorMode: pdfjs.AnnotationEditorType.NONE,
});
linkService.setViewer(viewer);

const EDITOR_MODES: Record<string, number> = {
  none: pdfjs.AnnotationEditorType.NONE,
  freetext: pdfjs.AnnotationEditorType.FREETEXT,
  ink: pdfjs.AnnotationEditorType.INK,
  highlight: pdfjs.AnnotationEditorType.HIGHLIGHT,
};

/** Library file name (web) or absolute path (desktop) of the open document. */
let currentId: string | null = null;
let currentDoc: PDFDocumentProxy | null = null;
let dirty = false;

function setStatus(text: string, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function setDirty(value: boolean) {
  dirty = value;
  els.save.disabled = !value || !currentId;
  els.saveAs.disabled = !currentId;
}

// ---------- file list ----------

async function refreshFileList() {
  let files: FileEntry[];
  try {
    files = await storage.list();
  } catch (err) {
    console.error(err);
    return setStatus("Could not load the file list", true);
  }
  els.fileList.replaceChildren(
    ...files.map((f) => {
      const li = document.createElement("li");
      li.classList.toggle("current", f.id === currentId);
      const a = document.createElement("a");
      a.href = storage.kind === "web" ? `?file=${encodeURIComponent(f.id)}` : "#";
      a.textContent = f.name;
      a.title = f.size === undefined ? f.id : `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void openFile(f.id);
      });
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.title = storage.kind === "web" ? "Delete from server" : "Remove from recent files";
      del.addEventListener("click", () => void deleteFile(f.id));
      li.append(a, del);
      return li;
    }),
  );
}

async function deleteFile(id: string) {
  if (storage.kind === "web" && !confirm(`Delete "${storage.nameOf(id)}" from the server?`)) return;
  try {
    await storage.remove(id);
  } catch (err) {
    console.error(err);
    return setStatus(storage.kind === "web" ? "Delete failed" : "Could not update recent files", true);
  }
  if (storage.kind === "web" && id === currentId) await closeDocument();
  await refreshFileList();
}

// ---------- document lifecycle ----------

function confirmDiscard() {
  return !dirty || confirm("You have unsaved changes. Discard them?");
}

async function closeDocument() {
  viewer.setDocument(null as never);
  linkService.setDocument(null);
  await currentDoc?.destroy();
  currentDoc = null;
  currentId = null;
  els.empty.classList.remove("hidden");
  els.download.removeAttribute("href");
  els.pageCount.textContent = "/ –";
  document.title = "PDF Editor";
  setDirty(false);
}

async function openFile(id: string, { push = true, force = false } = {}) {
  if (!force && !confirmDiscard()) return;
  const name = storage.nameOf(id);
  setStatus("Loading…");
  try {
    const task = pdfjs.getDocument({
      ...(await storage.source(id)),
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
    });
    const doc = await task.promise;
    const previous = currentDoc;
    const page = force && id === currentId ? viewer.currentPageNumber : 1;
    currentDoc = doc;
    currentId = id;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    void previous?.destroy();

    // Typed as `null` upstream, but pdf.js invokes these callbacks when set.
    const annotations = doc.annotationStorage as unknown as Record<string, (() => void) | null>;
    annotations.onSetModified = () => setDirty(true);
    annotations.onResetModified = () => setDirty(false);
    setDirty(false);

    els.empty.classList.add("hidden");
    if (storage.kind === "web") {
      els.download.href = storage.downloadUrl(id);
      els.download.download = name;
    }
    els.pageCount.textContent = `/ ${doc.numPages}`;
    document.title = `${name} – PDF Editor`;
    if (push && storage.kind === "web") history.pushState(null, "", `?file=${encodeURIComponent(id)}`);
    // Restore the page once the pages have been initialised.
    eventBus.on("pagesinit", () => {
      viewer.currentScaleValue = els.zoomSelect.value;
      viewer.currentPageNumber = Math.min(page, doc.numPages);
      if (tabletMode) selectTool(currentTool === "none" ? "ink" : currentTool);
    }, { once: true });
    setStatus("");
    await refreshFileList();
  } catch (err) {
    console.error(err);
    setStatus(`Could not open ${name}`, true);
  }
}

// ---------- save / open ----------

async function save() {
  if (!currentDoc || !currentId) return;
  const id = currentId;
  setStatus("Saving…");
  els.save.disabled = true;
  try {
    await storage.write(id, await currentDoc.saveDocument());
    setDirty(false);
    // Reload so the viewer shows the newly flattened/saved content.
    await openFile(id, { push: false, force: true });
    flashSaved();
  } catch (err) {
    console.error(err);
    setStatus(`Save failed: ${(err as Error).message}`, true);
    setDirty(true);
  }
}

async function saveAs() {
  if (storage.kind !== "desktop" || !currentDoc || !currentId) return;
  setStatus("Saving…");
  try {
    const entry = await storage.saveAs(storage.nameOf(currentId), await currentDoc.saveDocument());
    if (!entry) return setStatus("");
    setDirty(false);
    await openFile(entry.id, { push: false, force: true });
    flashSaved();
  } catch (err) {
    console.error(err);
    setStatus(`Save failed: ${(err as Error).message}`, true);
  }
}

function flashSaved() {
  setStatus("Saved");
  setTimeout(() => els.status.textContent === "Saved" && setStatus(""), 2000);
}

/** Web: upload into the server library, then open it. */
async function upload(file: File) {
  if (storage.kind !== "web" || !confirmDiscard()) return;
  setStatus("Uploading…");
  try {
    const entry = await storage.add(file);
    await openFile(entry.id, { force: true });
  } catch (err) {
    console.error(err);
    setStatus(`Upload failed: ${(err as Error).message}`, true);
  }
}

/** Desktop: native Open dialog. */
async function openNative() {
  if (storage.kind !== "desktop" || !confirmDiscard()) return;
  try {
    const entry = await storage.pick();
    if (entry) await openFile(entry.id, { force: true });
  } catch (err) {
    console.error(err);
    setStatus(`Could not open file: ${(err as Error).message}`, true);
  }
}

// ---------- toolbar wiring ----------

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  els.fileInput.value = "";
  if (file) void upload(file);
});
if (storage.kind === "desktop") {
  // Replace the browser file chooser with the native dialog.
  els.fileInput.addEventListener("click", (e) => {
    e.preventDefault();
    void openNative();
  });
}

els.save.addEventListener("click", () => void save());
els.saveAs.addEventListener("click", () => void saveAs());
$("toggleSidebar").addEventListener("click", () => els.sidebar.classList.toggle("hidden"));
$("prevPage").addEventListener("click", () => viewer.previousPage());
$("nextPage").addEventListener("click", () => viewer.nextPage());
$("zoomIn").addEventListener("click", () => viewer.increaseScale());
$("zoomOut").addEventListener("click", () => viewer.decreaseScale());

els.pageNumber.addEventListener("change", () => {
  const n = Number(els.pageNumber.value);
  if (Number.isInteger(n) && n >= 1 && n <= (currentDoc?.numPages ?? 0)) viewer.currentPageNumber = n;
  else els.pageNumber.value = String(viewer.currentPageNumber);
});

els.zoomSelect.addEventListener("change", () => {
  viewer.currentScaleValue = els.zoomSelect.value;
});

// ---------- eraser (needs our pdf.js fork: INK_ERASER params) ----------

const eraserRing = document.createElement("div");
eraserRing.id = "eraserRing";
eraserRing.hidden = true;
document.body.append(eraserRing);

let eraserActive = false;

function setEraserParam(type: number, value: number | boolean) {
  eventBus.dispatch("switchannotationeditorparams", { source: viewer, type, value });
}

function setEraser(active: boolean) {
  eraserActive = active;
  setEraserParam(pdfjs.AnnotationEditorParamsType.INK_ERASER, active);
  setEraserParam(pdfjs.AnnotationEditorParamsType.INK_ERASER_SIZE, Number(els.eraserSize.value));
  els.eraserSizeWrap.hidden = !active;
  if (!active) eraserRing.hidden = true;
}

function updateEraserRing(e: PointerEvent) {
  const overPage = !!(e.target as HTMLElement).closest?.(".annotationEditorLayer");
  eraserRing.hidden = !(eraserActive && overPage);
  eraserRing.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
}
els.container.addEventListener("pointermove", updateEraserRing);
els.container.addEventListener("pointerleave", () => (eraserRing.hidden = true));

els.eraserSize.addEventListener("input", () => {
  const size = Number(els.eraserSize.value);
  eraserRing.style.width = eraserRing.style.height = `${size}px`;
  setEraserParam(pdfjs.AnnotationEditorParamsType.INK_ERASER_SIZE, size);
});
eraserRing.style.width = eraserRing.style.height = `${els.eraserSize.value}px`;

/** Name of the selected toolbar tool (a `data-mode` value). */
let currentTool = "none";

function selectTool(name: string) {
  const erase = name === "erase";
  const mode = EDITOR_MODES[erase ? "ink" : name];
  if (mode === undefined) return;
  debug?.log("selectTool", { from: currentTool, to: name, stack: new Error().stack?.split("\n").slice(2, 5).join(" | ") });
  currentTool = name;
  setEraser(erase);
  viewer.annotationEditorMode = { mode };
  for (const b of els.tools.querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("active", b.dataset.mode === name);
  }
}

els.tools.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
  if (btn) selectTool(btn.dataset.mode!);
});

// ---------- tablet mode ----------
// pen: draws ink (barrel button / eraser end erases) · finger: scroll, pinch-zoom,
// double-tap toggles fit-page / fit-width · mouse: selects existing annotations.
// The editor stays in ink mode; pointer events are filtered before the pdf.js layer sees them,
// because switching editor modes is async and heavy.

const TABLET_KEY = "tabletMode";
const BARREL_BUTTONS = 2 | 32; // barrel button, pen eraser end

function loadTabletMode(): boolean {
  try {
    const saved = localStorage.getItem(TABLET_KEY);
    if (saved !== null) return saved === "1";
  } catch {}
  return matchMedia("(pointer: coarse)").matches;
}

let tabletMode = false;

/** Tablet routing only applies while the ink/eraser tool is active. */
const tabletInkActive = () => tabletMode && (currentTool === "ink" || currentTool === "erase");

function setTabletMode(on: boolean, { persist = true } = {}) {
  tabletMode = on;
  document.documentElement.classList.toggle("tablet", on);
  document.body.classList.toggle("tablet", on);
  $("tabletToggle").classList.toggle("active", on);
  if (persist) {
    try {
      localStorage.setItem(TABLET_KEY, on ? "1" : "0");
    } catch {}
  }
  if (!currentDoc) return;
  selectTool(on ? "ink" : "none");
}

/** The pen temporarily erases while its barrel button is held. */
let penErasing = false;

function endPenErase() {
  if (!penErasing) return;
  penErasing = false;
  setEraser(currentTool === "erase");
}

els.container.addEventListener(
  "pointerdown",
  (e) => {
    if (!tabletInkActive()) return;
    if (e.pointerType === "touch") {
      // Fingers never draw or select: the browser scrolls, TouchManager pinches.
      e.stopPropagation();
    } else if (e.pointerType === "mouse") {
      // Mouse selects: block strokes on empty page area, but let clicks reach existing editors.
      if ((e.target as HTMLElement).classList.contains("annotationEditorLayer")) e.stopPropagation();
    } else if (e.pointerType === "pen") {
      const erase = (e.buttons & BARREL_BUTTONS) !== 0;
      if (erase && !eraserActive) {
        penErasing = true;
        setEraser(true);
      } else if (!erase && penErasing) {
        endPenErase();
      }
    }
  },
  { capture: true },
);
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, (e) => {
    if ((e as PointerEvent).pointerType === "pen") endPenErase();
  });
}
els.container.addEventListener("contextmenu", (e) => {
  if (tabletMode) e.preventDefault();
});

// Pinch zoom with two fingers (same TouchManager the stock pdf.js viewer uses).
// The generated typings declare the callbacks as `null`, hence the cast.
const touchManagerOptions = {
  container: els.container,
  isPinchingDisabled: () => !tabletMode,
  onPinching: (origin: number[], prevDistance: number, distance: number) => {
    viewer.updateScale({ scaleFactor: distance / prevDistance, origin });
  },
  signal: new AbortController().signal,
};
new pdfjs.TouchManager(touchManagerOptions as unknown as ConstructorParameters<typeof pdfjs.TouchManager>[0]);

// Double-tap with a finger toggles fit-page / fit-width.
const TAP_MAX_MS = 350; // finger down -> up
const TAP_MAX_MOVE = 20; // px
const DOUBLE_TAP_MAX_GAP_MS = 500; // first tap up -> second tap down
const DOUBLE_TAP_MAX_DIST = 60; // px
let lastTap: { upT: number; x: number; y: number } | null = null;
let touchDown: { t: number; x: number; y: number; double: boolean } | null = null;
let activeTouches = 0;
let multiTouch = false;

// Double-tap whose second tap is held opens the text-stamp dialog.
const DOUBLE_TAP_HOLD_MS = 500;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let holdFired = false;

function cancelHold() {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
}

els.container.addEventListener(
  "pointerdown",
  (e) => {
    if (e.pointerType !== "touch") return;
    // The first finger of a gesture is primary: resync in case an up/cancel was missed.
    if (e.isPrimary) {
      activeTouches = 0;
      multiTouch = false;
      holdFired = false;
    }
    activeTouches++;
    if (activeTouches > 1) {
      multiTouch = true;
      cancelHold(); // a second finger means pinch, not the text-stamp gesture
    }
    const double = !!lastTap
      && e.timeStamp - lastTap.upT < DOUBLE_TAP_MAX_GAP_MS
      && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_MAX_DIST;
    touchDown = { t: e.timeStamp, x: e.clientX, y: e.clientY, double };
    if (tabletMode && double) e.preventDefault();
    cancelHold();
    debug?.log("touchDownState", {
      double,
      activeTouches,
      lastTapGap: lastTap ? Math.round(e.timeStamp - lastTap.upT) : null,
      willArmHold: tabletMode && double && activeTouches === 1 && !!currentDoc,
    });
    if (tabletMode && double && activeTouches === 1 && currentDoc) {
      const { clientX: x, clientY: y } = e;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        holdFired = true;
        lastTap = null;
        debug?.log("textStampHold", { x, y });
        void openTextStamp(x, y);
      }, DOUBLE_TAP_HOLD_MS);
    }
  },
  { capture: true },
);
els.container.addEventListener(
  "pointermove",
  (e) => {
    if (e.pointerType !== "touch" || !holdTimer || !touchDown) return;
    if (Math.hypot(e.clientX - touchDown.x, e.clientY - touchDown.y) > TAP_MAX_MOVE) {
      debug?.log("holdCancelled", { reason: "move" });
      cancelHold();
    }
  },
  { capture: true },
);
for (const type of ["pointerup", "pointercancel"]) {
  els.container.addEventListener(
    type,
    (e) => {
      const ev = e as PointerEvent;
      if (ev.pointerType !== "touch") return;
      if (holdTimer) debug?.log("holdCancelled", { reason: type });
      cancelHold();
      activeTouches = Math.max(0, activeTouches - 1);
      if (activeTouches > 0) return;
      if (holdFired) {
        // The long second tap opened the text dialog: not a double-tap, don't toggle fit.
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
      if (!tabletMode || type !== "pointerup" || wasMulti || !down) return lastTap = null;
      const isTap = ev.timeStamp - down.t < TAP_MAX_MS
        && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < TAP_MAX_MOVE;
      if (!isTap) return lastTap = null;
      if (down.double) {
        lastTap = null;
        toggleFit();
      } else {
        lastTap = { upT: ev.timeStamp, x: ev.clientX, y: ev.clientY };
      }
    },
    { capture: true },
  );
}

function toggleFit() {
  debug?.log("toggleFit", { from: viewer.currentScaleValue, hasDocument: !!currentDoc });
  if (!currentDoc) return;
  els.zoomSelect.value = viewer.currentScaleValue === "page-fit" ? "page-width" : "page-fit";
  viewer.currentScaleValue = els.zoomSelect.value;
}

eventBus.on("annotationeditormodechanged", (e: { mode: number }) => debug?.log("editorModeChanged", { mode: e.mode }));

// ---------- text stamps ----------
// Gesture: double-tap, holding the second tap. Opens a DOM text dialog; Apply renders the text to a
// PNG and adds it as a real Stamp annotation carrying the source text (/OPMText in the PDF), so the
// same gesture on that stamp reopens the dialog prefilled and replaces it.

/* eslint-disable @typescript-eslint/no-explicit-any */
type EditorLike = {
  div: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  pageDimensions: [number, number];
  remove(): void;
};
type LayerLike = {
  div: HTMLElement;
  createAndAddNewEditor(
    event: { offsetX: number; offsetY: number },
    isCentered: boolean,
    data: Record<string, unknown>,
  ): EditorLike | null;
};
type UIManagerLike = {
  getLayer(pageIndex: number): LayerLike | undefined;
  getEditors(pageIndex: number): Iterable<EditorLike>;
};

const editorUIManager = (): UIManagerLike | null =>
  (viewer as any)._layerProperties?.annotationEditorUIManager ?? null;

function waitForEditorMode(mode: number, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const bus = eventBus as any;
    const timer = setTimeout(() => {
      bus.off("annotationeditormodechanged", onMode);
      reject(new Error("editor mode switch timed out"));
    }, timeoutMs);
    function onMode(e: { mode: number }) {
      if (e.mode !== mode) return;
      clearTimeout(timer);
      bus.off("annotationeditormodechanged", onMode);
      resolve();
    }
    bus.on("annotationeditormodechanged", onMode);
  });
}

async function openTextStamp(clientX: number, clientY: number) {
  const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const pageEl = target?.closest<HTMLElement>(".page");
  const uiManager = editorUIManager();
  if (!pageEl || !uiManager) return;
  const pageIndex = Number(pageEl.dataset.pageNumber) - 1;

  // Existing text stamp under the finger -> edit it.
  const stampEl = target!.closest<HTMLElement>(".stampEditor[data-opm-text]");
  const old = stampEl ? ([...uiManager.getEditors(pageIndex)].find((ed) => ed.div === stampEl) ?? null) : null;
  const initial = old ? stampEl!.dataset.opmText ?? "" : "";

  const text = await promptText(initial);
  debug?.log("textStampDialog", { editing: !!old, applied: text !== null });
  if (text === null || text === initial) return;

  try {
    const layer = uiManager.getLayer(pageIndex);
    if (!layer) throw new Error("annotation layer not ready");
    // Where to put the centre of the new stamp (client coords): the old stamp's centre, or the finger.
    const rect = layer.div.getBoundingClientRect();
    let cx = clientX - rect.left;
    let cy = clientY - rect.top;
    if (old) {
      cx = (old.x + old.width / 2) * rect.width;
      cy = (old.y + old.height / 2) * rect.height;
    }
    const image = await renderTextToFile(text);

    old?.remove();
    const stampMode = pdfjs.AnnotationEditorType.STAMP;
    const switched = waitForEditorMode(stampMode);
    viewer.annotationEditorMode = { mode: stampMode };
    await switched;

    const editor = layer.createAndAddNewEditor({ offsetX: cx, offsetY: cy }, true, {
      bitmapFile: image.file,
      opmText: text,
    });
    if (!editor) throw new Error("could not create stamp editor");
    // Size in page units; set before the bitmap finishes loading so the stamp uses it.
    const [pageW, pageH] = editor.pageDimensions;
    editor.width = image.width / pageW;
    editor.height = image.height / pageH;
    // The stamp div stays hidden until its bitmap is drawn; don't leave STAMP mode before that.
    for (let i = 0; i < 120 && editor.div.hidden; i++) await new Promise(requestAnimationFrame);
  } catch (err) {
    setStatus(`Text stamp failed: ${(err as Error).message}`, true);
    debug?.log("textStampError", { message: String(err) });
  } finally {
    // Always return to the tool the user was on (ink in tablet mode), whatever happened above.
    const tool = tabletMode && currentTool === "none" ? "ink" : currentTool;
    viewer.annotationEditorMode = { mode: EDITOR_MODES[tool === "erase" ? "ink" : tool]! };
    selectTool(tool);
  }
}

$("tabletToggle").addEventListener("click", () => setTabletMode(!tabletMode));
setTabletMode(loadTabletMode(), { persist: false });

// ?debug=1 streams input events + state to the server log (see debug.ts).
const debug = initDebug(() => ({
  build: "text-stamp-2",
  tabletMode,
  currentTool,
  hasDocument: !!currentDoc,
  scaleValue: viewer.currentScaleValue,
  scale: viewer.currentScale,
  eraserActive,
  penErasing,
  storedTabletMode: (() => {
    try {
      return localStorage.getItem(TABLET_KEY);
    } catch {
      return "unavailable";
    }
  })(),
}));
eventBus.on("scalechanging", (e: { scale: number }) => debug?.log("scalechanging", { scale: e.scale }));

eventBus.on("pagechanging", (e: { pageNumber: number }) => {
  els.pageNumber.value = String(e.pageNumber);
});
eventBus.on("scalechanging", (e: { scale: number }) => {
  const label = `${Math.round(e.scale * 100)}%`;
  let opt = els.zoomSelect.querySelector<HTMLOptionElement>("option[data-custom]");
  if (!opt) {
    opt = document.createElement("option");
    opt.dataset.custom = "1";
    els.zoomSelect.append(opt);
  }
  opt.value = String(e.scale);
  opt.textContent = label;
  // Only show the custom entry when the scale doesn't match a preset.
  const preset = [...els.zoomSelect.options].find(
    (o) => o !== opt && Math.abs(Number(o.value) - e.scale) < 0.001,
  );
  if (preset) els.zoomSelect.value = preset.value;
  else if (els.zoomSelect.value !== "page-width" && els.zoomSelect.value !== "page-fit") {
    els.zoomSelect.value = opt.value;
  }
});

// Drag & drop a PDF anywhere on the viewer.
for (const type of ["dragenter", "dragover"]) {
  els.container.addEventListener(type, (e) => {
    e.preventDefault();
    els.container.classList.add("dragover");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.container.addEventListener(type, () => els.container.classList.remove("dragover"));
}
els.container.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = (e as DragEvent).dataTransfer?.files[0];
  if (file) void upload(file);
});

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    if (dirty) void save();
  }
});
if (storage.kind === "web") {
  window.addEventListener("popstate", () => {
    const name = new URLSearchParams(location.search).get("file");
    if (name) void openFile(name, { push: false });
    else void closeDocument();
  });
}

// ---------- boot ----------

if (storage.kind === "desktop") {
  // Desktop: no server library, no download link; Tauri delivers dropped files as paths.
  els.sidebarTitle.textContent = "Recent files";
  els.download.hidden = true;
  els.saveAs.hidden = false;
  els.save.title = "Save changes to the file";
  const desktop = storage; // keeps the narrowed type inside the callback
  desktop.onDrop((path) => {
    if (!confirmDiscard()) return;
    els.container.classList.remove("dragover");
    void openFile(desktop.remember(path).id, { force: true });
  });
}

await refreshFileList();
if (storage.kind === "web") {
  const initial = new URLSearchParams(location.search).get("file");
  if (initial) await openFile(initial, { push: false, force: true });
}
