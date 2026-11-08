import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

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
  download: $<HTMLAnchorElement>("download"),
  status: $<HTMLSpanElement>("status"),
  tools: $<HTMLDivElement>("tools"),
  eraserSizeWrap: $<HTMLLabelElement>("eraserSizeWrap"),
  eraserSize: $<HTMLInputElement>("eraserSize"),
};

interface FileInfo { name: string; size: number; modified: string }

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

let currentName: string | null = null;
let currentDoc: PDFDocumentProxy | null = null;
let dirty = false;

const fileUrl = (name: string) => `/api/files/${encodeURIComponent(name)}`;

function setStatus(text: string, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function setDirty(value: boolean) {
  dirty = value;
  els.save.disabled = !value || !currentName;
}

// ---------- file list ----------

async function refreshFileList() {
  const res = await fetch("/api/files");
  const files: FileInfo[] = await res.json();
  els.fileList.replaceChildren(
    ...files.map((f) => {
      const li = document.createElement("li");
      li.classList.toggle("current", f.name === currentName);
      const a = document.createElement("a");
      a.href = `?file=${encodeURIComponent(f.name)}`;
      a.textContent = f.name;
      a.title = `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void openFile(f.name);
      });
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.title = "Delete from server";
      del.addEventListener("click", () => void deleteFile(f.name));
      li.append(a, del);
      return li;
    }),
  );
}

async function deleteFile(name: string) {
  if (!confirm(`Delete "${name}" from the server?`)) return;
  const res = await fetch(fileUrl(name), { method: "DELETE" });
  if (!res.ok) return setStatus("Delete failed", true);
  if (name === currentName) await closeDocument();
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
  currentName = null;
  els.empty.classList.remove("hidden");
  els.download.removeAttribute("href");
  els.pageCount.textContent = "/ –";
  document.title = "PDF Editor";
  setDirty(false);
}

async function openFile(name: string, { push = true, force = false } = {}) {
  if (!force && !confirmDiscard()) return;
  setStatus("Loading…");
  try {
    const task = pdfjs.getDocument({
      url: `${fileUrl(name)}?t=${Date.now()}`,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
    });
    const doc = await task.promise;
    const previous = currentDoc;
    const page = force && name === currentName ? viewer.currentPageNumber : 1;
    currentDoc = doc;
    currentName = name;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    void previous?.destroy();

    // Typed as `null` upstream, but pdf.js invokes these callbacks when set.
    const storage = doc.annotationStorage as unknown as Record<string, (() => void) | null>;
    storage.onSetModified = () => setDirty(true);
    storage.onResetModified = () => setDirty(false);
    setDirty(false);

    els.empty.classList.add("hidden");
    els.download.href = fileUrl(name);
    els.download.download = name;
    els.pageCount.textContent = `/ ${doc.numPages}`;
    document.title = `${name} – PDF Editor`;
    if (push) history.pushState(null, "", `?file=${encodeURIComponent(name)}`);
    // Restore the page once the pages have been initialised.
    eventBus.on("pagesinit", () => {
      viewer.currentScaleValue = els.zoomSelect.value;
      viewer.currentPageNumber = Math.min(page, doc.numPages);
    }, { once: true });
    setStatus("");
    await refreshFileList();
  } catch (err) {
    console.error(err);
    setStatus(`Could not open ${name}`, true);
  }
}

// ---------- save / upload ----------

async function save() {
  if (!currentDoc || !currentName) return;
  setStatus("Saving…");
  els.save.disabled = true;
  try {
    const bytes = await currentDoc.saveDocument();
    const res = await fetch(fileUrl(currentName), {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    setDirty(false);
    // Reload so the viewer shows the newly flattened/saved content.
    await openFile(currentName, { push: false, force: true });
    setStatus("Saved");
    setTimeout(() => els.status.textContent === "Saved" && setStatus(""), 2000);
  } catch (err) {
    console.error(err);
    setStatus(`Save failed: ${(err as Error).message}`, true);
    setDirty(true);
  }
}

async function upload(file: File) {
  if (!confirmDiscard()) return;
  setStatus("Uploading…");
  const form = new FormData();
  form.set("file", file);
  const res = await fetch("/api/files", { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) return setStatus(`Upload failed: ${body.error}`, true);
  await openFile(body.name, { force: true });
}

// ---------- toolbar wiring ----------

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  els.fileInput.value = "";
  if (file) void upload(file);
});

els.save.addEventListener("click", () => void save());
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

els.tools.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
  if (!btn) return;
  const name = btn.dataset.mode!;
  const erase = name === "erase";
  const mode = EDITOR_MODES[erase ? "ink" : name];
  if (mode === undefined) return;
  setEraser(erase);
  viewer.annotationEditorMode = { mode };
  for (const b of els.tools.querySelectorAll("button")) b.classList.toggle("active", b === btn);
});

// Erasing is undoable like any other edit: it makes the document dirty.
eventBus.on("annotationeditorstateschanged", (e: { details: { hasSomethingToUndo?: boolean } }) => {
  if (e.details?.hasSomethingToUndo) setDirty(true);
});

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
window.addEventListener("popstate", () => {
  const name = new URLSearchParams(location.search).get("file");
  if (name) void openFile(name, { push: false });
  else void closeDocument();
});

// ---------- boot ----------

await refreshFileList();
const initial = new URLSearchParams(location.search).get("file");
if (initial) await openFile(initial, { push: false, force: true });
