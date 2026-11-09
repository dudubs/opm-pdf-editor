// The PDF editor: EmbedPDF (PDFium) with its stock UI, plus tablet mode + Hebrew-safe text stamps
// (pdfium-tablet.ts) and file handling.
//
// Product (Tauri desktop): files are opened from disk by path (native dialog, drag-and-drop, recent
// files, "open with" / command line via the Rust shell) and Save writes back to the same path; Save As
// picks a new one. The PDF is handed to EmbedPDF as bytes, so nothing here talks to a server.
// Dev (plain browser + the Bun server): Open… / drop uploads a local PDF into the server data dir; `?file=<name>` loads from / saves to it.
// @ts-ignore - resolved at runtime from /embedpdf/embedpdf.js
import EmbedPDF from "/embedpdf/embedpdf.js";

import { viewerConfig } from "./pdfium-config";
import { initTablet } from "./pdfium-tablet";
import { createToolbar, toolbarIcons } from "./pdfium-toolbar";
import { storage } from "./storage";

/* eslint-disable @typescript-eslint/no-explicit-any */

const desktop = storage.kind === "desktop" ? storage : null;
const web = storage.kind === "web" ? storage : null;

const target = document.getElementById("viewer")!;
const openButton = document.getElementById("open") as HTMLButtonElement;
const recentSelect = document.getElementById("recents") as HTMLSelectElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const statusEl = document.getElementById("status")!;

// The toolbar is EmbedPDF's own (pdfium-toolbar.ts); `toolbar` is assigned below, after the tablet controller
// it needs, so the tablet's first change notification (at init) must tolerate it being unset.
let toolbar: ReturnType<typeof createToolbar> | undefined;
const tablet = initTablet({ target, onChange: () => toolbar?.refresh() });

let viewer: any;
/** Absolute path (desktop) or server file name (dev). Null while nothing is open. */
let currentId: string | null = null;
let dirty = false;
let busy = false;

// ---------- chrome: status, title, buttons ----------

function setStatus(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function flashStatus(text: string) {
  setStatus(text);
  setTimeout(() => statusEl.textContent === text && setStatus(""), 2000);
}

function refreshChrome() {
  const name = currentId ? storage.nameOf(currentId) : "";
  const title = `${dirty ? "• " : ""}${name ? `${name} — ` : ""}PDF Editor`;
  document.title = title;
  toolbar?.refresh();
  if (desktop) {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title));
  }
}

function setDirty(value: boolean) {
  dirty = value;
  refreshChrome();
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  if (desktop) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask("Discard unsaved changes?", { title: "PDF Editor", kind: "warning" });
  }
  return confirm("Discard unsaved changes?");
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------- recent files ----------

async function refreshRecents() {
  if (!desktop) return;
  const files = await desktop.list();
  recentSelect.hidden = files.length === 0;
  recentSelect.replaceChildren(
    new Option(files.length ? "Recent files…" : "No recent files", ""),
    ...files.map((f) => Object.assign(new Option(f.name, f.id), { title: f.id })),
  );
  recentSelect.disabled = files.length === 0;
}

// ---------- the EmbedPDF viewer ----------

/** Tracks edits (annotation create / update / delete, incl. undo + eraser) for the Save button. */
async function watchChanges(v: any) {
  const reg = await v.registry;
  if (viewer !== v) return;
  const ann = reg.getPlugin("annotation")?.provides?.();
  ann?.onAnnotationEvent?.((e: any) => {
    if (viewer === v && e.type !== "loaded") setDirty(true);
  });
}

async function mount(id: string, bytes: Uint8Array) {
  target.replaceChildren();
  currentId = id;
  dirty = false;
  setStatus("");
  // No initial document: the toolbar (commands + schema) must be in place before one opens.
  const v = EmbedPDF.init({ type: "container", target, ...viewerConfig(), icons: toolbarIcons });
  viewer = v;
  tablet.attach(v);
  void watchChanges(v);
  refreshChrome();
  if (!desktop) history.replaceState(null, "", `?file=${encodeURIComponent(id)}`);
  const { registry } = await toolbar!.setup(v);
  if (viewer !== v) return;
  // EmbedPDF may transfer the buffer to its worker, so give it its own copy. Load errors (e.g. a
  // password prompt) are EmbedPDF's own UI to show, so the task is not awaited.
  registry.getPlugin("document-manager").provides().openDocumentBuffer({
    buffer: bytes.slice().buffer,
    name: storage.nameOf(id),
  });
}

function isPdf(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-");
}

