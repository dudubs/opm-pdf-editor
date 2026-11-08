// PDFium-based viewer/editor using EmbedPDF's stock UI, plus: tablet mode + Hebrew-safe text stamps
// (pdfium-tablet.ts) and Save back to the server library (below).
// @ts-ignore - resolved at runtime from /embedpdf/embedpdf.js
import EmbedPDF from "/embedpdf/embedpdf.js";

import { initTablet } from "./pdfium-tablet";

/* eslint-disable @typescript-eslint/no-explicit-any */

const select = document.getElementById("files") as HTMLSelectElement;
const upload = document.getElementById("upload") as HTMLInputElement;
const target = document.getElementById("viewer")!;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;

const tablet = initTablet({
  target,
  button: document.getElementById("tabletToggle")!,
  textButton: document.getElementById("textTool")!,
});

const fileUrl = (name: string) => `/api/files/${encodeURIComponent(name)}`;

let viewer: any;
let currentName = "";
let dirty = false;
let saving = false;

function setStatus(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function setDirty(value: boolean) {
  dirty = value;
  saveButton.disabled = !value || saving;
  document.title = `${value ? "• " : ""}PDF Editor (PDFium)`;
}

const confirmDiscard = () => !dirty || confirm("Discard unsaved changes?");

/** Tracks edits (annotation create / update / delete, incl. undo + eraser) for the Save button. */
async function watchChanges(v: any) {
  const reg = await v.registry;
  if (viewer !== v) return;
  const ann = reg.getPlugin("annotation")?.provides?.();
  ann?.onAnnotationEvent?.((e: any) => {
    if (viewer === v && e.type !== "loaded") setDirty(true);
  });
}

async function save() {
  if (!dirty || saving || !viewer) return;
  saving = true;
  saveButton.disabled = true;
  setStatus("Saving…");
  try {
    const reg = await viewer.registry;
    const docId: string | undefined = reg.getPlugin("document-manager")?.provides?.().getActiveDocumentId?.();
    const ann = reg.getPlugin("annotation")?.provides?.();
    const exporter = reg.getPlugin("export")?.provides?.();
    if (!docId || !exporter) throw new Error("Document is not ready");
    // Write any pending annotation changes into the document, then serialise it.
    await ann?.forDocument(docId).commit().toPromise();
    const buffer: ArrayBuffer = await exporter.forDocument(docId).saveAsCopy().toPromise();
    const res = await fetch(fileUrl(currentName), {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: buffer,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
    saving = false;
    setDirty(false);
    setStatus("Saved");
    setTimeout(() => statusEl.textContent === "Saved" && setStatus(""), 2000);
  } catch (err) {
    saving = false;
    setDirty(true);
    setStatus(`Save failed: ${(err as Error).message ?? err}`, true);
  }
}

function open(name: string) {
  target.replaceChildren();
  currentName = name;
  setDirty(false);
  setStatus("");
  viewer = EmbedPDF.init({
    type: "container",
    target,
    src: fileUrl(name),
    worker: true,
    tabBar: "always",
    theme: { preference: "system" },
  });
  tablet.attach(viewer);
  void watchChanges(viewer);
  history.replaceState(null, "", `?file=${encodeURIComponent(name)}`);
}

async function refresh(selectName?: string) {
  const files: { name: string }[] = await (await fetch("/api/files")).json();
  select.replaceChildren(...files.map((f) => new Option(f.name, f.name)));
  const wanted = selectName ?? new URLSearchParams(location.search).get("file") ?? files[0]?.name;
  if (wanted) {
    select.value = wanted;
    open(wanted);
  }
}

select.addEventListener("change", () => {
  if (!confirmDiscard()) {
    select.value = currentName;
    return;
  }
  open(select.value);
});
upload.addEventListener("change", async () => {
  const file = upload.files?.[0];
  upload.value = "";
  if (!file || !confirmDiscard()) return;
  const form = new FormData();
  form.set("file", file);
  const res = await fetch("/api/files", { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) return alert(body.error);
  await refresh(body.name);
});

saveButton.addEventListener("click", () => void save());
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void save();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

refresh();
