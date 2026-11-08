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

// Direction is stored inside the text itself as an invisible leading mark, so it round-trips through
// the PDF with the source text and needs no extra annotation key: U+200F = RTL, U+200E = LTR, none = auto.
const RLM = "‏";
const LRM = "‎";
export type TextDir = "auto" | "rtl" | "ltr";

/** Splits the leading direction mark off the stored text. */
export function parseTextDir(stored: string): { text: string; dir: TextDir } {
  if (stored.startsWith(RLM)) return { text: stored.slice(1), dir: "rtl" };
  if (stored.startsWith(LRM)) return { text: stored.slice(1), dir: "ltr" };
  return { text: stored, dir: "auto" };
}

export function withTextDir(text: string, dir: TextDir): string {
  return (dir === "rtl" ? RLM : dir === "ltr" ? LRM : "") + text;
}

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** Direction of one line from its first strong (letter) character, or null if it has none. */
function lineDir(line: string): "rtl" | "ltr" | null {
  for (const ch of line) {
    if (RTL_CHAR.test(ch)) return "rtl";
    if (/\p{L}/u.test(ch)) return "ltr";
  }
  return null;
}

/** Draws the text onto a fresh canvas (RENDER_SCALE x page units). `stored` may start with a direction mark. */
export function renderTextToCanvas(stored: string): { canvas: HTMLCanvasElement; width: number; height: number } {
  const { text, dir } = parseTextDir(stored);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Auto: every line follows its own first strong character; lines without one (digits, blanks)
  // follow the line above, and the first ones follow the first line that has a direction.
  const dirs: ("rtl" | "ltr")[] = [];
  if (dir === "auto") {
    let prev: "rtl" | "ltr" | null = null;
    const own = lines.map(lineDir);
    const first = own.find((d) => d !== null) ?? "ltr";
    for (const d of own) {
      prev = d ?? prev ?? first;
      dirs.push(prev);
    }
  } else {
    lines.forEach(() => dirs.push(dir));
  }
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
  // RTL lines (e.g. Hebrew) are shaped right-to-left and aligned to the right edge.
  lines.forEach((line, i) => {
    const rtl = dirs[i] === "rtl";
    ctx.direction = rtl ? "rtl" : "ltr";
    ctx.textAlign = rtl ? "right" : "left";
    ctx.fillText(line, rtl ? canvas.width - pad : pad, pad + lineH * (i + 0.5));
  });
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

/**
 * Opens the text dialog. `initial` is the stored text (may start with a direction mark).
 * Resolves with the stored text (trimmed, direction mark included), or null if cancelled / empty.
 */
export function promptText(initialStored = ""): Promise<string | null> {
  openDialog?.close();
  const dialog = document.createElement("dialog");
  dialog.id = "textStampDialog";
  const editing = initialStored !== "";
  const initial = parseTextDir(initialStored);
  dialog.innerHTML = `
    <form method="dialog">
      <h3></h3>
      <textarea rows="5" spellcheck="false" placeholder="Type text…"></textarea>
      <div class="buttons">
        <label class="dir">Direction
          <select data-act="dir">
            <option value="auto">Auto</option>
            <option value="rtl">Right to left</option>
            <option value="ltr">Left to right</option>
          </select>
        </label>
        <span class="spacer"></span>
        <button type="button" data-act="cancel">Cancel</button>
        <button type="submit" class="primary" data-act="apply">Apply</button>
      </div>
    </form>`;
  dialog.querySelector("h3")!.textContent = editing ? "Edit text stamp" : "New text stamp";
  const textarea = dialog.querySelector("textarea")!;
  const dirSelect = dialog.querySelector<HTMLSelectElement>('[data-act="dir"]')!;
  dirSelect.value = initial.dir;
  // The editing box follows the chosen direction ("auto" lets the browser pick per paragraph).
  const syncDir = () => (textarea.dir = dirSelect.value);
  dirSelect.addEventListener("change", syncDir);
  syncDir();
  textarea.value = initial.text;
  document.body.append(dialog);
  openDialog = dialog;

  return new Promise((resolve) => {
    let result: string | null = null;
    dialog.querySelector('[data-act="cancel"]')!.addEventListener("click", () => dialog.close());
    dialog.querySelector("form")!.addEventListener("submit", () => {
      const text = textarea.value.trim();
      result = text ? withTextDir(text, dirSelect.value as TextDir) : null;
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
