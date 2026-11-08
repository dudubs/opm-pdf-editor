// Text stamps: a real DOM text dialog + text -> PNG rendering.
// The stamp itself is created in main.ts; the source text travels with the annotation
// (/OPMText in the PDF, see the pdf.js fork) so it can be edited later.

/** Page units (1 unit = 1pt at scale 1) of the rendered font size. */
const FONT_SIZE = 16;
/** Oversampling of the PNG relative to page units, so it stays crisp when zoomed. */
const RENDER_SCALE = 4;
const PADDING = 4;
const LINE_HEIGHT = 1.25;
const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Hebrew', sans-serif";

export interface RenderedText {
  file: File;
  /** Size of the image in page units. */
  width: number;
  height: number;
}

/** Draws the text onto a fresh canvas (RENDER_SCALE x page units). */
export function renderTextToCanvas(text: string): { canvas: HTMLCanvasElement; width: number; height: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const font = `${FONT_SIZE * RENDER_SCALE}px ${FONT_FAMILY}`;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const lineH = FONT_SIZE * RENDER_SCALE * LINE_HEIGHT;
  const pad = PADDING * RENDER_SCALE;
  const textW = Math.max(...lines.map((l) => measure.measureText(l).width), 1);

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(textW + pad * 2);
  canvas.height = Math.ceil(lineH * lines.length + pad * 2);
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  ctx.fillStyle = "#000";
  ctx.textBaseline = "middle";
  // Respect RTL text (e.g. Hebrew): align to the right edge if the dialog text is RTL.
  const rtl = /[֐-ࣿ]/.test(text);
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textAlign = rtl ? "right" : "left";
  const x = rtl ? canvas.width - pad : pad;
  lines.forEach((line, i) => ctx.fillText(line, x, pad + lineH * (i + 0.5)));
  return { canvas, width: canvas.width / RENDER_SCALE, height: canvas.height / RENDER_SCALE };
}

export async function renderTextToFile(text: string): Promise<RenderedText> {
  const { canvas, width, height } = renderTextToCanvas(text);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
  // Unique name: pdf.js caches bitmaps by name/size/lastModified.
  const file = new File([blob], `text-${Date.now()}-${Math.random().toString(36).slice(2)}.png`, {
    type: "image/png",
    lastModified: Date.now(),
  });
  return { file, width, height };
}

let openDialog: HTMLDialogElement | null = null;

/** Opens the text dialog. Resolves with the trimmed text, or null if cancelled / empty. */
export function promptText(initial = ""): Promise<string | null> {
  openDialog?.close();
  const dialog = document.createElement("dialog");
  dialog.id = "textStampDialog";
  const editing = initial !== "";
  dialog.innerHTML = `
    <form method="dialog">
      <h3></h3>
      <textarea rows="5" spellcheck="false" placeholder="Type text…"></textarea>
      <div class="buttons">
        <button type="button" data-act="cancel">Cancel</button>
        <button type="submit" class="primary" data-act="apply">Apply</button>
      </div>
    </form>`;
  dialog.querySelector("h3")!.textContent = editing ? "Edit text stamp" : "New text stamp";
  const textarea = dialog.querySelector("textarea")!;
  textarea.value = initial;
  document.body.append(dialog);
  openDialog = dialog;

  return new Promise((resolve) => {
    let result: string | null = null;
    dialog.querySelector('[data-act="cancel"]')!.addEventListener("click", () => dialog.close());
    dialog.querySelector("form")!.addEventListener("submit", () => {
      result = textarea.value.trim() || null;
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (openDialog === dialog) openDialog = null;
      resolve(result);
    });
    dialog.showModal();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
}