async function readBytes(id: string): Promise<Uint8Array> {
  const source = await storage.source(id);
  if ("data" in source) return source.data;
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Opens a file (replacing the current one after the unsaved-changes prompt). */
async function openFile(id: string, { confirmed = false } = {}) {
  if (busy || (!confirmed && !(await confirmDiscard()))) return;
  busy = true;
  refreshChrome();
  setStatus(`Opening ${storage.nameOf(id)}…`);
  try {
    const bytes = await readBytes(id);
    if (!isPdf(bytes)) throw new Error("Not a valid PDF");
    desktop?.remember(id);
    await mount(id, bytes);
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(`Could not open ${storage.nameOf(id)}: ${errorText(err)}`, true);
  } finally {
    busy = false;
    refreshChrome();
    void refreshRecents();
  }
}

async function pickAndOpen() {
  if (busy) return;
  if (web) {
    fileInput.click();
    return;
  }
  const entry = await desktop?.pick();
  if (entry) await openFile(entry.id);
}

/** Browser: uploads a local PDF into the server library (never overwriting), then opens it. */
async function uploadAndOpen(file: File) {
  if (!web || busy || !(await confirmDiscard())) return;
  busy = true;
  refreshChrome();
  setStatus(`Uploading ${file.name}…`);
  let id: string;
  try {
    id = (await web.add(file)).id;
  } catch (err) {
    setStatus(`Could not open ${file.name}: ${errorText(err)}`, true);
    busy = false;
    refreshChrome();
    return;
  }
  busy = false;
  await openFile(id, { confirmed: true });
}

// ---------- save ----------

/** Writes pending annotation changes into the document and serialises it. */
async function exportBytes(): Promise<Uint8Array> {
  const reg = await viewer.registry;
  const docId: string | undefined = reg.getPlugin("document-manager")?.provides?.().getActiveDocumentId?.();
  const ann = reg.getPlugin("annotation")?.provides?.();
  const exporter = reg.getPlugin("export")?.provides?.();
  if (!docId || !exporter) throw new Error("Document is not ready");
  await ann?.forDocument(docId).commit().toPromise();
  const buffer: ArrayBuffer = await exporter.forDocument(docId).saveAsCopy().toPromise();
  return new Uint8Array(buffer);
}

/** Runs a save action with the busy/error handling shared by Save and Save As. */
async function withSaving(action: (bytes: Uint8Array) => Promise<boolean>) {
  if (busy || !viewer || !currentId) return;
  busy = true;
  refreshChrome();
  setStatus("Saving…");
  try {
    const saved = await action(await exportBytes());
    if (saved) {
      dirty = false;
      flashStatus("Saved");
    } else {
      setStatus("");
    }
  } catch (err) {
    setStatus(`Save failed: ${errorText(err)}`, true);
  } finally {
    busy = false;
    refreshChrome();
    void refreshRecents();
  }
}

async function save() {
  if (!dirty || !currentId) return;
  const id = currentId;
  await withSaving(async (bytes) => {
    await storage.write(id, bytes);
    return true;
  });
}

async function saveAs() {
  if (!desktop || !currentId) return;
  const suggested = desktop.nameOf(currentId);
  await withSaving(async (bytes) => {
    const entry = await desktop.saveAs(suggested, bytes);
    if (!entry) return false;
    currentId = entry.id;
    return true;
  });
}

// ---------- wiring ----------

openButton.addEventListener("click", () => void pickAndOpen());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) void uploadAndOpen(file);
});
recentSelect.addEventListener("change", () => {
  const id = recentSelect.value;
  recentSelect.value = "";
  if (id) void openFile(id);
});
toolbar = createToolbar({
  tablet,
  desktop: !!desktop,
  open: () => void pickAndOpen(),
  save: () => void save(),
  saveAs: () => void saveAs(),
  canSave: () => !!currentId && dirty && !busy,
  canSaveAs: () => !!currentId && !busy,
  busy: () => busy,
});

window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "s") {
    e.preventDefault();
    void (e.shiftKey ? saveAs() : save());
  } else if (key === "o") {
    e.preventDefault();
    void pickAndOpen();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});
// Keep the browser from navigating to a dropped file when the drop is not a handled .pdf.
for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => e.preventDefault());
// Browser: dropping a .pdf anywhere opens it (desktop gets dropped paths from Tauri instead).
window.addEventListener("drop", (e) => {
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (file) void uploadAndOpen(file);
});

async function startDesktop(d: NonNullable<typeof desktop>) {
  d.onDrop((path) => void openFile(path));

  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");

  // The window's close button: same unsaved-changes prompt (beforeunload does not fire for it).
  await getCurrentWindow().onCloseRequested(async (event) => {
    if (!(await confirmDiscard())) event.preventDefault();
  });
  // "Open with" / double-click on a second file while the app runs (the Rust shell is single-instance).
  await listen<string[]>("open-paths", ({ payload }) => {
    const path = payload[0];
    if (path) void openFile(path);
  });
  // Files passed on the command line when the app was launched (listener first, so none are missed).
  const launched = await invoke<string[]>("take_launch_paths");
  await refreshRecents();
  if (launched[0]) await openFile(launched[0]);
}

if (desktop) {
  void startDesktop(desktop).catch((err) => setStatus(`Startup failed: ${errorText(err)}`, true));
} else {
  const name = new URLSearchParams(location.search).get("file");
  if (name) void openFile(name);
}
refreshChrome();
