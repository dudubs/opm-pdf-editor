// EmbedPDF configuration that keeps the viewer fully local: no CDN, no Google Fonts, no network at all.
// (By default EmbedPDF pulls pdfium.wasm, fallback fonts, UI fonts and a stamp manifest from jsDelivr /
// Google, which the Tauri CSP blocks and which fails offline.) Everything referenced here is copied
// into dist/public/embedpdf by scripts/build.ts.

/** PDFium font charsets (FontCharset in @embedpdf/models). */
const CHARSET = { GREEK: 161, VIETNAMESE: 163, HEBREW: 177, ARABIC: 178, CYRILLIC: 204 } as const;

interface FontFile {
  file: string;
  weight: number;
  italic?: boolean;
}

const NOTO_SANS: FontFile[] = [
  { file: "NotoSans-Regular.ttf", weight: 400 },
  { file: "NotoSans-Bold.ttf", weight: 700 },
  { file: "NotoSans-Italic.ttf", weight: 400, italic: true },
  { file: "NotoSans-BoldItalic.ttf", weight: 700, italic: true },
];
const NOTO_HEBREW: FontFile[] = [
  { file: "NotoSansHebrew-Regular.ttf", weight: 400 },
  { file: "NotoSansHebrew-Bold.ttf", weight: 700 },
];
const NOTO_ARABIC: FontFile[] = [
  { file: "NotoNaskhArabic-Regular.ttf", weight: 400 },
  { file: "NotoNaskhArabic-Bold.ttf", weight: 700 },
];

/** Files are fetched by a blob: worker, which has no base URL, so every URL must be absolute. */
const asset = (path: string) => new URL(`/embedpdf/${path}`, location.href).href;

const variants = (dir: string, files: FontFile[]) =>
  files.map((f) => ({ url: asset(`fonts/${dir}/${f.file}`), weight: f.weight, italic: f.italic }));

export function viewerConfig() {
  return {
    worker: true,
    wasmUrl: asset("pdfium.wasm"),
    // CJK packs are 30-40 MB each and are not bundled; those scripts fall back to PDFium's own handling.
    fontFallback: {
      fonts: {
        [CHARSET.HEBREW]: variants("hebrew", NOTO_HEBREW),
        [CHARSET.ARABIC]: variants("arabic", NOTO_ARABIC),
        [CHARSET.CYRILLIC]: variants("latin", NOTO_SANS),
        [CHARSET.GREEK]: variants("latin", NOTO_SANS),
        [CHARSET.VIETNAMESE]: variants("latin", NOTO_SANS),
      },
    },
    // null = no Google Fonts stylesheet; the UI uses the system font stack.
    fonts: { ui: null, signature: null },
    // No remote stamp library (it would be fetched from jsDelivr); text stamps are our own tool.
    stamp: { manifests: [] },
    // The app owns opening / closing / exporting (native dialogs, Save As). EmbedPDF's own versions use
    // browser file inputs and downloads, which would detach the document from its path on disk.
    disabledCategories: ["document-open", "document-close", "document-export"],
    tabBar: "never" as const,
    theme: { preference: "system" as const },
  };
}
