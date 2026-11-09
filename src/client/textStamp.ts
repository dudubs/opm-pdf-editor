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

/**
 * Direction of every paragraph. Auto: each follows its own first strong character; paragraphs without one
 * (digits, blanks) follow the one above, and the first ones follow the first paragraph that has a direction.
 */
function paragraphDirs(paras: string[], dir: TextDir): ("rtl" | "ltr")[] {
  if (dir !== "auto") return paras.map(() => dir);
  const dirs: ("rtl" | "ltr")[] = [];
  let prev: "rtl" | "ltr" | null = null;
  const own = paras.map(lineDir);
  const first = own.find((d) => d !== null) ?? "ltr";
  for (const d of own) {
    prev = d ?? prev ?? first;
    dirs.push(prev);
  }
  return dirs;
}

/** The area the text has to fill, in page units. */
export interface TextBox {
  width: number;
  height: number;
}

const MIN_FIT_SIZE = 4; // page units
const MAX_CANVAS_SIDE = 4096; // px

/** Greedy word wrap of one paragraph to `maxW` px (the context's font is already set). Overlong words break per character. */
function wrapParagraph(para: string, maxW: number, ctx: CanvasRenderingContext2D): string[] {
  const width = (t: string) => ctx.measureText(t).width;
  const lines: string[] = [];
  let cur = "";
  for (const word of para.split(" ")) {
    const trial = cur ? `${cur} ${word}` : word;
    if (width(trial) <= maxW) {
      cur = trial;
      continue;
    }
    if (cur) lines.push(cur);
    cur = "";
    if (width(word) <= maxW) {
      cur = word;
      continue;
    }
    for (const ch of word) {
      if (cur && width(cur + ch) > maxW) {
        lines.push(cur);
        cur = "";
      }
      cur += ch;
    }
  }
  lines.push(cur);
  return lines;
}

/** Draws the text so it fills `box`: the largest font size whose word-wrapped text still fits inside it. */
function renderFitted(paras: string[], dirs: ("rtl" | "ltr")[], box: TextBox) {
  const scale = Math.min(RENDER_SCALE, MAX_CANVAS_SIDE / Math.max(box.width, box.height, 1));
  const pad = Math.min(PADDING, 0.1 * Math.min(box.width, box.height));
  const availW = Math.max(1, box.width - pad * 2) * scale;
  const availH = Math.max(1, box.height - pad * 2) * scale;
  const measure = document.createElement("canvas").getContext("2d")!;

  const layout = (size: number) => {
    measure.font = `${size * scale}px ${FONT_FAMILY}`;
    const lines: { text: string; dir: "rtl" | "ltr" }[] = [];
    paras.forEach((p, i) => wrapParagraph(p, availW, measure).forEach((text) => lines.push({ text, dir: dirs[i] ?? "ltr" })));
    const widest = Math.max(...lines.map((l) => measure.measureText(l.text).width));
    return { lines, fits: widest <= availW + 0.5 && lines.length * size * scale * LINE_HEIGHT <= availH };
  };

  let lo = MIN_FIT_SIZE;
  let hi = Math.max(lo, availH / scale / LINE_HEIGHT);
  if (layout(lo).fits) {
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (layout(mid).fits) lo = mid;
      else hi = mid;
    }
  }
  const { lines } = layout(lo);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(box.width * scale));
  canvas.height = Math.max(1, Math.ceil(box.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${lo * scale}px ${FONT_FAMILY}`;
  ctx.fillStyle = "#000";
  ctx.textBaseline = "middle";
  const lineH = lo * scale * LINE_HEIGHT;
  lines.forEach((line, i) => {
    const rtl = line.dir === "rtl";
    ctx.direction = rtl ? "rtl" : "ltr";
    ctx.textAlign = rtl ? "right" : "left";
    ctx.fillText(line.text, rtl ? canvas.width - pad * scale : pad * scale, pad * scale + lineH * (i + 0.5));
  });
  return { canvas, width: box.width, height: box.height };
}

/**
 * Draws the text onto a fresh canvas. `stored` may start with a direction mark.
 * Without `box` the canvas is sized to the text (16 page units); with it the text is fitted to fill the box.
 */
export function renderTextToCanvas(
  stored: string,
  box?: TextBox,
): { canvas: HTMLCanvasElement; width: number; height: number } {
  const { text, dir } = parseTextDir(stored);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const dirs = paragraphDirs(lines, dir);
  if (box) return renderFitted(lines, dirs, box);
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

export interface PromptOptions {
  /** Called with the stored text (direction mark included) on every edit, for a live preview. */
  onInput?: (stored: string) => void;
  /**
   * Where the text will land on screen. Docks the dialog at the top/bottom edge, on the side away from it, keeps
   * the page visible behind the dialog and adds a "Move / resize" button.
   */
  anchor?: DOMRect;
}

export interface PromptResult {
  /** The stored text (trimmed, direction mark included), or null if cancelled / empty / moving the box. */
  result: string | null;
  /** "Move / resize" was pressed: the dialog closed so the box can be edited; reopen it with `draft`. */
  move: boolean;
  /** The untrimmed text typed so far, direction mark included. */
  draft: string;
}

/** Opens the text dialog. `initialStored` is the stored text (may start with a direction mark). */
export function promptTextEx(initialStored = "", opts: PromptOptions = {}): Promise<PromptResult> {
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
        ${opts.anchor ? '<button type="button" data-act="move">Move / resize</button>' : ""}
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
  const draft = () => withTextDir(textarea.value, dirSelect.value as TextDir);
  dirSelect.addEventListener("change", () => {
    syncDir();
    opts.onInput?.(draft());
  });
  textarea.addEventListener("input", () => opts.onInput?.(draft()));
  syncDir();
  textarea.value = initial.text;
  if (opts.anchor) {
    dialog.classList.add("with-preview");
    textarea.rows = 3;
    // Dock on the side of the screen away from the text box so the preview stays visible.
    const below = opts.anchor.top + opts.anchor.height / 2 < innerHeight / 2;
    dialog.style.cssText = `margin:0 auto;${below ? "top:auto;bottom:8px" : "top:8px;bottom:auto"};`;
  }
  document.body.append(dialog);
  openDialog = dialog;

  return new Promise((resolve) => {
    let result: string | null = null;
    let move = false;
    dialog.querySelector('[data-act="cancel"]')!.addEventListener("click", () => dialog.close());
    dialog.querySelector('[data-act="move"]')?.addEventListener("click", () => {
      move = true;
      dialog.close();
    });
    dialog.querySelector("form")!.addEventListener("submit", () => {
      const text = textarea.value.trim();
      result = text ? withTextDir(text, dirSelect.value as TextDir) : null;
    });
    dialog.addEventListener("close", () => {
      const last = draft();
      dialog.remove();
      if (openDialog === dialog) openDialog = null;
      resolve({ result, move, draft: last });
    });
    dialog.showModal();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
}

/**
 * Opens the text dialog. `initial` is the stored text (may start with a direction mark).
 * Resolves with the stored text (trimmed, direction mark included), or null if cancelled / empty.
 */
export async function promptText(initialStored = ""): Promise<string | null> {
  return (await promptTextEx(initialStored)).result;
}
