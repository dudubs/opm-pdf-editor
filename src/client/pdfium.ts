// Basic PDFium-based viewer/editor using EmbedPDF's stock UI (no custom features).
// @ts-ignore - resolved at runtime from /embedpdf/embedpdf.js
import EmbedPDF from "/embedpdf/embedpdf.js";

import { initTablet } from "./pdfium-tablet";

const select = document.getElementById("files") as HTMLSelectElement;
const upload = document.getElementById("upload") as HTMLInputElement;
const target = document.getElementById("viewer")!;

const tablet = initTablet({ target, button: document.getElementById("tabletToggle")! });

const fileUrl = (name: string) => `/api/files/${encodeURIComponent(name)}`;

let viewer: any;
function open(name: string) {
  target.replaceChildren();
  viewer = EmbedPDF.init({
    type: "container",
    target,
    src: fileUrl(name),
    worker: true,
    tabBar: "always",
    theme: { preference: "system" },
  });
  tablet.attach(viewer);
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

select.addEventListener("change", () => open(select.value));
upload.addEventListener("change", async () => {
  const file = upload.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.set("file", file);
  const res = await fetch("/api/files", { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) return alert(body.error);
  await refresh(body.name);
});

refresh();
